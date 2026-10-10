'use strict';

// Statistics: every number and chart on the Statistics screen, worked out from the tasks.
//
// What counts: a task occurrence is "counted" once it is done OR its end time has passed. A task that is
// still to come today is not counted, so "78% done" never includes things that were never due yet.
// Occurrences are filed under the Planning Day (and zone) that contains their START, like the Daily View.
// Numbers are worked out from the tasks as they are NOW: editing or deleting a task changes its history.
//
// computeStats(...) returns plain data (text, numbers, lists) for the window to draw.

const {
  addDaysToKey, keyToDayNumber, weekdayOfKey, splitKey, makeKey, daysInMonth,
  formatKeyShort, formatDuration, formatTime12, isValidKey,
} = require('./time');
const { deriveZone, currentPlanningDayKey, ZONE_NAMES } = require('./zones');
const { getOccurrences } = require('./tasks');

const RANGES = ['day', 'week', 'month', 'year', 'custom'];
const STREAK_GOAL = 70; // a day counts for the streak when at least this much of it is done
const MAX_HISTORY_DAYS = 3 * 366;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const ZONE_SHORT = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const NO_CATEGORY = { name: 'No category', color: '#8ca0b5' };
const NOUN = { day: 'yesterday', week: 'last week', month: 'last month', year: 'last year', custom: 'the previous period' };
const LATE_LIMIT = 200;

// ---- date helpers (calendar keys, no time zones involved) ---------------------------------------

const daysBetween = (a, b) => keyToDayNumber(b) - keyToDayNumber(a);
const monthStartKey = (key) => { const { y, m } = splitKey(key); return makeKey(y, m, 1); };
const monthEndKey = (key) => { const { y, m } = splitKey(key); return makeKey(y, m, daysInMonth(y, m)); };
function shiftMonth(key, n) {
  const { y, m } = splitKey(key);
  const index = y * 12 + (m - 1) + n;
  return makeKey(Math.floor(index / 12), (index % 12) + 1, 1);
}
function eachDay(from, to, fn) {
  for (let k = from; k <= to; k = addDaysToKey(k, 1)) fn(k);
}

// ---- the selected range -----------------------------------------------------------------------

// query: { range, anchorKey, fromKey, toKey }. Returns the dates of the range and of the one before it.
function resolveRange(query, todayKey, weekStart = 0) {
  const q = query || {};
  const range = RANGES.includes(q.range) ? q.range : 'week';
  let anchor = isValidKey(q.anchorKey) ? q.anchorKey : todayKey;
  if (anchor > todayKey) anchor = todayKey;
  let start;
  let end;
  let prevStart;
  let prevEnd;
  if (range === 'day') {
    start = anchor; end = anchor;
    prevStart = addDaysToKey(anchor, -1); prevEnd = prevStart;
  } else if (range === 'week') {
    start = addDaysToKey(anchor, -((weekdayOfKey(anchor) - weekStart + 7) % 7)); end = addDaysToKey(start, 6);
    prevStart = addDaysToKey(start, -7); prevEnd = addDaysToKey(start, -1);
  } else if (range === 'month') {
    start = monthStartKey(anchor); end = monthEndKey(anchor);
    prevStart = shiftMonth(start, -1); prevEnd = monthEndKey(prevStart);
  } else if (range === 'year') {
    const { y } = splitKey(anchor);
    start = makeKey(y, 1, 1); end = makeKey(y, 12, 31);
    prevStart = makeKey(y - 1, 1, 1); prevEnd = makeKey(y - 1, 12, 31);
  } else {
    let from = isValidKey(q.fromKey) ? q.fromKey : addDaysToKey(todayKey, -29);
    let to = isValidKey(q.toKey) ? q.toKey : todayKey;
    if (from > to) [from, to] = [to, from];
    to = to > todayKey ? todayKey : to;
    from = from > to ? to : from;
    start = from; end = to;
    const length = daysBetween(from, to) + 1;
    prevStart = addDaysToKey(from, -length); prevEnd = addDaysToKey(from, -1);
  }
  const dataEnd = end > todayKey ? todayKey : end; // days that have not come yet have no numbers
  const span = daysBetween(start, dataEnd) + 1;
  // The earlier period is cut to the same number of days (this week so far vs the first days of last week).
  let prevDataEnd = addDaysToKey(prevStart, span - 1);
  if (prevDataEnd > prevEnd) prevDataEnd = prevEnd;
  return { range, anchor: range === 'custom' ? dataEnd : anchor, start, end, dataEnd, span, prevStart, prevEnd, prevDataEnd };
}

function rangeLabel(r, todayKey) {
  const soFar = r.end > todayKey ? ' · so far' : '';
  const dayName = (k) => WEEKDAYS[weekdayOfKey(k)];
  if (r.range === 'day') return `${dayName(r.start)}, ${formatKeyShort(r.start, true)}${r.start === todayKey ? ' · today' : ''}`;
  if (r.range === 'week') return `${dayName(r.start)} ${formatKeyShort(r.start)} – ${dayName(r.end)} ${formatKeyShort(r.end, true)}${soFar}`;
  if (r.range === 'month') return `${MONTHS[splitKey(r.start).m - 1]} ${splitKey(r.start).y}${soFar}`;
  if (r.range === 'year') return `${splitKey(r.start).y}${soFar}`;
  return `${formatKeyShort(r.start, true)} – ${formatKeyShort(r.end, true)}`;
}

// The queries behind the "previous" and "next" buttons (null when there is nothing to go to).
function neighbours(r, todayKey, earliestKey) {
  if (r.range === 'custom') {
    const length = daysBetween(r.start, r.end) + 1;
    const back = r.prevEnd >= earliestKey ? { range: 'custom', fromKey: r.prevStart, toKey: r.prevEnd } : null;
    const forwardFrom = addDaysToKey(r.start, length);
    const forward = forwardFrom <= todayKey
      ? { range: 'custom', fromKey: forwardFrom, toKey: addDaysToKey(forwardFrom, length - 1) > todayKey ? todayKey : addDaysToKey(forwardFrom, length - 1) }
      : null;
    return { prev: back, next: forward };
  }
  const nextAnchor = addDaysToKey(r.end, 1);
  return {
    prev: r.prevEnd >= earliestKey ? { range: r.range, anchorKey: r.prevEnd } : null,
    next: nextAnchor <= todayKey ? { range: r.range, anchorKey: nextAnchor } : null,
  };
}

// ---- gathering the counted occurrences ---------------------------------------------------------

// The first day anything is planned (never more than about 3 years back).
function earliestDay(tasks, todayKey) {
  let earliest = todayKey;
  for (const t of tasks) {
    const candidates = [];
    if (t.date) candidates.push(t.date);
    if (t.recurrence && t.recurrence.startDate) candidates.push(t.recurrence.startDate);
    if (t.additions && t.additions.length) candidates.push(t.additions[0]);
    for (const k of candidates) if (isValidKey(k) && k < earliest) earliest = k;
  }
  const limit = addDaysToKey(todayKey, -MAX_HISTORY_DAYS);
  return earliest < limit ? limit : earliest;
}

// Map: Planning Day key -> counted occurrences. Done or past-due only.
function collectDays(provider, tasks, options, fromKey, toKey, nowMs) {
  const memo = new Map();
  const cached = (key) => {
    let value = memo.get(key);
    if (!value) { value = provider(key); memo.set(key, value); }
    return value;
  };
  const days = new Map();
  const lo = addDaysToKey(fromKey, -2);
  const hi = addDaysToKey(toKey, 2);
  const context = { ...options, tasks };
  for (const task of tasks) {
    for (const o of getOccurrences(cached, task, lo, hi, context)) {
      if (!o.done && o.end.getTime() > nowMs) continue;
      const placed = deriveZone(cached, o.start);
      const key = placed.planningDayKey;
      if (key < fromKey || key > toKey) continue;
      if (!days.has(key)) days.set(key, []);
      days.get(key).push({
        taskId: o.taskId, dateKey: o.dateKey, key, title: o.title, categoryId: o.categoryId, minutes: o.durationMinutes,
        done: o.done, startMs: o.start.getTime(), zone: placed.zoneIndex,
      });
    }
  }
  return days;
}

// ---- small calculations ---------------------------------------------------------------------

function totals(list) {
  let done = 0;
  let minutes = 0;
  for (const e of list) { if (e.done) done++; minutes += e.minutes; }
  return { total: list.length, done, minutes };
}
const percentOf = (t) => (t.total ? Math.round((t.done / t.total) * 100) : null);

// ---- the whole picture ------------------------------------------------------------------------

// args: { provider, tasks, categories, options, now, query }
function computeStats({ provider, tasks, categories, options, now, query, weekStart = 0 }) {
  const nowMs = now.getTime();
  const todayKey = currentPlanningDayKey(provider, now);
  const earliestKey = earliestDay(tasks, todayKey);
  const r = resolveRange(query, todayKey, weekStart);
  const days = collectDays(provider, tasks, options || {}, earliestKey < r.prevStart ? earliestKey : r.prevStart, todayKey, nowMs);

  const listFor = (from, to) => {
    const out = [];
    if (to < from) return out;
    eachDay(from, to, (k) => { const l = days.get(k); if (l) out.push(...l); });
    return out;
  };
  const statOf = (key) => totals(days.get(key) || []);
  const pctAt = (key) => (key > todayKey ? null : percentOf(statOf(key)));
  const nearby = neighbours(r, todayKey, earliestKey);

  const inRange = listFor(r.start, r.dataEnd);
  const cur = totals(inRange);
  const before = totals(listFor(r.prevStart, r.prevDataEnd));
  const noun = NOUN[r.range];

  // ---- streak (always as of today) ----
  let current = 0;
  let best = 0;
  let run = 0;
  eachDay(earliestKey, todayKey, (k) => {
    const t = statOf(k);
    if (t.total === 0) return; // a day without counted tasks neither adds nor breaks
    if (percentOf(t) >= STREAK_GOAL) { run++; if (run > best) best = run; } else run = 0;
  });
  for (let k = todayKey; k >= earliestKey; k = addDaysToKey(k, -1)) {
    const t = statOf(k);
    if (t.total === 0) continue;
    if (percentOf(t) >= STREAK_GOAL) current++;
    else if (k !== todayKey) break; // today may still be in progress, so it never breaks the streak
  }

  // ---- key figures ----
  const pctNow = percentOf(cur);
  const pctBefore = percentOf(before);
  const kpis = [
    {
      id: 'rate', label: 'Completion rate', value: pctNow === null ? '–' : String(pctNow), unit: '%',
      delta: pctBefore === null || pctNow === null ? { text: 'No earlier data', tone: 'none' }
        : pctNow === pctBefore ? { text: `Same as ${noun}`, tone: 'flat' }
          : { text: `${pctNow > pctBefore ? '▲' : '▼'} ${Math.abs(pctNow - pctBefore)} pts vs ${noun}`, tone: pctNow > pctBefore ? 'up' : 'down' },
    },
    {
      id: 'done', label: 'Tasks done', value: String(cur.done), unit: `of ${cur.total}`,
      delta: before.total === 0 ? { text: 'No earlier data', tone: 'none' }
        : cur.done === before.done ? { text: `Same as ${noun}`, tone: 'flat' }
          : {
            text: `${cur.done > before.done ? '▲' : '▼'} ${Math.abs(cur.done - before.done)} ${cur.done > before.done ? 'more' : 'fewer'} than ${noun}`,
            tone: cur.done > before.done ? 'up' : 'down',
          },
    },
    { id: 'streak', label: 'Current streak · as of today', value: String(current), unit: current === 1 ? 'day' : 'days', delta: { text: `Best: ${best} ${best === 1 ? 'day' : 'days'}`, tone: 'none' } },
    {
      id: 'time', label: 'Planned time', value: formatDuration(cur.minutes), unit: '',
      delta: before.total === 0 ? { text: 'No earlier data', tone: 'none' }
        : cur.minutes === before.minutes ? { text: `Same as ${noun}`, tone: 'flat' }
          : { text: `${cur.minutes > before.minutes ? '▲' : '▼'} ${formatDuration(Math.abs(cur.minutes - before.minutes))} vs ${noun}`, tone: 'flat' },
    },
  ];

  // ---- done vs planned bars ----
  let unit;
  if (r.range === 'day') unit = 'zone';
  else if (r.range === 'week' || r.range === 'month') unit = 'day';
  else if (r.range === 'year') unit = 'month';
  else unit = r.span <= 14 ? 'day' : r.span <= 100 ? 'week' : 'month';
  const items = [];
  const bucket = (label, title, list, future) => {
    const t = totals(list);
    items.push({ label, title, done: t.done, total: t.total, pct: percentOf(t), future: Boolean(future) });
  };
  if (unit === 'zone') {
    ZONE_SHORT.forEach((name, i) => bucket(name, ZONE_NAMES[i], inRange.filter((e) => e.zone === i + 1)));
  } else if (unit === 'day') {
    const dayNumbers = r.range === 'month' || r.range === 'custom';
    eachDay(r.start, r.dataEnd, (k) => bucket(dayNumbers ? String(splitKey(k).d) : WEEKDAYS[weekdayOfKey(k)], `${WEEKDAYS[weekdayOfKey(k)]} ${formatKeyShort(k)}`, days.get(k) || []));
  } else if (unit === 'week') {
    for (let k = r.start; k <= r.dataEnd; k = addDaysToKey(k, 7)) {
      const to = addDaysToKey(k, 6) > r.dataEnd ? r.dataEnd : addDaysToKey(k, 6);
      bucket(formatKeyShort(k), `Week of ${formatKeyShort(k)}`, listFor(k, to));
    }
  } else {
    const lastMonth = r.range === 'year' ? r.end : r.dataEnd;
    for (let m = monthStartKey(r.start); m <= lastMonth; m = shiftMonth(m, 1)) {
      const to = monthEndKey(m) > r.dataEnd ? r.dataEnd : monthEndKey(m);
      bucket(MONTHS_SHORT[splitKey(m).m - 1], `${MONTHS[splitKey(m).m - 1]} ${splitKey(m).y}`, m > r.dataEnd ? [] : listFor(m, to), m > r.dataEnd);
    }
  }
  const bars = {
    title: 'Done vs planned',
    sub: unit === 'zone' ? 'Each bar is one zone of the day' : `Each bar is one ${unit}`,
    unit, items, maxTotal: Math.max(1, ...items.map((i) => i.total)),
  };

  // ---- by zone, by category ----
  const zones = ZONE_NAMES.map((name, i) => {
    const t = totals(inRange.filter((e) => e.zone === i + 1));
    return { index: i + 1, name, done: t.done, total: t.total, pct: t.total ? Math.round((t.done / t.total) * 100) : 0 };
  });
  const catById = new Map((categories || []).map((c) => [c.id, c]));
  const groups = new Map();
  for (const e of inRange) {
    const key = catById.has(e.categoryId) ? e.categoryId : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const categoryRows = Array.from(groups.entries()).map(([id, list]) => {
    const c = id ? catById.get(id) : NO_CATEGORY;
    const t = totals(list);
    return { id, name: c.name, color: c.color, done: t.done, total: t.total, pct: Math.round((t.done / t.total) * 100), minutes: t.minutes, timeLabel: formatDuration(t.minutes) };
  }).sort((a, b) => b.minutes - a.minutes);

  // ---- needs attention ----
  const lateAll = inRange.filter((e) => !e.done);
  lateAll.sort((a, b) => (r.range === 'year' || r.range === 'custom' ? a.startMs - b.startMs : b.startMs - a.startMs));
  const late = {
    total: lateAll.length,
    items: lateAll.slice(0, LATE_LIMIT).map((e) => {
      const ago = daysBetween(e.key, todayKey);
      const started = new Date(e.startMs);
      return {
        taskId: e.taskId, dateKey: e.dateKey, title: e.title, zoneName: ZONE_NAMES[e.zone - 1],
        whenLabel: `${WEEKDAYS[weekdayOfKey(e.key)]} ${formatKeyShort(e.key)} · ${formatTime12(started)}`,
        ageLabel: ago <= 0 ? 'Today' : ago === 1 ? '1 day late' : `${ago} days late`,
      };
    }),
  };

  // ---- heat map ----
  const heatYearMode = r.range === 'year' || (r.range === 'custom' && r.span > 62);
  const highlight = r.range !== 'month' && r.range !== 'year' && r.span < 28;
  const heatDay = (k) => {
    const t = statOf(k);
    return { key: k, day: splitKey(k).d, pct: k > todayKey ? null : percentOf(t), total: t.total, done: t.done, future: k > todayKey, inRange: highlight && k >= r.start && k <= r.dataEnd };
  };
  let heat;
  if (heatYearMode) {
    const year = splitKey(r.dataEnd).y;
    const first = makeKey(year, 1, 1);
    const list = [];
    eachDay(first, makeKey(year, 12, 31), (k) => list.push(heatDay(k)));
    heat = { mode: 'year', title: `${year} at a glance`, firstWeekday: (weekdayOfKey(first) - weekStart + 7) % 7, weekStart, days: list };
  } else {
    const anchorMonth = r.range === 'custom' ? r.dataEnd : r.anchor;
    const first = monthStartKey(anchorMonth);
    const list = [];
    eachDay(first, monthEndKey(first), (k) => list.push(heatDay(k)));
    heat = { mode: 'month', title: `${MONTHS[splitKey(first).m - 1]} ${splitKey(first).y} at a glance`, firstWeekday: (weekdayOfKey(first) - weekStart + 7) % 7, weekStart, days: list };
  }

  // ---- completion trend: what the line shows depends on the range ----
  const point = (label, title, value) => ({ label, title: value === null ? title : `${title}: ${value}%`, value });
  let points = [];
  let compare = null;
  let thin = null;
  let legend = [];
  let sub = '';
  const dayPoint = (k) => point(WEEKDAYS[weekdayOfKey(k)], formatKeyShort(k), pctAt(k));
  if (r.range === 'day') {
    for (let i = 6; i >= 0; i--) points.push(dayPoint(addDaysToKey(r.start, -i)));
    sub = `The 7 days ending ${formatKeyShort(r.start)}`;
  } else if (r.range === 'week') {
    for (let i = 0; i < 7; i++) points.push(dayPoint(addDaysToKey(r.start, i)));
    compare = [];
    for (let i = 0; i < 7; i++) compare.push(pctAt(addDaysToKey(r.prevStart, i)));
    legend = [{ label: 'This week', style: 'solid' }, { label: 'Last week', style: 'dashed' }];
    sub = 'Each day of this week, against the same days last week';
  } else if (r.range === 'month' || (r.range === 'custom' && r.span <= 31)) {
    const average = r.range === 'month';
    thin = [];
    eachDay(r.start, r.dataEnd, (k) => {
      const dayNumber = splitKey(k).d;
      const label = average ? (dayNumber % 5 === 0 || dayNumber === 1 ? String(dayNumber) : '') : (r.span <= 12 || dayNumber % 5 === 0 ? String(dayNumber) : '');
      if (average) {
        const t = totals(listFor(addDaysToKey(k, -6) < earliestKey ? earliestKey : addDaysToKey(k, -6), k));
        thin.push(pctAt(k));
        points.push(point(label, formatKeyShort(k), percentOf(t)));
      } else {
        points.push(point(label, formatKeyShort(k), pctAt(k)));
      }
    });
    if (average) {
      legend = [{ label: 'Daily', style: 'faint' }, { label: '7-day average', style: 'solid' }];
      sub = 'Every day this month, and a 7-day average that smooths the bumps';
    } else {
      thin = null;
      sub = `Day by day, ${formatKeyShort(r.start)} – ${formatKeyShort(r.dataEnd)}`;
    }
  } else if (r.range === 'custom' && r.span <= 120) {
    for (let k = r.start; k <= r.dataEnd; k = addDaysToKey(k, 7)) {
      const to = addDaysToKey(k, 6) > r.dataEnd ? r.dataEnd : addDaysToKey(k, 6);
      points.push(point(formatKeyShort(k), `Week of ${formatKeyShort(k)}`, percentOf(totals(listFor(k, to)))));
    }
    sub = `Week by week, ${formatKeyShort(r.start)} – ${formatKeyShort(r.dataEnd)}`;
  } else {
    for (let m = monthStartKey(r.start); m <= r.dataEnd; m = shiftMonth(m, 1)) {
      const to = monthEndKey(m) > r.dataEnd ? r.dataEnd : monthEndKey(m);
      const from = m < r.start ? r.start : m;
      points.push(point(MONTHS_SHORT[splitKey(m).m - 1], `${MONTHS[splitKey(m).m - 1]} ${splitKey(m).y}`, percentOf(totals(listFor(from, to)))));
    }
    sub = r.range === 'year' ? 'Share of planned tasks done, month by month' : `Month by month, ${formatKeyShort(r.start)} – ${formatKeyShort(r.dataEnd)}`;
  }
  const known = points.filter((p) => p.value !== null).length;
  const trend = { sub, points, compare, thin, legend, ok: known >= 3 };

  return {
    range: r.range,
    rangeLabel: rangeLabel(r, todayKey),
    rangeStartKey: r.start,
    rangeEndKey: r.dataEnd,
    anchorKey: r.anchor,
    todayKey,
    earliestKey,
    prevQuery: nearby.prev,
    nextQuery: nearby.next,
    kpis, bars, zones, categories: categoryRows, late, heat, trend,
    empty: days.size === 0,
  };
}

module.exports = { RANGES, STREAK_GOAL, resolveRange, rangeLabel, neighbours, earliestDay, collectDays, computeStats };
