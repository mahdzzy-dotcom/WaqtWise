'use strict';

// The Settings screen (spec 12.4). Every change is saved as soon as it is made.

(function () {
  const WW = (window.WW = window.WW || {});
  const { h, clear } = WW;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const PRAYERS = [['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha']];

  async function save(patch) {
    try {
      WW.state.settings = await WW.call('saveSettings', patch);
      WW.applyTheme(WW.state.settings.theme);
    } catch (error) {
      WW.toast(error.message, 'error');
      WW.state.settings = await WW.call('getSettings');
      WW.renderSettings();
    }
  }

  function toggle(label, checked, onChange, hint) {
    return h('div', {},
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }),
        h('span', { text: label })),
      hint ? h('p', { class: 'hint', text: hint }) : null);
  }

  // A real on/off switch (a sliding knob) with the word On or Off next to it.
  function onOffSwitch(label, checked, onChange, hint) {
    const state = h('span', { class: 'onoff-state', text: checked ? 'On' : 'Off' });
    const input = h('input', {
      type: 'checkbox', class: 'onoff', role: 'switch', 'aria-label': label, checked,
      onchange: (e) => { state.textContent = e.target.checked ? 'On' : 'Off'; onChange(e.target.checked); },
    });
    return h('div', {},
      h('label', { class: 'onoff-row' }, input, h('span', { class: 'onoff-label', text: label }), state),
      hint ? h('p', { class: 'hint', text: hint }) : null);
  }

  function numberField(value, min, max, suffix, onCommit, label) {
    return h('span', { class: 'row tight' },
      h('input', {
        type: 'number', class: 'num', min: String(min), max: String(max), value: String(value), 'aria-label': label,
        onchange: (e) => {
          const n = Number(e.target.value);
          onCommit(e.target.value === '' ? NaN : n);
        },
      }),
      suffix ? h('span', { text: suffix }) : null);
  }

  function section(title, ...children) {
    return h('section', { class: 'settings-section' }, h('h2', { text: title }), ...children);
  }

  function row(label, control) {
    return [h('label', { text: label }), control];
  }

  // One sound choice: a list, a volume slider and a "Preview" button. Each change is saved at once.
  function soundPicker({ label, options, idKey, volumeKey, extra }) {
    const st = WW.state.settings;
    let id = st[idKey];
    let volume = st[volumeKey];
    const readout = h('span', { class: 'vol-readout', text: `${volume}%` });
    const select = h('select', {
      class: 'sel-auto', 'aria-label': `${label} sound`,
      onchange: (e) => { id = e.target.value; save({ [idKey]: id }); },
    }, options.map(([value, text]) => h('option', { value, text, selected: id === value })));
    const slider = h('input', {
      type: 'range', min: '0', max: '100', step: '5', value: String(volume), class: 'vol', 'aria-label': `${label} volume`,
      oninput: (e) => { volume = Number(e.target.value); readout.textContent = `${volume}%`; },
      onchange: (e) => { volume = Number(e.target.value); save({ [volumeKey]: volume }); },
    });
    const preview = h('button', {
      class: 'btn small', type: 'button', text: 'Preview', 'aria-label': `Preview the ${label.toLowerCase()} sound`,
      onclick: () => WW.sounds.play(id, volume),
    });
    return h('div', {}, h('div', { class: 'row' }, select, slider, readout, preview), extra || null);
  }

  function soundsSection() {
    const st = WW.state.settings;
    return section('Sounds',
      h('p', { class: 'dialog-message', text: 'Sounds are made by WaqtWise itself and play only while it is running. They are separate from the Windows notification sound above.' }),
      h('div', { class: 'settings-grid' },
        row('Task done', soundPicker({ label: 'Task done', options: WW.sounds.DONE_OPTIONS, idKey: 'doneSound', volumeKey: 'doneSoundVolume',
          extra: h('p', { class: 'hint', text: 'Plays when you tick a task as done.' }) })),
        row('Full-screen alert', soundPicker({ label: 'Full-screen alert', options: WW.sounds.ALERT_OPTIONS, idKey: 'alertSound', volumeKey: 'alertSoundVolume',
          extra: h('div', {},
            toggle('Keep repeating until a button is pressed', st.alertSoundRepeat, (v) => save({ alertSoundRepeat: v })),
            h('p', { class: 'hint', text: 'Plays when a full-screen alert appears (on one screen only, even if several are covered).' })) }))));
  }

  function categoriesSection() {
    const list = h('div');
    const draw = () => {
      clear(list);
      WW.state.categories.forEach((c) => {
        const name = h('input', { type: 'text', value: c.name, maxlength: '40', 'aria-label': `Name of ${c.name}` });
        const color = h('input', { type: 'color', value: c.color, 'aria-label': `Color of ${c.name}` });
        const commit = async () => {
          try {
            WW.state.categories = await WW.call('updateCategory', { id: c.id, name: name.value, color: color.value });
            WW.toast('Category saved');
          } catch (error) {
            WW.toast(error.message, 'error');
            name.value = c.name;
          }
          draw();
        };
        name.addEventListener('change', commit);
        color.addEventListener('change', commit);
        list.appendChild(h('div', { class: 'cat-row' }, color, name,
          h('button', {
            class: 'btn small danger', text: 'Delete',
            onclick: async () => {
              const ok = await WW.ask({
                title: 'Delete category', message: `Delete "${c.name}"? Tasks in this category are kept, but they become uncategorized.`,
                choices: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, kind: 'danger' }],
              });
              if (!ok) return;
              WW.state.categories = await WW.call('deleteCategory', { id: c.id });
              draw();
            },
          })));
      });
      const newName = h('input', { type: 'text', placeholder: 'New category name', maxlength: '40', 'aria-label': 'New category name' });
      const newColor = h('input', { type: 'color', value: '#3b82f6', 'aria-label': 'New category color' });
      list.appendChild(h('div', { class: 'cat-row' }, newColor, newName,
        h('button', {
          class: 'btn small primary', text: 'Add',
          onclick: async () => {
            try {
              WW.state.categories = await WW.call('addCategory', { name: newName.value, color: newColor.value });
              draw();
            } catch (error) {
              WW.toast(error.message, 'error');
            }
          },
        })));
    };
    draw();
    return section('Categories', list);
  }


  // ---- Full-screen reminder ------------------------------------------------------------------------------

  const FONTS = ['Segoe UI', 'Tahoma', 'Arial', 'Verdana', 'Georgia', 'Times New Roman'];
  const PRESETS = [
    ['dark', 'Dark'], ['light', 'Light'], ['highContrast', 'High contrast'], ['red', 'Red alert'], ['calm', 'Calm green'],
  ];
  const SAMPLE_ITEM = {
    id: 'preview', taskId: '__sample__', dateKey: '2026-01-01', title: 'Study SQL: joins and subqueries',
    notes: 'Open the exercises from yesterday.\nFinish chapter 4, then try the practice questions.',
    startLabel: '12:00 PM', endLabel: '12:45 PM', durationLabel: '45m', zoneName: 'Dhuhr → Asr', zoneIndex: 2,
    categoryName: 'Study', categoryColor: '#8b5cf6', priority: 'High', snoozed: false,
  };

  // setIn(object, ['name', 'size'], 90) -> a copy with that value changed
  function setIn(object, keys, value) {
    const copy = JSON.parse(JSON.stringify(object));
    let node = copy;
    keys.slice(0, -1).forEach((k) => { node = node[k]; });
    node[keys[keys.length - 1]] = value;
    return copy;
  }
  function getIn(object, keys) {
    return keys.reduce((node, k) => node[k], object);
  }
  function nestedPatch(keys, value) {
    return keys.reduceRight((inner, key) => ({ [key]: inner }), value);
  }

  function alertSection() {
    const preview = h('div', { class: 'alert-preview', 'aria-label': 'Preview of the full-screen reminder' });

    function drawPreview() {
      const { frame } = WW.AlertView.render(preview, {
        item: SAMPLE_ITEM, remaining: 0, appearance: WW.state.settings.alertAppearance,
        snoozeMinutes: WW.state.settings.snoozeMinutes, guardActive: false,
      }, null);
      const fit = () => { frame.style.transform = `scale(${preview.clientWidth / 1280})`; };
      fit();
      requestAnimationFrame(fit);
    }

    // Change one appearance value. `commit` false = only update the preview while a slider is being dragged.
    async function change(keys, value, commit = true) {
      WW.state.settings = { ...WW.state.settings, alertAppearance: setIn(WW.state.settings.alertAppearance, keys, value) };
      drawPreview();
      if (!commit) return;
      try {
        WW.state.settings = await WW.call('saveSettings', { alertAppearance: nestedPatch(keys, value) });
      } catch (error) {
        WW.toast(error.message, 'error');
        WW.state.settings = await WW.call('getSettings');
        WW.renderSettings();
      }
    }

    const value = (keys) => getIn(WW.state.settings.alertAppearance, keys);
    const color = (keys, label) => h('input', { type: 'color', value: value(keys), 'aria-label': label, onchange: (e) => change(keys, e.target.value) });
    const check = (keys, label) => h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked: value(keys), 'aria-label': label, onchange: (e) => change(keys, e.target.checked) }), h('span', { text: label }));
    const slider = (keys, min, max, label) => {
      const readout = h('span', { class: 'hint', text: `${value(keys)} px` });
      return h('span', { class: 'row tight' },
        h('input', {
          type: 'range', min: String(min), max: String(max), value: String(value(keys)), 'aria-label': label, style: { width: '220px' },
          oninput: (e) => { readout.textContent = `${e.target.value} px`; change(keys, Number(e.target.value), false); },
          onchange: (e) => change(keys, Number(e.target.value)),
        }), readout);
    };
    const select = (keys, options, label) => h('select', { class: 'sel-auto', 'aria-label': label, onchange: (e) => change(keys, e.target.value) },
      options.map(([v, l]) => h('option', { value: v, text: l, selected: value(keys) === v })));

    const presets = h('div', { class: 'row' }, PRESETS.map(([key, label]) => h('button', {
      class: 'btn small', type: 'button', text: label,
      onclick: async () => {
        const preset = await WW.call('getAlertPreset', key);
        WW.state.settings = await WW.call('saveSettings', { alertAppearance: preset });
        const y = window.scrollY;
        WW.renderSettings();
        window.scrollTo(0, y);
      },
    })));

    const box = section('Full-screen reminder',
      h('p', { class: 'dialog-message', text: 'At the exact start time of a task that has the full-screen alert switched on, a full-screen reminder covers the screen so it cannot be missed. It stays until you click a button.' }),
      h('div', { class: 'settings-grid' },
        row('Full-screen alerts', onOffSwitch('Full-screen reminders', WW.state.settings.fullScreenAlerts, (v) => save({ fullScreenAlerts: v }), 'Each task also has its own switch in the task form. With this off, no full-screen alert appears.')),
        row('New tasks', toggle('Switch the full-screen alert on for new tasks', WW.state.settings.fullScreenDefaultForNewTasks, (v) => save({ fullScreenDefaultForNewTasks: v }))),
        row('Screens', h('select', { class: 'sel-auto', 'aria-label': 'Screens', onchange: (e) => save({ alertScreens: e.target.value }) },
          h('option', { value: 'all', text: 'All screens', selected: WW.state.settings.alertScreens === 'all' }),
          h('option', { value: 'main', text: 'Main screen only', selected: WW.state.settings.alertScreens === 'main' }))),
        row('Ready-made looks', presets),
        row('Colors', h('div', { class: 'row' },
          h('span', { text: 'Background' }), color(['backgroundColor'], 'Background color'),
          h('span', { text: 'Text' }), color(['textColor'], 'Text color'),
          h('span', { text: 'Accent' }), color(['accentColor'], 'Accent color'))),
        row('Font', h('div', { class: 'row' },
          select(['fontFamily'], FONTS.map((f) => [f, f]), 'Font'),
          select(['alignment'], [['center', 'Centered'], ['left', 'Left aligned']], 'Alignment'))),
        row('Task name', h('div', {},
          slider(['name', 'size'], 24, 160, 'Task name size'),
          h('div', { class: 'row', style: { marginTop: '8px' } }, color(['name', 'color'], 'Task name color'),
            check(['name', 'bold'], 'Bold'), check(['name', 'italic'], 'Italic'), check(['name', 'uppercase'], 'CAPITALS')))),
        row('Notes', h('div', {},
          check(['notes', 'show'], 'Show the notes'),
          h('div', { style: { marginTop: '8px' } }, slider(['notes', 'size'], 14, 96, 'Notes size')),
          h('div', { class: 'row', style: { marginTop: '8px' } }, color(['notes', 'color'], 'Notes color'),
            check(['notes', 'bold'], 'Bold'), check(['notes', 'italic'], 'Italic')))),
        row('Details shown', h('div', { class: 'row' },
          check(['show', 'time'], 'Time'), check(['show', 'duration'], 'Duration'), check(['show', 'zone'], 'Zone'),
          check(['show', 'category'], 'Category'), check(['show', 'priority'], 'Priority')))),
      h('div', { style: { marginTop: '16px' } },
        preview,
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', {
            class: 'btn', text: 'Preview full screen',
            onclick: async () => {
              try { await window.api.previewAlert(); } catch (error) { WW.toast(error.message, 'error'); }
            },
          }),
          h('span', { class: 'hint', text: 'Shows the real full-screen reminder with an example task. Click "Got it" to close it.' }))));
    requestAnimationFrame(drawPreview);
    drawPreview();
    return box;
  }

  WW.renderSettings = function renderSettings() {
    const view = clear(document.getElementById('view'));
    const s = WW.state.settings;

    const city = h('select', { 'aria-label': 'City', onchange: (e) => save({ cityName: e.target.value }) },
      WW.state.cities.map((name) => h('option', { value: name, text: name, selected: s.cityName === name })));
    const method = h('select', { 'aria-label': 'Calculation method', onchange: (e) => save({ method: e.target.value }) },
      WW.state.methods.map((m) => h('option', { value: m.key, text: m.label, selected: s.method === m.key })));
    const adjustments = h('div', { class: 'row' },
      PRAYERS.map(([key, label]) => h('span', { class: 'row tight' },
        h('span', { text: label }),
        numberField(s.adjustments[key], -120, 120, 'min', (n) => save({ adjustments: { [key]: n } }), `${label} adjustment in minutes`))));
    const hijri = h('select', { 'aria-label': 'Hijri date adjustment', class: 'sel-auto', onchange: (e) => save({ hijriAdjustment: Number(e.target.value) }) },
      [[-1, '−1 day'], [0, 'No adjustment'], [1, '+1 day']].map(([v, l]) => h('option', { value: v, text: l, selected: s.hijriAdjustment === v })));

    const theme = h('select', { class: 'sel-auto', 'aria-label': 'Theme', onchange: (e) => save({ theme: e.target.value }) },
      [['system', 'System (follow Windows)'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, text: l, selected: s.theme === v })));

    const weekStart = h('select', { class: 'sel-auto', 'aria-label': 'First day of the week', onchange: (e) => save({ weekStart: Number(e.target.value) }) },
      [[6, 'Saturday'], [0, 'Sunday'], [1, 'Monday']].map(([v, l]) => h('option', { value: v, text: l, selected: s.weekStart === v })));

    const workingDays = h('span', { class: 'daytoggle' },
      DAYS.map((label, i) => h('button', {
        type: 'button', class: s.workingDays.includes(i) ? 'on' : '', text: label, 'aria-pressed': String(s.workingDays.includes(i)),
        onclick: async () => {
          const next = s.workingDays.includes(i) ? s.workingDays.filter((d) => d !== i) : [...s.workingDays, i];
          await save({ workingDays: next });
          WW.renderSettings();
        },
      })));

    view.append(
      h('button', { class: 'back-link', text: '← Back to Daily View', onclick: () => WW.showDaily() }),
      h('h1', { text: 'Settings', style: { marginTop: '0' } }),

      section('Prayer Times',
        h('div', { class: 'settings-grid' },
          row('City', city),
          row('Calculation method', method),
          row('Manual adjustment', h('div', {}, adjustments, h('p', { class: 'hint', text: 'Minutes added to the calculated time (negative = earlier).' }))),
          row('Hijri date', hijri))),

      section('Reminders & Notifications',
        h('div', { class: 'settings-grid' },
          row('Notifications', onOffSwitch('Windows notifications', s.notificationsEnabled, (v) => save({ notificationsEnabled: v }), 'Reminder pop-ups from Windows. With this off, no pop-up appears (full-screen reminders have their own switch).')),
          row('Sound', toggle('Play a sound', s.soundEnabled, (v) => save({ soundEnabled: v }))),
          row('Default reminder', h('div', {}, numberField(s.defaultReminderOffsetMinutes, 0, 10080, 'minutes before the start', (n) => save({ defaultReminderOffsetMinutes: n }), 'Default reminder minutes'),
            h('p', { class: 'hint', text: 'Used when a task has reminders turned on but no times added.' }))),
          row('Snooze', numberField(s.snoozeMinutes, 1, 1440, 'minutes', (n) => save({ snoozeMinutes: n }), 'Snooze minutes')),
          row('Zone start', toggle('Notify when each Zone begins', s.zoneStartNotifications, (v) => save({ zoneStartNotifications: v }), 'A notification at each prayer time.')),
          row('Test', h('div', {},
            h('button', {
              class: 'btn', text: 'Send a test notification',
              onclick: async () => {
                try {
                  await window.api.testNotification();
                  WW.toast('Test notification sent. Look at the bottom-right corner of the screen.');
                } catch (error) {
                  WW.toast(error.message, 'error');
                }
              },
            }),
            h('p', { class: 'hint', text: 'Checks that Windows shows notifications. Try its Snooze and Mark as Done buttons too.' }))))),

      section('Application',
        h('div', { class: 'settings-grid' },
          row('Start with Windows', toggle('Start WaqtWise when Windows starts (in the tray)', s.startWithWindows, (v) => save({ startWithWindows: v }))),
          row('Background message', toggle('Show the "still running in the background" message', s.showBackgroundMessage, (v) => save({ showBackgroundMessage: v }), 'Shown once, the next time the window is closed. Closing the window keeps WaqtWise running in the tray so reminders keep working.')),
          row('Theme', theme),
          row('First day of the week', h('div', {}, weekStart, h('p', { class: 'hint', text: 'The day cards at the top of the Daily View and the weeks in Statistics start from this day.' }))),
          row('Working days', h('div', {}, workingDays, h('p', { class: 'hint', text: 'Used by "last working day" repeat rules.' }))))),

      alertSection(),

      soundsSection(),

      categoriesSection(),

      section('Data',
        h('p', { class: 'dialog-message', text: 'Your data is stored only on this computer. Export a backup file to keep it safe or to move it to another computer.' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn', text: 'Export data…', onclick: () => WW.exportData() }),
          h('button', { class: 'btn', text: 'Import data…', onclick: () => WW.importData() })))
    );
  };
})();
