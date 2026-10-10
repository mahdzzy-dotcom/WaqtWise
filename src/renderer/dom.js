'use strict';

// Tiny helpers for building the screens. Text is always added as text (never as HTML),
// so a task title can never break the page.

(function () {
  const WW = (window.WW = window.WW || {});

  // h('div', { class: 'x', onclick: fn, dataset: {a: 1} }, 'text', childNode, [more])
  WW.h = function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    const add = (child) => {
      if (Array.isArray(child)) child.forEach(add);
      else if (child === null || child === undefined || child === false) return;
      else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    };
    children.forEach(add);
    return el;
  };

  // Small line icons (trusted constant markup, never built from user text).
  const ICONS = {"menu": "<path d=\"M4 7h16M4 12h16M4 17h16\"/>", "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4\"/>", "moon": "<path d=\"M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z\"/>", "bell": "<path d=\"M6 9a6 6 0 0 1 12 0c0 6 2 7.5 2 7.5H4S6 15 6 9z\"/><path d=\"M10 20a2 2 0 0 0 4 0\"/>", "plus": "<path d=\"M12 5v14M5 12h14\"/>", "left": "<path d=\"M15 6l-6 6 6 6\"/>", "right": "<path d=\"M9 6l6 6-6 6\"/>", "calendar": "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15\" rx=\"2.5\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/>", "gear": "<path d=\"M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z\"/><path d=\"M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z\"/>", "export": "<path d=\"M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14\"/>", "import": "<path d=\"M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19h14\"/>", "close": "<path d=\"M6 6l12 12M18 6L6 18\"/>", "check": "<path d=\"M5 12.5l4.5 4.5L19 7.5\"/>", "chart": "<path d=\"M5 20V11M12 20V4M19 20v-6\"/>", "warn": "<path d=\"M12 3l10 18H2L12 3z\"/><path d=\"M12 10v5M12 18.2v.1\"/>"};
  WW.icon = function icon(name, size, strokeWidth) {
    const span = document.createElement('span');
    span.style.display = 'inline-flex';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg width="${size || 22}" height="${size || 22}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth || 1.8}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
    return span;
  };
  WW.iconNames = Object.keys(ICONS);

  WW.clear = function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  };

  // Calls the planner service in the main process. Error messages are cleaned up for people.
  WW.call = async function call(method, ...args) {
    try {
      return await window.api.call(method, ...args);
    } catch (error) {
      const raw = String((error && error.message) || error);
      throw new Error(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^Error: /, ''));
    }
  };

  WW.debounce = function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  WW.toast = function toast(message, kind) {
    const root = document.getElementById('toast-root');
    const el = WW.h('div', { class: `toast ${kind || ''}`, text: message });
    root.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  };

  // ---- Modal dialogs ---------------------------------------------------------------------------------

  // Opens a dialog. Returns { close, body, footer }.
  WW.openDialog = function openDialog({ title, wide, onClose }) {
    const root = document.getElementById('dialog-root');
    const previousFocus = document.activeElement;
    const body = WW.h('div', { class: 'dialog-body' });
    const footer = WW.h('div', { class: 'dialog-footer' });
    const closeBtn = WW.h('button', { class: 'icon-btn', 'aria-label': 'Close', text: '✕' });
    const box = WW.h(
      'div',
      { class: `dialog ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      WW.h('div', { class: 'dialog-header' }, WW.h('h2', { text: title }), closeBtn),
      body,
      footer
    );
    const overlay = WW.h('div', { class: 'overlay' }, box);
    let closed = false;

    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      if (onClose) onClose(result);
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    }
    closeBtn.addEventListener('click', () => close());
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', onKey, true);
    root.appendChild(overlay);
    return { close, body, footer, box };
  };

  // A small question with buttons. choices: [{ label, value, kind }]. Resolves to the chosen value or null.
  WW.ask = function ask({ title, message, choices }) {
    return new Promise((resolve) => {
      let answered = false;
      const dlg = WW.openDialog({
        title,
        onClose: () => {
          if (!answered) resolve(null);
        },
      });
      dlg.body.appendChild(WW.h('p', { class: 'dialog-message', text: message }));
      for (const choice of choices) {
        dlg.footer.appendChild(
          WW.h('button', {
            class: `btn ${choice.kind || ''}`,
            text: choice.label,
            onclick: () => {
              answered = true;
              dlg.close();
              resolve(choice.value);
            },
          })
        );
      }
    });
  };

  // "This occurrence only / This and following / All occurrences" chooser.
  WW.askScope = function askScope({ title, verb, allowThis }) {
    return new Promise((resolve) => {
      let answered = false;
      const dlg = WW.openDialog({
        title,
        onClose: () => {
          if (!answered) resolve(null);
        },
      });
      const options = [
        { value: 'this', label: 'This occurrence only', disabled: allowThis === false },
        { value: 'following', label: 'This and following occurrences' },
        { value: 'all', label: 'All occurrences' },
      ];
      let chosen = options.find((o) => !o.disabled).value;
      dlg.body.appendChild(WW.h('p', { class: 'dialog-message', text: `${verb} which occurrences of this repeating task?` }));
      for (const option of options) {
        dlg.body.appendChild(
          WW.h(
            'label',
            { class: `choice ${option.disabled ? 'disabled' : ''}` },
            WW.h('input', {
              type: 'radio',
              name: 'scope',
              disabled: option.disabled,
              checked: option.value === chosen,
              onchange: () => (chosen = option.value),
            }),
            WW.h('span', { text: option.label })
          )
        );
      }
      if (allowThis === false) {
        dlg.body.appendChild(WW.h('p', { class: 'hint', text: 'The repeat pattern can only be changed for all or following occurrences.' }));
      }
      dlg.footer.appendChild(WW.h('button', { class: 'btn', text: 'Cancel', onclick: () => dlg.close() }));
      dlg.footer.appendChild(
        WW.h('button', {
          class: 'btn primary',
          text: verb === 'Delete' ? 'Delete' : 'Save',
          onclick: () => {
            answered = true;
            dlg.close();
            resolve(chosen);
          },
        })
      );
    });
  };
})();
