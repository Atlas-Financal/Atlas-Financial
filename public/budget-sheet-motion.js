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
  function enter(dialog, value) {
    cancel();
    if (reduce() || !dialog.open || typeof dialog.animate !== 'function') return;
    const from = value?.box || originRect(value), to = rect(dialog);
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
