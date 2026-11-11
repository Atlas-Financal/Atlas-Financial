/* Decorative motion only. Native plan.js owns dialog state, original evidence
 * nodes, focus, Escape, backdrop dismissal and all publication semantics. */
(function (global) {
  'use strict';
  const ease = 'cubic-bezier(.2,.85,.2,1)';
  const spring = (() => {
    if (!global.CSS?.supports('animation-timing-function', 'linear(0, 1)'))
      return 'cubic-bezier(.2,.9,.1,1)';
    const damping = .74, frequency = 11.5;
    const damped = frequency * Math.sqrt(1 - damping * damping);
    const points = Array.from({ length: 49 }, (_, index) => {
      const time = index / 48;
      return (1 - Math.exp(-damping * frequency * time)
        * (Math.cos(damped * time) + damping * frequency / damped * Math.sin(damped * time))).toFixed(4);
    });
    points[48] = '1';
    return 'linear(' + points.join(', ') + ')';
  })();
  let active = null;
  let hintedOrigin = null;
  const reduce = () => global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visible = node => node?.isConnected && node.getClientRects().length
    && getComputedStyle(node).visibility !== 'hidden';
  const rect = node => {
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  };
  function cancel(dialog) {
    if (active && (!dialog || active.dialog === dialog)) active.finish();
  }
  function run(dialog, specifications, shell) {
    cancel();
    const animations = [];
    const media = global.matchMedia('(prefers-reduced-motion: reduce)');
    const record = { dialog, finish: () => {
      if (active !== record) return;
      active = null;
      animations.forEach(animation => animation.cancel());
      shell?.remove();
      global.removeEventListener('resize', record.finish);
      global.removeEventListener('pagehide', record.finish);
      document.removeEventListener('visibilitychange', record.finish);
      media.removeEventListener('change', record.finish);
      observer.disconnect();
    } };
    const observer = new MutationObserver(() => {
      if (!dialog.isConnected) record.finish();
    });
    active = record;
    global.addEventListener('resize', record.finish, { once: true });
    global.addEventListener('pagehide', record.finish, { once: true });
    document.addEventListener('visibilitychange', record.finish, { once: true });
    media.addEventListener('change', record.finish, { once: true });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      specifications.forEach(([node, frames, options]) => {
        animations.push(node.animate(frames, { ...options, fill: 'both' }));
      });
      Promise.all(animations.map(animation => animation.finished)).then(record.finish, record.finish);
    } catch (_) {
      record.finish();
    }
  }
  function from(trigger, action) {
    const previous = hintedOrigin;
    hintedOrigin = trigger;
    try { return action(); } finally { hintedOrigin = previous; }
  }
  const opener = () => visible(hintedOrigin) ? hintedOrigin : null;
  function origin(trigger) {
    let target = visible(hintedOrigin) ? hintedOrigin : visible(trigger) ? trigger : null;
    // Projected rings forward to an incumbent, visually hidden evidence row.
    if (!target && trigger?.hasAttribute('data-budget-category-open')) {
      const id = trigger.getAttribute('data-budget-category-open');
      target = [...document.querySelectorAll('[data-blend-opened="1"]')]
        .find(node => node.getAttribute('data-blend-cat') === id && visible(node));
    }
    if (!target) return null;
    const tile = target.closest('.tile, [data-budget-browse], [data-budget-savings-goals]');
    const value = { node: visible(tile) ? tile : target };
    value.box = originRect(value);
    return value;
  }
  function originRect(value) {
    if (!visible(value?.node)) return null;
    const box = rect(value.node);
    // A tall Household tile may extend outside the viewport. Morph only its
    // visible surface; missing/offscreen origins use the short drawer reveal.
    const left = Math.max(0, box.left), top = Math.max(0, box.top);
    const right = Math.min(global.innerWidth, box.left + box.width);
    const bottom = Math.min(global.innerHeight, box.top + box.height);
    if (right - left < 12 || bottom - top < 12) return null;
    return { left, top, width: right - left, height: bottom - top,
      radius: getComputedStyle(value.node).borderRadius };
  }
  // Genie (owner design "Refined", step 4): the pop-up pours out of the card
  // that opened it and back into it on close. The pouring shape is a stack of
  // EMPTY strips in the sheet's own colour — no cloned evidence, IDs,
  // controls or amounts — so the page never holds a second copy of a figure.
  // Each strip's path is sampled into keyframes and run by run(), so the
  // incumbent cancel/cleanup (reopen, second close, resize, hide, reduced
  // motion switching on) ends it at once. Native open/close/focus are untouched.
  const GENIE_STRIPS = 22, GENIE_FRAMES = 18, GENIE_LAG = .46;
  function genieShell(sheet, source, opening, colour, radius) {
    const shell = document.createElement('div');
    shell.className = 'budget-sheet-motion-shell budget-sheet-genie';
    shell.setAttribute('aria-hidden', 'true');
    shell.inert = true;
    Object.assign(shell.style, { left: '0px', top: '0px', width: '100%', height: '100%', overflow: 'visible' });
    const h = sheet.height / GENIE_STRIPS;
    const centre = source.top + source.height / 2;
    const dist = j => Math.abs(sheet.top + j * h - centre);
    const far = Math.max(dist(0), dist(GENIE_STRIPS)) || 1;
    const smooth = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    const mix = (a, b, e) => a + (b - a) * e;
    const edge = (j, p) => {
      const e = smooth(Math.min(1, Math.max(0, (p - GENIE_LAG * (1 - dist(j) / far)) / (1 - GENIE_LAG))));
      return { y: mix(source.top + source.height * j / GENIE_STRIPS, sheet.top + j * h, e),
        l: mix(source.left, sheet.left, e), w: mix(source.width, sheet.width, e) };
    };
    const specs = [];
    for (let i = 0; i < GENIE_STRIPS; i++) {
      const strip = document.createElement('div');
      Object.assign(strip.style, { position: 'absolute', left: sheet.left + 'px', top: (sheet.top + i * h) + 'px',
        width: sheet.width + 'px', height: (h + .7) + 'px', background: colour, transformOrigin: '0 0',
        borderRadius: i === 0 ? radius + ' ' + radius + ' 0 0' : i === GENIE_STRIPS - 1 ? '0 0 ' + radius + ' ' + radius : '0' });
      shell.appendChild(strip);
      const frames = [];
      for (let k = 0; k <= GENIE_FRAMES; k++) {
        const t = k / GENIE_FRAMES, p = opening ? t : 1 - t;
        const a = edge(i, p), b = edge(i + 1, p);
        frames.push({ offset: t, transform: 'translate(' + ((a.l + b.l) / 2 - sheet.left) + 'px,' + (a.y - (sheet.top + i * h))
          + 'px) scale(' + ((a.w + b.w) / 2 / sheet.width) + ',' + (Math.max(0, b.y - a.y) / h) + ')',
          opacity: Math.min(1, p / .18) });
      }
      specs.push([strip, frames, { duration: opening ? 600 : 460, easing: 'linear' }]);
    }
    document.body.appendChild(shell);
    return { shell, specs };
  }
  function enter(dialog, value) {
    cancel();
    if (reduce() || !dialog.open || typeof dialog.animate !== 'function') return;
    const from = value?.box || originRect(value), to = rect(dialog);
    if (from && to.width && to.height) {
      const style = getComputedStyle(dialog);
      const radius = style.borderTopLeftRadius || '0px';
      const { shell, specs } = genieShell(to, from, true, style.backgroundColor, radius);
      // The dialog is open and focused from the first frame; only its paint
      // waits for the pour to finish, then fades in over the strips.
      specs.push([dialog, [{ opacity: 0 }, { opacity: 0, offset: .72 }, { opacity: 1 }], { duration: 640, easing: ease }]);
      const backdrop = [dialog, [{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: ease, pseudoElement: '::backdrop' }];
      try { dialog.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1, pseudoElement: '::backdrop' }).cancel(); specs.push(backdrop); }
      catch (_) { /* no ::backdrop animation support: the scrim appears at once */ }
      run(dialog, specs, shell);
      return;
    }
    if (!from || !to.width || !to.height) {
      run(dialog, [[dialog, [{ opacity: 0, transform: global.innerWidth < 760
        ? 'translateY(40px)' : 'translateX(40px)' }, { opacity: 1, transform: 'none' }],
      { duration: 380, easing: ease }]]);
      return;
    }
    const transform = 'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top)
      + 'px) scale(' + from.width / to.width + ',' + from.height / to.height + ')';
    const body = dialog.querySelector('[data-budget-detail-body]');
    const specifications = [[dialog, [
      { transform, transformOrigin: '0 0', borderRadius: from.radius },
      { transform: 'none', transformOrigin: '0 0', borderRadius: getComputedStyle(dialog).borderRadius },
    ], { duration: 640, easing: spring }]];
    if (body) specifications.push([body, [
      { opacity: .35, transform: 'translateY(28px) scale(.98)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 800, easing: ease }]);
    run(dialog, specifications);
  }
  function departure(dialog) {
    if (reduce() || !dialog.open) { cancel(dialog); return null; }
    const style = getComputedStyle(dialog);
    const snapshot = { dialog, box: rect(dialog), radius: style.borderRadius,
      background: style.backgroundColor, border: style.border, shadow: style.boxShadow };
    cancel(dialog);
    return snapshot;
  }
  function leave(snapshot, value) {
    cancel();
    if (!snapshot || reduce()) return;
    const to = originRect(value);
    if (!to) return;
    // Genie back into the card: empty strips in the sheet's colour, as on open.
    if (snapshot.box.width && snapshot.box.height) {
      const radius = String(snapshot.radius || '0px').split(' ')[0];
      const { shell, specs } = genieShell(snapshot.box, to, false, snapshot.background, radius);
      run(snapshot.dialog, specs, shell);
      return;
    }
    // An empty shape carries the closing motion. It contains no duplicated
    // evidence, IDs, controls, amounts or actions; native close is already done.
    const shell = document.createElement('div');
    shell.className = 'budget-sheet-motion-shell';
    shell.setAttribute('aria-hidden', 'true');
    shell.inert = true;
    Object.assign(shell.style, { background: snapshot.background,
      border: snapshot.border, boxShadow: snapshot.shadow });
    document.body.appendChild(shell);
    const shape = box => ({ left: box.left + 'px', top: box.top + 'px',
      width: box.width + 'px', height: box.height + 'px' });
    run(snapshot.dialog, [[shell, [
      { ...shape(snapshot.box), borderRadius: snapshot.radius, opacity: 1 },
      { ...shape(to), borderRadius: to.radius, opacity: 0 },
    ], { duration: 540, easing: spring }]], shell);
  }
  function detail(dialog, direction) {
    cancel();
    if (reduce() || !dialog.open) return;
    const body = dialog.querySelector('[data-budget-detail-body]');
    const title = dialog.querySelector('[data-budget-detail-title]');
    const specifications = [];
    if (body) specifications.push([body, direction ? [
      { transform: 'translateX(' + (direction * 100) + '%)' }, { transform: 'none' },
    ] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
    { duration: direction ? 460 : 280, easing: direction ? spring : ease }]);
    if (title) specifications.push([title, [
      { opacity: 0, transform: 'translateX(' + (direction * 18) + 'px)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 320, easing: ease }]);
    run(dialog, specifications);
  }
  global.BudgetSheetMotion = { from, opener, origin, enter, departure, leave, detail, cancel };
})(window);
