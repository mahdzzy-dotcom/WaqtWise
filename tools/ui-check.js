'use strict';

// Clicks through the real screens in a headless browser and checks what happens.
// Run with:  node tools/ui-check.js   (needs Playwright; not part of the installed app)

process.env.TZ = process.env.TZ || 'Africa/Cairo';
const assert = require('node:assert/strict');
const fs = require('fs');
const { createService, openApp, openAlertPage } = require('./ui-harness');

const playwright = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const executablePath = process.env.CHROMIUM_PATH || undefined;
const shotDir = process.env.SHOT_DIR || null;
// The font files are copied in by "npm install". Without them the browser reports "file not found" for the
// font requests and the app uses the system font; that is not a page error.
const fontsMissing = !fs.existsSync(require('path').join(__dirname, '..', 'src', 'renderer', 'fonts', 'PlusJakartaSans-latin-400.woff2'));
const realErrors = (list) => list.filter((e) => !(fontsMissing && /ERR_FILE_NOT_FOUND/.test(e)));

let passed = 0;
async function step(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // ONLY=text runs just the matching steps
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
    process.exitCode = 1;
  }
}

async function shot(page, name) {
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: `${shotDir}/${name}.png` });
  }
}

// A task row, found by its exact title (not by words that happen to appear in another row's tags).
const taskRow = (page, title) =>
  page.locator('.task').filter({ has: page.locator('.task-title', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

const rowTexts = (page, zone) => page.$$eval(`.zone.z${zone} .task .task-title`, (els) => els.map((e) => e.textContent));
const figure = (page, zone, label) =>
  page.$eval(`.zone.z${zone} .zone-figures`, (el, l) => {
    const span = Array.from(el.children).find((c) => c.textContent.startsWith(l));
    return span.querySelector('b').textContent;
  }, label);

async function setTime(page, hour, minute, ampm) {
  await page.selectOption('select[aria-label="Hour"]', String(hour));
  await page.selectOption('select[aria-label="Minute"]', String(minute));
  await page.selectOption('select[aria-label="AM or PM"]', ampm);
}

(async () => {
  const exampleSeed = require(process.env.SEED_PATH || './ui-seed');
  const service = createService();
  exampleSeed(service);
  const app = await openApp({ playwright, service, executablePath, width: 1100, height: 1100 });
  const { page, errors } = app;

  console.log('Start-up splash');
  await step('the splash shows the icon, name, slogan and zone strip, then fades away by itself', async () => {
    const splashApp = await openApp({ playwright, service: createService(), executablePath, width: 1100, height: 700, keepSplash: true });
    assert.equal(await splashApp.page.isVisible('#splash'), true);
    assert.equal(await splashApp.page.textContent('.splash-title'), 'WaqtWise');
    assert.equal(await splashApp.page.textContent('.splash-slogan'), 'Make every waqt count, wisely.');
    assert.equal((await splashApp.page.$$('.splash-strip > div')).length, 5);
    assert.ok(await splashApp.page.$eval('.splash-logo', (img) => img.complete && img.naturalWidth > 100), 'the big icon loaded');
    await splashApp.page.waitForTimeout(500);
    await shot(splashApp.page, 'splash');
    await splashApp.page.waitForSelector('#splash', { state: 'detached', timeout: 6000 });
    await splashApp.browser.close();
  });
  await step('a click skips the splash', async () => {
    const skipApp = await openApp({ playwright, service: createService(), executablePath, width: 1100, height: 700, keepSplash: true });
    await skipApp.page.waitForSelector('.zone');
    await skipApp.page.click('#splash');
    await skipApp.page.waitForSelector('#splash', { state: 'detached', timeout: 2000 });
    await skipApp.browser.close();
  });

  console.log('Daily View');
  await step('shows the header, Hijri date, Planning Day line and 5 zones', async () => {
    assert.match(await page.textContent('.day-title'), /Sunday, October 4, 2026/);
    assert.match(await page.textContent('.day-sub'), /1448/);
    assert.match(await page.textContent('.day-sub'), /Planning Day: Oct 4 → Oct 5/);
    assert.equal((await page.$$('.zone')).length, 5);
    assert.equal(await page.$$eval('.zone-name', (els) => els.map((e) => e.firstChild.textContent)).then((a) => a.join('|')),
      'Fajr → Dhuhr|Dhuhr → Asr|Asr → Maghrib|Maghrib → Isha|Isha → Fajr');
  });
  await step('each task is a piece on its zone bar, in its category colour, placed and sized by its time', async () => {
    const pieces = await page.$$eval('.zone.z1 .timeline .seg', (els) => els.map((e) => ({
      title: e.title, left: parseFloat(e.style.left), width: parseFloat(e.style.width), color: e.style.backgroundColor,
    })));
    assert.equal(pieces.length, 5, 'one piece for each of the 5 tasks in the first zone');
    const study = pieces.find((p) => p.title.startsWith('Study SQL'));
    assert.equal(study.color, 'rgb(139, 92, 246)', 'Study = purple');
    const exercise = pieces.find((p) => p.title.startsWith('Exercise'));
    assert.equal(exercise.color, 'rgb(239, 68, 68)', 'Health = red');
    // 90 minutes against 45 minutes: twice as long
    assert.ok(Math.abs(study.width / exercise.width - 2) < 0.05, `widths follow durations (${study.width} vs ${exercise.width})`);
    assert.ok(study.left < exercise.left, 'placed by start time');
  });
  await step('highlights the current zone only', async () => {
    const current = await page.$$eval('.zone.current', (els) => els.map((e) => e.getAttribute('aria-label')));
    assert.deepEqual(current, ['Fajr → Dhuhr']);
    assert.equal((await page.$$('.now-chip')).length, 1);
  });
  await step('shows the three duration figures for every zone, empty zones included', async () => {
    assert.equal(await figure(page, 1, 'Total'), '6h 43m');
    assert.equal(await figure(page, 4, 'Total'), '1h 20m');
    assert.equal(await figure(page, 4, 'Scheduled'), '0m');
    assert.equal(await figure(page, 4, 'Free'), '1h 20m');
    assert.match(await page.textContent('.zone.z4 .empty-zone'), /No tasks/);
  });
  await step('rows show time, title, duration, indicators; after-midnight task has a "next day" label', async () => {
    assert.deepEqual(await rowTexts(page, 1), ['Morning Routine', 'Study SQL', 'Exercise', 'Long call with the team', 'Review notes']);
    const study = taskRow(page, 'Study SQL');
    assert.match(await study.textContent(), /8:00 AM/);
    assert.match(await study.textContent(), /1h 30m/);
    assert.doesNotMatch(await study.textContent(), /Repeats|Reminder/, 'repeat and reminder tags are not shown on rows');
    assert.match(await study.textContent(), /Not done/);
    assert.match(await taskRow(page, 'Night reading').textContent(), /next day/);
    assert.match(await page.locator('.zone.z2 .continues').first().textContent(), /Continues from/);
    assert.equal((await page.$$('.task .tag.warn')).length, 2, 'two overlapping tasks are flagged');
  });
  await step('Arabic titles display', async () => {
    assert.ok((await rowTexts(page, 5)).includes('مراجعة الدرس'));
  });

  console.log('Navigation');
  await step('previous / next / Today / date picker', async () => {
    await page.click('button[aria-label="Next day"]');
    await page.waitForFunction(() => document.querySelector('.day-title').textContent.includes('October 5'));
    assert.equal((await page.$$('.today-badge')).length, 0);
    assert.equal((await page.$$('.zone.current')).length, 0);
    // The 2 AM task belongs to Oct 4, so Oct 5 does not show it
    assert.ok(!(await page.textContent('#view')).includes('Night reading'));
    await page.click('button[aria-label="Previous day"]');
    await page.click('button[aria-label="Previous day"]');
    await page.waitForFunction(() => document.querySelector('.day-title').textContent.includes('October 3'));
    await page.click('button:text-is("Today")');
    await page.waitForFunction(() => document.querySelector('.day-title').textContent.includes('October 4'));
    await page.fill('input[aria-label="Jump to date"]', '2026-10-09');
    await page.waitForFunction(() => document.querySelector('.day-title').textContent.includes('October 9'));
    assert.deepEqual(await rowTexts(page, 4), ['Gym'], 'the Friday repeat appears');
    await page.click('button:text-is("Today")');
    await page.waitForSelector('.today-badge');
  });

  console.log('Adding tasks');
  await step('12-hour time picker + live end time + zone', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Dentist');
    await setTime(page, 3, 30, 'PM');
    await page.fill('input[aria-label="Duration hours"]', '1');
    await page.fill('input[aria-label="Duration minutes"]', '15');
    await page.waitForFunction(() => document.querySelector('.readout[aria-label="End time"]').textContent === '4:45 PM');
    assert.equal(await page.textContent('.readout.zone-readout'), 'Asr → Maghrib');
    await shot(page, 'form-fixed');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 3)).includes('Dentist'));
    // Read Quran 3:24-3:54 PM and Dentist 3:30-4:45 PM overlap, so the overlap is counted once: 3:24-4:45 PM
    assert.equal(await figure(page, 3, 'Scheduled'), '1h 21m');
    assert.equal((await page.$$('.zone.z3 .tag.warn')).length, 2, 'both overlapping tasks are flagged');
  });
  await step('prayer-relative start shows the resolved time and follows the prayer', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Before Maghrib walk');
    await page.click('button:text-is("Relative to Prayer")');
    await page.selectOption('select[aria-label="Prayer"]', 'maghrib');
    await page.selectOption('select[aria-label="Before or after"]', 'before');
    await page.fill('input[aria-label="Minutes"]', '45');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '5:15 PM');
    assert.equal(await page.textContent('.readout.zone-readout'), 'Asr → Maghrib');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    const row = taskRow(page, 'Before Maghrib walk');
    assert.match(await row.textContent(), /5:15 PM/);
  });
  await step('a 2:00 AM task entered on Oct 5 shows the Planning Day note and lands in Zone 5 of Oct 4', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Tahajjud');
    await setTime(page, 2, 0, 'AM');
    await page.fill('#f-date', '2026-10-05');
    await page.waitForSelector('.note.placement:not([hidden])');
    assert.equal(await page.textContent('.note.placement'), 'Will appear under Planning Day: Oct 4 → Oct 5, Zone: Isha → Fajr');
    await shot(page, 'form-after-midnight');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 5)).includes('Tahajjud'));
  });
  await step('validation: empty title and zero duration show friendly messages and nothing is saved', async () => {
    const before = service.data.tasks.length;
    await page.click('#add-btn');
    await page.fill('input[aria-label="Duration minutes"]', '0');
    await page.fill('input[aria-label="Duration hours"]', '0');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.errors:not([hidden])');
    const text = await page.textContent('.errors');
    assert.match(text, /Please enter a title/);
    assert.match(text, /Duration/);
    assert.equal(service.data.tasks.length, before);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.dialog', { state: 'detached' });
  });
  await step('repeating task: weekday toggles, live summary and next-5 preview', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Class');
    await page.click('button:text-is("Repeats")');
    await page.selectOption('select[aria-label="Repeat unit"]', 'weekly');
    await page.fill('input[aria-label="Repeat every"]', '2');
    await page.click('.daytoggle button:text-is("Mon")');
    await page.click('.daytoggle button:text-is("Wed")');
    await page.waitForFunction(() => /Every 2 weeks on/.test(document.querySelector('.summary').textContent));
    const summary = await page.textContent('.summary');
    assert.match(summary, /Every 2 weeks on Sun, Mon, Wed, starting Oct 4/);
    assert.equal((await page.$$('.preview-list li')).length, 6, 'heading + 5 dates');
    await shot(page, 'form-weekly');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 1)).concat(await rowTexts(page, 2)).includes('Class'));
  });
  await step('reminders: add and remove custom times; default hint when empty', async () => {
    await page.click('#add-btn');
    assert.match(await page.textContent('.hint >> text=/No custom times/'), /default reminder \(10 min before\)/);
    await page.fill('input[aria-label="Reminder amount"]', '1');
    await page.selectOption('select[aria-label="Reminder unit"]', '60');
    await page.click('button:text-is("Add reminder")');
    await page.click('button:text-is("At start time")');
    assert.deepEqual(await page.$$eval('.chip > span', (els) => els.map((e) => e.textContent)), ['1 hour before', 'At start time']);
    await page.click('button[aria-label="Remove 1 hour before"]');
    assert.deepEqual(await page.$$eval('.chip > span', (els) => els.map((e) => e.textContent)), ['At start time']);
    await page.click('.segmented[aria-label="Reminder on or off"] button:text-is("Off")');
    assert.equal((await page.$$('.chip')).length, 0);
    await page.keyboard.press('Escape');
  });

  await step('task form: the full-screen alert switch is off by default, can be switched on, and shows on the row', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Alarm task');
    assert.equal(await page.isChecked('#f-fullscreen'), false);
    await page.check('#f-fullscreen');
    await shot(page, 'form-fullscreen-switch');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.doesNotMatch(await taskRow(page, 'Alarm task').textContent(), /Full-screen alert/, 'not shown on the row');
    assert.equal(service.data.tasks.find((t) => t.title === 'Alarm task').reminders.fullScreen, true);
  });

  console.log('Tasks relative to tasks');
  await step('"Relative to Task": pick a task, minutes, before/after, start/end - the start time updates live', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Warm-up');
    await page.click('button:text-is("Relative to Task")');
    await page.selectOption('select[aria-label="Task to follow"]', { label: 'Study SQL (8:00 AM, 1h 30m, repeats)' });
    await page.fill('input[aria-label="Minutes"]', '15');
    const startText = () => page.$$eval('.readout', (els) => els[0].textContent);
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '9:45 AM');
    assert.equal(await page.textContent('.readout.zone-readout'), 'Fajr → Dhuhr');
    await page.selectOption('select[aria-label="Start or end of that task"]', 'start');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '8:15 AM');
    await page.selectOption('select[aria-label="Before or after"]', 'before');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '7:45 AM');
    await page.selectOption('select[aria-label="Start or end of that task"]', 'end');
    await page.selectOption('select[aria-label="Before or after"]', 'after');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '9:45 AM');
    assert.equal(await startText(), '9:45 AM');
    assert.equal(await page.isHidden('.note.start-warning'), true, 'no warning when the other task is on that day');
    await shot(page, 'form-relative-task');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    const row = taskRow(page, 'Warm-up');
    assert.match(await row.textContent(), /9:45 AM/);
    assert.doesNotMatch(await row.textContent(), /Follows/, 'the "follows" tag is not shown on rows');
  });
  await step('when the other task is not on that day, a warning and the backup time are shown', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Gym buddy');
    await page.click('button:text-is("Relative to Task")');
    await page.selectOption('select[aria-label="Task to follow"]', { label: 'Gym (6:30 PM, 1h 0m, repeats)' });
    await page.waitForSelector('.note.start-warning:not([hidden])');
    assert.match(await page.textContent('.note.start-warning'), /not on this day/);
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '9:00 AM');
    await setTime(page, 3, 0, 'PM');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '3:00 PM');
    await shot(page, 'form-backup-warning');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    const row = taskRow(page, 'Gym buddy');
    assert.match(await row.textContent(), /3:00 PM/);
    assert.match(await row.textContent(), /Backup start time/);
  });
  await step('a task cannot be offered itself, and a missing choice is reported', async () => {
    await taskRow(page, 'Warm-up').click();
    await page.waitForSelector('.dialog');
    const options = await page.$$eval('select[aria-label="Task to follow"] option', (els) => els.map((e) => e.textContent));
    assert.ok(options.some((o) => o.startsWith('Study SQL')));
    assert.ok(!options.some((o) => o.startsWith('Warm-up')), 'not itself');
    await page.selectOption('select[aria-label="Task to follow"]', '');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.errors:not([hidden])');
    assert.match(await page.textContent('.errors'), /Choose the task/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.dialog', { state: 'detached' });
  });
  await step('deleting a task that others follow warns, and the followers keep their times', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'Breakfast');
    await setTime(page, 6, 0, 'AM');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });

    await page.click('#add-btn');
    await page.fill('#f-title', 'Walk');
    await page.click('button:text-is("Relative to Task")');
    await page.selectOption('select[aria-label="Task to follow"]', { label: 'Breakfast (6:00 AM, 30m)' });
    await page.fill('input[aria-label="Minutes"]', '10');
    await page.waitForFunction(() => document.querySelectorAll('.readout')[0].textContent === '6:40 AM');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });

    await taskRow(page, 'Breakfast').click();
    await page.click('.dialog-footer .btn.danger');
    await page.waitForSelector('text=Other tasks follow this task');
    assert.match(await page.textContent('.overlay:last-child .dialog-message'), /“Walk”/);
    await shot(page, 'delete-warning');
    await page.click('.overlay:last-child .btn:text-is("Cancel")');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.overlay', { state: 'detached' });
    assert.ok((await rowTexts(page, 1)).includes('Breakfast'), 'cancel keeps it');

    await taskRow(page, 'Breakfast').click();
    await page.click('.dialog-footer .btn.danger');
    await page.waitForSelector('text=Other tasks follow this task');
    await page.click('.overlay:last-child .btn.danger');
    await page.waitForSelector('.overlay', { state: 'detached' });
    assert.ok(!(await rowTexts(page, 1)).includes('Breakfast'));
    const walk = taskRow(page, 'Walk');
    assert.match(await walk.textContent(), /6:40 AM/);
    assert.ok(!/Follows/.test(await walk.textContent()), 'it is a fixed time now');
  });

  console.log('Editing');
  await step('toggling done from the row', async () => {
    const row = taskRow(page, 'Exercise');
    await row.locator('.check').click();
    await page.waitForSelector('.task.done:has-text("Exercise")');
    assert.equal(await row.locator('.check.on').count(), 1);
  });
  await step('a sound plays when a task is ticked as done, and not when the tick is taken back', async () => {
    await page.evaluate(() => {
      window.__played = [];
      window.WW.sounds.play = (id, volume) => { window.__played.push([id, volume]); return { stop() {} }; };
    });
    const row = taskRow(page, 'Review notes');
    await row.locator('.check').click();
    await page.waitForSelector('.task.done:has-text("Review notes")');
    assert.deepEqual(await page.evaluate(() => window.__played), [['chime', 60]]);
    await row.locator('.check').click();
    await page.waitForSelector('.task:not(.done):has-text("Review notes")');
    assert.deepEqual(await page.evaluate(() => window.__played), [['chime', 60]], 'no sound for un-ticking');
  });
  await step('edit a one-off task', async () => {
    await taskRow(page, 'Dentist').click();
    await page.waitForSelector('.dialog');
    assert.equal(await page.inputValue('#f-title'), 'Dentist');
    await page.fill('#f-title', 'Dentist (moved)');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 3)).includes('Dentist (moved)'));
  });
  await step('editing one repeating occurrence: scope chooser, "This occurrence only"', async () => {
    await taskRow(page, 'Study SQL').click();
    await page.waitForSelector('.dialog');
    await page.fill('#f-title', 'Study SQL (today)');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('text=Save which occurrences');
    await shot(page, 'scope-dialog');
    assert.equal((await page.$$('input[name="scope"]:checked')).length, 1);
    await page.click('.overlay:last-child .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 1)).includes('Study SQL (today)'));
    await page.click('button[aria-label="Next day"]');
    await page.waitForFunction(() => document.querySelector('.day-title').textContent.includes('October 5'));
    assert.ok((await rowTexts(page, 1)).includes('Study SQL'), 'tomorrow keeps the old title');
    await page.click('button:text-is("Today")');
  });
  await step('changing the repeat pattern disables "This occurrence only"', async () => {
    await taskRow(page, 'Class').first().click();
    await page.waitForSelector('.dialog');
    await page.fill('input[aria-label="Repeat every"]', '3');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('text=Save which occurrences');
    assert.equal(await page.isDisabled('input[name="scope"] >> nth=0'), true);
    assert.match(await page.textContent('.overlay:last-child .hint'), /repeat pattern can only be changed/);
    await page.click('.overlay:last-child .btn:text-is("Cancel")');
    await page.keyboard.press('Escape');
  });
  await step('deleting a repeating task asks for scope; deleting a one-off asks to confirm', async () => {
    await taskRow(page, 'Class').first().click();
    await page.click('.dialog-footer .btn.danger');
    await page.waitForSelector('text=Delete which occurrences');
    await page.click('input[name="scope"] >> nth=2');
    await page.click('.overlay:last-child .btn.primary');
    await page.waitForSelector('.overlay', { state: 'detached' });
    assert.ok(!(await page.textContent('#view')).includes('Class'));

    await taskRow(page, 'Tahajjud').click();
    await page.click('.dialog-footer .btn.danger');
    await page.waitForSelector('text=Delete "Tahajjud"?');
    await page.click('.overlay:last-child .btn.danger');
    await page.waitForSelector('.overlay', { state: 'detached' });
    assert.ok(!(await page.textContent('#view')).includes('Tahajjud'));
  });
  await step('duplicate', async () => {
    await taskRow(page, 'Exercise').click();
    await page.click('.dialog-footer .btn:text-is("Duplicate")');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 1)).includes('Exercise (copy)'));
  });
  await step('Arabic text can be typed and saved', async () => {
    await page.click('#add-btn');
    await page.fill('#f-title', 'قراءة القرآن');
    await page.fill('#f-notes', 'ملاحظات مهمة');
    await page.click('.dialog-footer .btn.primary');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.ok((await rowTexts(page, 1)).includes('قراءة القرآن'));
  });

  console.log('Bell, menu, missed reminders');
  await step('bell is dim with no missed reminders, then shows a red count and lists them', async () => {
    assert.equal(await page.locator('#bell-btn.bell-empty').count(), 1);
    assert.equal(await page.locator('#bell-btn .bell-badge').count(), 0);
    await page.click('#bell-btn');
    await page.waitForSelector('#bell-panel:not([hidden])');
    assert.match(await page.textContent('#bell-panel'), /No missed reminders/);
    await page.click('#bell-btn');
    service.addMissed([{ taskId: 't2', dateKey: '2026-10-04', title: 'Study SQL', start: new Date('2026-10-04T05:00:00Z'), zoneName: 'Fajr → Dhuhr', alreadyStarted: true }]);
    await page.evaluate(() => window.__handlers['data-changed']());
    await page.waitForSelector('#bell-btn .bell-badge');
    assert.equal(await page.textContent('#bell-btn .bell-badge'), '1');
    assert.equal(await page.locator('#bell-btn.bell-empty').count(), 0);
    await page.click('#bell-btn');
    await page.waitForSelector('#bell-panel:not([hidden]) .upcoming-item');
    await shot(page, 'bell');
    await page.click('#bell-panel .upcoming-item');
    await page.waitForSelector('.dialog');
    await page.click('.dialog-header .icon-btn');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.equal(await page.locator('#bell-btn .bell-badge').count(), 0);
  });
  await step('theme button switches between light and dark', async () => {
    const before = await page.getAttribute('#theme-btn', 'aria-label');
    await page.click('#theme-btn');
    await page.waitForFunction(() => ['light', 'dark'].includes(document.documentElement.dataset.theme));
    assert.notEqual(await page.getAttribute('#theme-btn', 'aria-label'), before);
    await shot(page, 'daily-dark');
    await page.click('#theme-btn');
    await page.waitForTimeout(150);
    assert.equal(await page.getAttribute('#theme-btn', 'aria-label'), before);
  });
  await step('side menu: Daily View, Statistics, Settings, Export data, Import data; Esc closes it', async () => {
    await page.click('#menu-btn');
    const items = await page.$$eval('#drawer .drawer-item', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(items, ['Daily View', 'Statistics', 'Settings', 'Export data…', 'Import data…']);
    await shot(page, 'drawer');
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#drawer'), true);
  });
  await step('menu opens Settings', async () => {
    await page.click('#menu-btn');
    await page.click('#drawer .drawer-item:has-text("Settings")');
    await page.waitForSelector('.settings-section');
  });
  await step('missed-reminders summary dialog', async () => {
    await page.evaluate(() => window.__handlers.missed([
      { taskId: 't2', dateKey: '2026-10-04', title: 'Study SQL', startLabel: '8:00 AM', zoneName: 'Fajr → Dhuhr', alreadyStarted: true },
    ]));
    await page.waitForSelector('text=You missed 1 reminder');
    await shot(page, 'missed');
    await page.click('.overlay .btn.primary');
  });

  console.log('Settings');
  await step('every section is there', async () => {
    const titles = await page.$$eval('.settings-section h2', (els) => els.map((e) => e.textContent));
    assert.deepEqual(titles, ['Prayer Times', 'Reminders & Notifications', 'Application', 'Full-screen reminder', 'Sounds', 'Categories', 'Data']);
    await shot(page, 'settings');
  });
  await step('prayer adjustment is saved and moves the zone boundary', async () => {
    await page.fill('input[aria-label="Asr adjustment in minutes"]', '5');
    await page.press('input[aria-label="Asr adjustment in minutes"]', 'Enter');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(150);
    assert.equal(service.getSettings().adjustments.asr, 5);
  });
  await step('invalid value shows an error and is not kept', async () => {
    await page.fill('input[aria-label="Snooze minutes"]', '0');
    await page.press('input[aria-label="Snooze minutes"]', 'Enter');
    await page.waitForSelector('.toast.error');
    assert.match(await page.textContent('.toast.error'), /Snooze/);
    assert.equal(service.getSettings().snoozeMinutes, 5);
  });
  await step('theme switches instantly and is saved', async () => {
    await page.selectOption('select[aria-label="Theme"]', 'dark');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(service.getSettings().theme, 'dark');
    await shot(page, 'settings-dark');
    await page.selectOption('select[aria-label="Theme"]', 'light');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.selectOption('select[aria-label="Theme"]', 'system');
    await page.waitForFunction(() => document.documentElement.dataset.theme === undefined);
  });
  await step('sounds: choices and volumes are saved, Preview plays the chosen sound, repeat switch saves', async () => {
    await page.evaluate(() => {
      window.__played = [];
      window.WW.sounds.play = (id, volume) => { window.__played.push([id, volume]); return { stop() {} }; };
    });
    await page.selectOption('select[aria-label="Task done sound"]', 'ding');
    await page.waitForTimeout(150);
    assert.equal(service.getSettings().doneSound, 'ding');
    await page.fill('input[aria-label="Task done volume"]', '35');
    await page.dispatchEvent('input[aria-label="Task done volume"]', 'change');
    await page.waitForTimeout(150);
    assert.equal(service.getSettings().doneSoundVolume, 35);
    await page.click('button[aria-label="Preview the task done sound"]');
    assert.deepEqual(await page.evaluate(() => window.__played), [['ding', 35]]);
    await page.selectOption('select[aria-label="Full-screen alert sound"]', 'rising');
    await page.waitForTimeout(150);
    assert.equal(service.getSettings().alertSound, 'rising');
    await page.click('label:has-text("Keep repeating until a button is pressed") input');
    await page.waitForTimeout(150);
    assert.equal(service.getSettings().alertSoundRepeat, true);
    await shot(page, 'settings-sounds');
  });
  await step('toggles save: sound, zone-start, start with Windows', async () => {
    await page.click('label:has-text("Play a sound") input');
    await page.click('label:has-text("Notify when each Zone begins") input');
    await page.click('label:has-text("Start WaqtWise when Windows starts") input');
    await page.waitForTimeout(200);
    const s = service.getSettings();
    assert.equal(s.soundEnabled, false);
    assert.equal(s.zoneStartNotifications, true);
    assert.equal(s.startWithWindows, true);
  });
  await step('working days', async () => {
    await page.click('.settings-section .daytoggle button:text-is("Fri")');
    await page.waitForTimeout(200);
    assert.deepEqual(service.getSettings().workingDays, [0, 1, 2, 3, 4, 5]);
  });
  await step('categories: add, rename, delete', async () => {
    await page.fill('input[aria-label="New category name"]', 'Family');
    await page.click('.cat-row .btn:text-is("Add")');
    await page.waitForSelector('input[aria-label="Name of Family"]');
    await page.fill('input[aria-label="Name of Family"]', 'Home');
    await page.press('input[aria-label="Name of Family"]', 'Enter');
    await page.waitForSelector('input[aria-label="Name of Home"]');
    assert.ok(service.data.categories.some((c) => c.name === 'Home'));
    await page.locator('.cat-row', { has: page.locator('input[aria-label="Name of Home"]') }).locator('.btn.danger').click();
    await page.click('.overlay .btn.danger');
    await page.waitForSelector('input[aria-label="Name of Home"]', { state: 'detached' });
    assert.ok(!service.data.categories.some((c) => c.name === 'Home'));
  });
  await step('export button asks the app to export', async () => {
    await page.click('.settings-section button:text-is("Export data…")');
    await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(() => window.__exports), ['export']);
  });
  await step('the "Send a test notification" button asks the app to send one', async () => {
    await page.click('button:text-is("Send a test notification")');
    await page.waitForSelector('.toast:has-text("Test notification sent")');
    assert.deepEqual(await page.evaluate(() => window.__exports), ['export', 'test-notification']);
  });
  await step('full-screen reminder settings: colors, sizes, switches and looks are saved and the preview follows', async () => {
    const preview = (fn, arg) => page.$eval('.alert-preview', fn, arg);
    const setColor = (label, value) => page.$eval(`input[aria-label="${label}"]`, (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
    const setSlider = (label, value) => page.$eval(`input[aria-label="${label}"]`, (el, v) => {
      el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);

    await setColor('Background color', '#336699');
    await page.waitForTimeout(150);
    assert.equal(service.getSettings().alertAppearance.backgroundColor, '#336699');
    assert.equal(await preview((el) => el.querySelector('.alert-stage').style.getPropertyValue('--a-bg')), '#336699');

    await setColor('Text color', '#ffeecc');
    await setColor('Task name color', '#00ff00');
    await setSlider('Task name size', 120);
    await page.waitForTimeout(150);
    assert.equal(service.getSettings().alertAppearance.name.size, 120);
    assert.equal(service.getSettings().alertAppearance.name.color, '#00ff00');
    assert.equal(await preview((el) => el.querySelector('.alert-name').style.fontSize), '120px');
    assert.equal(await preview((el) => el.querySelector('.alert-name').style.color), 'rgb(0, 255, 0)');

    await setSlider('Notes size', 50);
    await page.click('label:has-text("CAPITALS") input');
    await page.click('label:has-text("Italic") >> nth=0');
    await page.selectOption('select[aria-label="Font"]', 'Georgia');
    await page.selectOption('select[aria-label="Alignment"]', 'left');
    await page.waitForTimeout(200);
    const a = service.getSettings().alertAppearance;
    assert.deepEqual([a.notes.size, a.name.uppercase, a.name.italic, a.fontFamily, a.alignment], [50, true, true, 'Georgia', 'left']);
    assert.equal(await preview((el) => el.querySelector('.alert-name').style.textTransform), 'uppercase');
    assert.match(await preview((el) => el.querySelector('.alert-stage').style.getPropertyValue('--a-font')), /Georgia/);
    assert.equal(await preview((el) => el.querySelector('.alert-stage').style.getPropertyValue('--a-align')), 'left');

    await page.click('label:has-text("Show the notes") input');
    await page.click('input[aria-label="Zone"]');
    await page.waitForTimeout(150);
    assert.equal(await preview((el) => el.querySelectorAll('.alert-notes').length), 0, 'notes hidden');
    assert.ok(!(await preview((el) => el.textContent)).includes('Zone:'), 'zone hidden');
    await shot(page, 'settings-fullscreen');

    await page.click('button:text-is("High contrast")');
    await page.waitForFunction(() => document.querySelector('.alert-preview .alert-stage').style.getPropertyValue('--a-bg') === '#000000');
    const hc = service.getSettings().alertAppearance;
    assert.deepEqual([hc.backgroundColor, hc.name.uppercase, hc.name.size, hc.notes.show, hc.show.zone], ['#000000', true, 96, true, true]);

    assert.equal(await page.$$eval('input.onoff', (els) => els.length), 2, 'Windows notifications and full-screen reminders are real on/off switches');
    assert.equal(await page.textContent('label.onoff-row:has-text("Full-screen reminders") .onoff-state'), 'On');
    await page.click('label:has-text("Full-screen reminders") input');
    assert.equal(await page.textContent('label.onoff-row:has-text("Full-screen reminders") .onoff-state'), 'Off');
    await page.click('label:has-text("Switch the full-screen alert on for new tasks") input');
    await page.selectOption('select[aria-label="Screens"]', 'main');
    await page.waitForTimeout(200);
    const st = service.getSettings();
    assert.deepEqual([st.fullScreenAlerts, st.fullScreenDefaultForNewTasks, st.alertScreens], [false, true, 'main']);
    await page.click('label:has-text("Full-screen reminders") input'); // back on

    await page.click('button:text-is("Preview full screen")');
    await page.waitForTimeout(150);
    assert.ok((await page.evaluate(() => window.__exports)).includes('preview-alert'));
  });
  await step('back to the Daily View keeps working', async () => {
    await page.click('.back-link');
    await page.waitForSelector('.zone');
    assert.equal((await page.$$('.zone')).length, 5);
  });

  await step('no errors were reported by the page', async () => {
    assert.deepEqual(realErrors(errors), []);
  });

  await app.browser.close();

  console.log('Full-screen reminder page');
  await step('the page shows task name, notes and details, and ignores presses during the first moment', async () => {
    const alert = await openAlertPage({ playwright, executablePath });
    const base = require('../src/core').DEFAULT_ALERT_APPEARANCE;
    const item = (id, title, extra = {}) => ({
      id, taskId: `t-${id}`, dateKey: '2026-10-04', title, notes: 'Bring the red folder\nCall the office first', startLabel: '12:00 PM',
      endLabel: '12:45 PM', durationLabel: '45m', zoneName: 'Dhuhr → Asr', zoneIndex: 2, categoryName: 'Work', categoryColor: '#3b82f6',
      priority: 'High', snoozed: false, ...extra,
    });
    const p = alert.page;
    await p.evaluate(([st]) => window.__render(st), [{ items: [item('a1', 'Team meeting'), item('a2', 'Second task')], appearance: base, snoozeMinutes: 7, guardMs: 600 }]);
    const text = await p.textContent('body');
    for (const part of ['Starts now', 'Team meeting', 'Bring the red folder', 'Call the office first', '12:00 PM', '45m', 'Dhuhr → Asr', 'Work', 'High priority', '1 more task starting now', 'Snooze 7 min']) {
      assert.ok(text.includes(part), `shows "${part}"`);
    }
    assert.equal(await p.$$eval('.alert-actions button', (els) => els.every((b) => b.disabled)), true, 'buttons are locked at first');
    await p.keyboard.press('Escape');
    await p.click('.alert-actions button.primary', { force: true, timeout: 1000 }).catch(() => {});
    assert.deepEqual(await p.evaluate(() => window.__actions), [], 'nothing was pressed through');

    await p.waitForFunction(() => document.querySelector('.alert-actions button').disabled === false, null, { timeout: 3000 });
    assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Got it', '"Got it" is ready');
    await shot(p, 'alert-ready');
    await p.click('button[data-action="snooze"]');
    await p.click('button[data-action="done"]');
    await p.click('button[data-action="open"]');
    await p.click('button[data-action="dismiss"]');
    assert.deepEqual(await p.evaluate(() => window.__actions), [['snooze', 'a1'], ['done', 'a1'], ['open', 'a1'], ['dismiss', 'a1']]);
    await p.keyboard.press('Escape');
    assert.deepEqual((await p.evaluate(() => window.__actions)).pop(), ['dismiss', 'a1'], 'Escape = Got it');
    assert.deepEqual(realErrors(alert.errors), []);
    await alert.browser.close();
  });
  await step('the alert rings once per arrival, on one screen only, repeats if asked, and stops when a button is pressed', async () => {
    const alert = await openAlertPage({ playwright, executablePath });
    const p = alert.page;
    const base = require('../src/core').DEFAULT_ALERT_APPEARANCE;
    const item = (id) => ({ id, taskId: `t-${id}`, dateKey: '2026-10-04', title: `Task ${id}`, notes: '', startLabel: '12:00 PM', endLabel: '12:45 PM',
      durationLabel: '45m', zoneName: 'Dhuhr → Asr', zoneIndex: 2, categoryName: '', categoryColor: '', priority: 'Low', snoozed: false });
    await p.evaluate(() => {
      window.__rings = [];
      window.WW.sounds.play = (id, volume, options) => {
        const ring = { id, volume, repeat: Boolean(options && options.repeat), stopped: false };
        window.__rings.push(ring);
        return { stop() { ring.stopped = true; } };
      };
    });
    const render = (extra) => p.evaluate(([st]) => window.__render(st), [{ items: [item('a1'), item('a2')], appearance: base, snoozeMinutes: 5, guardMs: 0,
      sound: { id: 'alarm', volume: 80, repeat: true }, soundSeq: 1, soundHere: true, ...extra }]);
    await render({});
    assert.deepEqual(await p.evaluate(() => window.__rings), [{ id: 'alarm', volume: 80, repeat: true, stopped: false }]);
    await render({}); // same arrival drawn again: no second ring
    assert.equal(await p.evaluate(() => window.__rings.length), 1);
    await p.click('button[data-action="dismiss"]');
    assert.equal(await p.evaluate(() => window.__rings[0].stopped), true, 'pressing a button stops the sound');
    await render({ soundSeq: 2 }); // more tasks arrived
    assert.equal(await p.evaluate(() => window.__rings.length), 2);
    await render({ soundSeq: 3, soundHere: false }); // another screen: silent
    assert.equal(await p.evaluate(() => window.__rings.length), 2);
    await render({ soundSeq: 4, sound: { id: 'off', volume: 80, repeat: false } });
    assert.equal(await p.evaluate(() => window.__rings.length), 2, '"Off" makes no sound');
    assert.deepEqual(realErrors(alert.errors), []);
    await alert.browser.close();
  });
  await step('the page follows the chosen look', async () => {
    const alert = await openAlertPage({ playwright, executablePath });
    const p = alert.page;
    const { DEFAULT_ALERT_APPEARANCE: base } = require('../src/core');
    const look = JSON.parse(JSON.stringify(base));
    Object.assign(look, { backgroundColor: '#112233', textColor: '#aabbcc', accentColor: '#ff00aa', fontFamily: 'Georgia', alignment: 'left' });
    Object.assign(look.name, { size: 110, color: '#ffff00', bold: false, italic: true, uppercase: true });
    Object.assign(look.notes, { size: 44, color: '#00ffff', bold: true, italic: true });
    look.show = { time: true, duration: false, zone: false, category: false, priority: false };
    await p.evaluate(([st]) => window.__render(st), [{
      items: [{ id: 'x', taskId: 't', dateKey: '2026-10-04', title: 'Pay the bill', notes: 'Use the card', startLabel: '9:00 AM', endLabel: '9:30 AM',
        durationLabel: '30m', zoneName: 'Fajr → Dhuhr', zoneIndex: 1, categoryName: 'Home', categoryColor: '#fff', priority: 'Low', snoozed: true }],
      appearance: look, snoozeMinutes: 5, guardMs: 0,
    }]);
    const css = (sel, prop) => p.$eval(sel, (el, pr) => getComputedStyle(el)[pr], prop);
    assert.equal(await css('.alert-stage', 'backgroundColor'), 'rgb(17, 34, 51)');
    assert.equal(await css('.alert-name', 'fontSize'), '110px');
    assert.equal(await css('.alert-name', 'color'), 'rgb(255, 255, 0)');
    assert.equal(await css('.alert-name', 'fontStyle'), 'italic');
    assert.equal(await css('.alert-name', 'textTransform'), 'uppercase');
    assert.equal(await css('.alert-name', 'fontWeight'), '400');
    assert.equal(await css('.alert-notes', 'fontSize'), '44px');
    assert.equal(await css('.alert-notes', 'color'), 'rgb(0, 255, 255)');
    assert.equal(await css('.alert-notes', 'fontWeight'), '700');
    assert.match(await css('.alert-stage', 'fontFamily'), /Georgia/);
    assert.equal(await css('.alert-stage', 'textAlign'), 'left');
    assert.equal(await css('.alert-label', 'color'), 'rgb(255, 0, 170)');
    const text = await p.textContent('.alert-info');
    assert.ok(text.includes('9:00 AM') && !text.includes('30m') && !text.includes('Zone') && !text.includes('Home') && !text.includes('priority'));
    assert.match(await p.textContent('.alert-label'), /Snoozed reminder/i);
    // notes switched off
    look.notes.show = false;
    await p.evaluate(([st]) => window.__render(st), [{ items: [{ id: 'y', taskId: 't', dateKey: 'd', title: 'No notes shown', notes: 'hidden', startLabel: '1:00 PM', endLabel: '2:00 PM',
      durationLabel: '1h 0m', zoneName: 'Dhuhr → Asr', zoneIndex: 2, categoryName: '', categoryColor: '', priority: 'Low', snoozed: false }], appearance: look, snoozeMinutes: 5, guardMs: 0 }]);
    assert.equal((await p.$$('.alert-notes')).length, 0);
    assert.deepEqual(realErrors(alert.errors), []);
    await alert.browser.close();
  });

  console.log('Statistics');
  await step('the Statistics screen follows the range: Day, Week, Month, Year and Custom', async () => {
    const { at } = require('./ui-harness');
    const stats = createService({ now: at('2026-10-10', '15:20') });
    const fixed = (time) => ({ mode: 'fixed', time });
    const make = (f) => stats.saveTask({ mode: 'create', form: { start: fixed('09:00'), durationMinutes: 30, date: null, recurrence: null,
      reminders: { enabled: false, offsets: [] }, priority: 'Medium', categoryId: null, notes: '', ...f } }).taskId;
    const study = make({ title: 'Study SQL', start: fixed('08:00'), durationMinutes: 60, categoryId: 'cat-study', recurrence: { startDate: '2026-08-01', frequency: 'daily', interval: 1 } });
    const walk = make({ title: 'Morning walk', start: fixed('06:00'), durationMinutes: 30, categoryId: 'cat-health', recurrence: { startDate: '2026-08-01', frequency: 'daily', interval: 1 } });
    make({ title: 'Read Quran', start: { mode: 'prayer', prayer: 'asr', direction: 'after', minutes: 10 }, durationMinutes: 30, categoryId: 'cat-worship', recurrence: { startDate: '2026-08-01', frequency: 'daily', interval: 1 } });
    make({ title: 'Send invoice', start: fixed('13:00'), durationMinutes: 30, categoryId: 'cat-work', date: '2026-10-08' });
    // Study is done every day but every fifth; the walk is done on even days.
    for (let d = new Date(2026, 7, 1), i = 0; d <= new Date(2026, 9, 10); d.setDate(d.getDate() + 1), i++) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (i % 5 !== 4) stats.setDone({ taskId: study, dateKey: key, done: true });
      if (d.getDate() % 2 === 0) stats.setDone({ taskId: walk, dateKey: key, done: true });
    }
    const sApp = await openApp({ playwright, service: stats, executablePath, width: 1280, height: 1500 });
    const sp = sApp.page;
    const label = () => sp.textContent('#stats-range-label');
    const pressed = () => sp.$eval('.stats-seg button.on', (b) => b.dataset.range);
    const barCount = () => sp.$$eval('.bars .bar-col', (els) => els.length);

    await sp.click('#menu-btn');
    await sp.click('.drawer-item:has-text("Statistics")');
    await sp.waitForSelector('.stats-kpis');
    assert.equal(await pressed(), 'week');
    assert.equal(await label(), 'Sun Oct 4 – Sat Oct 10, 2026');
    assert.equal((await sp.$$('.stats-card.kpi')).length, 4);
    assert.equal(await barCount(), 7, 'one bar for each day of the week so far');
    assert.equal(await sp.$$eval('.trend-body .tr-dot', (els) => els.length), 7);
    assert.ok(await sp.$('.tr-compare'), 'last week is drawn as a dashed line');
    assert.match(await sp.textContent('.trend-card .stats-legend'), /This week.*Last week/);
    assert.equal(await sp.$$eval('.heat-day', (els) => els.length), 31, 'the month grid, with this week marked');
    assert.equal(await sp.$$eval('.heat-day.sel', (els) => els.length), 7);
    assert.equal(await sp.isDisabled('button[aria-label="Next period"]'), true, 'cannot go past this week');
    await shot(sp, 'stats-week');

    await sp.click('.stats-seg button[data-range="day"]');
    await sp.waitForFunction(() => document.querySelector('.stats-seg button.on').dataset.range === 'day');
    assert.match(await label(), /Sat, Oct 10, 2026 · today/);
    assert.equal(await barCount(), 5, 'a day shows its 5 zones');
    assert.equal(await sp.textContent('#bars-sub'), 'Each bar is one zone of the day');
    assert.equal(await sp.$$eval('.trend-body .tr-dot', (els) => els.length), 7, 'the 7 days that end on that day');
    assert.equal(await sp.$$eval('.heat-day.sel', (els) => els.length), 1);
    await shot(sp, 'stats-day');

    await sp.click('.stats-seg button[data-range="month"]');
    await sp.waitForFunction(() => document.querySelector('.stats-seg button.on').dataset.range === 'month');
    assert.match(await label(), /October 2026 · so far/);
    assert.equal(await barCount(), 10);
    assert.match(await sp.textContent('.trend-card .stats-legend'), /7-day average/);
    assert.equal(await sp.$$eval('.heat-day.sel', (els) => els.length), 0, 'the whole month is shown, nothing to mark');
    await shot(sp, 'stats-month');

    await sp.click('.stats-seg button[data-range="year"]');
    await sp.waitForFunction(() => document.querySelector('.stats-seg button.on').dataset.range === 'year');
    assert.equal(await label(), '2026 · so far');
    assert.equal(await barCount(), 12, 'one bar for each month');
    assert.equal(await sp.textContent('#bars-sub'), 'Each bar is one month');
    assert.equal(await sp.$$eval('.heat-sq', (els) => els.length), 365, 'the whole year as a grid');
    assert.equal(await sp.textContent('#heat-title'), '2026 at a glance');
    await shot(sp, 'stats-year');

    await sp.click('.stats-seg button[data-range="custom"]');
    await sp.waitForSelector('#stats-from');
    assert.equal(await sp.inputValue('#stats-to'), '2026-10-10');
    await sp.click('#stats-all');
    await sp.waitForFunction(() => document.querySelector('#stats-from').value === '2026-08-01');
    assert.match(await label(), /Aug 1, 2026 – Oct 10, 2026/);
    assert.equal(await barCount(), 11, 'about 10 weeks are shown week by week');
    assert.equal(await sp.textContent('#bars-sub'), 'Each bar is one week');
    await shot(sp, 'stats-all-time');
    await sp.fill('#stats-from', '2026-10-09');
    await sp.waitForFunction(() => document.querySelector('#stats-from').value === '2026-10-09');
    assert.equal(await barCount(), 2);
    assert.ok(await sp.$('#trend-empty'), 'two days are too little for a trend');
    assert.match(await sp.textContent('#trend-empty'), /Not enough data yet/);

    // A day on the heat map opens that day.
    await sp.click('.stats-seg button[data-range="month"]');
    await sp.waitForSelector('.heat-day');
    await sp.click('.heat-day[data-key="2026-10-03"]');
    await sp.waitForFunction(() => document.querySelector('.stats-seg button.on').dataset.range === 'day');
    assert.match(await label(), /Sat, Oct 3, 2026$/);
    await sp.click('button[aria-label="Next period"]');
    await sp.waitForFunction(() => /Oct 4, 2026/.test(document.querySelector('#stats-range-label').textContent));

    // Needs attention lists what is overdue and opens the task.
    await sp.click('.stats-seg button[data-range="week"]');
    await sp.waitForSelector('.late-item');
    assert.ok((await sp.$$('.late-item')).length <= 5);
    assert.match(await sp.textContent('.late-card, section[aria-label="Needs attention"]'), /late|Today/);
    await sp.click('.late-item >> nth=0');
    await sp.waitForSelector('.overlay');
    await sp.keyboard.press('Escape');
    assert.deepEqual(realErrors(sApp.errors), []);
    await sApp.browser.close();
  });

  await step('Statistics: Manage adds, removes and re-orders the charts, and the choice is saved', async () => {
    const { at } = require('./ui-harness');
    const svc = createService({ now: at('2026-10-10', '15:20') });
    svc.saveTask({ mode: 'create', form: { title: 'Study', start: { mode: 'fixed', time: '08:00' }, durationMinutes: 60, date: null,
      recurrence: { startDate: '2026-10-01', frequency: 'daily', interval: 1 }, reminders: { enabled: false, offsets: [] }, priority: 'Medium', categoryId: 'cat-study', notes: '' } });
    const m = await openApp({ playwright, service: svc, executablePath, width: 1280, height: 1400 });
    const mp = m.page;
    const sections = () => mp.$$eval('.stats-grid > section', (els) => els.map((e) => e.getAttribute('aria-label')));
    await mp.click('#menu-btn');
    await mp.click('.drawer-item:has-text("Statistics")');
    await mp.waitForSelector('.stats-grid');
    assert.equal((await sections()).length, 6);
    assert.equal((await mp.$$('.stats-card.kpi')).length, 4);

    await mp.click('#stats-manage');
    await mp.waitForSelector('.manage-row');
    assert.equal((await mp.$$('.manage-row')).length, 10);
    await mp.click('button[aria-label="Remove Needs attention"]');
    await mp.click('button[aria-label="Remove By zone"]');
    await mp.click('button[aria-label="Remove Current streak"]');
    await mp.waitForFunction(() => document.querySelectorAll('.stats-card.kpi').length === 3);
    assert.deepEqual(svc.getSettings().statsCharts, ['kpi-rate', 'kpi-done', 'kpi-time', 'bars', 'heat', 'trend', 'categories']);
    assert.equal((await sections()).includes('Needs attention'), false);
    assert.equal((await sections()).includes('By zone'), false);
    assert.match(await mp.textContent('.manage-title >> nth=1'), /Available to add \(3\)/);
    await shot(mp, 'stats-manage');

    await mp.click('button[aria-label="Move Completion trend up"]');
    await mp.waitForFunction(() => document.querySelector('.stats-grid > section:nth-child(2)').getAttribute('aria-label') === 'Completion trend');
    assert.deepEqual(await sections(), ['Done versus planned', 'Completion trend', 'Calendar heat map', 'By category']);
    assert.deepEqual(svc.getSettings().statsCharts.slice(3), ['bars', 'trend', 'heat', 'categories']);
    await mp.click('button[aria-label="Add By zone"]');
    await mp.waitForFunction(() => document.querySelector('.stats-grid > section:last-child').getAttribute('aria-label') === 'By zone');

    // The choice survives opening the screen again.
    await mp.keyboard.press('Escape');
    await mp.click('#menu-btn');
    await mp.click('.drawer-item:has-text("Daily View")');
    await mp.waitForSelector('.zone');
    await mp.click('#menu-btn');
    await mp.click('.drawer-item:has-text("Statistics")');
    await mp.waitForSelector('.stats-grid');
    assert.equal((await sections()).includes('By zone'), true);
    assert.equal((await mp.$$('.stats-card.kpi')).length, 3);

    // Removing everything leaves a hint, and the reset button brings it all back.
    await mp.click('#stats-manage');
    for (const id of ['Done vs planned', 'Completion rate', 'Tasks done', 'Planned time', 'Calendar heat map', 'Completion trend', 'By category', 'By zone']) {
      await mp.click(`button[aria-label="Remove ${id}"]`);
    }
    await mp.waitForSelector('#stats-nothing');
    await mp.click('#manage-reset');
    await mp.waitForSelector('.stats-grid');
    assert.equal((await sections()).length, 6);
    assert.equal((await mp.$$('.stats-card.kpi')).length, 4);
    assert.deepEqual(realErrors(m.errors), []);
    await m.browser.close();
  });

  console.log('First run');
  await step('the welcome screen asks for the city once, then the app is ready', async () => {
    const fresh = createService({ firstRun: true });
    const first = await openApp({ playwright, service: fresh, executablePath, width: 1000, height: 800 });
    await first.page.waitForSelector('.welcome');
    assert.match(await first.page.textContent('.welcome'), /Make every waqt count, wisely\./);
    assert.equal(await first.page.inputValue('#welcome-city'), 'Cairo');
    await first.page.selectOption('#welcome-city', 'Alexandria');
    await shot(first.page, 'welcome');
    await first.page.click('button:text-is("Start planning")');
    await first.page.waitForSelector('.welcome', { state: 'detached' });
    assert.equal(fresh.getSettings().cityName, 'Alexandria');
    assert.equal(fresh.getSettings().welcomeShown, true);
    assert.deepEqual(realErrors(first.errors), []);
    await first.browser.close();

    // Opening the app again does not show it a second time
    const again = await openApp({ playwright, service: fresh, executablePath, width: 1000, height: 800 });
    assert.equal((await again.page.$$('.welcome')).length, 0);
    await again.browser.close();
  });

  console.log(`\n${passed} steps passed${process.exitCode ? ', some FAILED' : ''}`);
  process.exit(process.exitCode || 0); // the browsers left open by the first screens would keep the script alive
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
