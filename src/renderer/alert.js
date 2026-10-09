'use strict';

// The full-screen reminder page. The main process tells it what to show; it reports button presses.

(function () {
  const WW = window.WW;
  const root = document.getElementById('alert-root');

  let state = null; // { items, appearance, snoozeMinutes, guardMs }
  let guardUntil = 0;
  let lastItemId = null;
  let guardTimer = null;
  let lastSoundSeq = 0;
  let ringing = null; // the sound that is playing now

  function stopSound() {
    if (ringing) ringing.stop();
    ringing = null;
  }

  function current() {
    return state && state.items.length > 0 ? state.items[0] : null;
  }

  function draw() {
    const item = current();
    if (!item) return;
    const guardActive = performance.now() < guardUntil;
    WW.AlertView.render(root, {
      item,
      remaining: state.items.length - 1,
      appearance: state.appearance,
      snoozeMinutes: state.snoozeMinutes,
      guardActive,
    }, {
      dismiss: () => { stopSound(); window.alertApi.action('dismiss', item.id); },
      snooze: () => { stopSound(); window.alertApi.action('snooze', item.id); },
      done: () => { stopSound(); window.alertApi.action('done', item.id); },
      open: () => { stopSound(); window.alertApi.action('open', item.id); },
    });
    if (guardActive) {
      clearTimeout(guardTimer);
      guardTimer = setTimeout(draw, guardUntil - performance.now() + 20);
    } else {
      const primary = root.querySelector('button.primary');
      if (primary) primary.focus();
    }
  }

  window.alertApi.onRender((next) => {
    const first = !state;
    state = next;
    const item = current();
    // Ring once for each arrival of tasks (and only on one screen, even when several are covered).
    if (next.soundSeq !== lastSoundSeq) {
      lastSoundSeq = next.soundSeq;
      stopSound();
      if (next.soundHere && next.sound && next.sound.id !== 'off') {
        ringing = WW.sounds.play(next.sound.id, next.sound.volume, { repeat: next.sound.repeat });
      }
    }
    // A new task on screen (or the first one): ignore presses for a moment so nothing is dismissed by accident.
    if (item && (first || item.id !== lastItemId)) {
      guardUntil = performance.now() + next.guardMs;
      lastItemId = item.id;
    }
    draw();
  });

  // Keyboard: Enter or Escape = "Got it", once the short pause is over.
  document.addEventListener('keydown', (event) => {
    const item = current();
    if (!item || performance.now() < guardUntil) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      stopSound();
      window.alertApi.action('dismiss', item.id);
    }
  });

  window.alertApi.ready();
})();
