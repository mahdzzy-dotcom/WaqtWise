'use strict';

// Short sounds made with the browser's audio engine (no sound files to ship).
//   WW.sounds.play('chime', 60)                         -> plays once at 60 % volume
//   const s = WW.sounds.play('bell', 70, { repeat: true }); ... s.stop()
// The lists below must match DONE_SOUNDS and ALERT_SOUNDS in src/core/settings.js (a test checks that).

(function () {
  const WW = (window.WW = window.WW || {});

  const DONE_OPTIONS = [
    ['chime', 'Soft chime'],
    ['pop', 'Pop'],
    ['ding', 'Ding'],
    ['sparkle', 'Sparkle'],
    ['off', 'Off'],
  ];
  const ALERT_OPTIONS = [
    ['bell', 'Gentle bell'],
    ['alarm', 'Bright alarm'],
    ['rising', 'Rising chime'],
    ['pulse', 'Soft pulse'],
    ['off', 'Off'],
  ];

  let context = null;
  function audio() {
    if (!context) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      context = new Ctor();
    }
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
  }

  // One note: a pitch that rises/falls a little, with a quick attack and a smooth fade-out.
  function note(ctx, out, { at, freq, to, dur, gain = 0.5, type = 'sine', attack = 0.01 }) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, at + dur);
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(amp);
    amp.connect(out);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  // A bell-like note: the pitch plus a few quieter overtones.
  function bell(ctx, out, at, freq, dur, gain) {
    [[1, 1], [2.76, 0.35], [5.4, 0.15]].forEach(([ratio, level]) =>
      note(ctx, out, { at, freq: freq * ratio, dur: dur / Math.sqrt(ratio), gain: gain * level }));
  }

  // Each recipe schedules its notes starting at time "t" and returns how long it lasts (seconds).
  const RECIPES = {
    chime(ctx, out, t) {
      note(ctx, out, { at: t, freq: 659.25, dur: 0.45, gain: 0.5 });
      note(ctx, out, { at: t + 0.11, freq: 987.77, dur: 0.6, gain: 0.45 });
      return 0.8;
    },
    pop(ctx, out, t) {
      note(ctx, out, { at: t, freq: 520, to: 160, dur: 0.14, gain: 0.8, attack: 0.004 });
      return 0.2;
    },
    ding(ctx, out, t) {
      bell(ctx, out, t, 1318.5, 0.7, 0.5);
      return 0.8;
    },
    sparkle(ctx, out, t) {
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) => note(ctx, out, { at: t + i * 0.07, freq: f, dur: 0.35, gain: 0.32 }));
      return 0.7;
    },
    bell(ctx, out, t) {
      bell(ctx, out, t, 784, 1.8, 0.55);
      bell(ctx, out, t + 0.9, 784, 1.8, 0.55);
      return 2.8;
    },
    alarm(ctx, out, t) {
      for (let i = 0; i < 4; i++) {
        note(ctx, out, { at: t + i * 0.32, freq: i % 2 ? 740 : 988, dur: 0.24, gain: 0.5, type: 'triangle', attack: 0.012 });
      }
      return 1.4;
    },
    rising(ctx, out, t) {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(ctx, out, { at: t + i * 0.22, freq: f, dur: 0.9 - i * 0.1, gain: 0.45 }));
      note(ctx, out, { at: t + 0.9, freq: 1318.5, dur: 1.2, gain: 0.45 });
      return 2.2;
    },
    pulse(ctx, out, t) {
      for (let i = 0; i < 3; i++) note(ctx, out, { at: t + i * 0.45, freq: 440, dur: 0.38, gain: 0.55, attack: 0.08 });
      return 1.5;
    },
  };

  // Plays a sound. volume is 0-100. Returns { stop() }. Unknown names and "off" make no sound.
  function play(id, volume, options) {
    const opts = options || {};
    const recipe = RECIPES[id];
    const level = Math.max(0, Math.min(100, Number(volume))) / 100;
    const handle = { stopped: false, timer: null, master: null, stop() {
      handle.stopped = true;
      clearTimeout(handle.timer);
      if (handle.master) { try { handle.master.disconnect(); } catch (e) { /* already closed */ } }
    } };
    if (!recipe || !level) return handle;
    const ctx = audio();
    if (!ctx) return handle;

    const round = () => {
      if (handle.stopped) return;
      const master = ctx.createGain();
      master.gain.value = level;
      master.connect(ctx.destination);
      handle.master = master;
      const length = recipe(ctx, master, ctx.currentTime + 0.02);
      if (opts.repeat) handle.timer = setTimeout(round, (length + 1.2) * 1000);
    };
    round();
    return handle;
  }

  WW.sounds = { play, DONE_OPTIONS, ALERT_OPTIONS, ids: Object.keys(RECIPES) };
})();
