'use strict';

// WaqtWise - main screen logic (Daily View, navigation, bell, menu).

(function () {
  const WW = (window.WW = window.WW || {});
  const { h, clear } = WW;

  WW.state = { settings: null, categories: [], cities: [], methods: [], dayKey: null, view: 'daily', day: null };

  const view = () => document.getElementById('view');
  const anyDialogOpen = () => document.querySelector('.overlay') !== null;

  // The page follows the saved choice; "system" leaves it to the Windows setting (see styles.css).
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function effectiveTheme() {
    const saved = WW.state.settings && WW.state.settings.theme;
    if (saved === 'light' || saved === 'dark') return saved;
    return darkQuery && darkQuery.matches ? 'dark' : 'light';
  }

  function updateThemeButton() {
    const button = document.getElementById('theme-btn');
    if (!button) return;
    const dark = effectiveTheme() === 'dark';
    const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
    clear(button).appendChild(WW.icon(dark ? 'sun' : 'moon'));
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  WW.applyTheme = function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    updateThemeButton();
  };

  async function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    try {
      WW.state.settings = await WW.call('saveSettings', { theme: next });
      WW.applyTheme(WW.state.settings.theme);
      if (WW.state.view === 'settings') WW.renderSettings();
    } catch (error) {
      WW.toast(error.message, 'error');
    }
  }

  // ---- Daily View ---------------------------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // A ring showing "pct" percent. Built with SVG elements (no markup from data).
  function donut(size, radius, stroke, pct, color, numberSize) {
    const c = 2 * Math.PI * radius;
    const mid = size / 2;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('aria-hidden', 'true');
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', `rotate(-90 ${mid} ${mid})`);
    [['var(--border)', c], [color, (c * pct) / 100]].forEach(([stroke_color, dash]) => {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(mid));
      circle.setAttribute('cy', String(mid));
      circle.setAttribute('r', String(radius));
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', stroke_color);
      circle.setAttribute('stroke-width', String(stroke));
      circle.setAttribute('stroke-dasharray', `${dash} ${c}`);
      g.appendChild(circle);
    });
    svg.appendChild(g);
    return h('div', { class: 'donut', style: { width: `${size}px`, height: `${size}px` } },
      svg, h('div', { class: 'donut-num', style: { fontSize: `${numberSize}px` }, text: `${pct}%` }));
  }

  const percent = (done, total) => (total ? Math.round((done / total) * 100) : 0);

  function taskRow(t) {
    const tags = [];
    if (t.categoryName) {
      tags.push(h('span', { class: 'tag pill' }, h('span', { class: 'dot', style: { background: t.categoryColor } }), t.categoryName));
    }
    if (t.overdue) tags.push(h('span', { class: 'tag late', text: 'Not done' }));
    if (t.inProgress) tags.push(h('span', { class: 'tag live', text: 'In progress' }));
    if (t.overlaps) {
      const names = (t.conflictWith || []).map((n) => `“${n}”`).join(', ');
      tags.push(h('span', { class: 'tag warn conflict', title: 'Overlaps another task' },
        WW.icon('warn', 13, 2.6), names ? `Conflict with ${names}` : 'Conflict'));
    }
    if (t.startWarning) tags.push(h('span', { class: 'tag warn', title: t.startWarning, text: '⚠ Backup start time' }));
    if (t.extendsPastZoneEnd) tags.push(h('span', { class: 'tag', title: 'Continues into the next zone', text: '→ Continues into next zone' }));

    const check = h('button', {
      class: `check ${t.done ? 'on' : ''}`, type: 'button',
      'aria-label': t.done ? `Mark "${t.title}" as not done` : `Mark "${t.title}" as done`, 'aria-pressed': String(t.done),
      onclick: async (event) => {
        event.stopPropagation();
        try {
          await WW.call('setDone', { taskId: t.taskId, dateKey: t.dateKey, done: !t.done });
          // A small sound when a task becomes done (not when the tick is taken back).
          if (!t.done && WW.state.settings) WW.sounds.play(WW.state.settings.doneSound, WW.state.settings.doneSoundVolume);
          WW.afterChange();
        } catch (error) {
          WW.toast(error.message, 'error');
        }
      },
    }, WW.icon('check', 15, 3.4));

    return h('div', {
      class: `task ${t.done ? 'done' : ''} ${t.overdue ? 'overdue' : ''} ${t.inProgress ? 'live' : ''}`, role: 'button', tabindex: '0',
      'aria-label': `${t.title}, ${t.startLabel}`,
      onclick: () => WW.openTaskForm({ mode: 'edit', taskId: t.taskId, dateKey: t.dateKey }),
      onkeydown: (e) => { if (e.key === 'Enter') WW.openTaskForm({ mode: 'edit', taskId: t.taskId, dateKey: t.dateKey }); },
    },
      check,
      h('div', { class: 'task-time' }, t.startLabel, t.afterMidnight ? h('small', { text: 'next day' }) : null),
      h('div', { class: 'task-main' },
        h('div', { class: 'task-title', text: t.title }),
        tags.length ? h('div', { class: 'task-meta' }, tags) : null),
      h('div', { class: 'task-duration', text: t.durationLabel }),
      h('span', { class: `prio ${t.priority}`, title: `${t.priority} priority` }));
  }

  function zoneSection(z) {
    const fill = h('div', { class: 'timeline-fill' });
    // Square, touching pieces: back-to-back tasks look like one continuous band.
    z.segments.forEach((s) =>
      fill.appendChild(h('div', {
        class: `seg ${s.done ? 'done' : ''}`,
        title: s.title,
        // Each task piece takes its category's color (the zone color when it has no category).
        style: Object.assign({ left: `${s.leftPct}%`, width: `${s.widthPct}%` }, s.color ? { background: s.color } : {}),
      })));
    const timeline = h('div', { class: 'timeline' }, fill);
    z.confSegs.forEach((c) =>
      timeline.appendChild(h('div', { class: 'conflict-seg', title: c.title, style: { left: `${c.leftPct}%`, width: `${c.widthPct}%` } })));
    if (z.nowPct !== null) timeline.appendChild(h('div', { class: 'now', style: { left: `${z.nowPct}%` }, title: 'Now' }));

    const body = h('div', { class: 'zone-body' });
    z.continued.forEach((c) =>
      body.appendChild(h('div', {
        class: 'continues', text: `↳ Continues from “${c.title}” (${c.minutesLabel} here, until ${c.endLabel})`,
        onclick: () => WW.openTaskForm({ mode: 'edit', taskId: c.taskId, dateKey: c.dateKey }),
      })));
    if (z.tasks.length === 0 && z.continued.length === 0) {
      body.appendChild(h('div', { class: 'empty-zone', text: 'No tasks in this zone yet.' }));
    }
    z.tasks.forEach((t) => body.appendChild(taskRow(t)));

    const pct = percent(z.doneCount, z.taskCount);
    const conflictText = z.conflictCount === 1 ? '1 conflict' : `${z.conflictCount} conflicts`;

    return h('section', { class: `zone z${z.index} ${z.isCurrent ? 'current' : ''}`, 'aria-label': z.name },
      h('div', { class: 'zone-band' },
        h('div', { class: 'zone-band-left' },
          WW.zoneIcon(z.index, 26),
          h('h2', { class: 'zone-name' }, z.name),
          z.isCurrent ? h('span', { class: 'band-chip now-chip', text: 'NOW' }) : null,
          z.conflictCount ? h('span', { class: 'band-chip conflict-chip' }, WW.icon('warn', 13, 2.6), conflictText) : null),
        h('span', { class: 'zone-range', text: `${z.startLabel} – ${z.endLabel}` })),
      h('div', { class: 'zone-summary' },
        h('div', { class: 'zone-summary-main' },
          h('div', { class: 'zone-times' }, h('span', { text: z.startLabel }), timeline, h('span', { text: z.endLabel })),
          h('div', { class: 'zone-figures' },
            h('span', { class: 'fig' }, 'Total ', h('b', { text: z.totalLabel })),
            h('span', { class: 'fig' }, 'Scheduled ', h('b', { text: z.scheduledLabel })),
            h('span', { class: 'fig free' }, 'Free ', h('b', { text: z.freeLabel })))),
        h('div', { class: 'zone-done', role: 'img', 'aria-label': `${pct}% done: ${z.doneCount} of ${z.taskCount} tasks` },
          donut(76, 30, 8, pct, 'var(--zf)', 16),
          h('div', {},
            h('div', { class: 'stat-label', text: 'Completed' }),
            h('div', { class: 'stat-value' }, `${z.doneCount} of ${z.taskCount}`)))),
      body);
  }

  function heroCard(day) {
    const cur = day.currentZone;
    const pct = percent(day.doneCount, day.taskCount);
    const title = cur ? cur.name : day.isCurrentDay ? 'Between zones' : 'Day overview';
    const sub = cur
      ? [h('b', { text: cur.timeLeftLabel }), cur.nextName ? ` until ${cur.nextName.split(' → ')[0]} · ` : ' left · ', `${cur.freeLabel} free in this zone`]
      : [`${day.taskCount} task${day.taskCount === 1 ? '' : 's'} planned for this day`];

    const bars = h('div', { class: 'strip-bars' });
    const labels = h('div', { class: 'strip-labels' });
    day.zones.forEach((z) => {
      const grow = `${z.minutes} 1 0`;
      const dim = day.isCurrentDay && !z.isCurrent ? 0.45 : 1;
      bars.appendChild(h('div', { class: `z${z.index}`, style: { flex: grow, opacity: String(dim) }, title: `${z.name} · ${z.startLabel} – ${z.endLabel}` }));
      labels.appendChild(h('div', { style: { flex: grow }, text: z.name.split(' → ')[0] }));
    });
    const strip = h('div', { class: 'day-strip' }, bars);
    if (day.dayNowPct !== null) strip.appendChild(h('div', { class: 'strip-now', style: { left: `${day.dayNowPct}%` }, title: 'Now' }));
    strip.appendChild(labels);

    return h('section', { class: 'hero', 'aria-label': 'Right now' },
      h('div', { class: 'hero-top' },
        h('div', {},
          h('div', { class: 'hero-eyebrow', text: cur ? 'RIGHT NOW' : day.isCurrentDay ? 'TODAY' : 'OVERVIEW' }),
          h('div', { class: 'hero-title', text: title }),
          h('div', { class: 'hero-sub' }, sub)),
        h('div', { class: 'hero-cards' },
          h('div', { class: 'stat-card', role: 'img', 'aria-label': `Done ${day.doneCount} of ${day.taskCount} tasks (${pct}%)` },
            donut(64, 25, 7, pct, 'var(--accent)', 14),
            h('div', {},
              h('div', { class: 'stat-label', text: day.isCurrentDay ? 'Done today' : 'Done' }),
              h('div', { class: 'stat-value' }, `${day.doneCount} `, h('small', { text: `/ ${day.taskCount}` })))),
          day.isCurrentDay
            ? h('div', { class: 'stat-card plain' },
              h('div', { class: 'stat-label', text: 'In progress' }),
              h('div', { class: 'stat-text', text: day.inProgress.length ? day.inProgress.join(', ') : '—' }))
            : null)),
      strip);
  }

  function renderDay() {
    const day = WW.state.day;
    const root = clear(view());

    const picker = h('input', {
      type: 'date', value: day.planningDayKey, 'aria-label': 'Jump to date',
      onchange: (e) => { if (e.target.value) WW.showDay(e.target.value); },
    });

    const week = day.week;
    const chip = (d) => h('button', {
      class: `day-chip${d.isSelected ? ' on' : ''}${d.isToday ? ' today' : ''}`, type: 'button',
      'aria-pressed': String(d.isSelected), 'aria-label': d.label, title: d.label,
      onclick: () => { if (!d.isSelected) WW.showDay(d.key); },
    },
    h('span', { class: 'day-chip-wd', text: d.isToday ? 'TODAY' : d.weekday.toUpperCase() }),
    h('span', { class: 'day-chip-n', text: String(d.day) }),
    h('span', { class: 'day-chip-track', 'aria-hidden': 'true' }, h('span', { class: 'day-chip-fill', style: { width: `${d.pct}%` } })));

    root.append(
      h('div', { class: 'day-head' },
        h('div', { class: 'day-info' },
          h('h1', { class: 'day-title', text: day.dateTitle }),
          h('div', { class: 'day-sub' },
            day.hijri ? h('span', { class: 'hijri', text: day.hijri }) : null,
            h('span', { text: day.planningLine })),
          h('div', { class: 'day-actions' },
            h('button', { class: 'btn', text: 'Today', onclick: () => WW.showDay(WW.state.todayKey || day.currentPlanningDayKey) }),
            picker)),
        h('div', { class: 'week-strip', role: 'group', 'aria-label': 'Days of this week' },
          h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Previous week', onclick: () => WW.showDay(week.prevKey) }, WW.icon('left', 18, 2.2)),
          ...week.days.map(chip),
          h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Next week', onclick: () => WW.showDay(week.nextKey) }, WW.icon('right', 18, 2.2)))),
      heroCard(day),
      h('div', { class: 'zones' }, day.zones.map(zoneSection)));
  }

  WW.showDay = async function showDay(key) {
    try {
      // Redrawing the same day (ticking a task, a background refresh) must not throw the page back to the top.
      const keepScroll = WW.state.view === 'daily' && WW.state.dayKey === key;
      const scrollY = window.scrollY;
      WW.state.view = 'daily';
      WW.state.dayKey = key;
      WW.state.day = await WW.call('getDay', key);
      WW.state.todayKey = WW.state.day.currentPlanningDayKey;
      renderDay();
      if (keepScroll) window.scrollTo(0, scrollY);
    } catch (error) {
      WW.toast(error.message, 'error');
    }
  };

  WW.showDaily = function showDaily() {
    return WW.showDay(WW.state.dayKey || WW.state.todayKey);
  };

  WW.showSettings = function showSettings() {
    WW.state.view = 'settings';
    WW.renderSettings();
    window.scrollTo(0, 0);
  };

  // Called after anything changes the data.
  WW.afterChange = async function afterChange() {
    refreshBell();
    if (WW.state.view === 'daily') await WW.showDay(WW.state.dayKey);
    else if (WW.state.view === 'stats') await WW.showStats();
  };

  // ---- Bell and menu ----------------------------------------------------------------------------------------------

  function closePopovers() {
    document.getElementById('bell-panel').hidden = true;
  }

  // The bell shows reminders that were missed while the computer was off or asleep.
  // It shows a red number when there are some, and looks faded when there are none.
  async function refreshBell() {
    const button = document.getElementById('bell-btn');
    if (!button) return null;
    try {
      const list = await WW.call('getMissed');
      WW.state.missedCount = list.length;
      button.classList.toggle('bell-empty', list.length === 0);
      const label = list.length === 0 ? 'No missed reminders' : `${list.length} missed reminder${list.length === 1 ? '' : 's'}`;
      button.title = label;
      button.setAttribute('aria-label', label);
      let badge = button.querySelector('.bell-badge');
      if (list.length === 0) {
        if (badge) badge.remove();
      } else {
        if (!badge) { badge = h('span', { class: 'bell-badge', 'aria-hidden': 'true' }); button.appendChild(badge); }
        badge.textContent = list.length > 99 ? '99+' : String(list.length);
      }
      return list;
    } catch (error) {
      return null;
    }
  }

  async function toggleBell() {
    const panel = document.getElementById('bell-panel');
    const wasHidden = panel.hidden;
    closePopovers();
    if (!wasHidden) return;
    const list = (await refreshBell()) || [];
    clear(panel).appendChild(h('div', { class: 'popover-head' },
      h('h3', { text: 'Missed reminders' }),
      list.length ? h('button', {
        class: 'link-btn', type: 'button', text: 'Clear all',
        onclick: async () => {
          try { await WW.call('clearMissed'); } catch (error) { WW.toast(error.message, 'error'); }
          closePopovers();
          refreshBell();
        },
      }) : null));
    if (list.length === 0) panel.appendChild(h('div', { class: 'empty-zone', text: 'No missed reminders.' }));
    list.forEach((r) =>
      panel.appendChild(h('div', {
        class: 'upcoming-item', role: 'button', tabindex: '0',
        onclick: async () => {
          closePopovers();
          try { await WW.call('dismissMissed', { taskId: r.taskId, dateKey: r.dateKey }); } catch (error) { /* the task may be gone */ }
          refreshBell();
          WW.openTaskForm({ mode: 'edit', taskId: r.taskId, dateKey: r.dateKey });
        },
      },
        h('div', { class: 'when', text: r.title }),
        h('div', { class: 'what', text: `${r.alreadyStarted ? 'Started' : 'Was due'} ${r.whenLabel} · ${r.zoneName}` }))));
    panel.hidden = false;
  }

  function closeDrawer() {
    document.getElementById('drawer').hidden = true;
    document.getElementById('scrim').hidden = true;
    document.getElementById('menu-btn').setAttribute('aria-expanded', 'false');
  }

  function openDrawer() {
    closePopovers();
    const drawer = document.getElementById('drawer');
    const item = (icon, label, fn, active) => h('button', {
      class: `drawer-item ${active ? 'active' : ''}`, type: 'button',
      onclick: () => { closeDrawer(); fn(); },
    }, WW.icon(icon, 20, 1.9), label);
    clear(drawer).append(
      h('div', { class: 'drawer-head' },
        h('img', { class: 'app-logo', src: 'logo.png', alt: '' }),
        h('div', { class: 'drawer-title', text: 'WaqtWise' }),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close menu', onclick: closeDrawer }, WW.icon('close', 18, 2))),
      item('calendar', 'Daily View', () => WW.showDaily(), WW.state.view === 'daily'),
      item('chart', 'Statistics', () => WW.showStats({ range: 'week' }), WW.state.view === 'stats'),
      item('gear', 'Settings', () => WW.showSettings(), WW.state.view === 'settings'),
      h('div', { class: 'drawer-sep' }),
      h('div', { class: 'drawer-label', text: 'YOUR DATA' }),
      item('export', 'Export data…', () => WW.exportData()),
      item('import', 'Import data…', () => WW.importData()),
      h('p', { class: 'drawer-note', text: 'Export saves a backup file on this computer. Importing a backup replaces all tasks, categories and settings.' }));
    drawer.hidden = false;
    document.getElementById('scrim').hidden = false;
    document.getElementById('menu-btn').setAttribute('aria-expanded', 'true');
    const first = drawer.querySelector('.drawer-item');
    if (first) first.focus();
  }

  // ---- Export / import --------------------------------------------------------------------------------------------------

  WW.exportData = async function exportData() {
    try {
      const result = await window.api.exportData();
      if (result && result.ok) WW.toast('Backup saved');
    } catch (error) {
      WW.toast(error.message, 'error');
    }
  };

  WW.importData = async function importData() {
    const go = await WW.ask({
      title: 'Import data',
      message: 'Importing a backup replaces ALL tasks, categories and settings on this computer with the contents of the file. Continue?',
      choices: [{ label: 'Cancel', value: false }, { label: 'Choose file…', value: true, kind: 'primary' }],
    });
    if (!go) return;
    try {
      const result = await window.api.importData();
      if (!result || result.canceled) return;
      await reloadEverything();
      const extra = result.warnings && result.warnings.length ? ` (${result.warnings.length} item(s) skipped)` : '';
      WW.toast(`Imported ${result.tasks} task(s)${extra}`);
      if (result.warnings && result.warnings.length) {
        const dlg = WW.openDialog({ title: 'Some items were skipped' });
        result.warnings.forEach((w) => dlg.body.appendChild(h('p', { text: w })));
        dlg.footer.appendChild(h('button', { class: 'btn primary', text: 'OK', onclick: () => dlg.close() }));
      }
    } catch (error) {
      WW.toast(error.message, 'error');
    }
  };

  async function reloadEverything() {
    const boot = await WW.call('bootstrap');
    Object.assign(WW.state, { settings: boot.settings, categories: boot.categories, cities: boot.cities, methods: boot.methods, todayKey: boot.currentPlanningDayKey });
    WW.applyTheme(boot.settings.theme);
    if (WW.state.view === 'settings') WW.renderSettings();
    else if (WW.state.view === 'stats') await WW.showStats();
    else await WW.showDay(WW.state.todayKey);
  }

  // ---- Missed reminders --------------------------------------------------------------------------------------------------

  WW.showMissed = function showMissed(items) {
    if (!items || items.length === 0) return;
    const dlg = WW.openDialog({ title: items.length === 1 ? 'You missed 1 reminder' : `You missed ${items.length} reminders` });
    dlg.body.appendChild(h('p', { class: 'hint', text: 'These reminders came due while the computer was off or asleep:' }));
    items.forEach((i) =>
      dlg.body.appendChild(h('div', {
        class: 'upcoming-item', role: 'button', tabindex: '0',
        onclick: async () => {
          dlg.close();
          try { await WW.call('dismissMissed', { taskId: i.taskId, dateKey: i.dateKey }); } catch (error) { /* ignore */ }
          refreshBell();
          WW.openTaskForm({ mode: 'edit', taskId: i.taskId, dateKey: i.dateKey });
        },
      },
        h('div', { class: 'when', text: i.title }),
        h('div', { class: 'what', text: `${i.alreadyStarted ? 'Started' : 'Starts'} at ${i.startLabel} · ${i.zoneName}` }))));
    dlg.footer.appendChild(h('button', { class: 'btn primary', text: 'OK', onclick: () => dlg.close() }));
  };

  // ---- First run ---------------------------------------------------------------------------------------------------------

  // First run: the welcome screen asks for the city (prayer times depend on it), then the app starts.
  WW.showWelcome = function showWelcome() {
    let city = WW.state.settings.cityName;
    const select = h('select', { id: 'welcome-city', 'aria-label': 'Your city', onchange: (e) => { city = e.target.value; } },
      WW.state.cities.map((name) => h('option', { value: name, text: name, selected: name === city })));
    const strip = h('div', { class: 'splash-strip', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map((n) => h('div', { class: `z${n}` })));
    const start = h('button', {
      class: 'btn primary', type: 'button',
      onclick: async () => {
        try {
          WW.state.settings = await WW.call('saveSettings', { cityName: city, welcomeShown: true });
          screen.remove();
          await WW.showDay(WW.state.todayKey);
        } catch (error) {
          WW.toast(error.message, 'error');
        }
      },
    }, 'Start planning', WW.icon('right', 20, 2.4));
    const screen = h('div', { class: 'welcome', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Welcome to WaqtWise' },
      h('div', { class: 'welcome-brand' },
        h('img', { src: 'logo-large.png', alt: '' }),
        h('div', { class: 'welcome-name', text: 'WaqtWise' }),
        h('p', { text: 'Make every waqt count, wisely.' }),
        strip),
      h('div', { class: 'welcome-form' },
        h('div', { class: 'welcome-eyebrow', text: 'WELCOME' }),
        h('h2', { text: 'Let\u2019s set up your day' }),
        h('p', { class: 'lead', text: 'WaqtWise divides your day into 5 zones using the prayer times, so it needs to know your city.' }),
        h('label', { for: 'welcome-city', text: 'Your city' }),
        select,
        h('p', { class: 'hint', text: 'You can change this later in Settings. Everything stays on this computer.' }),
        start));
    document.body.appendChild(screen);
    start.focus();
  };

  // The splash covers the window for a moment at every start; a click or key skips it.
  const SPLASH_MS = 3200;
  const splashStarted = Date.now();
  function hideSplash() {
    const splash = document.getElementById('splash');
    if (!splash || splash.dataset.leaving) return;
    splash.dataset.leaving = '1';
    const leave = () => {
      splash.classList.add('hide');
      setTimeout(() => splash.remove(), 500);
    };
    setTimeout(leave, Math.max(0, SPLASH_MS - (Date.now() - splashStarted)));
    const skip = () => { splash.removeEventListener('click', skip); leave(); };
    splash.addEventListener('click', skip);
  }

  // ---- Start-up -------------------------------------------------------------------------------------------------------------

  async function init() {
    const put = (id, node) => clear(document.getElementById(id)).appendChild(node);
    put('menu-btn', WW.icon('menu', 22, 1.9));
    put('bell-btn', WW.icon('bell'));
    clear(document.getElementById('add-btn')).append(WW.icon('plus', 16, 2.6), 'New task');
    updateThemeButton();
    if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', updateThemeButton);

    document.getElementById('menu-btn').addEventListener('click', (e) => { e.stopPropagation(); openDrawer(); });
    document.getElementById('scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closePopovers(); } });
    document.getElementById('theme-btn').addEventListener('click', toggleTheme);
    document.getElementById('bell-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });
    document.getElementById('add-btn').addEventListener('click', () => {
      closePopovers();
      WW.openTaskForm({ mode: 'create', defaultKey: WW.state.dayKey || WW.state.todayKey });
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.popover') && !e.target.closest('.icon-btn')) closePopovers();
    });

    try {
      await reloadEverything();
      const boot = await WW.call('bootstrap');
      if (boot.loadNotes && boot.loadNotes.length) WW.toast(boot.loadNotes[0], 'error');
    } catch (error) {
      clear(view()).appendChild(h('div', { class: 'errors', text: `Could not start: ${error.message}` }));
      hideSplash();
      return;
    }

    refreshBell();
    if (!WW.state.settings.welcomeShown) WW.showWelcome();
    hideSplash();

    // The window keeps itself fresh: current zone, overdue marks, and changes made elsewhere.
    setInterval(() => { if ((WW.state.view === 'daily' || WW.state.view === 'stats') && !anyDialogOpen()) WW.afterChange(); }, 30000);
    window.addEventListener('focus', () => { if (!anyDialogOpen()) WW.afterChange(); });

    if (window.api && window.api.on) {
      window.api.on('data-changed', () => { if (!anyDialogOpen()) WW.afterChange(); else refreshBell(); });
      window.api.on('missed', (items) => { refreshBell(); WW.showMissed(items); });
      window.api.on('open-task', ({ taskId, dateKey }) => {
        if (taskId && dateKey) WW.openTaskForm({ mode: 'edit', taskId, dateKey });
        else WW.showDay(WW.state.todayKey);
      });
    }
    // Tell the main process the window is ready to receive events (missed reminders, links from notifications).
    if (window.api && window.api.ready) window.api.ready();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
