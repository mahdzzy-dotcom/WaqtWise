'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTask, setCompletion, computeStats, resolveRange, defaultCategories, addDaysToKey } = require('../src/core');
const { PlannerService, PUBLIC_METHODS } = require('../src/main/service');
const { MemoryStore } = require('../src/main/store');
const { at, constantProvider } = require('./helpers');

// "Now" is Saturday 2026-10-10, 3:20 PM. With these prayer times the Planning Day is the calendar day.
const TODAY = '2026-10-10';
const NOW = at(TODAY, '15:20');
const fixed = (time) => ({ mode: 'fixed', time });
const daily = (startDate) => ({ startDate, frequency: 'daily', interval: 1 });
const categories = defaultCategories();

let counter = 0;
function task(extra) {
  counter += 1;
  return createTask({
    id: `t${counter}`, title: 'Task', start: fixed('08:00'), durationMinutes: 30, date: TODAY, recurrence: null,
    reminders: { enabled: false, offsets: [] }, priority: 'Medium', categoryId: null, notes: '', ...extra,
  });
}
function markDone(t, keys) {
  return keys.reduce((acc, key) => setCompletion(acc, key, true), t);
}
function range(from, to) {
  const out = [];
  for (let k = from; k <= to; k = addDaysToKey(k, 1)) out.push(k);
  return out;
}
const stats = (tasks, query, now = NOW) => computeStats({ provider: constantProvider, tasks, categories, options: {}, now, query });
const kpi = (s, id) => s.kpis.find((k) => k.id === id);

test('only tasks that are done or past their time are counted', () => {
  const past = task({ title: 'Morning', start: fixed('08:00') });
  const later = task({ title: 'Evening', start: fixed('21:00') });
  const laterButDone = markDone(task({ title: 'Early tick', start: fixed('21:30') }), [TODAY]);
  const s = stats([past, later, laterButDone], { range: 'day' });
  assert.equal(kpi(s, 'done').value, '1');
  assert.equal(kpi(s, 'done').unit, 'of 2', 'the 9 PM task is not counted yet; the one ticked early is');
  assert.equal(kpi(s, 'rate').value, '50');
});

test('a task still running (started, not ended) is not counted until it ends or is done', () => {
  const running = task({ start: fixed('15:00'), durationMinutes: 60 });
  assert.equal(kpi(stats([running], { range: 'day' }), 'done').unit, 'of 0');
  const ticked = markDone(running, [TODAY]);
  assert.equal(kpi(stats([ticked], { range: 'day' }), 'done').unit, 'of 1');
});

test('the week starts on Sunday, runs to Saturday, and is compared with the days before it', () => {
  const r = resolveRange({ range: 'week', anchorKey: '2026-10-07' }, TODAY);
  assert.equal(r.start, '2026-10-04');
  assert.equal(r.end, '2026-10-10');
  assert.equal(r.prevStart, '2026-09-27');
  assert.equal(r.prevEnd, '2026-10-03');

  // 5 tasks this week (2 done), 4 tasks last week (3 done)
  const t = markDone(task({ recurrence: daily('2026-10-01') }), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  const s = stats([t], { range: 'week' });
  assert.equal(s.rangeLabel, 'Sun Oct 4 – Sat Oct 10, 2026');
  assert.equal(kpi(s, 'done').value, '2');
  assert.equal(kpi(s, 'done').unit, 'of 7');
  assert.equal(kpi(s, 'rate').value, '29');
  assert.equal(kpi(s, 'rate').delta.text.startsWith('▼'), true);
  assert.match(kpi(s, 'rate').delta.text, /vs last week$/);
  assert.equal(s.bars.unit, 'day');
  assert.equal(s.bars.items.length, 7);
  assert.deepEqual(s.bars.items.map((b) => b.label), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
});

test('a period that is not over yet is compared with the same number of days before it', () => {
  // Today is the 10th: this month so far = 10 days, compared with the first 10 days of September.
  const r = resolveRange({ range: 'month', anchorKey: TODAY }, TODAY);
  assert.equal(r.start, '2026-10-01');
  assert.equal(r.dataEnd, TODAY);
  assert.equal(r.span, 10);
  assert.equal(r.prevStart, '2026-09-01');
  assert.equal(r.prevDataEnd, '2026-09-10');
  const s = stats([task({ recurrence: daily('2026-09-01') })], { range: 'month' });
  assert.equal(s.rangeLabel, 'October 2026 · so far');
  assert.equal(kpi(s, 'done').unit, 'of 10');
  assert.equal(kpi(s, 'done').delta.text, 'Same as last month', '10 tasks against the first 10 days of September');
});

test('days that have not come yet have no numbers', () => {
  const s = stats([task({ recurrence: daily('2026-10-01') })], { range: 'week', anchorKey: TODAY });
  assert.equal(s.rangeEndKey, TODAY);
  const future = stats([task({ recurrence: daily('2026-10-01') })], { range: 'day', anchorKey: '2026-12-31' });
  assert.equal(future.anchorKey, TODAY, 'a day in the future is brought back to today');
});

test('Day: five zone bars, a trend of the 7 days ending that day, and its own heat-map cell marked', () => {
  const t = task({ recurrence: daily('2026-09-01') });
  const s = stats([t], { range: 'day', anchorKey: '2026-10-05' });
  assert.equal(s.bars.unit, 'zone');
  assert.deepEqual(s.bars.items.map((b) => b.label), ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']);
  assert.equal(s.bars.items[0].total, 1, 'an 8:00 AM task belongs to the Fajr → Dhuhr zone');
  assert.equal(s.trend.points.length, 7);
  assert.equal(s.trend.points[6].title.startsWith('Oct 5'), true);
  assert.equal(s.trend.points[0].title.startsWith('Sep 29'), true);
  assert.equal(s.trend.compare, null);
  assert.equal(s.heat.mode, 'month');
  assert.deepEqual(s.heat.days.filter((d) => d.inRange).map((d) => d.key), ['2026-10-05']);
});

test('Week: seven daily points and a dashed line for the week before', () => {
  const t = markDone(task({ recurrence: daily('2026-09-01') }), range('2026-09-27', '2026-10-03'));
  const s = stats([t], { range: 'week' });
  assert.equal(s.trend.points.length, 7);
  assert.equal(s.trend.compare.length, 7);
  assert.deepEqual(s.trend.compare, [100, 100, 100, 100, 100, 100, 100]);
  assert.deepEqual(s.trend.points.map((p) => p.value), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(s.trend.legend.map((l) => l.style), ['solid', 'dashed']);
  assert.deepEqual(s.heat.days.filter((d) => d.inRange).map((d) => d.key), range('2026-10-04', '2026-10-10'));
});

test('Month: daily points with a 7-day average, day bars and the whole month on the heat map', () => {
  const t = markDone(task({ recurrence: daily('2026-09-01') }), range('2026-10-01', '2026-10-07'));
  const s = stats([t], { range: 'month' });
  assert.equal(s.bars.unit, 'day');
  assert.equal(s.bars.items.length, 10);
  assert.equal(s.bars.items[0].label, '1');
  assert.equal(s.trend.points.length, 10);
  assert.equal(s.trend.thin.length, 10);
  assert.deepEqual(s.trend.thin.slice(0, 8), [100, 100, 100, 100, 100, 100, 100, 0]);
  assert.equal(s.trend.points[6].value, 100, 'seven good days in a row average 100');
  assert.equal(s.trend.points[9].value, 57, 'the last 7 days: 4 of 7');
  assert.deepEqual(s.trend.legend.map((l) => l.style), ['faint', 'solid']);
  assert.equal(s.heat.mode, 'month');
  assert.equal(s.heat.days.length, 31);
  assert.equal(s.heat.days.filter((d) => d.inRange).length, 0);
  assert.equal(s.heat.days[10].future, true);
});

test('Year: one bar for every month, monthly points and a year grid', () => {
  const t = task({ recurrence: daily('2026-08-15') });
  const s = stats([t], { range: 'year' });
  assert.equal(s.bars.unit, 'month');
  assert.equal(s.bars.items.length, 12);
  assert.equal(s.bars.items[7].total, 17, 'Aug 15 – Aug 31');
  assert.equal(s.bars.items[10].future, true);
  assert.equal(s.trend.points.length, 10, 'January to October');
  assert.equal(s.trend.points[0].value, null, 'months without tasks have no point');
  assert.equal(s.heat.mode, 'year');
  assert.equal(s.heat.days.length, 365);
  assert.equal(s.heat.firstWeekday, 4, '2026 starts on a Thursday');
  assert.equal(s.heat.title, '2026 at a glance');
});

test('Custom: the shape follows the length of the range', () => {
  const t = task({ recurrence: daily('2025-01-01') });
  const short = stats([t], { range: 'custom', fromKey: '2026-10-01', toKey: '2026-10-10' });
  assert.equal(short.bars.unit, 'day');
  assert.equal(short.trend.points.length, 10);
  assert.equal(short.heat.mode, 'month');
  assert.equal(short.heat.days.filter((d) => d.inRange).length, 10, 'a short custom range is marked');

  const medium = stats([t], { range: 'custom', fromKey: '2026-08-01', toKey: TODAY });
  assert.equal(medium.bars.unit, 'week');
  assert.equal(medium.heat.mode, 'year');
  assert.match(medium.trend.sub, /^Week by week/);

  const long = stats([t], { range: 'custom', fromKey: '2025-01-01', toKey: TODAY });
  assert.equal(long.bars.unit, 'month');
  assert.equal(long.bars.items.length, 22);
  assert.match(long.trend.sub, /^Month by month/);
  assert.equal(long.trend.points.length, 22);

  const swapped = stats([t], { range: 'custom', fromKey: TODAY, toKey: '2026-10-08' });
  assert.equal(swapped.rangeStartKey, '2026-10-08', 'dates entered the wrong way round are swapped');
  const future = stats([t], { range: 'custom', fromKey: '2026-10-08', toKey: '2027-03-01' });
  assert.equal(future.rangeEndKey, TODAY, 'the end is cut at today');
});

test('the trend needs 3 days with tasks', () => {
  const t = task({ recurrence: daily('2026-10-09') });
  assert.equal(stats([t], { range: 'week' }).trend.ok, false, 'two days of data');
  const more = task({ recurrence: daily('2026-10-08') });
  assert.equal(stats([more], { range: 'week' }).trend.ok, true);
  assert.equal(stats([], { range: 'week' }).trend.ok, false);
  assert.equal(stats([], { range: 'week' }).empty, true);
});

test('the streak counts days with at least 70% done, as of today, whatever range is chosen', () => {
  // Done every day from Oct 3 to Oct 9; today (Oct 10, task at 8:00) is not ticked yet.
  const t = markDone(task({ recurrence: daily('2026-10-01') }), range('2026-10-03', '2026-10-09'));
  const week = stats([t], { range: 'week' });
  const year = stats([t], { range: 'year' });
  const dayOld = stats([t], { range: 'day', anchorKey: '2026-10-01' });
  for (const s of [week, year, dayOld]) {
    assert.equal(kpi(s, 'streak').value, '7', 'today is still open, so it does not break the streak');
    assert.equal(kpi(s, 'streak').delta.text, 'Best: 7 days');
  }
  const doneToday = markDone(t, [TODAY]);
  assert.equal(kpi(stats([doneToday], { range: 'week' }), 'streak').value, '8');
});

test('a missed earlier day ends the streak, and days without tasks do not', () => {
  const t = markDone(task({ recurrence: { startDate: '2026-10-01', frequency: 'daily', interval: 2 } }), ['2026-10-03', '2026-10-07', '2026-10-09']);
  // Task days: 1, 3, 5, 7, 9. Done: 3, 7, 9 (not 5). Today (10th) has no tasks.
  const s = stats([t], { range: 'week' });
  assert.equal(kpi(s, 'streak').value, '2', 'Oct 9 and Oct 7 (the 8th and 10th have no tasks); the missed 5th ends it');
  assert.equal(kpi(s, 'streak').delta.text, 'Best: 2 days');
});

test('zones and categories add up what is in the range', () => {
  const study = task({ title: 'Study', categoryId: 'cat-study', start: fixed('08:00'), durationMinutes: 60 });
  const quran = task({ title: 'Quran', categoryId: 'cat-worship', start: fixed('12:30'), durationMinutes: 30 });
  const loose = task({ title: 'Loose', categoryId: null, start: fixed('13:00'), durationMinutes: 15 });
  const s = stats([markDone(study, [TODAY]), quran, loose], { range: 'day' });
  assert.deepEqual(s.zones.map((z) => [z.done, z.total]), [[1, 1], [0, 2], [0, 0], [0, 0], [0, 0]]);
  assert.equal(s.zones[0].pct, 100);
  assert.deepEqual(s.categories.map((c) => c.name), ['Study', 'Worship', 'No category'], 'longest planned time first');
  assert.equal(s.categories[0].timeLabel, '1h 0m');
  assert.equal(s.categories[0].pct, 100);
  assert.equal(s.categories[2].color, '#8ca0b5');
  assert.equal(kpi(s, 'time').value, '1h 45m');
});

test('Needs attention: newest first for short ranges, oldest first for Year and Custom', () => {
  const t = task({ title: 'Invoice', recurrence: daily('2026-10-05') });
  const week = stats([t], { range: 'week' });
  assert.equal(week.late.total, 6);
  assert.deepEqual(week.late.items.map((i) => i.dateKey), ['2026-10-10', '2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05']);
  assert.equal(week.late.items[0].ageLabel, 'Today');
  assert.equal(week.late.items[1].ageLabel, '1 day late');
  assert.equal(week.late.items[5].ageLabel, '5 days late');
  assert.equal(week.late.items[0].whenLabel, 'Sat Oct 10 · 8:00 AM');
  assert.equal(week.late.items[0].zoneName, 'Fajr → Dhuhr');
  const year = stats([t], { range: 'year' });
  assert.equal(year.late.items[0].dateKey, '2026-10-05');
  assert.equal(stats([markDone(t, range('2026-10-05', TODAY))], { range: 'week' }).late.total, 0);
});

test('a repeating task edited for one day, or removed for one day, is counted as it is now', () => {
  let t = task({ title: 'Walk', recurrence: daily('2026-10-01') });
  t = { ...t, exceptions: ['2026-10-08'], overrides: { '2026-10-09': { start: fixed('22:00') } } };
  const s = stats([t], { range: 'month' });
  assert.equal(kpi(s, 'done').unit, 'of 9', '10 days minus the removed one; the one moved to 10 PM on the 9th has passed too');
});

test('previous and next buttons stay inside the days that exist', () => {
  const t = task({ recurrence: daily('2026-09-20') });
  const week = stats([t], { range: 'week' });
  assert.equal(week.nextQuery, null, 'nothing after the current week');
  assert.deepEqual(week.prevQuery, { range: 'week', anchorKey: '2026-10-03' });
  const older = stats([t], { range: 'week', anchorKey: '2026-09-22' });
  assert.deepEqual(older.nextQuery, { range: 'week', anchorKey: '2026-09-27' });
  assert.equal(older.prevQuery, null, 'the week before the first task is empty');
  const custom = stats([t], { range: 'custom', fromKey: '2026-10-01', toKey: '2026-10-05' });
  assert.deepEqual(custom.nextQuery, { range: 'custom', fromKey: '2026-10-06', toKey: '2026-10-10' });
  assert.deepEqual(custom.prevQuery, { range: 'custom', fromKey: '2026-09-26', toKey: '2026-09-30' });
  const day = stats([t], { range: 'day', anchorKey: '2026-09-20' });
  assert.equal(day.prevQuery, null);
  assert.equal(day.earliestKey, '2026-09-20');
});

test('a task after midnight belongs to the Planning Day before it', () => {
  // 1:00 AM on Oct 10 is before that day's Fajr (5:05), so it is part of the Oct 9 Planning Day.
  const night = markDone(task({ title: 'Night reading', date: TODAY, start: fixed('01:00') }), [TODAY]);
  const s = stats([night], { range: 'day', anchorKey: '2026-10-09' });
  assert.equal(kpi(s, 'done').value, '1');
  assert.equal(s.bars.items[4].total, 1, 'in the Isha → Fajr zone');
  assert.equal(kpi(stats([night], { range: 'day', anchorKey: TODAY }), 'done').unit, 'of 0');
});

test('unknown ranges and bad dates fall back to something sensible', () => {
  const t = task({ recurrence: daily('2026-10-01') });
  const s = stats([t], { range: 'decade', anchorKey: 'not a date' });
  assert.equal(s.range, 'week');
  assert.equal(s.anchorKey, TODAY);
  const c = stats([t], { range: 'custom', fromKey: 'x', toKey: 'y' });
  assert.equal(c.rangeEndKey, TODAY);
  assert.equal(c.rangeStartKey, '2026-09-11', 'the last 30 days');
});

test('the service offers getStats to the window and returns plain data', () => {
  assert.ok(PUBLIC_METHODS.includes('getStats'));
  let n = 0;
  const service = new PlannerService({ store: new MemoryStore(), now: () => NOW, newId: () => `s${++n}`, providerFactory: () => constantProvider });
  service.saveTask({ mode: 'create', form: { title: 'Study', start: fixed('08:00'), durationMinutes: 60, date: null, recurrence: daily('2026-10-01'), reminders: { enabled: false, offsets: [] }, priority: 'Medium', categoryId: 'cat-study', notes: '' } });
  const s = service.getStats({ range: 'week' });
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(kpi(s, 'done').unit, 'of 7');
  assert.equal(service.getStats().range, 'week', 'no query at all shows this week');
  // Ticking a task changes the numbers.
  service.setDone({ taskId: 's1', dateKey: TODAY, done: true });
  assert.equal(kpi(service.getStats({ range: 'day' }), 'done').value, '1');
});

// ---- when a task was ticked, and which charts are shown ----

const fs = require('fs');
const path = require('path');
const { STATS_CHARTS, STATS_CHART_IDS, DEFAULT_SETTINGS, mergeSettings, sanitizeSettings, normalizeData, editTask, deleteOccurrences } = require('../src/core');

test('ticking a task remembers the moment, un-ticking forgets it, and ticking twice keeps the first moment', () => {
  const t = task({ recurrence: daily('2026-10-01') });
  assert.deepEqual(t.completedAt, {});
  const first = setCompletion(t, '2026-10-05', true, at('2026-10-05', '09:15'));
  assert.equal(first.completions['2026-10-05'], true);
  assert.equal(first.completedAt['2026-10-05'], at('2026-10-05', '09:15').toISOString());
  const again = setCompletion(first, '2026-10-05', true, at('2026-10-05', '21:00'));
  assert.equal(again.completedAt['2026-10-05'], first.completedAt['2026-10-05']);
  const undone = setCompletion(again, '2026-10-05', false);
  assert.deepEqual(undone.completedAt, {});
  assert.deepEqual(undone.completions, {});
  assert.deepEqual(t.completedAt, {}, 'the original is not changed');
});

test('the moment follows the occurrence when a repeating task is split or an occurrence is deleted', () => {
  let t = task({ recurrence: daily('2026-10-01') });
  for (const k of ['2026-10-02', '2026-10-06']) t = setCompletion(t, k, true, at(k, '10:00'));
  const { updated, created } = editTask(t, 'following', '2026-10-04', { title: 'Renamed' }, { newId: 'split1' });
  assert.deepEqual(Object.keys(updated.completedAt), ['2026-10-02']);
  assert.deepEqual(Object.keys(created.completedAt), ['2026-10-06']);
  const one = deleteOccurrences(t, 'this', '2026-10-02');
  assert.deepEqual(Object.keys(one.completedAt), ['2026-10-06']);
  assert.deepEqual(Object.keys(one.completions), ['2026-10-06']);
  const tail = deleteOccurrences(t, 'following', '2026-10-04');
  assert.deepEqual(Object.keys(tail.completedAt), ['2026-10-02']);
});

test('saved data keeps the moments, ignores bad ones, and still loads tasks saved before they existed', () => {
  let t = task({ recurrence: daily('2026-10-01') });
  t = setCompletion(t, '2026-10-02', true, at('2026-10-02', '08:00'));
  const raw = JSON.parse(JSON.stringify(t));
  raw.completedAt['2026-10-03'] = 'not a date';
  raw.completedAt['2026-10-04'] = 42;
  const loaded = normalizeData({ tasks: [raw] }).data.tasks[0];
  assert.deepEqual(Object.keys(loaded.completedAt), ['2026-10-02']);
  const old = JSON.parse(JSON.stringify(t));
  delete old.completedAt;
  assert.deepEqual(normalizeData({ tasks: [old] }).data.tasks[0].completedAt, {});
});

test('the service records the time of the tick, using its own clock', () => {
  let n = 0;
  const service = new PlannerService({ store: new MemoryStore(), now: () => NOW, newId: () => `c${++n}`, providerFactory: () => constantProvider });
  service.saveTask({ mode: 'create', form: { title: 'A', start: fixed('08:00'), durationMinutes: 30, date: TODAY, recurrence: null, reminders: { enabled: false, offsets: [] }, priority: 'Medium', categoryId: null, notes: '' } });
  service.setDone({ taskId: 'c1', dateKey: TODAY, done: true });
  assert.equal(service.getTasks()[0].completedAt[TODAY], NOW.toISOString());
});

test('the list of charts: the settings list and the screen agree, all are shown by default, and bad lists are refused', () => {
  const screen = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'stats.js'), 'utf8');
  const listed = Array.from(screen.matchAll(/\['([a-z-]+)', '([^']+)', '([^']+)'\]/g)).map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(listed, STATS_CHARTS.map((c) => [c.id, c.title, c.about]));
  assert.deepEqual(DEFAULT_SETTINGS.statsCharts, STATS_CHART_IDS);
  assert.notEqual(DEFAULT_SETTINGS.statsCharts, STATS_CHART_IDS, 'the default is a copy');
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, { statsCharts: ['trend', 'bars'] }).statsCharts, ['trend', 'bars']);
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, { statsCharts: [] }).statsCharts, [], 'all charts may be removed');
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { statsCharts: ['bars', 'bars'] }), /each one only once/);
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { statsCharts: ['pie'] }), /from the list/);
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { statsCharts: 'bars' }), /from the list/);
  assert.deepEqual(sanitizeSettings({ statsCharts: ['late', 'nope'] }).statsCharts, STATS_CHART_IDS, 'a bad saved list falls back to the default');
  assert.deepEqual(sanitizeSettings({ statsCharts: ['late', 'zones'] }).statsCharts, ['late', 'zones']);
});
