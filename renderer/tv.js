// Controller mode: input and moving around, for the big-screen view in
// renderer/app.js. A gamepad (standard layout: Xbox, PlayStation, Switch Pro
// and most others), the keyboard or a TV remote all turn into the same
// actions: up, down, left, right, ok, back, x, y, prevTab, nextTab, menu, view.
//
//   move(index, dir, cols, count)   the tile a direction goes to
//   Repeater                        pressed buttons -> actions, repeating held directions
//   Pad                             reads gamepads every frame while one is connected
(function (root) {
  // Standard mapping: https://w3c.github.io/gamepad/#remapping
  const BUTTONS = { 0: 'ok', 1: 'back', 2: 'x', 3: 'y', 4: 'prevTab', 5: 'nextTab', 6: 'prevTab', 7: 'nextTab', 8: 'view', 9: 'menu', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  const KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'ok', ' ': 'ok', Escape: 'back', Backspace: 'back', BrowserBack: 'back', GoBack: 'back',
    PageUp: 'prevTab', PageDown: 'nextTab', q: 'prevTab', e: 'nextTab', x: 'x', y: 'y', r: 'y', ContextMenu: 'menu',
  };
  const DIRS = new Set(['up', 'down', 'left', 'right']);
  const FIRST_REPEAT_MS = 380;
  const REPEAT_MS = 110;
  const STICK = 0.55;

  // Where a direction goes in a grid of `count` tiles, `cols` wide. Down from
  // the second-last row goes to the last tile when the one below is missing.
  function move(index, dir, cols, count) {
    if (count <= 0) return -1;
    const i = Math.min(Math.max(index, 0), count - 1);
    if (dir === 'left') return i % cols > 0 ? i - 1 : i;
    if (dir === 'right') return i % cols < cols - 1 && i + 1 < count ? i + 1 : i;
    if (dir === 'up') return i - cols >= 0 ? i - cols : i;
    if (dir === 'down') {
      if (i + cols < count) return i + cols;
      const lastRow = Math.floor((count - 1) / cols);
      return Math.floor(i / cols) < lastRow ? count - 1 : i;
    }
    return i;
  }

  // Press -> one action; directions held down repeat, like a keyboard.
  class Repeater {
    constructor() {
      this.held = new Map(); // action -> { since, last }
    }

    step(pressed, now) {
      const out = [];
      for (const a of pressed) {
        const h = this.held.get(a);
        if (!h) {
          this.held.set(a, { since: now, last: now });
          out.push(a);
        } else if (DIRS.has(a) && now - h.since >= FIRST_REPEAT_MS && now - h.last >= REPEAT_MS) {
          h.last = now;
          out.push(a);
        }
      }
      for (const a of [...this.held.keys()]) if (!pressed.has(a)) this.held.delete(a);
      return out;
    }
  }

  // The actions a gamepad's state presses right now.
  function padActions(pad) {
    const on = new Set();
    if (!pad || !pad.connected) return on;
    pad.buttons.forEach((b, i) => {
      if (BUTTONS[i] && (b.pressed || b.value > 0.5)) on.add(BUTTONS[i]);
    });
    const [x = 0, y = 0] = pad.axes || [];
    if (x < -STICK) on.add('left');
    if (x > STICK) on.add('right');
    if (y < -STICK) on.add('up');
    if (y > STICK) on.add('down');
    return on;
  }

  // Polls while a gamepad is connected (browsers only tell pages about a
  // gamepad once a button on it is pressed), and stops when none is left.
  class Pad {
    constructor(onAction, { win = root } = {}) {
      this.onAction = onAction;
      this.win = win;
      this.repeater = new Repeater();
      this.frame = null;
      win.addEventListener('gamepadconnected', () => this.start());
      win.addEventListener('gamepaddisconnected', () => { if (!this.pads().length) this.stop(); });
    }

    pads() {
      return [...(this.win.navigator.getGamepads?.() || [])].filter((p) => p && p.connected);
    }

    start() {
      if (this.frame) return;
      const tick = () => {
        const pressed = new Set();
        for (const p of this.pads()) for (const a of padActions(p)) pressed.add(a);
        for (const a of this.repeater.step(pressed, this.win.performance.now())) this.onAction(a, 'pad');
        this.frame = this.win.requestAnimationFrame(tick);
      };
      this.frame = this.win.requestAnimationFrame(tick);
    }

    stop() {
      if (this.frame) this.win.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  const keyAction = (e) => (e.ctrlKey || e.altKey || e.metaKey ? null : KEYS[e.key] || KEYS[e.key?.toLowerCase?.()] || null);

  const api = { move, Repeater, Pad, padActions, keyAction, BUTTONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TV = api;
})(this);
