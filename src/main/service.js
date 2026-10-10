'use strict';

// The planner "service": every action the screens can ask for, in plain Node code.
// It has no Electron in it, so it is tested directly and used by the screenshot tool.
// Everything it returns is plain data (text, numbers, lists) that can cross into the window.

const crypto = require('crypto');
const core = require('../core');

const {
  CITIES, findCity, METHOD_KEYS, METHOD_LABELS,
  mergeSettings, buildExport, parseImport, ALERT_PRESETS,
  createTask, validateTask, validateStart, validateRule, normalizeRule, describeRule, previewDates,
  occurrencesForPlanningDay, computeDayLayout, currentPlanningDayKey, getOccurrences, buildOccurrence,
  startAtDate, resolveStart, computeEnd, placementNote, setCompletion, editTask, deleteOccurrences,
  dependencyProblem, findDependents, followsTransitively, freezeDependents,
  remindersInWindow, reminderOffsets, createPrayerProvider, computeStats,
  addDaysToKey, dateKey, formatTime12, formatDuration, formatKeyShort, weekdayOfKey, parseDateKey, isValidKey,
} = core;

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EDIT_FIELDS = ['title', 'start', 'durationMinutes', 'notes', 'priority', 'categoryId', 'reminders'];

function defaultProviderFactory(settings) {
  const city = findCity(settings.cityName);
  return createPrayerProvider({
    latitude: city.latitude,
    longitude: city.longitude,
    method: settings.method,
    adjustments: settings.adjustments,
  });
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

class PlannerService {
  // deps: { store, now, newId, providerFactory, onDataChanged(), onSettingsChanged(settings) }
  constructor(deps) {
    this.store = deps.store;
    this.now = deps.now || (() => new Date());
    this.newId = deps.newId || (() => crypto.randomUUID());
    this.providerFactory = deps.providerFactory || defaultProviderFactory;
    this.onDataChanged = deps.onDataChanged || (() => {});
    this.onSettingsChanged = deps.onSettingsChanged || (() => {});
    this.data = this.store.load();
    this.providerCache = null;
  }

  // ---- basics -----------------------------------------------------------------------------------------

  get settings() {
    return this.data.settings;
  }

  provider() {
    const s = this.settings;
    const key = JSON.stringify([s.cityName, s.method, s.adjustments]);
    if (!this.providerCache || this.providerCache.key !== key) {
      this.providerCache = { key, provider: this.providerFactory(s) };
    }
    return this.providerCache.provider;
  }

  // Options used whenever occurrences are worked out. `tasks` lets tasks that follow other tasks find them.
  recurrenceOptions() {
    return { workingDays: this.settings.workingDays, tasks: this.data.tasks };
  }

  weekStart() {
    return [6, 0, 1].includes(this.settings.weekStart) ? this.settings.weekStart : 0;
  }

  persist() {
    this.store.save(this.data);
  }

  changed() {
    this.persist();
    this.onDataChanged();
  }

  findTask(taskId) {
    const task = this.data.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('This task no longer exists.');
    return task;
  }

  categoryOf(categoryId) {
    return this.data.categories.find((c) => c.id === categoryId) || null;
  }

  // ---- start-up information ----------------------------------------------------------------------------

  bootstrap() {
    return {
      settings: copy(this.settings),
      categories: copy(this.data.categories),
      cities: CITIES.map((c) => c.name),
      methods: METHOD_KEYS.map((key) => ({ key, label: METHOD_LABELS[key] })),
      currentPlanningDayKey: currentPlanningDayKey(this.provider(), this.now()),
      loadNotes: copy(this.store.loadNotes || []),
    };
  }

  // ---- the Daily View -----------------------------------------------------------------------------------

  hijriLabel(key) {
    try {
      const noon = parseDateKey(key);
      noon.setHours(12, 0, 0, 0);
      noon.setDate(noon.getDate() + this.settings.hijriAdjustment);
      return new Intl.DateTimeFormat('en-US-u-ca-islamic-umalqura-nu-latn', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(noon);
    } catch (error) {
      return '';
    }
  }

  viewOccurrence(o, planningKey, nowDate, conflictTitles) {
    const category = this.categoryOf(o.categoryId);
    return {
      id: o.id,
      taskId: o.taskId,
      dateKey: o.dateKey,
      title: o.title,
      notes: o.notes,
      priority: o.priority,
      categoryName: category ? category.name : '',
      categoryColor: category ? category.color : '',
      startLabel: formatTime12(o.start),
      endLabel: formatTime12(o.end),
      endsNextDay: dateKey(o.end) !== dateKey(o.start),
      afterMidnight: dateKey(o.start) !== planningKey,
      durationMinutes: o.durationMinutes,
      durationLabel: formatDuration(o.durationMinutes),
      isRecurring: o.isRecurring,
      hasReminders: reminderOffsets(o.reminders, this.settings).length > 0,
      hasFullScreen: Boolean(o.reminders && o.reminders.fullScreen),
      done: o.done,
      overlaps: Boolean(o.overlaps),
      conflictWith: conflictTitles || [],
      inProgress: !o.done && o.start.getTime() <= nowDate.getTime() && nowDate.getTime() < o.end.getTime(),
      extendsPastZoneEnd: Boolean(o.extendsPastZoneEnd),
      overdue: !o.done && o.end.getTime() <= nowDate.getTime(),
      followsTitle: this.followsTitle(o.startDefinition),
      startWarning: o.startWarning || null,
    };
  }

  // For a task that follows another task: the other task's title.
  followsTitle(startDefinition) {
    if (!startDefinition || startDefinition.mode !== 'task') return null;
    const other = this.data.tasks.find((t) => t.id === startDefinition.taskId);
    return other ? other.title : 'a deleted task';
  }

  getDay(planningKey) {
    if (!isValidKey(planningKey)) throw new Error('That date is not valid.');
    const provider = this.provider();
    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    const occurrences = occurrencesForPlanningDay(provider, this.data.tasks, planningKey, this.recurrenceOptions());
    const layout = computeDayLayout(provider, planningKey, occurrences);
    const currentKey = currentPlanningDayKey(provider, nowDate);
    const endKey = addDaysToKey(planningKey, 1);

    // Which tasks overlap which (titles for the "Conflict with ..." note) and the overlapping stretches.
    const conflictTitles = new Map();
    const conflictSpans = [];
    for (let i = 0; i < occurrences.length; i++) {
      for (let j = i + 1; j < occurrences.length; j++) {
        const a = occurrences[i];
        const b = occurrences[j];
        if (!(a.start < b.end && b.start < a.end)) continue;
        for (const [x, y] of [[a, b], [b, a]]) {
          if (!conflictTitles.has(x.id)) conflictTitles.set(x.id, []);
          if (!conflictTitles.get(x.id).includes(y.title)) conflictTitles.get(x.id).push(y.title);
        }
        conflictSpans.push({
          from: Math.max(a.start.getTime(), b.start.getTime()),
          to: Math.min(a.end.getTime(), b.end.getTime()),
          a: a.title,
          b: b.title,
        });
      }
    }

    const zones = layout.zones.map((z) => {
      const span = z.end.getTime() - z.start.getTime();
      const isCurrent = planningKey === currentKey && nowMs >= z.start.getTime() && nowMs < z.end.getTime();
      const segments = [...z.tasks, ...z.continued].map((o) => {
        const from = Math.max(o.start.getTime(), z.start.getTime());
        const to = Math.min(o.end.getTime(), z.end.getTime());
        const category = this.categoryOf(o.categoryId);
        return {
          leftPct: ((from - z.start.getTime()) / span) * 100,
          widthPct: Math.max(((to - from) / span) * 100, 0.8),
          color: category ? category.color : '',
          title: `${o.title} · ${formatTime12(o.start)} – ${formatTime12(o.end)}`,
          done: o.done,
        };
      });
      const zoneConflicts = conflictSpans
        .map((c) => ({ ...c, from: Math.max(c.from, z.start.getTime()), to: Math.min(c.to, z.end.getTime()) }))
        .filter((c) => c.to > c.from);
      const confSegs = zoneConflicts.map((c) => ({
        leftPct: ((c.from - z.start.getTime()) / span) * 100,
        widthPct: Math.max(((c.to - c.from) / span) * 100, 0.8),
        title: `Conflict: “${c.a}” and “${c.b}” overlap`,
      }));
      return {
        index: z.index,
        name: z.name,
        minutes: z.totalMinutes,
        freeMinutes: z.freeMinutes,
        minutesLeftLabel: isCurrent ? formatDuration(Math.max(0, Math.ceil((z.end.getTime() - nowMs) / 60000))) : '',
        taskCount: z.tasks.length,
        doneCount: z.tasks.filter((o) => o.done).length,
        confSegs,
        conflictCount: zoneConflicts.length,
        startLabel: formatTime12(z.start),
        endLabel: formatTime12(z.end),
        totalLabel: z.totalLabel,
        scheduledLabel: z.scheduledLabel,
        freeLabel: z.freeLabel,
        isCurrent,
        nowPct: isCurrent ? ((nowMs - z.start.getTime()) / span) * 100 : null,
        segments,
        tasks: z.tasks.map((o) => this.viewOccurrence(o, planningKey, nowDate, conflictTitles.get(o.id))),
        continued: z.continued.map((o) => ({
          taskId: o.taskId,
          dateKey: o.dateKey,
          title: o.title,
          endLabel: formatTime12(o.end),
          minutesLabel: formatDuration(o.minutesInZone),
        })),
      };
    });

    const listed = zones.reduce((n, z) => n + z.taskCount, 0);
    const listedDone = zones.reduce((n, z) => n + z.doneCount, 0);
    const currentZone = zones.find((z) => z.isCurrent) || null;
    const dayStart = layout.zones[0].start.getTime();
    const dayEnd = layout.zones[layout.zones.length - 1].end.getTime();
    const inProgress = zones.flatMap((z) => z.tasks.filter((t) => t.inProgress).map((t) => t.title));

    return {
      taskCount: listed,
      doneCount: listedDone,
      dayNowPct: planningKey === currentKey ? Math.min(100, Math.max(0, ((nowMs - dayStart) / (dayEnd - dayStart)) * 100)) : null,
      currentZone: currentZone
        ? { name: currentZone.name, timeLeftLabel: currentZone.minutesLeftLabel, freeLabel: currentZone.freeLabel, nextName: (zones[currentZone.index] || {}).name || '' }
        : null,
      inProgress,
      planningDayKey: planningKey,
      prevKey: addDaysToKey(planningKey, -1),
      nextKey: endKey,
      isCurrentDay: planningKey === currentKey,
      currentPlanningDayKey: currentKey,
      dateTitle: parseDateKey(planningKey).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      }),
      hijri: this.hijriLabel(planningKey),
      planningLine: `Planning Day: ${formatKeyShort(planningKey)} → ${formatKeyShort(endKey)}`,
      week: this.weekStrip(planningKey, currentKey),
      zones,
    };
  }

  // The seven days of the week (from the first day chosen in Settings) around a planning day, for the strip at the top of the Daily View.
  weekStrip(planningKey, currentKey) {
    const provider = this.provider();
    const options = this.recurrenceOptions();
    const first = addDaysToKey(planningKey, -((weekdayOfKey(planningKey) - this.weekStart() + 7) % 7));
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const longNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = [];
    for (let i = 0; i < 7; i++) {
      const key = addDaysToKey(first, i);
      const wd = weekdayOfKey(key);
      const list = occurrencesForPlanningDay(provider, this.data.tasks, key, options);
      const done = list.filter((o) => o.done).length;
      const pct = list.length ? Math.round((done / list.length) * 100) : 0;
      days.push({
        key,
        weekday: names[wd],
        day: parseDateKey(key).getDate(),
        total: list.length,
        done,
        pct,
        isToday: key === currentKey,
        isSelected: key === planningKey,
        label: `${key === currentKey ? 'Today, ' : ''}${longNames[wd]} ${formatKeyShort(key)}, ${list.length ? `${done} of ${list.length} done` : 'no tasks'}`,
      });
    }
    return { days, prevKey: addDaysToKey(planningKey, -7), nextKey: addDaysToKey(planningKey, 7) };
  }

  // The Statistics screen. query: { range: 'day'|'week'|'month'|'year'|'custom', anchorKey, fromKey, toKey }.
  getStats(query) {
    return computeStats({
      provider: this.provider(),
      tasks: this.data.tasks,
      categories: this.data.categories,
      options: this.recurrenceOptions(),
      now: this.now(),
      query: query || {},
      weekStart: this.weekStart(),
    });
  }

  // Next reminders, for the bell.
  getUpcoming() {
    const nowDate = this.now();
    const from = nowDate.getTime();
    const list = remindersInWindow(this.provider(), this.data.tasks, from, from + 7 * 86400000, this.settings).slice(0, 12);
    const todayKey = dateKey(nowDate);
    const tomorrowKey = addDaysToKey(todayKey, 1);
    return list.map((r) => {
      const k = dateKey(r.notifyAt);
      const day = k === todayKey ? 'Today' : k === tomorrowKey ? 'Tomorrow' : formatKeyShort(k);
      return {
        taskId: r.taskId,
        dateKey: r.dateKey,
        title: r.title,
        whenLabel: `${day}, ${formatTime12(r.notifyAt)}`,
        startLabel: formatTime12(r.start),
        zoneName: r.zoneName,
      };
    });
  }

  // ---- missed reminders (shown on the bell) ------------------------------------------------------------------
  // Reminders that came due while the computer was off or asleep. They stay on the bell until the person
  // opens the task, marks it done, or clears the list.

  missedList() {
    if (!Array.isArray(this.data.missedReminders)) this.data.missedReminders = [];
    return this.data.missedReminders;
  }

  // items: [{ taskId, dateKey, title, start, zoneName, alreadyStarted }] from the reminder engine.
  addMissed(items) {
    const list = this.missedList();
    for (const i of items) {
      if (list.some((m) => m.taskId === i.taskId && m.dateKey === i.dateKey)) continue;
      list.push({
        taskId: i.taskId,
        dateKey: i.dateKey,
        title: i.title,
        startMs: new Date(i.start).getTime(),
        zoneName: i.zoneName,
        alreadyStarted: Boolean(i.alreadyStarted),
      });
    }
    if (list.length > 50) list.splice(0, list.length - 50);
    this.changed();
  }

  // Entries whose task was deleted, or whose occurrence is already done or removed, quietly drop out.
  getMissed() {
    const list = this.missedList();
    const live = list.filter((m) => {
      const task = this.data.tasks.find((t) => t.id === m.taskId);
      return task && !task.completions[m.dateKey] && !(task.exceptions || []).includes(m.dateKey);
    });
    if (live.length !== list.length) {
      this.data.missedReminders = live;
      this.persist();
    }
    const todayKey = dateKey(this.now());
    const yesterdayKey = addDaysToKey(todayKey, -1);
    return live
      .slice()
      .sort((a, b) => b.startMs - a.startMs)
      .map((m) => {
        const k = dateKey(new Date(m.startMs));
        const day = k === todayKey ? 'Today' : k === yesterdayKey ? 'Yesterday' : formatKeyShort(k);
        return {
          taskId: m.taskId,
          dateKey: m.dateKey,
          title: m.title,
          whenLabel: `${day}, ${formatTime12(new Date(m.startMs))}`,
          startLabel: formatTime12(new Date(m.startMs)),
          zoneName: m.zoneName,
          alreadyStarted: m.alreadyStarted,
        };
      });
  }

  dismissMissed({ taskId, dateKey: key }) {
    this.data.missedReminders = this.missedList().filter((m) => !(m.taskId === taskId && m.dateKey === key));
    this.changed();
    return { ok: true };
  }

  clearMissed() {
    this.data.missedReminders = [];
    this.changed();
    return { ok: true };
  }

  // ---- the full-screen alert ----------------------------------------------------------------------------------

  // What the alert window shows for each task starting now (plain text and numbers only).
  buildAlertItems(items) {
    return items.map((i) => {
      const category = this.categoryOf(i.categoryId);
      return {
        id: i.id,
        taskId: i.taskId,
        dateKey: i.dateKey,
        title: i.title,
        notes: i.notes || '',
        startLabel: formatTime12(i.start),
        endLabel: formatTime12(i.end),
        durationLabel: formatDuration(i.durationMinutes),
        zoneName: i.zoneName,
        zoneIndex: i.zoneIndex,
        categoryName: category ? category.name : '',
        categoryColor: category ? category.color : '',
        priority: i.priority,
        snoozed: Boolean(i.snoozed),
      };
    });
  }

  // How the alert should look and behave right now.
  getAlertConfig() {
    const s = this.settings;
    return {
      appearance: copy(s.alertAppearance),
      screens: s.alertScreens,
      snoozeMinutes: s.snoozeMinutes,
      sound: { id: s.alertSound, volume: s.alertSoundVolume, repeat: s.alertSoundRepeat },
    };
  }

  // One of the ready-made looks.
  getAlertPreset(key) {
    const preset = ALERT_PRESETS[key];
    if (!preset) throw new Error('That look does not exist.');
    return copy(preset.appearance);
  }

  // An example for the "Preview" button in Settings.
  getAlertSample() {
    const now = this.now();
    return {
      id: `sample-${now.getTime()}`,
      taskId: '__sample__',
      dateKey: dateKey(now),
      title: 'Study SQL: joins and subqueries',
      notes: 'Open the exercises from yesterday.\nFinish chapter 4, then try the practice questions.',
      startLabel: formatTime12(now),
      endLabel: formatTime12(new Date(now.getTime() + 45 * 60000)),
      durationLabel: '45m',
      zoneName: 'Dhuhr → Asr',
      zoneIndex: 2,
      categoryName: 'Study',
      categoryColor: '#8b5cf6',
      priority: 'High',
      snoozed: false,
    };
  }

  // ---- the task form ---------------------------------------------------------------------------------------

  newTaskDefaults(forKey) {
    const key = isValidKey(forKey) ? forKey : dateKey(this.now());
    return {
      title: '',
      start: { mode: 'fixed', time: '09:00' },
      durationMinutes: 30,
      date: key,
      recurrence: null,
      // empty list = the default reminder time from Settings; the full-screen switch follows the Settings default
      reminders: { enabled: true, offsets: [], fullScreen: Boolean(this.settings.fullScreenDefaultForNewTasks) },
      priority: 'Medium',
      categoryId: null,
      notes: '',
    };
  }

  getTaskForEdit({ taskId, dateKey: key }) {
    const task = this.findTask(taskId);
    const occurrence = buildOccurrence(this.provider(), task, key, false, this.recurrenceOptions());
    return {
      taskId,
      dateKey: key,
      isRecurring: Boolean(task.recurrence),
      done: occurrence.done,
      form: {
        title: occurrence.title,
        start: copy(occurrence.startDefinition),
        durationMinutes: occurrence.durationMinutes,
        date: task.recurrence ? key : task.date,
        recurrence: task.recurrence ? copy(task.recurrence) : null,
        reminders: copy(occurrence.reminders),
        priority: occurrence.priority,
        categoryId: occurrence.categoryId,
        notes: occurrence.notes,
      },
    };
  }

  // Live preview shown while the form is open: resolved start, end, zone, and the repeat summary.
  previewForm(form, context = {}) {
    const provider = this.provider();
    const errors = [];
    const out = { errors, resolved: null, placement: null, rule: null };

    errors.push(...validateStart(form.start));
    const durationOk = Number.isInteger(form.durationMinutes) && form.durationMinutes > 0;
    if (!durationOk) errors.push('Duration must be a whole number of minutes, more than 0');

    let contextKey = form.recurrence ? form.recurrence.startDate : form.date;
    if (!isValidKey(contextKey)) {
      errors.push(form.recurrence ? 'Please choose a start date' : 'Please choose a date');
      contextKey = null;
    }

    if (form.recurrence) {
      const ruleErrors = validateRule(form.recurrence);
      errors.push(...ruleErrors);
      if (ruleErrors.length === 0) {
        const rule = normalizeRule(form.recurrence);
        out.rule = {
          summary: describeRule(rule),
          preview: previewDates(rule, 5, this.recurrenceOptions()).map((k) => ({
            key: k,
            label: `${WEEKDAY_SHORT[weekdayOfKey(k)]}, ${formatKeyShort(k, true)}`,
          })),
        };
      }
    }

    if (form.start && form.start.mode === 'task' && validateStart(form.start).length === 0) {
      const problem = dependencyProblem(this.data.tasks, {
        id: context.taskId || '__new__',
        start: form.start,
        overrides: {},
      });
      if (problem) errors.push(problem);
    }

    if (contextKey && validateStart(form.start).length === 0) {
      const resolvedStart = resolveStart(provider, form.start, contextKey, this.recurrenceOptions(), context.taskId || '__new__');
      const start = resolvedStart.start;
      out.resolved = {
        startLabel: formatTime12(start),
        endLabel: null,
        endsNextDay: false,
        warning: resolvedStart.warning,
      };
      if (durationOk) {
        const end = computeEnd(start, form.durationMinutes);
        out.resolved.endLabel = formatTime12(end);
        out.resolved.endsNextDay = dateKey(end) !== dateKey(start);
      }
      const note = placementNote(provider, start, contextKey);
      out.placement = {
        text: note.text,
        zoneIndex: note.zoneIndex,
        zoneName: note.zoneName,
        differsFromDate: note.differsFromDate,
      };
    }
    return out;
  }

  cleanForm(form) {
    const fields = {
      title: String(form.title === undefined || form.title === null ? '' : form.title).trim(),
      start: form.start,
      durationMinutes: form.durationMinutes,
      notes: typeof form.notes === 'string' ? form.notes : '',
      priority: form.priority || 'Medium',
      categoryId: form.categoryId && this.categoryOf(form.categoryId) ? form.categoryId : null,
      reminders: {
        enabled: Boolean(form.reminders && form.reminders.enabled),
        offsets: form.reminders && Array.isArray(form.reminders.offsets) ? form.reminders.offsets : [],
        fullScreen: Boolean(form.reminders && form.reminders.fullScreen),
      },
    };
    return { fields, recurrence: form.recurrence ? normalizeRule(form.recurrence) : null, date: form.date };
  }

  // payload: { mode: 'create' | 'edit', taskId, dateKey, scope: 'this'|'following'|'all', form }
  saveTask(payload) {
    const { fields, recurrence, date } = this.cleanForm(payload.form);

    if (payload.mode === 'create') {
      const task = createTask({ id: this.newId(), ...fields, recurrence, date });
      this.checkDependencies(task);
      this.data.tasks.push(task);
      this.changed();
      return { ok: true, taskId: task.id };
    }

    const old = this.findTask(payload.taskId);
    const key = payload.dateKey;
    const scope = payload.scope || 'all';
    const wasRecurring = Boolean(old.recurrence);
    const willRecur = Boolean(recurrence);

    let updated;
    let created = null;

    if (wasRecurring !== willRecur) {
      if (scope !== 'all') {
        throw new Error('To switch between repeating and not repeating, choose "All occurrences".');
      }
      const replacement = createTask({ id: old.id, ...fields, recurrence, date });
      updated = { ...replacement, completions: copy(old.completions), completedAt: copy(old.completedAt || {}) };
    } else if (!wasRecurring) {
      ({ updated } = editTask(old, 'all', key, { ...fields, date }));
    } else {
      // Only the fields the user really changed are sent, so single-occurrence edits elsewhere survive.
      const current = buildOccurrence(this.provider(), old, key, false, this.recurrenceOptions());
      const currentValues = {
        title: current.title,
        start: current.startDefinition,
        durationMinutes: current.durationMinutes,
        notes: current.notes,
        priority: current.priority,
        categoryId: current.categoryId,
        reminders: current.reminders,
      };
      const patch = {};
      for (const name of EDIT_FIELDS) {
        if (!same(fields[name], currentValues[name])) patch[name] = fields[name];
      }
      const ruleChanged = !same(normalizeRule(old.recurrence), recurrence);
      if (ruleChanged) {
        if (scope === 'this') {
          throw new Error('The repeat pattern can only be changed for "This and following" or "All occurrences".');
        }
        patch.recurrence = recurrence;
      }
      if (Object.keys(patch).length === 0) return { ok: true, taskId: old.id, unchanged: true };
      ({ updated, created } = editTask(old, scope, key, patch, { newId: this.newId(), ...this.recurrenceOptions() }));
    }

    this.checkDependencies(updated);
    this.data.tasks = this.data.tasks.map((t) => (t.id === updated.id ? updated : t));
    if (created) this.data.tasks.push(created);
    this.changed();
    return { ok: true, taskId: updated.id };
  }

  // Does this delete remove the whole task (so tasks that follow it lose it)?
  deletesWholeTask(task, scope, key) {
    if (!task.recurrence || scope === 'all') return true;
    return scope === 'following' && key <= normalizeRule(task.recurrence).startDate;
  }

  // Tasks that start relative to this one, and whether this delete removes it completely.
  getDeleteImpact({ taskId, dateKey: key, scope }) {
    const task = this.findTask(taskId);
    return {
      wholeTask: this.deletesWholeTask(task, scope || 'all', key),
      dependents: findDependents(this.data.tasks, taskId).map((t) => ({ taskId: t.id, title: t.title })),
    };
  }

  deleteTask({ taskId, dateKey: key, scope }) {
    const task = this.findTask(taskId);
    const result = deleteOccurrences(task, scope || 'all', key, this.recurrenceOptions());
    let frozen = [];
    if (result === null) {
      // Tasks that followed it keep the times they have now.
      ({ tasks: this.data.tasks, frozen } = freezeDependents(this.provider(), this.data.tasks, taskId, key, this.recurrenceOptions()));
    } else {
      this.data.tasks = this.data.tasks.map((t) => (t.id === taskId ? result : t));
    }
    this.changed();
    return { ok: true, frozen };
  }

  checkDependencies(task) {
    const problem = dependencyProblem(this.data.tasks, task);
    if (problem) throw new Error(problem);
  }

  // The tasks a new or edited task can follow: everything except itself and the tasks that follow it.
  getReferenceChoices({ taskId }) {
    const describe = (def) => {
      if (def.mode === 'fixed') {
        const [h, m] = def.time.split(':').map(Number);
        return formatTime12(new Date(2000, 0, 1, h, m));
      }
      if (def.mode === 'prayer') {
        const name = def.prayer.charAt(0).toUpperCase() + def.prayer.slice(1);
        return `${def.minutes} min ${def.direction} ${name}`;
      }
      return 'follows another task';
    };
    return this.data.tasks
      .filter((t) => t.id !== taskId && !(taskId && followsTransitively(this.data.tasks, t.id, taskId)))
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        label: `${t.title} (${describe(t.start)}, ${formatDuration(t.durationMinutes)}${t.recurrence ? ', repeats' : ''})`,
      }));
  }

  setDone({ taskId, dateKey: key, done }) {
    const task = this.findTask(taskId);
    const updated = setCompletion(task, key, Boolean(done), this.now());
    this.data.tasks = this.data.tasks.map((t) => (t.id === taskId ? updated : t));
    this.changed();
    return { ok: true };
  }

  duplicateTask({ taskId }) {
    const old = this.findTask(taskId);
    const task = createTask({
      id: this.newId(),
      title: `${old.title} (copy)`,
      start: copy(old.start),
      durationMinutes: old.durationMinutes,
      date: old.date,
      recurrence: old.recurrence ? copy(old.recurrence) : null,
      reminders: copy(old.reminders),
      priority: old.priority,
      categoryId: old.categoryId,
      notes: old.notes,
    });
    this.data.tasks.push(task);
    this.changed();
    return { ok: true, taskId: task.id };
  }

  // ---- settings and categories ---------------------------------------------------------------------------------

  getSettings() {
    return copy(this.settings);
  }

  saveSettings(patch) {
    const previous = this.data.settings;
    const merged = mergeSettings(previous, patch);
    // Turning the "still running in the background" message back on shows it again at the next close.
    if (patch.showBackgroundMessage === true && !previous.showBackgroundMessage) merged.backgroundMessageShown = false;
    this.data.settings = merged;
    this.providerCache = null;
    this.persist();
    this.onSettingsChanged(copy(this.data.settings));
    this.onDataChanged();
    return copy(this.data.settings);
  }

  validateCategory({ name, color }, ignoreId) {
    const clean = String(name || '').trim();
    if (clean === '') throw new Error('Please enter a category name.');
    if (clean.length > 40) throw new Error('Category names can be up to 40 characters.');
    if (this.data.categories.some((c) => c.id !== ignoreId && c.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error('There is already a category with that name.');
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(color || '')) throw new Error('Please choose a color.');
    return { name: clean, color };
  }

  addCategory(input) {
    const clean = this.validateCategory(input);
    const category = { id: `cat-${this.newId()}`, ...clean };
    this.data.categories.push(category);
    this.changed();
    return copy(this.data.categories);
  }

  updateCategory({ id, name, color }) {
    const category = this.categoryOf(id);
    if (!category) throw new Error('That category no longer exists.');
    Object.assign(category, this.validateCategory({ name, color }, id));
    this.changed();
    return copy(this.data.categories);
  }

  // Deleting a category never deletes tasks: they simply become uncategorized.
  deleteCategory({ id }) {
    this.data.categories = this.data.categories.filter((c) => c.id !== id);
    for (const task of this.data.tasks) {
      if (task.categoryId === id) task.categoryId = null;
      for (const key of Object.keys(task.overrides)) {
        if (task.overrides[key].categoryId === id) task.overrides[key].categoryId = null;
      }
    }
    this.changed();
    return copy(this.data.categories);
  }

  // ---- export / import --------------------------------------------------------------------------------------------

  exportData() {
    return buildExport(this.data, this.now());
  }

  // Replaces tasks, categories and settings with the contents of a backup.
  importData(input) {
    const { data, warnings } = parseImport(input);
    this.data = { ...data, reminderState: this.data.reminderState };
    this.providerCache = null;
    this.persist();
    this.onSettingsChanged(copy(this.data.settings));
    this.onDataChanged();
    return { ok: true, tasks: data.tasks.length, categories: data.categories.length, warnings };
  }

  // ---- used by the background reminder engine (main process) ------------------------------------------------------------

  getTasks() {
    return this.data.tasks;
  }

  getReminderSettings() {
    return this.data.settings;
  }

  updateTaskFromEngine(task) {
    this.data.tasks = this.data.tasks.map((t) => (t.id === task.id ? task : t));
    this.changed();
  }

  getReminderState() {
    return this.data.reminderState;
  }

  saveReminderState(state) {
    this.data.reminderState = state;
    this.persist();
  }
}

// The names the window is allowed to call.
const PUBLIC_METHODS = [
  'bootstrap', 'getDay', 'getStats', 'getUpcoming', 'getMissed', 'dismissMissed', 'clearMissed', 'newTaskDefaults', 'getTaskForEdit', 'previewForm', 'saveTask',
  'getReferenceChoices', 'getDeleteImpact', 'getAlertPreset', 'deleteTask', 'setDone', 'duplicateTask', 'getSettings', 'saveSettings', 'addCategory', 'updateCategory',
  'deleteCategory',
];

module.exports = { PlannerService, PUBLIC_METHODS, defaultProviderFactory };
