'use strict';

// The Statistics screen. A range (Day, Week, Month, Year or Custom) decides what every chart shows;
// the numbers come ready-made from the main process (getStats), this file only draws them.

(function () {
  const WW = (window.WW = window.WW || {});
  const { h, clear } = WW;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RANGES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year'], ['custom', 'Custom']];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const BAR_AREA = 170; // tallest bar, in pixels
  const LATE_SHOWN = 5;

  // Must match STATS_CHARTS in src/core/settings.js (a test checks that).
  const CHARTS = [
    ['kpi-rate', 'Completion rate', 'Share of counted tasks that are done'],
    ['kpi-done', 'Tasks done', 'How many tasks were done, out of how many'],
    ['kpi-streak', 'Current streak', 'Days in a row with at least 70% done'],
    ['kpi-time', 'Planned time', 'Total time of the counted tasks'],
    ['bars', 'Done vs planned', 'Bars of done and planned tasks'],
    ['zones', 'By zone', 'Share done in each of the 5 zones'],
    ['heat', 'Calendar heat map', 'Every day of the month or year as a colour'],
    ['trend', 'Completion trend', 'How the completion rate moves over time'],
    ['categories', 'By category', 'Share done and planned time per category'],
    ['late', 'Needs attention', 'Tasks not done and already past their time'],
  ];
  const local = { query: { range: 'week' }, showAllLate: false };

  const shade = (pct) => `color-mix(in srgb, var(--accent) ${Math.round(14 + pct * 0.86)}%, var(--surface))`;

  function svg(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    children.forEach((c) => { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  // ---- header ------------------------------------------------------------------------------------

  function header(data) {
    const go = (query) => query && WW.showStats(query);
    const prev = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous period', disabled: !data.prevQuery, onclick: () => go(data.prevQuery) }, WW.icon('left', 20, 2.2));
    const next = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next period', disabled: !data.nextQuery, onclick: () => go(data.nextQuery) }, WW.icon('right', 20, 2.2));

    const choose = (id) => {
      if (id === data.range) return;
      if (id === 'custom') go({ range: 'custom', fromKey: data.rangeStartKey, toKey: data.rangeEndKey });
      else go({ range: id, anchorKey: data.rangeEndKey });
    };
    const seg = h('div', { class: 'stats-seg', role: 'group', 'aria-label': 'Range' },
      RANGES.map(([id, label]) => h('button', {
        type: 'button', class: id === data.range ? 'on' : '', 'aria-pressed': String(id === data.range), 'data-range': id, onclick: () => choose(id),
      }, label)));

    const custom = data.range === 'custom'
      ? [
        h('input', { type: 'date', value: data.rangeStartKey, max: data.todayKey, 'aria-label': 'From date', id: 'stats-from',
          onchange: (e) => e.target.value && go({ range: 'custom', fromKey: e.target.value, toKey: data.rangeEndKey }) }),
        h('span', { class: 'stats-to', text: 'to' }),
        h('input', { type: 'date', value: data.rangeEndKey, max: data.todayKey, 'aria-label': 'To date', id: 'stats-to',
          onchange: (e) => e.target.value && go({ range: 'custom', fromKey: data.rangeStartKey, toKey: e.target.value }) }),
        h('button', { class: 'btn tall', type: 'button', id: 'stats-all', text: 'All time', onclick: () => go({ range: 'custom', fromKey: data.earliestKey, toKey: data.todayKey }) }),
      ]
      : [];

    return h('div', { class: 'day-head stats-head' },
      h('div', { class: 'day-nav' }, prev,
        h('div', {}, h('h1', { class: 'day-title', text: 'Statistics' }), h('div', { class: 'day-sub', id: 'stats-range-label', text: data.rangeLabel })),
        next),
      h('div', { class: 'day-actions stats-actions' }, custom, seg,
        h('button', { class: 'btn tall', type: 'button', id: 'stats-manage', onclick: openManage }, WW.icon('gear', 18, 2), 'Manage')));
  }

  // ---- key figures ----------------------------------------------------------------------------------

  function kpiCards(data, ids) {
    const cards = ids.map((id) => data.kpis.find((k) => `kpi-${k.id}` === id)).filter(Boolean);
    return h('div', { class: 'stats-kpis' }, cards.map((k) =>
      h('div', { class: 'stats-card kpi', 'data-kpi': k.id },
        h('div', { class: 'kpi-label', text: k.label }),
        h('div', { class: 'kpi-value' }, h('span', { class: 'kpi-num', text: k.value }), k.unit ? h('span', { class: 'kpi-unit', text: k.unit }) : null),
        h('div', { class: `kpi-delta ${k.delta.tone}`, text: k.delta.text }))));
  }

  // ---- done versus planned ---------------------------------------------------------------------------

  function barsCard(data) {
    const b = data.bars;
    const many = b.items.length > 14;
    const detailed = b.items.length <= 12;
    const stride = b.items.length > 12 ? Math.ceil(b.items.length / 10) : 1;
    const columns = h('div', { class: `bars ${many ? 'tight' : ''}` }, b.items.map((it) =>
      h('div', { class: 'bar-col', title: `${it.title}: ${it.done} of ${it.total} done` },
        h('div', { class: 'bar-pct', text: detailed && it.total ? `${it.pct}%` : '' }),
        h('div', { class: 'bar-planned', style: { height: `${Math.round((it.total / b.maxTotal) * BAR_AREA)}px` } },
          h('div', { class: 'bar-done', style: { height: `${Math.round((it.done / b.maxTotal) * BAR_AREA)}px` } })))));
    const labels = h('div', { class: `bar-labels ${many ? 'tight' : ''}` }, b.items.map((it, i) =>
      h('div', {}, h('div', { class: 'bl-name', text: i % stride === 0 ? it.label : '' }),
        h('div', { class: 'bl-ratio', text: detailed && !it.future ? `${it.done}/${it.total}` : '' }))));
    return h('section', { class: 'stats-card bars-card', 'aria-label': 'Done versus planned' },
      h('div', { class: 'stats-card-head' },
        h('div', {}, h('h2', { text: b.title }), h('div', { class: 'sub', id: 'bars-sub', text: b.sub })),
        h('div', { class: 'stats-legend' },
          h('span', {}, h('i', { class: 'sw planned' }), 'Planned'), h('span', {}, h('i', { class: 'sw done' }), 'Done'))),
      columns, labels);
  }

  function zonesCard(data) {
    return h('section', { class: 'stats-card zones-card', 'aria-label': 'By zone' },
      h('h2', { text: 'By zone' }), h('div', { class: 'sub', text: 'Share of tasks done in each zone' }),
      h('div', { class: 'bars-list' }, data.zones.map((z) =>
        h('div', { class: `z${z.index}` },
          h('div', { class: 'row-top' }, h('span', { text: z.name }), h('span', { text: `${z.pct}%` })),
          h('div', { class: 'meter' }, h('div', { style: { width: `${z.pct}%`, background: 'var(--zf)' } })),
          h('div', { class: 'row-note', text: `${z.done} of ${z.total} tasks` })))));
  }

  // ---- heat map -------------------------------------------------------------------------------------------

  function heatCard(data) {
    const heat = data.heat;
    const open = (key) => WW.showStats({ range: 'day', anchorKey: key });
    const legend = h('div', { class: 'stats-legend heat-legend' }, 'Less',
      [0, 25, 50, 75, 100].map((p) => h('span', { class: 'heat-sw', style: { background: shade(p) } })), 'More');
    const cellTitle = (d) => `${d.key}${d.pct === null ? '' : `: ${d.pct}% done`}`;
    let body;
    if (heat.mode === 'month') {
      const cells = [];
      for (let i = 0; i < 7; i++) cells.push(h('div', { class: 'heat-wd', text: WEEKDAYS[(heat.weekStart + i) % 7] }));
      for (let i = 0; i < heat.firstWeekday; i++) cells.push(h('div', { class: 'heat-blank' }));
      heat.days.forEach((d) => {
        const strong = d.pct !== null && d.pct >= 70;
        cells.push(h('button', {
          type: 'button', class: `heat-day ${d.inRange ? 'sel' : ''}`, title: cellTitle(d), 'aria-label': cellTitle(d), disabled: d.future, 'data-key': d.key,
          style: { background: d.pct === null ? 'var(--heat-empty)' : shade(d.pct), color: d.pct === null ? 'var(--text-soft)' : strong ? 'var(--accent-text)' : 'var(--text)' },
          onclick: () => open(d.key),
        }, h('span', { class: 'hd-n', text: String(d.day) }), h('span', { class: 'hd-p', text: d.pct === null ? '' : `${d.pct}%` })));
      });
      body = h('div', { class: 'heat-month' }, cells);
    } else {
      const marks = [];
      heat.days.forEach((d, i) => {
        if (d.day === 1) marks.push(h('div', { class: 'ym', style: { gridColumn: String(Math.floor((heat.firstWeekday + i) / 7) + 1) }, text: MONTHS_SHORT[Number(d.key.slice(5, 7)) - 1] }));
      });
      const cells = [];
      for (let i = 0; i < heat.firstWeekday; i++) cells.push(h('div', { class: 'heat-blank' }));
      heat.days.forEach((d) => cells.push(h('button', {
        type: 'button', class: `heat-sq ${d.inRange ? 'sel' : ''}`, title: cellTitle(d), 'aria-label': cellTitle(d), disabled: d.future, 'data-key': d.key,
        style: { background: d.pct === null ? 'var(--heat-empty)' : shade(d.pct) }, onclick: () => open(d.key),
      })));
      body = h('div', { class: 'heat-year-wrap' }, h('div', { class: 'heat-year' }, h('div', { class: 'heat-marks' }, marks), h('div', { class: 'heat-grid' }, cells)));
    }
    return h('section', { class: 'stats-card heat-card', 'aria-label': 'Calendar heat map' },
      h('div', { class: 'stats-card-head' },
        h('div', {}, h('h2', { id: 'heat-title', text: heat.title }), h('div', { class: 'sub', text: 'Darker = more of that day’s tasks were done. Click a day to open it.' })),
        legend),
      body);
  }

  // ---- completion trend ---------------------------------------------------------------------------------------

  function trendChart(trend) {
    const W = 640;
    const x0 = 56;
    const x1 = 616;
    const yTop = 12;
    const yBot = 180;
    const series = trend.points.map((p) => p.value);
    const values = series.concat(trend.compare || [], trend.thin || []).filter((v) => v !== null);
    const lo = Math.max(0, Math.floor((Math.min(...values) - 8) / 10) * 10);
    const hi = Math.min(100, Math.max(lo + 30, Math.ceil((Math.max(...values) + 4) / 10) * 10));
    const n = series.length;
    const X = (i) => (n === 1 ? (x0 + x1) / 2 : Math.round(x0 + ((x1 - x0) * i) / (n - 1)));
    const Y = (v) => Math.round(yBot - ((v - lo) / (hi - lo)) * (yBot - yTop));
    const poly = (arr) => arr.map((v, i) => (v === null ? null : `${X(i)},${Y(v)}`)).filter(Boolean).join(' ');
    const root = svg('svg', { viewBox: `0 0 ${W} 220`, width: '100%', role: 'img', 'aria-label': `Completion trend. ${trend.sub}` });
    root.style.overflow = 'visible';

    const step = Math.round((hi - lo) / 3);
    [0, 1, 2, 3].forEach((i) => {
      const v = i === 3 ? hi : lo + step * i;
      root.append(
        svg('line', { x1: 40, x2: 632, y1: Y(v), y2: Y(v), class: 'tr-grid' }),
        svg('text', { x: 0, y: Y(v) + 4, class: 'tr-axis' }, `${v}%`));
    });
    if (trend.thin) root.appendChild(svg('polyline', { points: poly(trend.thin), class: 'tr-thin' }));
    if (trend.compare) root.appendChild(svg('polyline', { points: poly(trend.compare), class: 'tr-compare' }));

    const known = series.map((v, i) => (v === null ? null : i)).filter((i) => i !== null);
    const first = known[0];
    const last = known[known.length - 1];
    if (known.length > 1) {
      const d = `M${X(first)},${yBot} L${poly(series).split(' ').join(' L')} L${X(last)},${yBot} Z`;
      root.appendChild(svg('path', { d, class: `tr-area ${trend.compare || trend.thin ? 'light' : ''}` }));
    }
    root.appendChild(svg('polyline', { points: poly(series), class: 'tr-line' }));

    const showDots = n <= 12;
    const labelStride = n > 8 && trend.points.every((p) => p.label !== '') ? Math.ceil(n / 8) : 1;
    trend.points.forEach((p, i) => {
      if (p.value !== null && (showDots || i === last)) {
        root.appendChild(svg('circle', { cx: X(i), cy: Y(p.value), r: 5, class: 'tr-dot' }, svg('title', {}, p.title)));
      }
      if (i % labelStride === 0 && p.label) root.appendChild(svg('text', { x: X(i), y: 212, 'text-anchor': 'middle', class: 'tr-axis' }, p.label));
    });
    root.appendChild(svg('text', { x: X(last), y: Y(series[last]) - 14, 'text-anchor': 'end', class: 'tr-last' }, `${series[last]}%`));
    return root;
  }

  function trendCard(data) {
    const t = data.trend;
    return h('section', { class: 'stats-card trend-card', 'aria-label': 'Completion trend' },
      h('div', { class: 'stats-card-head' },
        h('div', {}, h('h2', { text: 'Completion trend' }), h('div', { class: 'sub', id: 'trend-sub', text: t.sub })),
        h('div', { class: 'stats-legend' }, t.legend.map((l) => h('span', {}, h('i', { class: `ln ${l.style}` }), l.label)))),
      t.ok
        ? h('div', { class: 'trend-body' }, trendChart(t))
        : h('div', { class: 'trend-empty', id: 'trend-empty', text: 'Not enough data yet. The trend appears after 3 days with tasks.' }));
  }

  // ---- by category, needs attention ---------------------------------------------------------------------------------

  function categoriesCard(data) {
    return h('section', { class: 'stats-card cat-card', 'aria-label': 'By category' },
      h('h2', { text: 'By category' }), h('div', { class: 'sub', text: 'Share done, and planned time' }),
      data.categories.length === 0
        ? h('div', { class: 'stats-none', text: 'No tasks in this range.' })
        : h('div', { class: 'bars-list cats' }, data.categories.map((c) =>
          h('div', { class: 'cat-line' },
            h('span', { class: 'cat-dot', style: { background: c.color } }),
            h('span', { class: 'cat-name', text: c.name }),
            h('div', { class: 'meter' }, h('div', { style: { width: `${c.pct}%`, background: c.color } })),
            h('span', { class: 'cat-pct', text: `${c.pct}%` }),
            h('span', { class: 'cat-time', text: c.timeLabel })))));
  }

  function lateCard(data) {
    const late = data.late;
    const shown = local.showAllLate ? late.items : late.items.slice(0, LATE_SHOWN);
    const list = h('div', { class: 'late-list' }, shown.map((t) =>
      h('div', { class: 'late-item', role: 'button', tabindex: '0', 'data-task': t.taskId,
        onclick: () => WW.openTaskForm({ mode: 'edit', taskId: t.taskId, dateKey: t.dateKey }),
        onkeydown: (e) => { if (e.key === 'Enter') WW.openTaskForm({ mode: 'edit', taskId: t.taskId, dateKey: t.dateKey }); } },
      h('div', { class: 'late-main' }, h('div', { class: 'late-title', text: t.title }), h('div', { class: 'late-when', text: `${t.whenLabel} · ${t.zoneName}` })),
      h('span', { class: 'late-age', text: t.ageLabel }))));
    const more = late.total > LATE_SHOWN
      ? h('button', { class: 'link-btn late-more', type: 'button', id: 'late-more',
        text: local.showAllLate ? 'Show fewer' : `View all ${late.total}`,
        onclick: () => { local.showAllLate = !local.showAllLate; WW.renderStats(); } })
      : null;
    return h('section', { class: 'stats-card late-card', 'aria-label': 'Needs attention' },
      h('h2', { text: 'Needs attention' }), h('div', { class: 'sub', text: 'Not done and already past their time' }),
      late.total === 0 ? h('div', { class: 'stats-none', id: 'late-none', text: 'Nothing overdue in this range.' }) : list, more);
  }

  // ---- screen ---------------------------------------------------------------------------------------------------------

  WW.renderStats = function renderStats() {
    const data = WW.state.stats;
    const root = clear(document.getElementById('view'));
    const chosen = WW.state.settings.statsCharts;
    const kpiIds = chosen.filter((id) => id.startsWith('kpi-'));
    const builders = { bars: barsCard, zones: zonesCard, heat: heatCard, trend: trendCard, categories: categoriesCard, late: lateCard };
    const cards = chosen.filter((id) => builders[id]);
    root.append(
      header(data),
      ...(data.empty ? [h('div', { class: 'stats-intro', id: 'stats-empty', text: 'Nothing to count yet. Tasks appear here once they are done or their time has passed.' })] : []),
      ...(kpiIds.length ? [kpiCards(data, kpiIds)] : []),
      ...(cards.length
        ? [h('div', { class: 'stats-grid' }, cards.map((id) => builders[id](data)))]
        : (kpiIds.length ? [] : [h('div', { class: 'stats-intro', id: 'stats-nothing', text: 'No charts are shown. Use Manage to add some.' })])));
  };

  // ---- Manage: add, remove and re-order the charts -------------------------------------------------------

  function openManage() {
    const dlg = WW.openDialog({ title: 'Manage charts' });
    const info = (id) => CHARTS.find((c) => c[0] === id);
    const save = async (list) => {
      try {
        WW.state.settings = await WW.call('saveSettings', { statsCharts: list });
      } catch (error) {
        WW.toast(error.message, 'error');
      }
      draw();
      WW.renderStats();
    };
    function draw() {
      const shown = WW.state.settings.statsCharts.slice();
      const hidden = CHARTS.map((c) => c[0]).filter((id) => !shown.includes(id));
      const move = (i, d) => { const list = shown.slice(); [list[i], list[i + d]] = [list[i + d], list[i]]; save(list); };
      const row = (id, buttons) => h('div', { class: 'manage-row', 'data-chart': id },
        h('div', { class: 'manage-name' }, h('b', { text: info(id)[1] }), h('div', { class: 'hint', text: info(id)[2] })),
        h('div', { class: 'manage-btns' }, buttons));
      clear(dlg.body).append(
        h('h3', { class: 'manage-title', text: `Shown (${shown.length})` }),
        ...(shown.length === 0 ? [h('p', { class: 'hint', text: 'No charts are shown.' })] : []),
        ...shown.map((id, i) => row(id, [
          h('button', { class: 'btn small', type: 'button', text: '▲', 'aria-label': `Move ${info(id)[1]} up`, disabled: i === 0, onclick: () => move(i, -1) }),
          h('button', { class: 'btn small', type: 'button', text: '▼', 'aria-label': `Move ${info(id)[1]} down`, disabled: i === shown.length - 1, onclick: () => move(i, 1) }),
          h('button', { class: 'btn small danger', type: 'button', text: 'Remove', 'aria-label': `Remove ${info(id)[1]}`, onclick: () => save(shown.filter((x) => x !== id)) }),
        ])),
        h('h3', { class: 'manage-title', text: `Available to add (${hidden.length})` }),
        ...(hidden.length === 0 ? [h('p', { class: 'hint', text: 'Every chart is already shown.' })] : []),
        ...hidden.map((id) => row(id, [
          h('button', { class: 'btn small primary', type: 'button', text: 'Add', 'aria-label': `Add ${info(id)[1]}`, onclick: () => save(shown.concat(id)) }),
        ])));
    }
    draw();
    dlg.footer.append(
      h('button', { class: 'btn', type: 'button', id: 'manage-reset', text: 'Show all, default order', onclick: () => save(CHARTS.map((c) => c[0])) }),
      h('button', { class: 'btn primary', type: 'button', text: 'Done', onclick: () => dlg.close() }));
  }

  // query: { range, anchorKey, fromKey, toKey }. Without a query the last one is used again (a refresh).
  WW.showStats = async function showStats(query) {
    try {
      const keepScroll = WW.state.view === 'stats' && !query;
      const scrollY = window.scrollY;
      if (query) { local.query = query; local.showAllLate = false; }
      WW.state.view = 'stats';
      WW.state.stats = await WW.call('getStats', local.query);
      // Remember the resolved dates so the next step (Month, Custom, ...) starts from what is on screen.
      WW.renderStats();
      if (keepScroll) window.scrollTo(0, scrollY);
      else if (query) window.scrollTo(0, 0);
    } catch (error) {
      WW.toast(error.message, 'error');
    }
  };
})();
