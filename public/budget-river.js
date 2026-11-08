/* Source port: original g-blend/js/river.js, SHA256 ea69d4fe3f24f9bf6a8becf8d5b9b014eff7bec1ae8de8f7e10324268d4d4ccb.
 * Seams: native publications/known runs, live selection, lifecycle/capture,
 * unavailable geometry and the owner-approved light theme. No data.js or financial policy. */
/* The pay-period river (Direction A "Cinematic" date selector, adapted).
 * The year as a line of light: height = each period's Balance After Deductions,
 * amber/red beads glow for tight/short periods. Drag or scrub like a film; the
 * playhead springs to the nearest pay period on release (with fling).
 * Changes from A: it lives in the page flow (no fixed dock, so nothing sits
 * under it on phones), it carries month groups and each period's value, and
 * when the year is wider than the screen it pans under a centred playhead. */
(function (root) {
  class Spring {
    constructor(v, o = {}) { this.x = v; this.v = 0; this.target = v; this.k = o.k || 190; this.c = o.c || 27; }
    step(dt) {
      const n = Math.ceil(dt / 0.008), h = dt / n;
      for (let i = 0; i < n; i++) { const a = -this.k * (this.x - this.target) - this.c * this.v; this.v += a * h; this.x += this.v * h; }
      if (Math.abs(this.v) < 1e-3 && Math.abs(this.x - this.target) < 1e-3) { this.x = this.target; this.v = 0; }
      return this.x;
    }
    get settled() { return this.x === this.target && this.v === 0; }
    set(v) { this.x = this.target = v; this.v = 0; }
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const DARK_COL = { healthy: [92, 242, 176], tight: [255, 190, 92], short: [255, 86, 102] };
  const LIGHT_COL = { healthy: [10, 168, 112], tight: [236, 146, 18], short: [225, 63, 90], unknown: [144, 150, 162] };
  DARK_COL.unknown = [144, 150, 162];
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const sprites = new Map();
  const glow = c => {
    const key = c.join(',');
    if (sprites.has(key)) return sprites.get(key);
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const x = cv.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.38, `rgba(${key},.55)`); g.addColorStop(1, `rgba(${key},0)`);
    x.fillStyle = g; x.fillRect(0, 0, 64, 64); sprites.set(key, cv); return cv;
  };
  function monotone(xs, ys) {
    const n = xs.length, d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return m;
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const publicationKey = periods => JSON.stringify(periods.map(p =>
    [p.start, p.end, p.bad, p.state, p.role, p.label, p.fullLabel, p.estimated]));

  const River = {
    init(o) {
      Object.assign(this, o);
      this.N = this.periods.length;
      this.ctx = this.canvas.getContext('2d');
      this.head = new Spring(Math.max(0, this.index), { k: 190, c: 27 });
      this.dragging = false;
      this.parts = Array.from({ length: 40 }, (_, i) => ({ u: (i * 0.6180339) % 1, sp: 0.03 + ((i * 7) % 11) / 220, r: 0.6 + ((i * 5) % 9) / 6, o: (i * 0.37) % 1 }));
      this.reveal = this.reduce || o.noIntro ? 1 : 0;
      this.removers = []; this.visible = true; this.disposed = false; this.raf = null;
      this.layout(); this.bind();
      this.periodKey = publicationKey(this.periods);
      this.sizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
        for (const entry of entries) {
          if (entry.target === this.pill) this.pillWidth = entry.borderBoxSize?.[0]?.inlineSize || this.pill.offsetWidth;
          else this.layout();
        }
        this.request();
      }) : null;
      this.sizeObserver?.observe(this.el); this.sizeObserver?.observe(this.pill);
      this.listen(root, 'resize', () => { this.layout(); this.request(); });
      this.listen(document, 'visibilitychange', () => { this.last = 0; this.request(); });
      this.media = matchMedia('(prefers-reduced-motion: reduce)');
      this.listen(this.media, 'change', () => { this.reduce = this.media.matches; if (this.reduce) { this.head.set(this.head.target); this.reveal = 1; } this.request(); });
      this.observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        this.visible = !!entries[0]?.isIntersecting; this.last = 0; this.request();
      }) : null;
      this.observer?.observe(this.el);
      const updateTheme = () => {
        this.dark = document.documentElement.dataset.theme === 'dark'
          || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
        this.build(); this.request();
      };
      this.themeMedia = matchMedia('(prefers-color-scheme: dark)');
      this.listen(this.themeMedia, 'change', updateTheme);
      this.themeObserver = new MutationObserver(updateTheme);
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      this.request(); return this;
    },
    listen(target, event, fn, options) {
      target.addEventListener(event, fn, options);
      this.removers.push(() => target.removeEventListener(event, fn, options));
    },
    request() {
      this._dirty = true;
      if (this.raf != null || this.disposed || document.hidden || !this.visible) return;
      this.raf = requestAnimationFrame(ts => {
        this.raf = null;
        if (this.disposed || !this.el.isConnected) return;
        const dt = this.last ? Math.min(.05, Math.max(.001, (ts - this.last) / 1000)) : .016;
        this.last = ts;
        if (!document.querySelector('dialog[open]')) this.frame(dt, ts / 1000);
        if (!this.reduce || !this.head.settled || this.dragging || this.reveal < 1) this.request();
      });
    },
    adopt(o) {
      const key = publicationKey(o.periods), changed = key !== this.periodKey || o.dark !== this.dark;
      Object.assign(this, o); this.N = this.periods.length;
      this.periodKey = key;
      if (!this.dragging) this.head.target = Math.max(0, this.index);
      if (this.reduce) this.head.set(this.head.target);
      // A native period selection changes the selected row, not the printed
      // year. Keep the canvas, curve and label nodes through those remounts.
      // ResizeObserver handles geometry; new publications rebuild the curve.
      if (changed) this.update();
      this.mark(this.index); this.request();
    },
    dispose() {
      this.disposed = true; this.dragging = false;
      this.removers.forEach(remove => remove()); this.observer?.disconnect(); this.themeObserver?.disconnect();
      this.sizeObserver?.disconnect();
      if (this.raf != null) cancelAnimationFrame(this.raf);
      if (this.pointerId != null && this.captureTarget?.hasPointerCapture?.(this.pointerId)) this.captureTarget.releasePointerCapture(this.pointerId);
    },
    layout() {
      const r = this.el.getBoundingClientRect();
      if (r.width) this.lastRect = r;
      const dpr = Math.min(2, devicePixelRatio || 1);
      if (this.W === r.width && this.H === r.height && this.dpr === dpr) return;
      this.dpr = dpr;
      this.W = r.width; this.H = r.height;
      if (!this.W) return;
      this.canvas.width = Math.round(this.W * dpr); this.canvas.height = Math.round(this.H * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const mobile = this.W < 640;
      this.padL = mobile ? 26 : 36; this.padR = this.padL;
      // Owner-approved shorter tile (~25% less height): the plotting band
      // stays centred between the playhead pill (bottom edge 31px) and the
      // value labels (top edge 44px from the bottom) with equal clearances
      // — 7px desktop, 5px mobile. The value domain is unchanged, so the
      // zero line keeps its data-derived position inside the band.
      this.top = mobile ? 36 : 38; this.bot = this.H - (mobile ? 49 : 51);
      this.beamTop = 30; // 1px above the pill's bottom edge, as before
      const fit = this.N < 2 ? 0 : (this.W - this.padL - this.padR) / (this.N - 1), minSp = mobile ? 44 : 52;
      this.pan = this.N > 1 && fit < minSp;
      this.sp = this.pan ? minSp : fit;
      this.CW = this.N < 2 ? this.W : this.padL + this.sp * (this.N - 1) + this.padR;
      this.build();
      this.labels();
      this.place(this.head.x);
    },
    build() {
      this.el.parentElement.dataset.riverTheme = this.dark ? 'dark' : 'light';
      this.COL = this.dark ? DARK_COL : LIGHT_COL;
      const vals = this.periods.map(p => p.bad).filter(Number.isFinite);
      const vmax = vals.length ? Math.max(...vals) : 1, vmin = Math.min(0, ...vals), span = vmax - vmin || 1;
      this.yOf = v => this.bot - (v - vmin) / span * (this.bot - this.top);
      this.xs = this.periods.map((_, i) => this.xc(i));
      this.ys = this.periods.map(p => Number.isFinite(p.bad) ? this.yOf(p.bad) : null);
      this.ms = new Array(this.N).fill(null); this.runIds = new Array(this.N).fill(null);
      this.y0 = vals.length ? this.yOf(0) : (this.top + this.bot) / 2;
      this.path = new Path2D(); this.area = new Path2D();
      this.knownRuns.forEach((run, id) => {
        run.forEach(i => { this.runIds[i] = id; });
        if (run.length < 2) return;
        const xs = run.map(i => this.xs[i]), ys = run.map(i => this.ys[i]), ms = monotone(xs, ys);
        run.forEach((i, j) => { this.ms[i] = ms[j]; });
        const path = new Path2D(); path.moveTo(xs[0], ys[0]);
        for (let i = 0; i < run.length - 1; i++) {
          const h = xs[i + 1] - xs[i];
          path.bezierCurveTo(xs[i] + h / 3, ys[i] + ms[i] * h / 3, xs[i + 1] - h / 3, ys[i + 1] - ms[i + 1] * h / 3, xs[i + 1], ys[i + 1]);
        }
        const area = new Path2D(path);
        area.lineTo(xs[xs.length - 1], this.bot + 6); area.lineTo(xs[0], this.bot + 6); area.closePath();
        this.path.addPath(path); this.area.addPath(area);
      });
      const g = k => {
        const gr = this.ctx.createLinearGradient(this.xs[0], 0, this.xs[this.N - 1], 0);
        this.periods.forEach((p, i) => { const c = this.COL[p.state] || this.COL.unknown;
          gr.addColorStop(this.N < 2 ? 0 : i / (this.N - 1), rgba(k ? c.map(v => Math.round(v + (255 - v) * k)) : c, 1)); }); return gr;
      };
      this.grad = g(0); this.gradCore = g(this.dark ? 0.55 : 0.15);
      this.monthX = [];
      this.periods.forEach((p, i) => { const prev = this.periods[i - 1]; if (i && p.start && prev.start.slice(0, 7) !== p.start.slice(0, 7)) this.monthX.push(this.xs[i] - this.sp / 2); });
    },
    /* periods changed (e.g. a Confirm): redraw the curve and labels */
    update() { this.build(); this.labels(); },
    labels() {
      const fmt = this.fmt;
      let mh = '', vh = '', yearDone = false;
      // first month only gets a label if it owns at least 2 periods (otherwise it collides with the next)
      const firstNew = this.periods.findIndex((p, i) => i && p.start.slice(0, 7) !== this.periods[i - 1].start.slice(0, 7));
      this.periods.forEach((p, i) => {
        const x = this.xs[i], prev = this.periods[i - 1];
        if (p.start && (!prev ? firstNew === -1 || firstNew >= 2 : prev.start.slice(0, 7) !== p.start.slice(0, 7))) {
          const m = +p.start.slice(5, 7) - 1, yr = m === 0 || !yearDone;
          yearDone = true;
          mh += `<span style="left:${(Math.max(x - this.sp / 2, 0) + 6).toFixed(1)}px"${m === 0 ? ' class="is-year"' : ''}>${escapeHtml(MON[m])}${yr ? ` <b>${escapeHtml(p.start.slice(0, 4))}</b>` : ''}</span>`;
        }
        vh += `<span class="rv" data-i="${i}" data-state="${escapeHtml(p.state)}" style="left:${x.toFixed(1)}px">${fmt(p.bad, i)}</span>`;
      });
      this.monthsEl.innerHTML = mh;
      this.valsEl.innerHTML = vh;
      this.valEls = Array.from(this.valsEl.children);
      this._stepEl = null; // rebuilt label nodes carry no step-aside transform
      this._stepBox = null; // ... and no stepped-label hit box (see hitIndex)
      this._yielded = new Set(); // ... and no yielded (faded-out) state
      this.valEls.forEach((el, i) => { el.title = this.periods[i].fullLabel || ''; el.classList.toggle('is-est', !!this.periods[i].estimated);
        if (this.periods[i].label != null) el.dataset.riverNativeValue = this.periods[i].label;
      });
      this.mark(this.index);
    },
    mark(i) { if (this.valEls) this.valEls.forEach((e, k) => { e.classList.toggle('is-sel', k === i); e.classList.toggle('is-past', this.periods[k].role === 'past'); }); },
    xc(f) { return this.N < 2 ? this.W / 2 : this.padL + f * this.sp; },
    offFor(f) { return this.pan ? clamp(this.xc(f) - this.W / 2, 0, this.CW - this.W) : 0; },
    fOfScreen(x) { return this.N < 2 ? 0 : clamp((x + this.off - this.padL) / this.sp, 0, this.N - 1); },
    /* Discrete pointer resolution (tap, hover). The raw mapping resolves
       to the period whose data centre is nearest the pointer — but a
       selected bottom-edge label steps sideways clear of the orb
       (place()), possibly by more than half the period spacing, so its
       visible centre can sit nearer the neighbouring period's centre
       than its own, and a tap on the label the user sees would select
       the neighbour. While a label is stepped, its period's marker for
       this resolution is the label's visible centre: the pointer
       resolves to whichever marker — the raw winner's data centre or
       the stepped label's visible centre — is nearer, with ties keeping
       the visible label. (The step cannot instead be capped: at mobile
       spacing any orb-clearing step crosses a neighbour's centre, and
       an uncapped step leaves the neighbouring period's own centre
       resolving to that period, as before.) Placement, geometry and
       the continuous drag/scrub mappings are unchanged; the drag paths
       are deliberately not routed here. */
    hitIndex(x) {
      const raw = Math.round(this.fOfScreen(x)), b = this._stepBox;
      if (!b || raw === b.i) return raw;
      const centre = (b.l + b.r) / 2;
      return Math.abs(x - centre) <= Math.abs(x - (this.xs[raw] - this.off)) ? b.i : raw;
    },
    yAt(f) {
      f = clamp(f, 0, this.N - 1);
      if (this.N < 2 || Number.isInteger(f)) return this.ys[Math.round(f)];
      const left = Math.floor(f), right = left + 1;
      if (this.ys[left] == null || this.ys[right] == null || this.runIds[left] !== this.runIds[right]) return null;
      const i = clamp(Math.floor(f), 0, this.N - 2), t = f - i, h = this.xs[i + 1] - this.xs[i];
      const t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * this.ys[i] + (t3 - 2 * t2 + t) * h * this.ms[i] + (-2 * t3 + 3 * t2) * this.ys[i + 1] + (t3 - t2) * h * this.ms[i + 1];
    },
    bind() {
      const el = this.el, capture = this.captureTarget || el;
      let lastX = 0, lastT = 0, vel = 0, downX = 0, downY = 0, downF = 0, moved = false, pid = null, downHit = null;
      this.listen(el, 'pointerdown', e => {
        if (!this.enabled || document.querySelector('dialog[open]')) return;
        if (e.isPrimary === false) return;
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        pid = this.pointerId = e.pointerId; el.focus({ preventScroll: true }); this.dragging = true; moved = false; downX = e.clientX; downY = e.clientY; downF = this.head.x;
        lastX = e.clientX; lastT = performance.now(); vel = 0;
        el.classList.add('is-dragging'); this.request();
        const r = el.isConnected ? el.getBoundingClientRect() : this.lastRect;
        // Resolve this press's discrete target now, against the geometry
        // the user sees as they press: a stationary release commits this
        // index (see end()), because in a non-pan layout the press also
        // aims the spring at the raw fractional position and the ensuing
        // spring/place motion can clear the stepped label's hit box
        // before pointerup (Systems Review 5481846544).
        downHit = this.hitIndex(e.clientX - r.left);
        if (!this.pan) { this.head.target = this.fOfScreen(e.clientX - r.left); }
      });
      this.listen(root, 'pointermove', e => {
        if (!this.dragging || e.pointerId !== pid) return;
        if (!moved && Math.abs(e.clientY - downY) > 5 && Math.abs(e.clientY - downY) > Math.abs(e.clientX - downX)) { end(e, true); return; }
        if (Math.abs(e.clientX - downX) > 5 && !moved) { moved = true; try { capture.setPointerCapture(e.pointerId); } catch (er) { /* gone */ } }
        if (moved && e.cancelable) e.preventDefault();
        const now = performance.now(), dt = Math.max(1, now - lastT);
        vel = 0.75 * vel + 0.25 * ((e.clientX - lastX) / dt);
        lastX = e.clientX; lastT = now;
        if (this.pan) { if (moved) this.head.target = clamp(downF - (e.clientX - downX) / this.sp, 0, this.N - 1); }
        else { const r = el.isConnected ? el.getBoundingClientRect() : this.lastRect; this.head.target = this.fOfScreen(e.clientX - r.left); }
        const i = Math.round(this.head.target);
        if (moved && i !== this.index) { this.index = i; this.mark(i); this.onChange && this.onChange(i, 'scrub'); }
        this.request();
      });
      const end = (e, cancelled = false) => {
        if (!this.dragging || e.pointerId !== pid) return;
        this.dragging = false; el.classList.remove('is-dragging');
        const hit = downHit; downHit = null;
        if (capture.hasPointerCapture?.(pid)) capture.releasePointerCapture(pid);
        if (cancelled) { const native = this.onCancel?.(); if (Number.isInteger(native)) this.index = native; this.head.set(Math.max(0, this.index)); this.mark(this.index); this.request(); return; }
        if (!moved) {
          // Stationary press: commit the target resolved at pointerdown.
          // Re-resolving the release coordinate here would measure it
          // against geometry the hold itself changed — in a non-pan
          // layout the spring travels to the raw fractional aim during
          // the hold, the displaced label un-steps, and its hit box
          // clears, so the release would commit the neighbouring period
          // (Systems Review 5481846544). Once movement begins the press
          // is a drag and takes the continuous path below, unchanged.
          if (hit != null) { this.go(hit); return; }
          const r = el.isConnected ? el.getBoundingClientRect() : this.lastRect; this.go(this.hitIndex(e.clientX - r.left)); return;
        }
        const fresh = !this.reduce && performance.now() - lastT < 80 && Math.abs(vel) > 0.6;
        const fling = moved && fresh ? clamp((this.pan ? -vel : vel) * 140 / this.sp, -4, 4) : 0;
        this.go(Math.round(clamp(this.head.target + fling, 0, this.N - 1)));
      };
      this.listen(root, 'pointerup', e => end(e));
      this.listen(root, 'pointercancel', e => end(e, true));
      this.listen(root, 'keydown', e => {
        if (!this.enabled || this.dragging || this.cur < 0 || e.altKey || e.ctrlKey || e.metaKey
          || document.querySelector('dialog[open]') || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        if (e.key === 't' || e.key === 'T') { e.preventDefault(); this.go(this.cur); }
      });
      // Touch starts with implicit capture on the canvas. Transferring it to
      // the stable mount legitimately emits a bubbling loss from that canvas.
      this.listen(capture, 'lostpointercapture', e => { if (e.target === capture) end(e, true); });
      this.listen(el, 'keydown', e => {
        if (!this.enabled || this.dragging || e.altKey || e.ctrlKey || e.metaKey) return;
        const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 6, PageDown: -6 }[e.key];
        if (k) { e.preventDefault(); e.stopPropagation(); this.go(clamp(this.index + k, 0, this.N - 1)); }
        else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); this.go(0); }
        else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); this.go(this.N - 1); }
      });
      let acc = 0, accT = 0;
      this.listen(el, 'wheel', e => {
        if (!this.enabled || this.dragging || e.ctrlKey || e.metaKey) return;
        const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
        if (!horizontal && document.activeElement !== el) return;
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if ((this.index === 0 && d < 0) || (this.index === this.N - 1 && d > 0)) return;
        e.preventDefault();
        if (performance.now() - accT > 400) acc = 0;
        accT = performance.now(); acc += d;
        if (Math.abs(acc) > 60) { this.go(clamp(this.index + Math.sign(acc), 0, this.N - 1)); acc = 0; }
      }, { passive: false });
      if (matchMedia('(hover: hover)').matches) {
        this.listen(el, 'pointermove', e => { if (this.dragging) return; const r = el.getBoundingClientRect(); this.hover = this.hitIndex(e.clientX - r.left); this.hoverVal(); });
        this.listen(el, 'pointerleave', () => { this.hover = null; this.hoverVal(); });
      }
    },
    hoverVal() { if (this.valEls) this.valEls.forEach((e, k) => e.classList.toggle('is-hover', k === this.hover)); },
    go(i, instant) {
      if (!this.enabled) return;
      const changed = i !== this.index;
      this.index = i; this.head.target = i; this.mark(i);
      if (instant || this.reduce) this.head.set(i);
      if (changed || !instant) this.onChange && this.onChange(i, 'commit');
      this.request();
    },
    place(f) {
      this.off = this.offFor(f);
      const x = this.xc(f) - this.off, y = this.yAt(f);
      this.playhead.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
      const known = y != null;
      this.playhead.querySelector('.playhead-orb').hidden = this.playhead.querySelector('.playhead-beam').hidden = !known;
      if (known) this.playhead.style.setProperty('--orb-y', `${y.toFixed(2)}px`);
      this.playhead.style.setProperty('--beam-top', `${this.beamTop ?? this.top - 12}px`);
      this.slide.style.transform = `translate3d(${(-this.off).toFixed(2)}px,0,0)`;
      // Selected-extreme legibility: a point at the band's bottom edge parks
      // the 20px orb one radius above the value-label row, so the disc covers
      // the selected label's own text. Step that label sideways just clear of
      // the disc (toward the side with more room, clamped inside the tile);
      // if a sideways step would erase another visible period target, use
      // the space above the disc instead. Viewport-clamped values retain
      // their existing horizontal placement and context-label yielding.
      // Placement only — selection, domain, and gesture behaviour unchanged.
      const selEl = this.valEls && this.index >= 0 ? this.valEls[this.index] : null;
      if (this._stepEl && this._stepEl !== selEl) { this._stepEl.style.transform = ''; this._stepEl = null; this._stepBox = null; }
      let stepDx = 0, stepDy = 0, selW = 0, selC = 0;
      if (selEl) {
        selW = selEl.offsetWidth; selC = this.xs[this.index] - this.off;
        // Keep a visible selected value whole at an end of the viewport.
        // The existing displaced-label hit box also follows this paint shift;
        // point coordinates, camera, selection and drag/fling stay untouched.
        const edgeDx = selC >= 0 && selC <= this.W
          ? clamp(selC, selW / 2 + 2, this.W - selW / 2 - 2) - selC : 0;
        stepDx = edgeDx;
        if (known && y + 10 > this.H - 44) {
          const need = 12 + selW / 2 - Math.abs(selC - x);
          if (need > 0) {
            const dir = this.W - (selC + selW / 2) >= selC - selW / 2 ? 1 : -1;
            stepDx = clamp(selC + dir * need, selW / 2 + 2, this.W - selW / 2 - 2) - selC;
            if (Math.abs(selC + stepDx - x) < 12 + selW / 2) stepDx = edgeDx; // no room: retain viewport clearance
            if (stepDx && !edgeDx) {
              const masksTarget = dx => {
                const left = selC + dx - selW / 2, right = selC + dx + selW / 2;
                return this.valEls.some((el, k) => {
                  if (k === this.index) return false;
                  const ck = this.xs[k] - this.off, half = el.offsetWidth / 2;
                  return ck - half >= 0 && ck + half <= this.W
                    && (ck + half <= x - 10 || ck - half >= x + 10)
                    && ck + half > left && ck - half < right;
                });
              };
              // The extra row uses the period's raw click region. Keep a
              // pixel of room on each side; wider text retains its existing
              // horizontal displacement and hit box, even with tiny neighbors.
              if (selW + 2 <= this.sp && masksTarget(stepDx) && !masksTarget(0)) {
                stepDx = 0;
                // The value row ends 28px above the tile bottom. Its new
                // bottom clears the 10px-radius orb by the same 2px gap.
                stepDy = y - 12 - (this.H - 28);
              }
            }
          }
        }
        const t = stepDy ? `translateX(-50%) translateY(${stepDy.toFixed(1)}px)`
          : stepDx ? `translateX(-50%) translateX(${stepDx.toFixed(1)}px)` : '';
        if (selEl.style.transform !== t) selEl.style.transform = t;
        this._stepEl = stepDx || stepDy ? selEl : null;
        // The stepped label's visible box, in element coordinates: pointer
        // resolution (hitIndex) honours it, because the box can sit inside
        // the neighbouring period's raw hit region.
        this._stepBox = stepDx ? { i: this.index, l: selC + stepDx - selW / 2, r: selC + stepDx + selW / 2 } : null;
      }
      if (this.valEls) {
        if (!this._yielded) this._yielded = new Set();
        const inBand = known && y + 10 > this.H - 44;
        const selL = selC + stepDx - selW / 2, selR = selC + stepDx + selW / 2;
        this.valEls.forEach((el, k) => {
          if (k === this.index) {
            // The selected label must never stay yielded: a label faded out
            // as a neighbour keeps its node across selections (mark/adopt
            // retain the nodes), so restore it before the skip — this loop is
            // the only place its opacity is managed.
            if (this._yielded.has(el)) { el.style.opacity = ''; this._yielded.delete(el); }
            return;
          }
          let cover = false;
          // An undisplaced selected value also needs its own clear text box.
          if (inBand || selW > 0) {
            const ck = this.xs[k] - this.off, wk = el.offsetWidth;
            cover = (inBand && ck + wk / 2 > x - 10 && ck - wk / 2 < x + 10)
              || (selW > 0 && !stepDy && ck + wk / 2 > selL && ck - wk / 2 < selR);
          }
          if (cover && !this._yielded.has(el)) { el.style.opacity = '0'; this._yielded.add(el); }
          else if (!cover && this._yielded.has(el)) { el.style.opacity = ''; this._yielded.delete(el); }
        });
        // Offscreen context must not leave a cut sign, number or date fragment.
        // These labels are decorative; the native slider/pill retain the full
        // selected publication. Visibility resets as the camera returns.
        this.valEls.forEach((el, k) => {
          const centre = this.xs[k] - this.off + (k === this.index ? stepDx : 0), half = el.offsetWidth / 2;
          el.style.visibility = centre - half >= 0 && centre + half <= this.W ? '' : 'hidden';
        });
      }
      // The month row sits inside the tile's rounded lower corners. Derive its
      // clearance from that existing clip instead of changing timeline geometry.
      const radius = parseFloat(getComputedStyle(this.el.parentElement).borderBottomLeftRadius) || 0;
      const depth = clamp(this.monthsEl.offsetTop + this.monthsEl.offsetHeight - (this.H - radius), 0, radius);
      const inset = Math.ceil(radius - Math.sqrt(Math.max(0, radius * radius - depth * depth))) + 1;
      for (const month of this.monthsEl.children) {
        const left = parseFloat(month.style.left) - this.off, shift = Math.max(0, inset - left);
        const fits = left >= 0 && left + shift + month.offsetWidth <= this.W - inset;
        month.style.visibility = fits ? '' : 'hidden';
        month.style.transform = fits && shift ? `translateX(${shift.toFixed(1)}px)` : '';
      }
      if (this.index < 0) {
        this.playhead.style.transform = 'translate3d(8px,0,0)'; this.pill.style.transform = 'none';
        this.playhead.querySelector('.playhead-orb').hidden = this.playhead.querySelector('.playhead-beam').hidden = true;
        return;
      }
      const pw = this.pillWidth || (this.pillWidth = this.pill.offsetWidth || 160);
      const shift = clamp(-pw / 2, -x + 8, this.W - x - pw - 8);
      this.pill.style.transform = `translate3d(${shift.toFixed(2)}px,0,0)`;
    },
    frame(dt, t) {
      if (!this.W) { this.layout(); if (!this.W) return; }
      const f = this.head.step(dt);
      this.place(f);
      if (this.reveal < 1) this.reveal = Math.min(1, this.reveal + dt / 1.6);
      if (this.reduce && this._drawn && this.head.settled && !this.dragging && this._lastF === f && !this._dirty) return;
      this._drawn = true; this._lastF = f; this._dirty = false;
      this.draw(t, f);
    },
    draw(t, f) {
      const c = this.ctx, W = this.W, H = this.H, off = this.off;
      c.clearRect(0, 0, W, H);
      c.save(); c.translate(-off, 0);
      const rev = 1 - Math.pow(1 - this.reveal, 3);
      const revX = this.xs[0] + (this.xs[this.N - 1] - this.xs[0] + 20) * rev;
      c.beginPath(); c.rect(off - 10, 0, revX - off + 10, H); c.clip();
      const COL = this.COL, light = !this.dark;
      const xCur = this.xc(this.cur - 0.5);
      /* month groups */
      c.fillStyle = light ? 'rgba(16,18,27,.07)' : 'rgba(255,255,255,.07)';
      this.monthX.forEach(x => c.fillRect(Math.round(x), this.top - 26, 1, this.bot - this.top + 34));
      /* river body */
      c.save();
      c.globalAlpha = 0.22; c.fillStyle = this.grad; c.fill(this.area);
      c.globalCompositeOperation = 'destination-out';
      const fade = c.createLinearGradient(0, this.top, 0, this.bot + 6);
      fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,1)');
      c.globalAlpha = 1; c.fillStyle = fade; c.fillRect(off - 10, this.top - 40, W + 20, this.bot - this.top + 50);
      c.restore();
      /* zero line */
      c.save(); c.setLineDash([2, 6]); c.strokeStyle = light ? 'rgba(16,18,27,.2)' : 'rgba(255,255,255,.22)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(this.xs[0] - 18, this.y0 + .5); c.lineTo(this.xs[this.N - 1] + 18, this.y0 + .5); c.stroke(); c.restore();
      /* glow + core, past dimmed */
      const pass = a => {
        c.globalCompositeOperation = light ? 'source-over' : 'lighter';
        c.strokeStyle = this.grad; c.lineCap = 'round'; c.lineJoin = 'round';
        c.globalAlpha = 0.07 * a; c.lineWidth = 16; c.stroke(this.path);
        c.globalAlpha = 0.16 * a; c.lineWidth = 7; c.stroke(this.path);
        c.globalAlpha = 0.95 * a; c.lineWidth = 2; c.strokeStyle = this.gradCore; c.stroke(this.path);
      };
      c.save(); c.beginPath(); c.rect(off - 10, 0, xCur - off + 10, H); c.clip(); pass(0.42); c.restore();
      c.save(); c.beginPath(); c.rect(xCur, 0, W + off - xCur + 10, H); c.clip(); pass(1); c.restore();
      /* period beads: amber / red glow for tight / short */
      c.globalCompositeOperation = light ? 'source-over' : 'lighter';
      this.periods.forEach((p, i) => {
        const x = this.xs[i], y = this.ys[i], col = COL[p.state], a = p.role === 'past' ? 0.5 : 1;
        if (y == null) return;
        if (x < off - 30 || x > off + W + 30) return;
        if (p.state !== 'healthy') {
          const pulse = this.reduce ? 0.5 : 0.5 + 0.5 * Math.sin(t * (p.state === 'short' ? 4 : 2.2) + i);
          const rr = (p.state === 'short' ? 15 : 10) + pulse * 4;
          const g = c.createRadialGradient(x, y, 0, x, y, rr);
          g.addColorStop(0, rgba(col, 0.6 * a)); g.addColorStop(1, rgba(col, 0));
          c.fillStyle = g; c.globalAlpha = 1; c.beginPath(); c.arc(x, y, rr, 0, 7); c.fill();
        }
        c.globalAlpha = a; c.fillStyle = rgba(col.map(v => Math.round(v + (255 - v) * 0.4)), 1);
        c.beginPath(); c.arc(x, y, p.state === 'healthy' ? 2.4 : 3.6, 0, 7); c.fill();
      });
      /* light flowing downstream */
      if (!this.reduce && this.N > 1) {
        this.parts.forEach(pt => {
          pt.u += pt.sp * 0.016 * (this.dragging ? 2.2 : 1);
          if (pt.u > 1) pt.u -= 1;
          const ff = pt.u * (this.N - 1), x = this.xc(ff);
          if (x < off - 20 || x > off + W + 20) return;
          const y = this.yAt(ff); if (y == null) return;
          const col = COL[this.periods[Math.round(ff)].state];
          const a = (ff < this.cur - 0.5 ? 0.35 : 0.9) * (0.5 + 0.5 * Math.sin(t * 3 + pt.o * 6));
          const rr = 3 + pt.r * 3;
          c.globalAlpha = Math.max(0, a); c.drawImage(glow(col), x - rr, y - rr, rr * 2, rr * 2);
        });
      }
      /* today */
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
      if (this.cur >= 0 && this.ys[this.cur] != null) {
      const xt = this.xs[this.cur], yt = this.y0;
      c.fillStyle = 'rgba(255,255,255,.85)';
      c.beginPath(); c.moveTo(xt, yt - 5); c.lineTo(xt + 5, yt); c.lineTo(xt, yt + 5); c.lineTo(xt - 5, yt); c.closePath(); c.fill();
      }
      /* lens: brighten the selected stretch */
      const xs = this.xc(f), ys = this.yAt(f);
      if (ys != null) {
      const lg = c.createRadialGradient(xs, ys, 0, xs, ys, 90);
      lg.addColorStop(0, light ? 'rgba(10,168,112,.08)' : 'rgba(255,255,255,.10)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
      c.globalCompositeOperation = light ? 'source-over' : 'lighter'; c.fillStyle = lg; c.fillRect(xs - 90, 0, 180, H);
      }
      c.restore();
      this.el.setAttribute('data-river-motion', !this.head.settled || this.reveal < 1 ? 'moving' : 'settled');
    },
  };
  const api = { create: options => Object.create(River).init(options), Spring };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BudgetRiver = api;
})(globalThis);
