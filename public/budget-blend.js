'use strict';
/* Visual layer for the Budget bento. Copies text the page already rendered.
   Does not read Forecast, total money, or invent a figure. */
(function blendBudget() {
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let categoryFocusReturn = null;
  let retainedAurora = null;
  let stackPlaceTiles = null;
  function moveWidget(parent, node, before = null) {
    if (parent.moveBefore && parent.isConnected && node.isConnected) parent.moveBefore(node, before);
    else parent.insertBefore(node, before);
  }

  function clip(node) {
    if (node) node.classList.add('blend-clip');
  }

  function text(node) {
    return (node && node.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Tap-to-explain window (owner direction, 2026-11-09: clean main view,
  // explanations on tap). One small native modal dialog for the whole
  // page: it traps focus, closes on Escape, the Close button or a tap
  // outside, and hands focus back to the row that opened it. It prints
  // only nodes its caller copied from text the page already rendered; it
  // reads no Forecast value and computes nothing. A remount closes it, so
  // it never keeps wording from a period the page no longer shows.
  let explainDialog = null;
  let explainOpener = null;
  let explainRestore = true;
  function explainClose(restoreFocus = true) {
    if (!explainDialog?.open) return;
    explainRestore = restoreFocus;
    explainDialog.close();
  }
  function explainSettle(restoreFocus) {
    const back = explainOpener;
    explainOpener = null;
    if (!back) return;
    back.setAttribute('aria-expanded', 'false');
    if (restoreFocus && back.isConnected) back.focus({ preventScroll: true });
  }
  function explainOpen(opener, title, content) {
    if (typeof HTMLDialogElement === 'undefined' || !opener?.isConnected) return false;
    if (!explainDialog) {
      const dialog = document.createElement('dialog');
      dialog.className = 'blend-explain';
      dialog.id = 'blend-explain';
      dialog.setAttribute('data-blend-explain', '');
      dialog.setAttribute('aria-labelledby', 'blend-explain-title');
      const sheet = document.createElement('div');
      sheet.className = 'blend-explain-sheet';
      const head = document.createElement('header');
      const heading = document.createElement('h2');
      heading.id = 'blend-explain-title';
      heading.setAttribute('data-blend-explain-title', '');
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'blend-explain-close';
      close.setAttribute('data-blend-explain-close', '');
      close.setAttribute('aria-label', 'Close');
      close.textContent = '×';
      close.addEventListener('click', () => explainClose());
      head.append(heading, close);
      const body = document.createElement('div');
      body.className = 'blend-explain-body';
      body.setAttribute('data-blend-explain-body', '');
      sheet.append(head, body);
      dialog.appendChild(sheet);
      // The dialog box carries no padding, so a click whose target is the
      // dialog itself landed on the backdrop.
      dialog.addEventListener('click', event => { if (event.target === dialog) explainClose(); });
      // The close event arrives a task after the dialog closes. If the
      // window has been opened again by then, that event belongs to the
      // earlier session and must not empty or settle the new one.
      dialog.addEventListener('close', () => {
        if (dialog.open) return;
        const restore = explainRestore;
        explainRestore = true;
        body.replaceChildren();
        explainSettle(restore);
      });
      document.body.appendChild(dialog);
      explainDialog = dialog;
    }
    if (explainDialog.open) explainClose(false);
    explainSettle(false);
    explainRestore = true;
    explainDialog.querySelector('[data-blend-explain-title]').textContent = title;
    explainDialog.querySelector('[data-blend-explain-body]').replaceChildren(content);
    explainOpener = opener;
    opener.setAttribute('aria-controls', explainDialog.id);
    opener.setAttribute('aria-expanded', 'true');
    explainDialog.showModal();
    return true;
  }
  // A copy for the window: the printed nodes, without the page's own hook
  // attributes or ids, so no selector finds a second copy of a source row.
  function explainCopy(node) {
    const copy = node.cloneNode(true);
    if (copy.nodeType !== 1) return copy;
    [copy, ...copy.querySelectorAll('*')].forEach(element => {
      [...element.attributes].forEach(attribute => {
        if (attribute.name === 'id' || attribute.name.startsWith('data-')) element.removeAttribute(attribute.name);
      });
    });
    return copy;
  }
  // The Savings goal window: every fact plan.js printed on the goal's row,
  // label beside figure, with the estimate wording spelled out. Verbatim
  // copies only — no amount is parsed, compared or recomputed here.
  function explainGoal(button, row) {
    const content = document.createDocumentFragment();
    const status = text(row.querySelector('.budget-goal-state'));
    if (status) {
      const line = document.createElement('p');
      line.className = 'blend-explain-status';
      line.setAttribute('data-blend-explain-status', '');
      line.textContent = status;
      content.appendChild(line);
    }
    const facts = document.createElement('dl');
    facts.className = 'blend-explain-facts';
    const fact = (key, label, nodes, note, words) => {
      const line = document.createElement('div');
      line.className = 'blend-explain-fact';
      line.setAttribute('data-blend-explain-fact', key);
      const term = document.createElement('dt');
      term.textContent = label;
      const value = document.createElement('dd');
      if (words) value.className = 'blend-explain-words';
      nodes.forEach(node => value.appendChild(explainCopy(node)));
      line.append(term, value);
      if (note) {
        const why = document.createElement('dd');
        why.className = 'blend-explain-note';
        why.setAttribute('data-blend-explain-note', key);
        why.textContent = note;
        line.appendChild(why);
      }
      facts.appendChild(line);
    };
    let savedPrinted = false;
    row.querySelectorAll('.budget-goal-amounts > span').forEach(span => {
      const label = text(span.querySelector('small'));
      const amount = span.querySelector('.budget-goal-amount');
      if (!label || !amount) return;
      if (/^saved$/i.test(label)) savedPrinted = true;
      fact(label.toLowerCase().replace(/[^a-z]+/g, '-'), label, [...amount.childNodes]);
    });
    const paid = row.querySelector('[data-budget-goal-paid]');
    if (paid) {
      // plan.js prints no paid figure for an owner-confirmed item with no
      // stated amount. The window says that in words rather than leaving
      // the value blank; the printed owner-confirmation note follows.
      const blank = !text(paid);
      fact('paid', 'Paid', blank ? [document.createTextNode('Amount not given')] : [...paid.childNodes],
        text(row.querySelector('[data-budget-goal-owner-confirmation]')), blank);
    }
    const gap = row.querySelector('[data-budget-goal-still-to-fund]');
    if (gap) {
      const reason = gap.querySelector('[data-budget-goal-still-to-fund-reason]');
      fact('still-to-fund', 'Still to fund', [...gap.childNodes].filter(node => node !== reason), text(reason));
    }
    // plan.js prints "<amount> this period": this period's proposed top-up,
    // a different figure from Saved. It gets its own label here, so an
    // unavailable top-up is never read as an unavailable Saved.
    const context = row.querySelector('.budget-goal-context');
    const contextNodes = context ? [...context.childNodes]
      .filter(node => !(node.nodeType === 1 && node.classList.contains('budget-goal-evidence'))) : [];
    const tail = contextNodes[contextNodes.length - 1];
    const tailLead = tail && tail.nodeType === 3 && /(^|\s)this period\s*$/.test(tail.textContent)
      ? tail.textContent.replace(/\s*this period\s*$/, '') : null;
    const labelled = tailLead != null && (contextNodes.length > 1 || !!tailLead.trim());
    if (labelled) {
      fact('this-period', 'Top-up this period', tailLead.trim()
        ? [...contextNodes.slice(0, -1), document.createTextNode(tailLead)] : contextNodes.slice(0, -1));
    }
    if (facts.childNodes.length) content.appendChild(facts);
    if (context && !labelled) {
      const line = document.createElement('p');
      line.className = 'blend-explain-context';
      line.setAttribute('data-blend-explain-fact', 'context');
      contextNodes.forEach(node => line.appendChild(explainCopy(node)));
      if (text(line)) content.appendChild(line);
    }
    // Forecast publishes payment facts only for some goals. Where plan.js
    // printed no Paid / Still-to-fund block the window says so in words;
    // it never prints a figure the row did not.
    if (savedPrinted && !row.querySelector('[data-budget-goal-paid-progress]')) {
      const quiet = document.createElement('p');
      quiet.className = 'blend-explain-quiet';
      quiet.setAttribute('data-blend-explain-untracked', '');
      quiet.textContent = 'Paid and Still to fund are not tracked for this goal.';
      content.appendChild(quiet);
    }
    const members = row.querySelector('.budget-goal-members');
    if (members) {
      const group = explainCopy(members);
      group.classList.add('blend-explain-members');
      content.appendChild(group);
    }
    const source = row.querySelector('[data-budget-goal-open]');
    if (source) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'blend-explain-more';
      more.setAttribute('data-blend-explain-evidence', '');
      more.textContent = 'Transactions & evidence';
      more.addEventListener('click', () => {
        // Hand over to the existing evidence sheet: this window closes
        // first, the row's own incumbent control opens the sheet, and
        // focus comes back to the visible row when that sheet closes.
        const key = button.getAttribute('data-blend-goal') || '';
        explainClose(false);
        const open = () => source.click();
        if (window.BudgetSheetMotion?.from) window.BudgetSheetMotion.from(button, open);
        else open();
        const sheet = document.querySelector('[data-budget-detail-sheet]');
        if (!sheet?.open) { if (button.isConnected) button.focus({ preventScroll: true }); return; }
        sheet.addEventListener('close', () => requestAnimationFrame(() => {
          if (document.querySelector('[data-budget-detail-sheet]')?.open) return;
          const back = button.isConnected ? button
            : document.querySelector('.blend-goal-row[data-blend-goal="' + CSS.escape(key) + '"]');
          back?.focus({ preventScroll: true });
        }), { once: true });
      });
      content.appendChild(more);
    }
    explainOpen(button, text(row.querySelector('strong')) || 'Goal', content);
  }

  // Join the printed node's own pieces with spaces. Skip chips this skin
  // added. Do not trim inside a piece, and do not drop "≈" or "estimated".
  function separatedText(node) {
    if (!node) return '';
    const bits = [];
    const walk = el => {
      if (!el) return;
      if (el.nodeType === 3) {
        const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (raw) bits.push(raw);
        return;
      }
      if (el.nodeType !== 1) return;
      if (el.classList.contains('blend-est') || el.classList.contains('blend-term')) return;
      for (const child of el.childNodes) walk(child);
    };
    walk(node);
    return bits.join(' ');
  }

  function printedMagnitude(value) {
    const match = String(value || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) ? Math.abs(number) : null;
  }

  function moneyToken(value) {
    const found = String(value || '').match(/-?\$[\d,]+(?:\.\d{2})?/);
    return found ? found[0] : '';
  }

  // Household tile face (whole-dollar amendment, follow-on to #577,
  // Option B as approved after Systems BLOCK 5484530088): the face
  // renders each published amount in whole dollars, rounded UP once
  // from its own typed value. The values are the canonical amounts
  // plan.js stamps as data attributes under the same finite-value and
  // trust predicates that print the amounts (data-budget-pair-actual /
  // data-budget-pair-planned on the category row;
  // data-budget-actual-amount / data-budget-planned-amount on the
  // totals ratio span) — no figure is ever parsed back out of a
  // printed money token. A missing, empty, malformed or non-finite
  // attribute is REJECTED (null), never coerced to zero: the side is
  // unknown and its published word stands. The printed source keeps
  // exact cents everywhere: the ring geometry fallbacks parse it, the
  // accessible name quotes it, and the sheet evidence prints it.
  function stampedAmount(raw) {
    if (raw == null) return null;
    const shown = String(raw).trim();
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(shown)) return null;
    const value = Number(shown);
    return Number.isFinite(value) ? value : null;
  }

  // Magnitude ceiling at dollar precision, cent-exact: any nonzero
  // cents round up to the next dollar; exact dollars and zero are
  // unchanged ($0.00 renders $0). Sign is retained, and a negative
  // zero can never render — a rounded magnitude of zero carries no
  // sign. Grouping and sign shape as money2 (U+2212 for negatives).
  function wholeDollarAmount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const cents = Math.round(Math.abs(value) * 100);
    const dollars = Math.ceil(cents / 100);
    return (value < 0 && dollars > 0 ? '−$' : '$') + new Intl.NumberFormat('en-CA', {
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(dollars);
  }

  // One side of a face pair. A valid stamped value renders in whole
  // dollars, keeping the estimated ≈ the print carries. Without one,
  // the side is unknown: its printed word passes through verbatim,
  // and a printed amount with no valid stamp fails closed to the
  // unknown word — never cents on the face, never an invented zero.
  function pairSideText(value, printed) {
    if (Number.isFinite(value)) {
      return (String(printed || '').includes('≈') ? '≈ ' : '') + wholeDollarAmount(value);
    }
    const word = String(printed || '');
    return moneyToken(word) ? 'Unavailable' : word;
  }

  // The bottom totals only: locate the printed token inside a text
  // node and replace it with the whole-dollar rendering of the side's
  // STAMPED value. The pattern locates the token's span; the figure
  // itself comes from the attribute, never from the text. With no
  // valid value the text stands untouched (an unknown side prints
  // its word, which carries no token anyway).
  function replacePrintedAmount(shown, value) {
    if (!Number.isFinite(value)) return String(shown);
    return String(shown).replace(/[-−]?\$[\d,]+\.\d{2}/, wholeDollarAmount(value));
  }

  function place(bento) {
    const hero = bento.querySelector('.budget-blend-hero-layout');
    if (!hero) return;
    hero.classList.add('blend-hero', 'blend-tilt', 'tile', 't-hero');
    bento.classList.add('atlas-g');
    if (!document.querySelector('.blend-ambient')) {
      const ambient = document.createElement('div');
      ambient.className = 'blend-ambient';
      ambient.setAttribute('aria-hidden', 'true');
      ambient.innerHTML = '<i class="a1"></i><i class="a2"></i><i class="a3"></i>';
      document.body.prepend(ambient);
    }
    if (!hero.dataset.blendOpen) {
      hero.dataset.blendOpen = '1';
      hero.addEventListener('click', event => {
        if (event.target.closest('a, button, input, .blend-hero-pill, .blend-hero-foot')) return;
        if (event.target.closest('summary')) return;
        hero.querySelector('[data-operating-question="07"] .budget-step-summary')?.click();
      });
    }
    if (!hero.querySelector('.blend-sky')) {
      const sky = document.createElement('div');
      sky.className = 'blend-sky';
      sky.setAttribute('aria-hidden', 'true');
      sky.innerHTML = '<i class="b1"></i><i class="b2"></i><i class="b3"></i>';
      hero.prepend(sky);
    }
    if (!hero.querySelector('.blend-aurora') && retainedAurora) {
      moveWidget(hero, retainedAurora, hero.firstChild);
      hero.dataset.auroraOn = '1';
    }
    if (!hero.querySelector('.blend-aurora')) {
      const canvas = document.createElement('canvas');
      canvas.className = 'blend-aurora';
      canvas.setAttribute('data-aurora', '');
      canvas.setAttribute('aria-hidden', 'true');
      hero.prepend(canvas);
    }
    if (globalThis.Aurora && hero.dataset.auroraOn !== '1') {
      hero.dataset.auroraOn = '1';
      const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      globalThis.Aurora.init(hero.querySelector('.blend-aurora'), { reduce: reduce });
      globalThis.Aurora.set('healthy');
    }
    const theme = document.documentElement.getAttribute('data-theme');
    const dark = theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches);
    globalThis.Aurora?.setLight?.(dark ? 1.15 : 1.5);
    retainedAurora = hero.querySelector('.blend-aurora');
    // Keep the original WebGL context and curtain phase through tile updates.
    // Measure after the complete board is laid out, rather than between writes.
    requestAnimationFrame(() => { if (hero.isConnected) globalThis.Aurora?.resize?.(); });
    const tight = hero.querySelector('[data-operating-question="07"] [data-sign="negative"]')
      || hero.querySelector('.budget-cash-notice.has-gap');
    hero.classList.toggle('is-tight', !!tight);
    const progress = bento.querySelector('[data-budget-window-progress]');
    if (progress && progress.parentElement !== bento) {
      progress.classList.add('blend-pay', 'blend-tilt', 'tile', 't-pay');
      bento.appendChild(progress);
    }
    const header = bento.querySelector('[data-budget-window-header]');
    const granularityFocus = header?.contains(document.activeElement)
      && document.activeElement.hasAttribute('data-budget-granularity');
    // Retain the native selection handlers and printed date identity as an
    // internal source. The river is the period control; no alternate chooser.
    if (header) header.hidden = true;
    const guard = (label, fn) => {
      try { fn(); }
      catch (error) { console.error('Budget blend stopped on ' + label, error); }
    };
    guard('payday', () => paintPayday(progress));
    guard('hero', () => paintHero(hero));
    // Income remains in the hero equation and its original native evidence.
    // The owner removed the separate tile from the approved face.
    bento.querySelector('.blend-income')?.remove();
    guard('bills', () => paintBills(bento));
    guard('household', () => paintHouse(bento));
    guard('cards', () => paintCards(bento));
    guard('goals', () => paintGoals(bento));
    guard('funding', () => parkFunding(bento));
    guard('updated', () => paintUpdated());
    guard('badges', () => paintFaceBadges(bento));
    guard('quiet', () => paintQuiet(bento));
    guard('river', () => paintRiver(bento));
    guard('lift', () => liftFace(bento));
    if (activeRiver?.restoreFocus) {
      activeRiver.restoreFocus = false;
      const river = activeRiver.controller.el;
      if (document.activeElement !== river) river.focus({ preventScroll: true });
    }
    // Native Month/drilldown remounts focus the Pay period toggle before
    // this adapter moves it into the disclosure. Restore a visible opener.
    if (granularityFocus) hero.querySelector('[data-blend-figures-open]')?.focus({ preventScroll: true });
    bento.querySelectorAll('[data-budget-browse="bills"], [data-budget-browse="spending"], .budget-blend-card-movements, [data-budget-savings-goals]')
      .forEach(node => node.classList.add('blend-tilt'));
  }

  function liftFace(bento) {
    const active = document.activeElement;
    const restoreFocus = active && active !== document.body && bento.contains(active);
    const header = bento.querySelector('[data-budget-window-header]');
    const river = bento.querySelector('.g-river-wrap');
    const quiet = bento.querySelector('.blend-quiet');
    if (header) bento.appendChild(header);
    if (river) moveWidget(bento, river);
    stackBoard(bento);
    // Keep the current-period review after the financial cards. It is a
    // disclosure of Forecast's existing rows, not another face tile.
    const transfers = bento.querySelector('[data-budget-browse="e-transfers"]');
    if (transfers) bento.appendChild(transfers);
    if (quiet) bento.appendChild(quiet);
    const cards = bento.querySelector('.budget-blend-card-movements');
    const browse = bento.querySelector(':scope > .budget-browse-grid');
    if (cards && browse) cards.after(browse);
    bento.querySelectorAll(':scope > .budget-surface-grid, :scope > .budget-browse-grid').forEach(node => {
      node.classList.add('g-source');
    });
    if (restoreFocus && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  }

  // Two independent columns with fixed membership. On phones, move the
  // same tiles into the approved reading order so keyboard order follows
  // the visible stack. Payday stays in the tree, off the face.
  function stackBoard(bento) {
    let board = bento.querySelector(':scope > .blend-board');
    if (!board) {
      board = document.createElement('div');
      board.className = 'blend-board';
      const left = document.createElement('div');
      left.className = 'blend-col blend-col-main';
      const right = document.createElement('div');
      right.className = 'blend-col blend-col-side';
      board.append(left, right);
    }
    bento.appendChild(board);
    const left = board.querySelector('.blend-col-main');
    const right = board.querySelector('.blend-col-side');
    const find = selector => bento.querySelector(selector);
    const hero = find('.budget-blend-hero-layout');
    const house = find('[data-budget-browse="spending"]');
    const bills = find('[data-budget-browse="bills"]');
    const cards = find('.budget-blend-card-movements');
    const goals = find('[data-budget-savings-goals]');
    const pay = find('.blend-pay');
    const placeTiles = () => {
      const active = document.activeElement;
      const restoreFocus = active && board.contains(active);
      if (pay) {
        pay.classList.add('blend-sr');
        bento.appendChild(pay);
      }
      const phone = window.matchMedia('(max-width: 759px)').matches;
      if (phone) {
        [hero, bills, house, cards, goals].filter(Boolean).forEach(node => board.appendChild(node));
      } else {
        [hero, bills, cards].filter(Boolean).forEach(node => left.appendChild(node));
        [house, goals].filter(Boolean).forEach(node => right.appendChild(node));
      }
      if (restoreFocus && document.activeElement !== active) active.focus({ preventScroll: true });
      fitBadAmount(hero);
    };
    placeTiles();
    document.fonts?.ready.then(() => { if (hero?.isConnected) fitBadAmount(hero); });
    stackPlaceTiles = () => { if (bento.isConnected) placeTiles(); };
  }

  function tileGlyph(kind) {
    const paths = {
      income: '<path d="M12 4v12m0 0-5-5m5 5 5-5M5 20h14"/>',
      payday: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 3h5"/>',
      bills: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>',
      house: '<path d="M5 9h14l-1.2 9.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 9V7a3 3 0 0 1 6 0v2"/>',
      cards: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
      goals: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8" fill="currentColor" stroke="none"/>',
    };
    const holder = document.createElement('span');
    holder.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (paths[kind] || paths.cards) + '</svg>';
    return holder.firstChild;
  }

  function tileIcon(kind) {
    const ico = document.createElement('span');
    ico.className = 'blend-tile-ico';
    ico.appendChild(tileGlyph(kind));
    return ico;
  }

  function paintPayday(progress) {
    if (!progress || progress.querySelector('.blend-pay-face, .blend-pay-main')) return;
    if (!progress.querySelector('.blend-tile-head')) {
      const head = document.createElement('span');
      head.className = 'blend-tile-head';
      const title = document.createElement('span');
      title.className = 'blend-tile-title';
      title.textContent = 'Payday';
      head.append(tileIcon('payday'), title);
      progress.prepend(head);
    }
    const sentence = text(progress.querySelector('p'));
    if (sentence) progress.setAttribute('aria-label', sentence);
    const line = text(progress.querySelector('p span:last-child'));
    const days = /in (\d+) days/.exec(line);
    const dates = [...progress.querySelectorAll('p b')];
    const published = dates.length >= 2 ? text(dates[1]) : '';
    const printedDate = /^[A-Z][a-z]{2}\s+\d{1,2}$/.test(published) ? published : '';
    const marks = [...progress.querySelectorAll('.budget-window-days > span')];
    const current = selectedPeriodIsCurrent(progress.closest('[data-budget-bento]') || document);
    progress.querySelector('p')?.classList.add('blend-clip');
    if (current) {
      const face = document.createElement('div');
      face.className = 'blend-pay-face';
      face.appendChild(payRing(marks));
      const num = document.createElement('span');
      num.className = 'blend-pay-num' + (days ? '' : ' is-word');
      num.textContent = days ? days[1] : 'Unavailable';
      const unit = document.createElement('span');
      unit.className = 'blend-pay-unit';
      unit.textContent = days ? 'days' : '';
      face.append(num, unit);
      progress.appendChild(face);
      if (printedDate) {
        const date = document.createElement('span');
        date.className = 'blend-pay-date';
        date.textContent = printedDate;
        progress.appendChild(date);
      }
    } else {
      const statusText = text(progress.querySelector('p > span'));
      const shown = printedDate || statusText;
      const main = document.createElement('span');
      main.className = 'blend-pay-main' + (shown ? '' : ' is-unavailable');
      main.textContent = shown || 'Unavailable';
      progress.appendChild(main);
    }
    const next = document.querySelector('[data-budget-cash-next]');
    if (next) progress.addEventListener('click', () => next.click());
  }

  function payRing(marks) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('class', 'blend-pay-ring');
    svg.setAttribute('aria-hidden', 'true');
    const n = marks.length;
    if (!n) return svg;
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    const gap = circumference * (6 / 360);
    const segment = Math.max(0, circumference / n - gap);
    marks.forEach((mark, index) => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '60');
      circle.setAttribute('cy', '60');
      circle.setAttribute('r', String(radius));
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke-width', '7');
      circle.setAttribute('stroke-linecap', 'butt');
      circle.setAttribute('stroke-dasharray', segment.toFixed(3) + ' ' + (circumference - segment).toFixed(3));
      const turn = -90 + 3 + index * (360 / n);
      circle.setAttribute('transform', 'rotate(' + turn.toFixed(3) + ' 60 60)');
      circle.setAttribute('class', mark.classList.contains('is-today') ? 'is-today'
        : mark.classList.contains('is-past') ? 'is-past' : 'is-left');
      svg.appendChild(circle);
    });
    return svg;
  }

  function paintHero(hero) {
    const cash = hero.querySelector('.budget-today-cash');
    if (cash && !cash.querySelector('.blend-cash-label')) {
      const sub = text(cash.querySelector('.budget-cash-sub'));
      const heading = text(cash.querySelector('h2'));
      const label = document.createElement('span');
      label.className = 'blend-cash-label';
      label.textContent = /^Bills account\b/i.test(sub) ? 'Bills account' : (heading || 'Unavailable');
      cash.querySelector('[data-budget-cash-hero]')?.before(label);
    }
    clip(hero.querySelector('.budget-cash-how'));
    const panel = heroPanel(hero);
    const body = panelBody(panel);
    const info = hero.querySelector('.budget-period-info');
    if (info && info.parentElement !== body) body.appendChild(info);
    parkBadTerms(hero, body);
    ['04', '06'].forEach(number => {
      const step = hero.querySelector('[data-operating-question="' + number + '"]');
      if (!step || step.previousElementSibling?.classList.contains('blend-minus')) return;
      const sep = document.createElement('span');
      sep.className = 'blend-minus' + (number === '04' ? ' is-bills' : ' is-house');
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '−';
      step.before(sep);
    });
    let foot = hero.querySelector('.blend-hero-foot');
    if (!foot) {
      foot = document.createElement('div');
      foot.className = 'blend-hero-foot';
      hero.appendChild(foot);
    }
    const savings = hero.querySelector('[data-operating-question="savings"], [data-budget-savings-stock]');
    const closing = hero.querySelector('[data-bills-closing]');
    const afterBills = hero.querySelector('[data-operating-question="05"]');
    if (savings) {
      savings.classList.add('blend-hero-pill');
      savings.querySelector('.operating-number')?.classList.add('blend-clip');
      const summary = savings.querySelector('summary') || savings;
      if (!summary.querySelector('.blend-save-ico')) {
        const ico = document.createElement('span');
        ico.className = 'blend-save-ico';
        ico.setAttribute('aria-hidden', 'true');
        ico.appendChild(tileGlyph('goals'));
        summary.prepend(ico);
      }
    }
    [afterBills, closing].forEach(node => {
      if (node && node.parentElement !== body) body.appendChild(node);
    });
    if (savings && savings.parentElement !== foot) foot.appendChild(savings);
    if (afterBills) afterBills.classList.remove('blend-clip');
    clip(closing && closing.querySelector('details > summary'));
    hero.querySelectorAll('.budget-bills-closing > .operating-note').forEach(node => {
      if (/Latest recorded Bills balance/i.test(text(node))) {
        node.classList.add('blend-panel-note');
        if (node.parentElement !== body) body.appendChild(node);
      } else clip(node);
    });
    const notice = hero.querySelector('.budget-cash-notice');
    if (notice && notice.parentElement !== body) {
      notice.classList.add('blend-panel-note');
      body.appendChild(notice);
    }
    hero.classList.toggle('is-other-period', !selectedPeriodIsCurrent(hero));
    paintHeroTop(hero);
    joinResultLabel(hero);
    paintTermSlots(hero);
    markResultClosed(hero);
    splitPrintedCents(hero.querySelector('[data-blend-term="balanceAfterDeductions"]'));
    paintAfterFunding(hero);
    paintFinalResult(hero.closest('[data-budget-bento]') || document);
    paintIncomeLongLabel(hero);
    paintPlanStatus(hero);
    paintSplit(hero, foot);
    wirePeriodFigures(hero, body);
  }

  function wirePeriodFigures(hero, body) {
    const result = hero.querySelector('[data-operating-question="07"]');
    const trigger = result?.querySelector('.budget-step-summary');
    const figures = document.querySelector('[data-budget-period-info-body]');
    const sheet = document.querySelector('[data-budget-detail-sheet]')?.budgetSheet;
    if (!trigger || !figures || !sheet) return;
    const granularity = document.querySelector('[data-budget-window-header] .budget-granularity');
    if (granularity && !figures.contains(granularity)) figures.prepend(granularity);
    // Preserve every original qualifier and evidence node. The visible result
    // is the keyboard opener; no financial text or values are regenerated.
    const resultBody = result.querySelector('.budget-step-body');
    if (resultBody && !figures.contains(resultBody)) figures.appendChild(resultBody);
    [...body.children].forEach(node => {
      if (!node.classList.contains('budget-period-info') && node !== figures && !node.contains(figures))
        figures.appendChild(node);
    });
    if (!figures.id) figures.id = 'budget-period-figures';
    trigger.setAttribute('aria-controls', figures.id);
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', String(!!figures.closest('dialog[open]')));
    if (trigger.hasAttribute('data-blend-figures-open')) return;
    trigger.setAttribute('data-blend-figures-open', '');
    trigger.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      sheet.open(figures, trigger, 'Period figures');
    }, true);
  }

  function paintPlanStatus(hero) {
    // Forecast's status describes the whole planning window. A verdict beside
    // these dates requires a qualified selected-period publication from Forecast.
    // Keep the native status band and its identity hook; clear only face additions.
    hero.querySelector('.blend-plan-chip')?.remove();
    hero.querySelector('.blend-plan-note')?.remove();
  }

  function paintHeroTop(hero) {
    if (hero.querySelector('.blend-hero-top')) return;
    const top = document.createElement('div');
    top.className = 'blend-hero-top';
    const id = document.createElement('div');
    id.className = 'blend-hero-id';
    const range = document.querySelector('[data-budget-window-range]');
    if (range) {
      range.classList.add('blend-hero-range');
      id.appendChild(range);
    }
    if (selectedPeriodIsCurrent(hero)) {
      const now = document.createElement('span');
      now.className = 'blend-now';
      now.textContent = 'Now';
      id.appendChild(now);
    }
    top.appendChild(id);
    const cash = hero.querySelector('.budget-today-cash');
    if (cash) top.appendChild(cash);
    const sky = hero.querySelector('.blend-sky');
    if (sky && sky.parentElement === hero) sky.after(top);
    else hero.prepend(top);
  }

  function splitPrintedCents(value) {
    if (!value || value.classList.contains('is-fail-closed') || value.classList.contains('is-unavailable') || value.querySelector('.blend-cents')) return;
    const nodes = [];
    const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && node.parentElement.closest('.budget-cash-sr, .est, .blend-clip')) continue;
      if (/\$[\d,]+\.\d{2}/.test(node.textContent)) nodes.push(node);
    }
    nodes.forEach(textNode => {
      // Both printed minus glyphs stay with dollars, never the small qualifier prefix.
      const parts = textNode.textContent.match(/^(.*?)([-−]?\$[\d,]+)(\.\d{2})(.*)$/);
      if (!parts) return;
      const frag = document.createDocumentFragment();
      if (parts[1]) {
        const prefix = document.createElement('span');
        prefix.className = 'blend-term-prefix';
        prefix.textContent = parts[1];
        frag.appendChild(prefix);
      }
      const dollars = document.createElement('span');
      dollars.className = 'blend-dollars';
      dollars.textContent = parts[2];
      const cents = document.createElement('sup');
      cents.className = 'blend-cents';
      cents.textContent = parts[3];
      frag.append(dollars, cents, document.createTextNode(parts[4]));
      textNode.replaceWith(frag);
    });
  }

  // Fit the complete printed amount, not a parsed/reformatted monetary value.
  // Reuse the existing dollar/cents group and layout/resize path. Ordinary
  // amounts retain their CSS size; reset it before measuring each new layout.
  function fitBadAmount(hero) {
    const bad = hero?.querySelector('[data-blend-term="balanceAfterDeductions"]');
    const dollars = bad?.querySelector('.blend-dollars');
    const cents = bad?.querySelector('.blend-cents');
    const slot = bad?.closest('.budget-step-value');
    if (!dollars || !cents || !slot) return;
    let group = dollars.parentElement;
    if (!group.classList.contains('blend-dollar-group')) {
      group = document.createElement('span');
      group.className = 'blend-dollar-group';
      dollars.before(group);
      group.append(dollars, cents);
    }
    group.style.fontSize = '';
    const style = getComputedStyle(hero);
    const contentWidth = hero.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const available = Math.min(slot.clientWidth, contentWidth) - group.offsetLeft;
    const width = group.scrollWidth;
    if (available > 1 && width > available) {
      const size = parseFloat(getComputedStyle(group).fontSize);
      group.style.fontSize = (size * (available - 1) / width).toFixed(3) + 'px';
    }
  }

  function selectedPeriodIsCurrent(hero) {
    const root = hero.closest('[data-budget-bento]') || document;
    const sub = text(root.querySelector('.budget-cash-sub'));
    if (/not the selected period opening/i.test(sub)) return false;
    const line = text(root.querySelector('[data-budget-window-progress]'));
    if (/Next payday/i.test(line)) return true;
    if (/Upcoming|Completed pay period|Selected pay period/i.test(line)) return false;
    return true;
  }

  // Face slots copy Forecast's printed Balance After Deductions terms.
  // The long labels stay in the published block. No arithmetic.
  const TERM_SOURCES = [
    ['02', 'periodIncome'],
    ['04', 'assignedBills'],
    ['06', 'householdBudgetHold'],
  ];

  function badTermsBlock(hero) {
    const root = hero.closest('[data-budget-bento]') || document;
    return root.querySelector('[data-bad-terms]');
  }

  function parkBadTerms(hero, body) {
    const block = badTermsBlock(hero);
    if (block && body && block.parentElement !== body) body.appendChild(block);
  }

  function selectedPeriodIsPast(root) {
    return /Completed pay period/i.test(text((root || document).querySelector('[data-budget-window-progress]')));
  }

  // Path A: a non-empty [data-bad-term-amount] is the bare amount. An est.
  // chip is added only when that row's trust is estimated. Only the span's
  // own text is read, so the ≈ mark in the value is not copied again.
  // An empty or whitespace-only amount span is absent.
  // Unavailable trust is decided before the span is read.
  // Path B: no usable amount span — the value text is copied verbatim,
  // including "≈ estimated" when that is what was printed, and no chip is added.
  function termDisplay(row, blockStatus) {
    const trust = row ? (row.getAttribute('data-bad-term-trust') || '') : '';
    if (blockStatus !== 'published' || !row || trust === 'unavailable') {
      return { text: 'Unavailable', chip: false, unavailable: true };
    }
    const bare = text(row.querySelector('[data-bad-term-amount]'));
    if (bare) return { text: bare, chip: trust === 'estimated', unavailable: false };
    const value = row.querySelector('[data-bad-term-value]');
    return { text: text(value) || 'Unavailable', chip: false, unavailable: !text(value) };
  }

  function paintTermFace(parent, name, display, className) {
    if (!parent || parent.querySelector('[data-blend-term="' + name + '"]')) return null;
    const slot = document.createElement('span');
    slot.className = className;
    slot.setAttribute('data-blend-term', name);
    slot.textContent = display.text;
    slot.classList.toggle('is-unavailable', !!display.unavailable);
    slot.classList.toggle('is-estimated', !!display.chip);
    slot.classList.toggle('is-negative', !!display.negative && !display.unavailable);
    if (display.chip) slot.title = 'Estimated — see Period figures for the source and qualification';
    parent.appendChild(slot);
    if (display.chip) {
      const pill = document.createElement('span');
      pill.className = 'blend-est';
      pill.textContent = 'est.';
      slot.after(pill);
    }
    return slot;
  }

  // The BAD face's sign comes only from Forecast's typed publication:
  // plan.js stamps data-sign="negative" on a period's [data-bad-timeline]
  // row iff that period's published Balance After Deductions term is
  // known and < 0 (a trusted zero and an unavailable term carry no sign).
  // The printed amount text is never parsed, and the Q07 step value's own
  // data-sign is never read here — it keys off the after-funding figure,
  // a different number. No matching row or no sign: fail closed, no mark.
  function badTermNegative(block) {
    const period = block ? (block.getAttribute('data-bad-terms-period') || '') : '';
    if (!period) return false;
    const list = document.querySelector('ol[data-bad-timeline]');
    if (!list) return false;
    const row = [...list.children].find(node => node.tagName === 'LI'
      && (node.getAttribute('data-bad-timeline-period') || '') === period);
    return !!row && row.getAttribute('data-sign') === 'negative';
  }

  // The Household face copies Balance After Deductions' household term,
  // which is not the planned total the Household budget card prints. The
  // face says which figure it is, in the words the terms printer stamps on
  // that row for the selected period (data-bad-term-face-label): greater of
  // plan or spent for a current or future period, spending observed for a
  // completed one. Copied verbatim; no wording is decided here. A row with
  // no stamp gets no label. Words only; no figure.
  function labelTermFace(hero, number, name, row) {
    const words = row ? (row.getAttribute('data-bad-term-face-label') || '').trim() : '';
    const slot = words && hero.querySelector('[data-operating-question="' + number + '"] .budget-step-value > [data-blend-term="' + name + '"]');
    if (!slot || slot.parentElement.querySelector('[data-blend-term-label="' + name + '"]')) return;
    const label = document.createElement('span');
    label.className = 'blend-term-label';
    label.setAttribute('data-blend-term-label', name);
    label.textContent = words;
    // After the figure (and its est. chip): the heading text stays as printed.
    slot.parentElement.appendChild(label);
  }

  function paintTermSlots(hero) {
    const block = badTermsBlock(hero);
    const status = block ? (block.getAttribute('data-bad-terms-status') || 'unavailable') : 'unavailable';
    TERM_SOURCES.forEach(([number, name]) => {
      const value = hero.querySelector('[data-operating-question="' + number + '"] .budget-step-value');
      const row = block && block.querySelector('[data-bad-term="' + name + '"]');
      paintTermFace(value, name, termDisplay(row, status), 'blend-term');
      labelTermFace(hero, number, name, row);
    });
    const result = hero.querySelector('[data-operating-question="07"] .budget-step-value');
    if (result && !result.querySelector('[data-blend-term="balanceAfterDeductions"]')) {
      if (!result.querySelector(':scope > .blend-clip')) {
        const hidden = document.createElement('span');
        hidden.className = 'blend-clip';
        while (result.firstChild) hidden.appendChild(result.firstChild);
        result.appendChild(hidden);
      }
      const row = block && block.querySelector('[data-bad-term="balanceAfterDeductions"]');
      const display = termDisplay(row, status);
      display.negative = badTermNegative(block);
      paintTermFace(result, 'balanceAfterDeductions', display, 'blend-bad');
    }
  }

  // Concatenate each printed node's textContent. Do not trim an inner node:
  // the space before "$" is the leading character of that text node.
  function copiedPrintedText(node) {
    let copied = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3 || child.nodeType === 1) copied += child.textContent;
    }
    return copied;
  }

  // The printed prompt beside the Q07 value. A colon is dropped only when
  // that colon is its own node. The caller keeps this text, verbatim.
  function printedQ07Prompt(value) {
    const row = value && value.closest('[data-operating-question="07"][data-budget-period-result]');
    const prompt = row && row.querySelector('.budget-step-summary .operating-prompt');
    let copied = '';
    if (!prompt) return '';
    for (const node of prompt.childNodes) {
      const raw = node.textContent || '';
      if (raw.trim() === ':') continue;
      copied += raw;
    }
    return copied;
  }

  function appendAfterLine(line, value, valueText) {
    const printed = printedQ07Prompt(value);
    if (printed) {
      const hidden = document.createElement('span');
      hidden.className = 'blend-after-label budget-cash-sr';
      hidden.textContent = printed;
      line.appendChild(hidden);
    }
    const name = document.createElement('span');
    name.className = 'blend-after-visible';
    name.textContent = 'After proposed savings';
    line.appendChild(name);
    const shown = document.createElement('span');
    shown.className = 'blend-after-value';
    shown.textContent = valueText;
    line.appendChild(shown);
    return shown;
  }

  // On an after-proposed-funding period the '=' slot stays the pre-funding
  // Balance After Deductions figure. The printed note says those terms are
  // before proposed savings funding. The printed Q07 value is the after
  // figure and is shown, not left in the clip. Nothing here is calculated.
  function paintSplit(hero, foot) {
    if (!foot || foot.querySelector('.blend-split')) return;
    const read = selector => printedMagnitude(text(hero.querySelector(selector)));
    const parts = [
      ['s-bills', read('[data-operating-question="04"] .blend-term')],
      ['s-house', read('[data-operating-question="06"] .blend-term')],
      ['s-bad', read('[data-blend-term="balanceAfterDeductions"]')],
    ];
    const split = document.createElement('span');
    split.className = 'blend-split';
    split.setAttribute('aria-hidden', 'true');
    const total = parts.reduce((sum, part) => sum + (part[1] > 0 ? part[1] : 0), 0);
    if (!total) {
      split.classList.add('is-untracked');
      const mark = document.createElement('b');
      mark.className = 'blend-untracked-mark';
      mark.textContent = '—';
      split.appendChild(mark);
    } else {
      parts.forEach(([name, amount]) => {
        const segment = document.createElement('i');
        segment.className = name;
        if (amount == null) segment.classList.add('is-untracked');
        else segment.style.setProperty('--w', (amount / total * 100).toFixed(2) + '%');
        split.appendChild(segment);
      });
    }
    foot.appendChild(split);
  }

  // Text only. Number('') is 0, so an empty span must never become $0.00.
  function resultAmountDecision(trust, raw) {
    const bare = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (trust === 'unavailable' || bare.length === 0) return 'Unavailable';
    return bare;
  }

  function budgetResultHook(hero) {
    const host = hero.querySelector('[data-operating-question="07"][data-budget-result-trust]')
      || hero.querySelector('[data-budget-period-result][data-budget-result-trust]');
    if (!host) return null;
    const amount = host.querySelector('[data-budget-result-amount]');
    if (!amount) return null;
    const trust = host.getAttribute('data-budget-result-trust') || '';
    const shown = resultAmountDecision(trust, amount.textContent);
    return { trust: trust, shown: shown, closed: shown === 'Unavailable' };
  }

  function paintFinalResult(root) {
    root.querySelectorAll('.budget-period-result[data-budget-result-trust]').forEach(host => {
      const span = host.querySelector('[data-budget-result-amount]');
      const value = host.querySelector('.budget-period-result-value');
      if (!span || !value) return;
      const trust = host.getAttribute('data-budget-result-trust') || '';
      const decision = resultAmountDecision(trust, span.textContent);
      if (decision !== 'Unavailable') return;
      const current = (value.textContent || '').replace(/\s+/g, ' ').trim();
      if (current === 'Unavailable') return;
      const kept = document.createElement('span');
      kept.setAttribute('data-budget-result-amount', '');
      value.replaceChildren(document.createTextNode('Unavailable'), kept);
    });
  }

  function paintAfterFunding(hero) {
    const block = badTermsBlock(hero);
    if (!block || block.getAttribute('data-bad-terms-face') !== 'after-proposed-funding') return;
    const note = text(block.querySelector('.operating-note'));
    const copied = (note.match(/before proposed savings funding/) || [])[0];
    const prompt = hero.querySelector('[data-operating-question="07"] .operating-prompt');
    if (copied && prompt && !prompt.parentElement.querySelector('.blend-bad-qualifier')) {
      const qualifier = document.createElement('span');
      qualifier.className = 'blend-bad-qualifier';
      qualifier.textContent = ' · ' + copied;
      prompt.after(qualifier);
    }
    const value = hero.querySelector('[data-operating-question="07"] .budget-step-value');
    const clip = value && value.querySelector(':scope > .blend-clip');
    const bad = value && value.querySelector('.blend-bad');
    if (!clip || !bad || bad.querySelector('.blend-after-funding') || !clip.childNodes.length) return;
    const line = document.createElement('p');
    line.className = 'blend-after-funding';
    const hook = budgetResultHook(hero);
    if (hook) {
      appendAfterLine(line, value, hook.shown);
      if (!hook.closed && hook.trust === 'estimated') {
        const pill = document.createElement('span');
        pill.className = 'blend-est';
        pill.textContent = 'est.';
        line.appendChild(pill);
      }
      clip.remove();
      const dollars = bad.querySelector('.blend-dollars');
      const cents = bad.querySelector('.blend-cents');
      if (dollars && !dollars.parentElement.classList.contains('blend-dollar-group')) {
        const group = document.createElement('span');
        group.className = 'blend-dollar-group';
        dollars.before(group);
        group.appendChild(dollars);
        if (cents) group.appendChild(cents);
      }
      bad.appendChild(line);
      return;
    }
    const amount = [...clip.querySelectorAll('[data-bad-term-amount]')].find(node => !node.closest('[data-bad-terms]')) || null;
    const bare = text(amount);
    const trustHost = amount && amount.closest('[data-bad-term]');
    const trust = trustHost ? (trustHost.getAttribute('data-bad-term-trust') || '') : '';
    if (amount && trust === 'unavailable') {
      appendAfterLine(line, value, 'Unavailable');
      clip.remove();
    } else if (bare) {
      appendAfterLine(line, value, bare);
      if (trust === 'estimated') {
        const pill = document.createElement('span');
        pill.className = 'blend-est';
        pill.textContent = 'est.';
        line.appendChild(pill);
      }
      clip.remove();
    } else {
      appendAfterLine(line, value, copiedPrintedText(clip));
      clip.remove();
    }
    const dollars = bad.querySelector('.blend-dollars');
    const cents = bad.querySelector('.blend-cents');
    if (dollars && !dollars.parentElement.classList.contains('blend-dollar-group')) {
      const group = document.createElement('span');
      group.className = 'blend-dollar-group';
      dollars.before(group);
      group.appendChild(dollars);
      if (cents) group.appendChild(cents);
    }
    bad.appendChild(line);
  }

  function paintIncomeLongLabel(hero) {
    const body = panelBody(heroPanel(hero));
    if (!body || body.querySelector('.blend-income-long')) return;
    const note = document.createElement('p');
    note.className = 'blend-income-long budget-cash-sr';
    note.textContent = 'Period income, counted in Balance After Deductions';
    body.appendChild(note);
  }

  function markResultClosed(hero) {
    const value = hero.querySelector('[data-operating-question="07"] .budget-step-value');
    if (!value) return;
    const shown = value.querySelector('[data-blend-term="balanceAfterDeductions"]');
    const root = hero.closest('[data-budget-bento]') || document;
    const closed = !!root.querySelector('[data-operating-plan="unavailable"]')
      || !shown
      || shown.classList.contains('is-unavailable')
      || !moneyToken(text(shown));
    value.classList.toggle('is-fail-closed', closed);
  }

  function joinResultLabel(hero) {
    const step = hero.querySelector('[data-operating-question="07"]');
    const number = step && step.querySelector('.operating-number');
    const title = step && step.querySelector('.budget-step-title');
    if (!number || !title || number.parentElement.classList.contains('blend-result-label')) return;
    const wrap = document.createElement('span');
    wrap.className = 'blend-result-label';
    title.before(wrap);
    wrap.append(number, document.createTextNode(' '), title);
  }

  function heroPanel(hero) {
    let panel = hero.querySelector('.blend-hero-panel');
    if (panel) return panel;
    panel = document.createElement('details');
    panel.className = 'blend-hero-panel';
    const summary = document.createElement('summary');
    summary.className = 'blend-clip';
    summary.textContent = 'Period figures';
    const body = document.createElement('div');
    body.className = 'blend-hero-panel-body';
    panel.append(summary, body);
    hero.appendChild(panel);
    return panel;
  }

  function panelBody(panel) {
    return panel.querySelector('.blend-hero-panel-body') || panel;
  }

  function billIcon(label) {
    const s = String(label || '').toLowerCase();
    const name = !s ? 'card'
      : /rent|mortgage|house|property|home/.test(s) ? 'house'
      : /\bcar\b|auto|vehicle/.test(s) ? 'car'
      : /hydro|electric|power|bolt/.test(s) ? 'bolt'
      : /wifi|internet|shaw|telus|rogers|phone/.test(s) ? 'wifi'
      : /card|visa|mastercard|mbna|amex|credit/.test(s) ? 'card'
      : 'card';
    const paths = {
      house: 'M4 11.2 12 4l8 7.2V20h-5.2v-5.2H9.2V20H4V11.2Z',
      car: 'M4 16h16v2H4v-2Zm1.2-2 1.6-5h10.4l1.6 5H5.2Z',
      bolt: 'M13 3 6 13h5l-1 8 7-10h-5l1-8Z',
      wifi: 'M12 18.2 12.1 18.1M7.2 14.2a6.8 6.8 0 0 1 9.6 0M4.2 11.2a11 11 0 0 1 15.6 0',
      card: 'M4 7h16v10H4V7Zm0 3h16',
      generic: 'M8 4h8v16H8V4Zm2.2 3h3.6'
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[name]);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    return svg;
  }

  function billState(row) {
    const state = text(row.querySelector('.budget-bill-state'));
    if (/\boverdue\b/i.test(state)) return 'overdue';
    if (!state || /status unavailable|unknown|unavailable|not observed/i.test(state)) return 'unknown';
    if (/paid/i.test(state) && !/not paid|unpaid|not confirmed/i.test(state)) return 'paid';
    if (/confirm|needs a date/i.test(state)) return 'confirm';
    if (/pending/i.test(state)) return 'pending';
    if (/not paid|^due\b|planned/i.test(state)) return 'due';
    return 'unknown';
  }

  function printedOverdueCount(section) {
    const named = section.querySelector('[data-budget-overdue-count], [data-budget-bills-overdue]');
    if (named) {
      const found = text(named).match(/\d+/);
      return found ? Number(found[0]) : 0;
    }
    const label = [...section.querySelectorAll('h3, .budget-browse-pill, p')].find(node => /^Overdue\s+\d+\b/i.test(text(node)));
    if (!label) return null;
    const found = text(label).match(/\d+/);
    return found ? Number(found[0]) : null;
  }

  function paintBills(bento) {
    const section = bento.querySelector('[data-budget-browse="bills"]');
    if (!section || section.querySelector('[data-blend-bill-list]')) return;
    section.classList.add('tile', 't-bills');
    const progress = document.querySelector('[data-budget-window-progress]');
    const asOf = progress && progress.getAttribute('data-as-of');
    const head = document.createElement('div');
    head.className = 'blend-bills-head';
    const title = document.createElement('span');
    title.className = 'blend-tile-title';
    title.textContent = 'Bills';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'blend-bills-open';
    toggle.setAttribute('data-blend-bills-open', '');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Bills detail');
    toggle.append(tileIcon('bills'), title);
    head.appendChild(toggle);
    const rows = [...section.querySelectorAll('.budget-bill-row')];
    const confirmRows = rows.filter(row => billState(row) === 'confirm');
    const overdueCount = printedOverdueCount(section);
    const past = selectedPeriodIsPast(bento);
    let remain = null;
    if (!past) {
      remain = document.createElement('span');
      remain.className = 'blend-bills-of';
      const leftRaw = text(section.querySelector('[data-budget-browse-bills-remaining]'));
      const planRaw = text(section.querySelector('[data-budget-ratio="bills"] [data-budget-ratio-plan]'));
      const billsStatus = text(section.querySelector('[data-budget-ratio="bills"]'));
      const leftMoney = moneyToken(leftRaw);
      const planMoney = moneyToken(planRaw);
      const statusUnavailable = !planMoney && /unknown|unavailable/i.test(billsStatus + ' ' + leftRaw);
      if (statusUnavailable) {
        remain.textContent = 'Unavailable';
        remain.classList.add('is-unavailable');
      } else if (!rows.length) {
        remain.textContent = 'No bills assigned';
        remain.classList.add('is-empty');
      } else if (leftMoney && planMoney) {
        remain.appendChild(document.createTextNode(leftMoney + ' left of ' + planMoney));
        if (/estimated|≈/.test(leftRaw + ' ' + planRaw)) {
          const est = document.createElement('span');
          est.className = 'blend-est';
          est.textContent = 'est.';
          remain.appendChild(est);
        }
      } else {
        remain.textContent = 'Unavailable';
        remain.classList.add('is-unavailable');
      }
    }
    if (confirmRows.length > 0) {
      const flag = document.createElement('span');
      flag.className = 'blend-flag';
      flag.textContent = 'To confirm ' + confirmRows.length;
      head.appendChild(flag);
    }
    if (overdueCount > 0) {
      const overdue = document.createElement('span');
      overdue.className = 'blend-flag is-overdue';
      overdue.textContent = 'Overdue ' + overdueCount;
      head.appendChild(overdue);
    }
    if (remain) head.appendChild(remain);
    // #824: every bill at a glance, one row each, like Savings goals. The
    // rows are the incumbent roster's own printed rows: date, name, amount
    // and status words are copied verbatim. Nothing is parsed, summed or
    // recalculated; ordering by the printed ISO date is presentation only.
    const list = document.createElement('ul');
    list.className = 'blend-bill-list';
    list.setAttribute('data-blend-bill-list', '');
    list.setAttribute('aria-label', 'Bills this period');
    const summaryUnavailable = !!remain && remain.textContent === 'Unavailable';
    const dated = rows.map((row, index) => ({ row, index, date: row.getAttribute('data-budget-bill-date') || '' }))
      .sort((a, b) => {
        const ad = /^\d{4}-\d{2}-\d{2}$/.test(a.date), bd = /^\d{4}-\d{2}-\d{2}$/.test(b.date);
        if (ad !== bd) return ad ? -1 : 1;
        if (ad && a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.index - b.index;
      });
    dated.forEach(({ row, date }) => {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
      const item = document.createElement('li');
      item.className = 'blend-bill-li';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'blend-bill-item' + (iso && iso === asOf ? ' is-today' : '');
      const state = billState(row);
      button.dataset.s = summaryUnavailable ? 'unknown' : state;
      if (state === 'overdue') button.classList.add('is-overdue');
      button.setAttribute('data-blend-bill', (row.getAttribute('data-budget-bill-open') || '') + ':' + iso);
      const when = document.createElement('span');
      when.className = 'blend-bill-when';
      when.setAttribute('data-blend-bill-when', '');
      if (iso) {
        when.textContent = new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (row.querySelector('.budget-bill-date.est')) {
          const est = document.createElement('span');
          est.className = 'blend-est';
          est.textContent = 'est.';
          when.appendChild(est);
        }
      } else {
        when.textContent = 'No date';
      }
      const name = document.createElement('span');
      name.className = 'blend-bill-name';
      name.setAttribute('data-blend-bill-name', '');
      name.textContent = text(row.querySelector('.budget-bill-label strong')) || 'Bill';
      const amount = document.createElement('span');
      amount.className = 'blend-bill-amount';
      amount.setAttribute('data-blend-bill-amount', '');
      // A clone keeps the roster's own estimate mark and its screen-reader
      // word ("estimated") exactly as printed; nothing is re-formatted.
      const printedAmount = row.querySelector('.budget-bill-amount');
      if (printedAmount && text(printedAmount)) printedAmount.childNodes.forEach(node => amount.appendChild(node.cloneNode(true)));
      else amount.textContent = 'Unavailable';
      const status = document.createElement('span');
      status.className = 'blend-bill-status';
      status.setAttribute('data-blend-bill-status', '');
      const dot = document.createElement('i');
      dot.className = 'blend-bill-dot';
      dot.setAttribute('aria-hidden', 'true');
      status.append(dot, document.createTextNode(text(row.querySelector('.budget-bill-state')) || 'Status unavailable'));
      button.append(when, name, amount, status);
      markSheet(button, row);
      item.appendChild(button);
      list.appendChild(item);
    });
    if (!rows.length) {
      const none = document.createElement('li');
      none.className = 'blend-missing';
      none.textContent = 'No bills this period';
      list.appendChild(none);
    }
    const header = section.querySelector('header');
    header?.before(head);
    header?.after(list);
    const panel = document.createElement('div');
    panel.className = 'blend-face-off';
    panel.id = 'blend-bills-more';
    panel.setAttribute('data-blend-bills-panel', '');
    panel.setAttribute('data-budget-bill-roster', '');
    toggle.setAttribute('aria-controls', panel.id);
    const sheet = document.querySelector('[data-budget-detail-sheet]');
    const native = typeof sheet?.budgetSheet?.open === 'function';
    const releasePreviousOpener = () => {
      // A previous day Close event can arrive after the roster has reopened.
      // Its skin fallback must not override the new native heading/hero origin.
      categoryFocusReturn = null;
      document.querySelectorAll('[data-blend-opened="1"]').forEach(node => {
        node.setAttribute('aria-expanded', 'false');
        node.removeAttribute('data-blend-opened');
      });
    };
    if (native) {
      panel.hidden = true;
      toggle.setAttribute('aria-haspopup', 'dialog');
    }
    toggle.addEventListener('click', () => {
      if (native) {
        releasePreviousOpener();
        panel.removeAttribute('data-budget-bill-day');
        budgetApplyBillFilter(panel, 'all');
        sheet.budgetSheet.open(panel, toggle, 'Bills');
        return;
      }
      const open = panel.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    list.after(panel);
    [...section.children].forEach(node => {
      if (node !== head && node !== list && node !== panel) panel.appendChild(node);
    });
    if (native) {
      // Match Income's compact list entry point. Keep the native Bills
      // deduction body available behind the roster's existing Why control.
      const heroBills = bento.querySelector('[data-operating-question="04"] .budget-step-summary');
      if (heroBills) {
        heroBills.setAttribute('aria-haspopup', 'dialog');
        heroBills.setAttribute('aria-controls', sheet.id);
        heroBills.setAttribute('aria-expanded', 'false');
      }
      heroBills?.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        releasePreviousOpener();
        panel.removeAttribute('data-budget-bill-day');
        budgetApplyBillFilter(panel, 'all');
        sheet.budgetSheet.open(panel, heroBills, 'Bills');
      }, true);
      // Period totals stay available without crowding the default roster.
      // Keep the original filters visible and preserve every control handler.
      const context = document.createElement('details');
      context.className = 'blend-bill-list-context';
      const summary = document.createElement('summary');
      summary.textContent = 'Period figures';
      context.appendChild(summary);
      [...panel.children].filter(node => !node.hasAttribute('data-budget-bill-bucket')
        && !node.classList.contains('budget-bill-filters') && !node.hasAttribute('data-budget-bill-filter-status')
        && !node.hasAttribute('data-budget-bill-filter-empty'))
        .forEach(node => context.appendChild(node));
      panel.appendChild(context);
    }
  }

  function plannedPhrase(row) {
    const meta = row.querySelector('.budget-category-meta');
    const found = text(meta).match(/of planned\s+(.+)$/i);
    if (!found) return null;
    const wrap = document.createElement('span');
    wrap.className = 'blend-of-plan';
    wrap.textContent = 'of planned ' + found[1].trim();
    return wrap;
  }

  function markSheet(button, row, activate = () => row.click()) {
    const sheet = document.querySelector('[data-budget-detail-sheet]');
    const categoryId = button.getAttribute('data-blend-cat');
    const attribute = categoryId ? 'data-blend-cat' : 'data-blend-bill';
    const id = button.getAttribute(attribute);
    const kind = button.classList.contains('blend-bill-item') ? '.blend-bill-item'
      : button.classList.contains('blend-other') ? '.blend-other' : '.blend-ring';
    if (sheet && !sheet.id) sheet.id = 'budget-detail-sheet';
    button.setAttribute('aria-haspopup', 'dialog');
    if (sheet) button.setAttribute('aria-controls', sheet.id);
    button.setAttribute('aria-expanded', 'false');
    if (sheet?.open && id && categoryFocusReturn?.id === id
      && (!categoryId || sheet.querySelector('[data-budget-category="' + CSS.escape(categoryId) + '"]'))) {
      categoryFocusReturn.node = button;
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('data-blend-opened', '1');
    }
    button.addEventListener('click', () => {
      if (sheet?.open && button.getAttribute('aria-expanded') === 'true') return;
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('data-blend-opened', '1');
      categoryFocusReturn = { node: button, id, kind, attribute };
      if (window.BudgetSheetMotion?.from) window.BudgetSheetMotion.from(button, activate);
      else activate();
      if (!sheet || !sheet.open) {
        button.removeAttribute('data-blend-opened');
        button.setAttribute('aria-expanded', 'false');
        if (categoryFocusReturn?.node === button) categoryFocusReturn = null;
      }
    });
    if (sheet && sheet.dataset.blendRingClose !== '1') {
      sheet.dataset.blendRingClose = '1';
      sheet.addEventListener('close', () => {
        // A remount may already have restored this native dialog. Keep its
        // return identity until that dialog actually closes.
        if (document.querySelector('[data-budget-detail-sheet]')?.open) return;
        const opened = document.querySelector('[data-blend-opened="1"]');
        const returnTo = categoryFocusReturn || (opened ? {
          node: opened, id: opened.getAttribute('data-blend-cat') || opened.getAttribute('data-blend-bill'),
          attribute: opened.hasAttribute('data-blend-cat') ? 'data-blend-cat' : 'data-blend-bill',
          kind: opened.classList.contains('blend-bill-item') ? '.blend-bill-item'
            : opened.classList.contains('blend-other') ? '.blend-other' : '.blend-ring',
        } : null);
        document.querySelectorAll('[data-blend-opened="1"]').forEach(node => {
          node.setAttribute('aria-expanded', 'false');
        });
        document.querySelectorAll('[data-blend-opened="1"]').forEach(node => node.removeAttribute('data-blend-opened'));
        if (returnTo) {
          categoryFocusReturn = returnTo;
          const restore = attempt => {
            if (categoryFocusReturn !== returnTo || document.querySelector('[data-budget-detail-sheet]')?.open) return;
            const visible = node => node?.isConnected && node.getClientRects().length
              && getComputedStyle(node).visibility !== 'hidden';
            const target = visible(returnTo.node) ? returnTo.node : returnTo.id
              ? [...document.querySelectorAll(returnTo.kind + '[' + (returnTo.attribute || 'data-blend-cat') + '="' + CSS.escape(returnTo.id) + '"]')].find(visible) : null;
            if (target) {
              target.focus({ preventScroll: true });
              if (document.activeElement === target) {
                target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                categoryFocusReturn = null;
                return;
              }
            }
            if (attempt === 0) requestAnimationFrame(() => restore(1));
            else categoryFocusReturn = null;
          };
          // Wait for native modal teardown and responsive DOM placement;
          // the incumbent close path may first try its hidden source row.
          requestAnimationFrame(() => restore(0));
          return;
        }
        queueMicrotask(() => {
          const current = document.activeElement;
          if (!current || current === document.body || !current.getBoundingClientRect) return;
          const dock = document.querySelector('.sitenav-household');
          const limit = dock && getComputedStyle(dock).position === 'fixed'
            ? dock.getBoundingClientRect().top : window.innerHeight;
          const box = current.getBoundingClientRect();
          if (box.height < 1 || box.top < 0 || box.bottom > limit - 4) {
            current.scrollIntoView({ block: 'center', inline: 'nearest' });
          }
        });
      });
    }
  }

  function leftArc(share) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 104 104');
    svg.setAttribute('class', 'blend-left-arc');
    svg.setAttribute('aria-hidden', 'true');
    ['blend-arc-track', 'blend-arc-left'].forEach(name => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '52');
      circle.setAttribute('cy', '52');
      circle.setAttribute('r', '49');
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke-width', '3');
      circle.setAttribute('class', name);
      if (name === 'blend-arc-left') {
        circle.setAttribute('stroke-linecap', 'round');
        circle.setAttribute('pathLength', '100');
        const drawn = share == null ? 0 : Math.max(0, Math.min(100, share * 100));
        circle.setAttribute('stroke-dasharray', drawn.toFixed(2) + ' 100');
      }
      svg.appendChild(circle);
    });
    return svg;
  }

  function categoryArc(share, ratio) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'blend-arc-ring');
    svg.setAttribute('aria-hidden', 'true');
    const ns = 'http://www.w3.org/2000/svg';
    const circle = (cls, extra) => {
      const node = document.createElementNS(ns, 'circle');
      node.setAttribute('cx', '50');
      node.setAttribute('cy', '50');
      node.setAttribute('r', '44');
      node.setAttribute('fill', 'none');
      node.setAttribute('class', cls);
      if (extra) Object.entries(extra).forEach(([key, value]) => node.setAttribute(key, value));
      svg.appendChild(node);
      return node;
    };
    const track = circle(share == null ? 'rg-track is-dotted' : 'rg-track');
    if (share > 0) {
      const circ = 2 * Math.PI * 44;
      const drawn = Math.max(0, Math.min(1, share)) * circ;
      const over = typeof ratio === 'number' && ratio > 1;
      circle('rg-arc' + (over ? ' rg-lap1' : ''), {
        stroke: 'currentColor',
        'stroke-width': '7',
        'stroke-linecap': 'round',
        transform: 'rotate(-90 50 50)',
        'stroke-dasharray': drawn.toFixed(2) + ' ' + circ.toFixed(2),
        ...(over ? { style: 'stroke: var(--blend-over)' } : {}),
      });
      if (over) {
        // Overflow decomposition (approved boundary, with Atlas's two
        // corrections): past the published plan the ring laps. The
        // red treatment covers the WHOLE ring — lap 1 above and this
        // overflow lap alike. The second lap is drawn exactly through
        // 200%: its fraction is ratio − 1, capped at a complete lap,
        // so above 200% the geometry stays two full laps. Within the
        // red treatment the overflow lap reads as a brighter core and
        // its tip stays a distinct dot.
        circle('rg-arc rg-lap2', {
          'stroke-width': '3.5',
          'stroke-linecap': 'round',
          transform: 'rotate(-90 50 50)',
          'stroke-dasharray': (Math.min(1, ratio - 1) * circ).toFixed(2) + ' ' + circ.toFixed(2),
          style: 'stroke: color-mix(in srgb, var(--blend-over) 55%, white)',
        });
        // The budget-limit crossing marker: a fixed tick at the lap
        // origin (top of the ring), painted above lap 1 and the
        // overflow lap but below the tip, and long enough to stay
        // legible at 200% and beyond, when the tip returns to the
        // origin and paints over its middle.
        const marker = document.createElementNS(ns, 'line');
        marker.setAttribute('x1', '50');
        marker.setAttribute('y1', '0.5');
        marker.setAttribute('x2', '50');
        marker.setAttribute('y2', '11.5');
        marker.setAttribute('class', 'rg-limit-marker');
        marker.setAttribute('stroke-width', '2.6');
        marker.setAttribute('stroke-linecap', 'round');
        marker.setAttribute('style', 'stroke: var(--blend-ink)');
        svg.appendChild(marker);
        const tipFraction = Math.min(1, ratio - 1);
        const angle = tipFraction * 2 * Math.PI;
        const tip = document.createElementNS(ns, 'circle');
        tip.setAttribute('cx', (50 + 44 * Math.sin(angle)).toFixed(2));
        tip.setAttribute('cy', (50 - 44 * Math.cos(angle)).toFixed(2));
        tip.setAttribute('r', '4');
        tip.setAttribute('class', 'rg-tip');
        tip.setAttribute('style', 'fill: var(--blend-over); stroke: var(--blend-ink); stroke-width: 1.4');
        svg.appendChild(tip);
      }
    }
    const glass = document.createElementNS(ns, 'circle');
    glass.setAttribute('cx', '50');
    glass.setAttribute('cy', '50');
    glass.setAttribute('r', '38');
    glass.setAttribute('class', 'rg-glass');
    svg.appendChild(glass);
    track.setAttribute('stroke-width', '7');
    return svg;
  }

  // Decorative liquid requires the same known spent/plan geometry as the
  // arc. Its level is existing --left; no financial state is derived.
  // Spent semantics for every Household ring (Systems Review 5481323065
  // R2): the liquid level IS the spent share, positioned by --left. A
  // known zero returns no liquid at all — the wave surface would
  // otherwise leave a visible sliver at the bottom of the glass — and a
  // full share keeps its liquid: at --left 1 the surface sits above the
  // glass top, so the interior reads full, matching the full arc.
  let categoryLiquidSequence = 0;
  function categoryLiquid(share) {
    if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1) return null;
    if (share === 0) return null;
    const ns = 'http://www.w3.org/2000/svg';
    const liquid = document.createElementNS(ns, 'svg');
    liquid.setAttribute('class', 'blend-ring-liquid');
    liquid.setAttribute('viewBox', '0 0 100 100');
    liquid.setAttribute('aria-hidden', 'true');
    // Keep decorative waves in phase when native publication remounts a tile.
    liquid.style.setProperty('--blend-wave-phase', (-performance.now() / 1000).toFixed(3) + 's');
    const defs = document.createElementNS(ns, 'defs');
    const clip = document.createElementNS(ns, 'clipPath');
    const clipId = 'blend-liquid-' + (++categoryLiquidSequence);
    clip.id = clipId;
    const glass = document.createElementNS(ns, 'circle');
    glass.setAttribute('cx', '50'); glass.setAttribute('cy', '50'); glass.setAttribute('r', '38');
    clip.appendChild(glass); defs.appendChild(clip);
    const masked = document.createElementNS(ns, 'g');
    masked.setAttribute('clip-path', 'url(#' + clipId + ')');
    const water = document.createElementNS(ns, 'g');
    water.setAttribute('class', 'blend-ring-water');
    // Reuse the prototype's decorative wave path, never its financial ringState.
    let wavePath = 'M0 12';
    for (let x = 0; x < 200; x += 19) wavePath += ' Q' + (x + 9.5) + ' ' + (x / 19 % 2 ? 15.5 : 8.5) + ' ' + (x + 19) + ' 12';
    wavePath += ' V110 H0 Z';
    ['blend-ring-wave w2', 'blend-ring-wave'].forEach(className => {
      const wave = document.createElementNS(ns, 'path');
      wave.setAttribute('class', className); wave.setAttribute('d', wavePath);
      water.appendChild(wave);
    });
    masked.appendChild(water); liquid.append(defs, masked);
    return liquid;
  }

  function ringCentre(status) {
    const raw = String(status || '').replace(/\s+/g, ' ').trim();
    const wrap = document.createElement('span');
    wrap.className = 'blend-ring-v';
    const parts = raw.match(/^(-?\$[\d,]+)(\.\d{2})(?:\s+(\S+))?/);
    if (!parts) {
      wrap.textContent = raw || '—';
      if (!/\$[\d,]/.test(raw) || raw.length > 14) wrap.classList.add('is-word');
      return wrap;
    }
    const amt = document.createElement('span');
    amt.className = 'blend-ring-amt';
    amt.appendChild(document.createTextNode(parts[1]));
    const cents = document.createElement('span');
    cents.className = 'blend-cents';
    cents.textContent = parts[2];
    amt.appendChild(cents);
    wrap.appendChild(amt);
    if (parts[3]) {
      const gap = document.createElement('span');
      gap.className = 'budget-cash-sr';
      gap.textContent = ' ';
      const unit = document.createElement('span');
      unit.className = 'blend-ring-u';
      unit.textContent = parts[3];
      wrap.append(gap, unit);
    }
    return wrap;
  }

  // Geometry for the ring arc. The bar width is preferred. When that width
  // is missing, a printed spent amount and a printed plan amount
  // are the same kind of share the split bar already uses. Nothing here is
  // written back as a figure.
  function printedSpentPlanShare(row) {
    const meta = row.querySelector('.budget-category-meta');
    if (!meta) return null;
    const clone = meta.cloneNode(true);
    clone.querySelectorAll('.budget-cash-sr').forEach(node => node.remove());
    const shown = text(clone);
    const amounts = [...shown.matchAll(/-?\$[\d,]+\.\d{2}/g)].map(match => printedMagnitude(match[0]));
    if (amounts.length < 2 || amounts[0] == null || amounts[1] == null || !(amounts[1] > 0)) return null;
    return Math.max(0, Math.min(1, amounts[0] / amounts[1]));
  }

  // The UNCLAMPED published spent/plan ratio, from the same printed
  // meta tokens printedSpentPlanShare reads. The overflow
  // decomposition (approved boundary, #atlas-coordination thread
  // 1791643511.871799, approval ts 1791699806.567609) must see past
  // 100%: lap 1 and the liquid keep the clamped share exactly as
  // before; only the overflow lap, its budget-limit marker and tip,
  // and the "2x+" threshold label read this ratio. A meta carrying no
  // printed pair — no plan, an unknown actual, Other Spending's
  // unassigned note — yields null, and nothing overflow is drawn.
  function printedOverflowShare(row) {
    const meta = row.querySelector('.budget-category-meta');
    if (!meta) return null;
    const clone = meta.cloneNode(true);
    clone.querySelectorAll('.budget-cash-sr').forEach(node => node.remove());
    const shown = text(clone);
    const amounts = [...shown.matchAll(/-?\$[\d,]+\.\d{2}/g)].map(match => printedMagnitude(match[0]));
    if (amounts.length < 2 || amounts[0] == null || amounts[1] == null || !(amounts[1] > 0)) return null;
    return Math.max(0, amounts[0] / amounts[1]);
  }

  function paintHouse(bento) {
    const section = bento.querySelector('[data-budget-browse="spending"]');
    if (!section || section.querySelector('[data-blend-rings]')) return;
    section.classList.add('tile', 't-house');
    const rings = document.createElement('div');
    rings.className = 'blend-rings';
    rings.setAttribute('data-blend-rings', '');
    const rows = [...section.querySelectorAll('.budget-category-row')];
    const other = rows.filter(row => row.getAttribute('data-budget-category-open') === 'other-spending');
    const main = rows.filter(row => !other.includes(row));
    const bridges = [];
    rows.forEach(row => row.classList.remove('blend-category-projected'));
    const spentPrinted = row => {
      const meta = row.querySelector('.budget-category-meta');
      if (!meta) return false;
      const clone = meta.cloneNode(true);
      clone.querySelectorAll('.budget-cash-sr').forEach(node => node.remove());
      const head = text(clone).split('/')[0] || '';
      if (/\$[\d,]/.test(head)) return true;
      return /\$[\d,]/.test(text(row.querySelector('.budget-category-status')));
    };
    // One spent treatment for every Household ring (Systems Review
    // 5481323065 R1): the fill is the published spent/plan share and
    // the liquid level is the spent share — circles start empty and
    // fill as spending lands. Geometry reuses the incumbent
    // printed-geometry path (the source row's numeric bar width first,
    // then the printed spent/plan share); when no spent amount is
    // printed the share stays unknown. Nothing here is written back
    // as a figure.
    // Face layout (owner amendment, Atlas boundary approval in
    // #atlas-coordination thread 1791643511.871799, superseding the
    // R1 amount-only centre): the centre carries the category NAME,
    // and the category's published Actual / Planned pair prints
    // beneath the circle. The full printed status — spent, planned,
    // remaining and every qualification — stays in the ring's
    // accessible name via the bridge below, exactly as before.
    const spentShare = row => {
      const bar = row.querySelector('.budget-category-bar');
      const scale = bar && bar.getAttribute('data-budget-category-scale');
      const fill = row.querySelector('.budget-category-fill');
      const width = fill && fill.style.width ? parseFloat(fill.style.width) : NaN;
      let share = scale === 'numeric' && Number.isFinite(width) && width >= 0
        ? Math.max(0, Math.min(1, width / 100)) : null;
      if (share == null) share = printedSpentPlanShare(row);
      return spentPrinted(row) ? share : null;
    };
    // The spent amount as printed: the meta head carries it when a plan
    // is published; the unassigned status is the spent amount itself; an
    // unobserved row falls back to its status word.
    const spentAmountText = (row, status) => {
      const metaNode = row.querySelector('.budget-category-meta');
      if (metaNode) {
        const clone = metaNode.cloneNode(true);
        clone.querySelectorAll('.budget-cash-sr').forEach(node => node.remove());
        const head = (text(clone).split('/')[0] || '').trim();
        if (moneyToken(head)) return head;
      }
      return moneyToken(status) || status;
    };
    // The category's published Actual / Planned pair as PRINTED in
    // the source row's meta, screen-reader lead-ins stripped — the
    // same clone the geometry fallback reads. The printed sides are
    // the source for the pair's words and qualifiers (Unavailable,
    // the estimated ≈); the face's figures come from the row's
    // stamped canonical amounts (pairSideText), never from parsing
    // these tokens. A meta carrying no pair — Other Spending's
    // unassigned note — yields null.
    const printedPair = row => {
      const metaNode = row.querySelector('.budget-category-meta');
      if (!metaNode) return null;
      const clone = metaNode.cloneNode(true);
      clone.querySelectorAll('.budget-cash-sr').forEach(node => node.remove());
      const shown = text(clone);
      const cut = shown.indexOf('/');
      if (cut < 0) return null;
      const actual = shown.slice(0, cut).trim();
      const planned = shown.slice(cut + 1).trim();
      return actual && planned ? { actual, planned } : null;
    };
    // Beneath each circle: the published Actual / Planned pair in the
    // source meta's own idiom (screen-reader "Spent … / of planned …",
    // visible tokens either side of the slash). When the row publishes
    // no pair but does publish a spent amount (Other Spending's
    // unassigned note in a period whose plan is withheld), the pair
    // still prints in Actual / Planned order with the missing side
    // explicitly Unavailable — never a lone amount, never an invented
    // zero (Systems Review 5482743628). A row publishing no amount at
    // all keeps its published status word alone.
    const pairLabel = (row, status) => {
      const label = document.createElement('span');
      label.className = 'blend-ring-l';
      const holder = document.createElement('span');
      holder.className = 'blend-ring-pair';
      const fillPair = (actual, planned) => {
        const srSpent = document.createElement('span');
        srSpent.className = 'budget-cash-sr';
        srSpent.textContent = 'Spent ';
        const sep = document.createElement('span');
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = ' / ';
        const srPlan = document.createElement('span');
        srPlan.className = 'budget-cash-sr';
        srPlan.textContent = ' of planned ';
        holder.append(srSpent, document.createTextNode(actual), sep,
          srPlan, document.createTextNode(planned));
      };
      const pair = printedPair(row);
      // The face's figures are the row's stamped canonical amounts,
      // each side rounded up once from its own typed value
      // (pairSideText). A side with no valid stamp is unknown and
      // renders its published word.
      const actualValue = stampedAmount(row.getAttribute('data-budget-pair-actual'));
      const plannedValue = stampedAmount(row.getAttribute('data-budget-pair-planned'));
      if (pair) {
        fillPair(pairSideText(actualValue, pair.actual),
          pairSideText(plannedValue, pair.planned));
      } else if (actualValue != null) {
        // Synthesized pair: the spent side renders from its stamp
        // (its ≈ qualifier, when the row is estimated, rides in the
        // status print); the withheld plan side is Unavailable.
        fillPair(pairSideText(actualValue, status), 'Unavailable');
      } else {
        const spent = spentAmountText(row, status);
        holder.textContent = pairSideText(null, spent);
      }
      label.appendChild(holder);
      // #821: the source row's stale-feed mark rides on the circle face too,
      // so a stale period never reads as final spending.
      if (row.getAttribute('data-budget-spent-trust') === 'incomplete') {
        const mark = document.createElement('span');
        mark.className = 'blend-ring-incomplete';
        mark.setAttribute('data-blend-spent-incomplete', '');
        mark.textContent = 'Incomplete';
        label.appendChild(mark);
      }
      return label;
    };
    // Display-only threshold label for spending past 200% of plan
    // (approved boundary): it is not a computed or printed percentage,
    // and it never enters the accessible name, which the bridge below
    // builds from the source row alone.
    const overBadge = () => {
      const badge = document.createElement('span');
      badge.className = 'blend-ring-x2';
      badge.textContent = '2x+';
      return badge;
    };
    main.forEach(row => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'blend-ring';
      const categoryId = row.getAttribute('data-budget-category-open');
      if (categoryId) button.setAttribute('data-blend-cat', categoryId);
      const share = spentShare(row);
      // The overflow decomposition reads the unclamped published
      // ratio, and only once the clamped share is full: a ring that
      // has not reached its plan never grows overflow artefacts.
      const ratio = share === 1 ? printedOverflowShare(row) : null;
      const hasSpend = spentPrinted(row);
      const status = text(row.querySelector('.budget-category-status')) || 'Unavailable';
      if (share != null) {
        button.classList.add('is-known');
        if (share < 1) button.classList.add('has-arc');
        // --left is the liquid level fraction: the spent share, so the
        // level rises toward the plan exactly as the arc fills.
        button.style.setProperty('--left', String(share));
        button.style.setProperty('--pct', share.toFixed(4));
      } else button.classList.add('is-unknown');
      const name = text(row.querySelector('.budget-category-name')) || 'Category';
      const nothingPrinted = !hasSpend || (!(share > 0) && !/\$[\d,]/.test(status) && /not observed|unavailable|unknown|^$/i.test(status));
      const well = document.createElement('span');
      well.className = 'blend-ring-g' + (nothingPrinted ? ' is-empty' : '');
      // The centre carries the category name (owner amendment); the
      // amounts move beneath the circle as the pair. The two personal
      // rings print the approved short labels — exactly Dale /
      // Amanda (Systems Review 5482743628) — in the visual centre
      // only: the accessible name and the sheet identity keep the
      // source row's full published label via the bridge below.
      const centreName = categoryId === 'dale-guilt-free' ? 'Dale'
        : categoryId === 'amanda-guilt-free' ? 'Amanda' : name;
      const value = ringCentre(centreName);
      well.appendChild(categoryArc(share, ratio));
      const liquid = categoryLiquid(share);
      if (liquid) well.appendChild(liquid);
      well.appendChild(value);
      const label = pairLabel(row, status);
      if (ratio != null && ratio > 2) label.appendChild(overBadge());
      button.append(well, label);
      if (row.classList.contains('is-over')) {
        button.classList.add('is-over');
        const pill = document.createElement('span');
        pill.className = 'blend-over-pill';
        const amount = document.createElement('span');
        amount.className = 'budget-cash-sr';
        amount.textContent = status;
        const word = document.createElement('span');
        word.textContent = 'Over plan';
        pill.append(amount, word);
        button.appendChild(pill);
      }
      markSheet(button, row);
      rings.appendChild(button);
      bridges.push([row, button]);
    });
    if (!main.length) {
      const missing = document.createElement('p');
      missing.className = 'blend-missing';
      missing.textContent = 'Unavailable';
      rings.appendChild(missing);
    }
    const header = section.querySelector('header');
    header?.after(rings);
    const facts = section.querySelector('.budget-browse-stats');
    const counts = section.querySelector('.budget-browse-counts');
    const titleWrap = header && (header.querySelector('h2')?.parentElement || header);
    if (titleWrap && !header.querySelector('.blend-tile-ico')) {
      titleWrap.prepend(tileIcon('house'));
      const chev = document.createElement('span');
      chev.className = 'blend-house-chev';
      chev.setAttribute('aria-hidden', 'true');
      chev.textContent = '›';
      header.querySelector('h2')?.after(chev);
    }
    if (facts) {
      // The published Actual / Planned pair leaves the tile header: it
      // becomes the tile's bottom totals (appended at the end of this
      // painter, rendered there in whole dollars from its stamps). The Still planned / From today cell is
      // evidence, not a header sentence; it moves into the sheet evidence
      // body with the counts (see the remainBlock handling below).
      facts.classList.add('blend-house-totals');
    }
    if (counts) counts.classList.add('blend-house-status');
    if (other[0]) {
      // Other Spending is a ring like its sibling categories, not a
      // footer chip: the duplicate chip (amber dot, amount, needs-a-
      // category badge) is retired. The needs-a-category status already
      // lives in the detail panel's context line and, in the unassigned
      // state, in this row's own printed meta — the bridge below carries
      // both into the ring's accessible name, as it did for the chip.
      // Differences from the sibling rings, per the agreed rulings: the
      // fill is spent / plan (siblings fill with what remains), and the
      // amber identity is kept via blend-ring-other, outside the colour
      // rotation. No figure is computed here; the share is the same
      // printed spent/plan geometry the sibling rings already use.
      const row = other[0];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'blend-ring blend-ring-other';
      const otherId = row.getAttribute('data-budget-category-open');
      if (otherId) button.setAttribute('data-blend-cat', otherId);
      const share = spentShare(row);
      const ratio = share === 1 ? printedOverflowShare(row) : null;
      const hasSpend = spentPrinted(row);
      const status = text(row.querySelector('.budget-category-status')) || 'Unavailable';
      // The spent amount as printed (see spentAmountText above).
      const spentText = spentAmountText(row, status);
      if (share != null) {
        button.classList.add('is-known');
        if (share < 1) button.classList.add('has-arc');
        // --left is the liquid level fraction: spent here, so the level
        // rises toward the plan exactly as the arc fills.
        button.style.setProperty('--left', String(share));
        button.style.setProperty('--pct', share.toFixed(4));
      } else button.classList.add('is-unknown');
      const nothingPrinted = !hasSpend || (!(share > 0) && !/\$[\d,]/.test(spentText)
        && /not observed|unavailable|unknown|^$/i.test(status));
      const otherName = text(row.querySelector('.budget-category-name')) || 'Other spending';
      const well = document.createElement('span');
      well.className = 'blend-ring-g' + (nothingPrinted ? ' is-empty' : '');
      well.appendChild(categoryArc(share, ratio));
      const liquid = categoryLiquid(share);
      if (liquid) well.appendChild(liquid);
      // The centre carries the published category name (owner
      // amendment), like every sibling ring; the pair prints beneath.
      well.appendChild(ringCentre(otherName));
      const otherLabel = pairLabel(row, status);
      if (ratio != null && ratio > 2) otherLabel.appendChild(overBadge());
      button.append(well, otherLabel);
      if (row.classList.contains('is-over')) {
        button.classList.add('is-over');
        const pill = document.createElement('span');
        pill.className = 'blend-over-pill';
        const amount = document.createElement('span');
        amount.className = 'budget-cash-sr';
        amount.textContent = status;
        const word = document.createElement('span');
        word.textContent = 'Over plan';
        pill.append(amount, word);
        button.appendChild(pill);
      }
      markSheet(button, row);
      rings.appendChild(button);
      bridges.push([row, button]);
    }
    const sourceRoot = bento.closest('[data-budget-surface]') || bento;
    const sheet = sourceRoot.querySelector('[data-budget-detail-sheet]');
    const body = document.createElement('div');
    body.className = 'blend-house-body';
    if (counts) body.appendChild(counts);
    const remainBlock = section.querySelector('[data-budget-browse-remaining]')?.parentElement;
    if (remainBlock) {
      remainBlock.classList.add('blend-house-remain');
      body.appendChild(remainBlock);
    }
    const cycle = section.querySelector('.budget-browse-cycle');
    if (cycle) body.appendChild(cycle);
    section.querySelectorAll('footer > p').forEach(node => body.appendChild(node));
    const sourceIdentity = `[data-operating-question="${CSS.escape('06')}"] .budget-step-body`;
    const evidenceBody = sheet?.budgetSheet?.sourceForIdentity?.(sourceIdentity)
      || sourceRoot.querySelector(sourceIdentity);
    if (evidenceBody) evidenceBody.appendChild(body);
    else {
      // A missing native disclosure must not discard counts or qualifiers.
      const more = document.createElement('details');
      more.className = 'blend-house-panel';
      const summary = document.createElement('summary');
      summary.textContent = 'Household detail';
      more.append(summary, body);
      (section.querySelector('.blend-other') || rings).after(more);
    }
    // The Actual / Planned pair is the tile's bottom totals. The face
    // renders each side in whole dollars, rounded up once from the
    // ratio span's stamped published amount — never a sum of the
    // rounded category pairs, and never a value parsed back out of
    // the printed cents (replacePrintedAmount only locates the
    // printed token's span). A side with no valid stamp (unknown)
    // keeps its printed word untouched. The Still planned cell has
    // already been extracted above, so it is not walked; the sheet's
    // separate evidence instance of the same publication is a
    // different element and keeps exact cents.
    if (facts) {
      const ratio = facts.querySelector('[data-budget-ratio]');
      const renderTotalSide = (selector, attribute) => {
        const span = ratio && ratio.querySelector(selector);
        const value = stampedAmount(ratio && ratio.getAttribute(attribute));
        if (!span || value == null) return;
        span.childNodes.forEach(child => {
          if (child.nodeType === 3) child.nodeValue = replacePrintedAmount(child.nodeValue, value);
        });
      };
      renderTotalSide('[data-budget-ratio-actual]', 'data-budget-actual-amount');
      renderTotalSide('[data-budget-ratio-plan]', 'data-budget-planned-amount');
      const delta = facts.querySelector('[data-budget-household-delta]');
      if (delta) {
        const value = stampedAmount(delta.getAttribute('data-budget-delta-amount'));
        const printed = delta.querySelector('[data-budget-delta-value]');
        if (printed && value != null) printed.childNodes.forEach(child => {
          if (child.nodeType === 3) child.nodeValue = replacePrintedAmount(child.nodeValue, value);
        });
        delta.hidden = false;
      }
      section.appendChild(facts);
    }
    // M13: the face rounds every amount UP to whole dollars (owner-approved
    // rounding, above). Say so on the face, once per tile, so a rounded
    // figure never reads as an exact one. The sheet keeps exact cents.
    if (!section.querySelector('[data-blend-rounding-note]')) {
      const rounding = document.createElement('p');
      rounding.className = 'blend-rounding-note';
      rounding.setAttribute('data-blend-rounding-note', '');
      rounding.textContent = 'Whole dollars, rounded up. Exact cents in the detail.';
      if (facts && facts.parentNode === section) section.appendChild(rounding);
      else rings.after(rounding);
    }
    // Only a complete, connected bridge may replace its source row on the
    // face. Keep the full printed status and amounts in its accessible name.
    // Unrepresented rows (including extra Other rows) remain visible.
    bridges.forEach(([row, button]) => {
      let label = separatedText(row);
      // Completed-period Other (Systems Review 5483272344): when the
      // Other row publishes a spent amount but no Actual / Planned
      // pair (its meta is the unassigned note), the visible pair
      // beneath the circle synthesizes the withheld plan side as
      // Unavailable — but the source row text carries no such
      // qualification, so the button's focus announcement omitted
      // it. Synthesize the same qualification into this ring's
      // accessible name only, after the full source label, status
      // and amounts, preserved verbatim. Known-plan names (a printed
      // pair exists) and every sibling ring are unchanged: their
      // source text already carries the pair.
      if (label && button.classList.contains('blend-ring-other') && !printedPair(row)) {
        const status = text(row.querySelector('.budget-category-status')) || '';
        if (moneyToken(spentAmountText(row, status))) label += '; planned Unavailable';
      }
      if (label) button.setAttribute('aria-label', label);
      const id = row.getAttribute('data-budget-category-open');
      const source = id && sourceRoot.querySelector('[data-budget-category="' + CSS.escape(id) + '"]');
      if (label && source && button.isConnected && typeof sheet?.budgetSheet?.open === 'function') {
        row.classList.add('blend-category-projected');
      }
    });
    section.querySelectorAll('.budget-category-list').forEach(node => node.classList.remove('blend-in-panel'));
    section.querySelectorAll('.budget-pace-key').forEach(node => {
      node.classList.add('blend-in-panel');
    });
    // Reuse the native evidence action on the visible title. Its delegated
    // handler and publication remain unchanged; keyboard users need not find
    // a control clipped inside the source footer.
    const evidence = section.querySelector('footer [data-budget-browse-evidence]');
    const heading = section.querySelector('header h2');
    if (evidence && heading) {
      const headingText = text(heading);
      const chevron = section.querySelector('.blend-house-chev');
      evidence.classList.add('blend-house-open');
      evidence.textContent = headingText;
      if (chevron) evidence.appendChild(chevron);
      heading.setAttribute('aria-label', headingText);
      heading.replaceChildren(evidence);
    }
    clip(section.querySelector('footer'));
    section.querySelectorAll('.budget-browse-eyebrow, .budget-browse-sub').forEach(clip);
  }

  function paintCards(bento) {
    const heading = bento.querySelector('.card-movement-heading');
    if (!heading || heading.dataset.blendCards === '1') return;
    heading.dataset.blendCards = '1';
    heading.closest('.budget-blend-card-movements')?.classList.add('tile', 't-cards');
    if (!heading.querySelector('.blend-tile-ico')) heading.prepend(tileIcon('cards'));
    const h2 = heading.querySelector('h2');
    if (h2 && !heading.querySelector('.blend-tile-title')) {
      const title = document.createElement('span');
      title.className = 'blend-tile-title';
      title.textContent = 'Credit cards';
      h2.classList.add('blend-clip');
      h2.after(title);
    }
    const note = heading.querySelector('p');
    if (note && /Opening balance unavailable|Future period not observed|activity not observed|Posted through/i.test(text(note))) {
      note.classList.add('blend-card-posted', 'blend-card-aside');
      // The status belongs to the strip's first panel, and that panel
      // leads with its reported balance (the card-detail lead): the
      // status follows the lead when the panel carries one and keeps
      // the incumbent prepend when it does not. A remount can restore
      // the first panel into the open detail sheet before this paint
      // runs, leaving it absent from the bento, so the panel is
      // selected by the track's first card identity across the whole
      // document — falling back to the bento's first panel when no
      // such panel exists. Status text and classes are unchanged.
      const firstId = bento.querySelector('.card-movement-trigger')
        ?.getAttribute('data-budget-card-toggle');
      const home = (firstId && bento.ownerDocument
        .querySelector(`[data-budget-card-panel="${firstId}"]`))
        || bento.querySelector('.card-movement-panel');
      if (home) {
        const lead = home.querySelector('.card-movement-lead');
        if (lead) lead.after(note); else home.prepend(note);
      }
    }
    bento.querySelectorAll('.card-movement-trigger').forEach(button => {
      if (!button.querySelector('.blend-cc-chip')) {
        const chip = document.createElement('span');
        chip.className = 'blend-cc-chip cc-chip';
        // Chip network and hue key on the row's canonical card id (the
        // trigger's own data-budget-card-toggle), never on the display
        // name: issuer facts per docs/ACCOUNT_FACTS.md — the Travel and
        // Cash Back cards are TD Visa, Triangle and the Amazon card are
        // Mastercards; Emerald (TD) and the HELOC carry no network mark.
        const networks = { travelvisa: 'visa', cashback: 'visa', triangle: 'mc', mbna: 'mc' };
        const hues = { travelvisa: '220', cashback: '160', tdcc: '150', triangle: '0', mbna: '30' };
        const id = button.getAttribute('data-budget-card-toggle');
        if (networks[id]) chip.setAttribute('data-net', networks[id]);
        chip.style.setProperty('--h', hues[id] || '220');
        button.prepend(chip);
      }
    });
  }

  function paintGoals(bento) {
    const card = bento.querySelector('[data-budget-savings-goals]');
    if (!card || card.querySelector('[data-blend-goals]')) return;
    card.classList.add('tile', 't-goals');
    if (card.parentElement !== bento) bento.appendChild(card);
    const face = document.createElement('div');
    face.className = 'blend-goals';
    face.setAttribute('data-blend-goals', '');
    face.setAttribute('aria-hidden', 'true');
    const list = document.createElement('ul');
    list.className = 'blend-goal-legend';
    const goals = [...card.querySelectorAll('[data-budget-savings-goal]')];
    // Clean main view; explanations on tap (owner direction, 2026-11-09).
    // A goal row shows its name, its bar, and Saved against Needed, each
    // copied from plan.js's printed row with its estimate mark and its
    // screen-reader trust word. Paid, Still to fund, its reason and the
    // this-period wording open in the tap-to-explain window. Nothing is
    // parsed, summed or recomputed, and a side that prints no figure keeps
    // its printed unavailable word.
    goals.forEach(row => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'blend-goal-row';
      button.setAttribute('data-blend-goal', row.getAttribute('data-budget-savings-goal') || '');
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
      const name = document.createElement('span');
      name.className = 'blend-goal-name';
      name.textContent = text(row.querySelector('strong')) || 'Goal';
      const status = text(row.querySelector('.budget-goal-state'));
      const sides = [...row.querySelectorAll('.budget-goal-amounts > span')]
        .map(span => ({ label: text(span.querySelector('small')), node: span.querySelector('.budget-goal-amount') }))
        .filter(side => side.node);
      const amounts = sides.map(side => [text(side.node), side.label].filter(Boolean).join(' ')).join(' · ');
      const sideFor = label => sides.find(side => new RegExp('^' + label + '$', 'i').test(side.label)) || null;
      const printedMoney = node => {
        if (!node) return false;
        const clone = node.cloneNode(true);
        clone.querySelectorAll('.budget-cash-sr').forEach(hidden => hidden.remove());
        return /\$[\d,]/.test(text(clone));
      };
      // The printed amount, copied verbatim with its estimate mark. The
      // screen-reader trust words stay off the visible line and are carried
      // in the row's accessible name below, so no figure loses its tag.
      const appendPrintedAmount = (line, amountNode) => {
        const walk = node => {
          node.childNodes.forEach(child => {
            if (child.nodeType === 3) {
              const value = child.textContent.replace(/\s+/g, ' ');
              if (!value) return;
              value.split('≈').forEach((part, index) => {
                if (index > 0) {
                  const mark = document.createElement('span');
                  mark.className = 'budget-v3-est';
                  mark.textContent = '≈';
                  line.appendChild(mark);
                }
                if (part) line.appendChild(document.createTextNode(part));
              });
              return;
            }
            if (child.nodeType === 1 && !child.classList.contains('budget-cash-sr')) walk(child);
          });
        };
        walk(amountNode);
      };
      const printed = (className, word, node, wordShown) => {
        const part = document.createElement('span');
        part.className = className;
        if (word) {
          const label = document.createElement('span');
          label.className = wordShown ? 'blend-goal-word' : 'blend-goal-word blend-clip';
          label.textContent = word + ' ';
          part.appendChild(label);
        }
        appendPrintedAmount(part, node);
        return part;
      };
      // A side that prints no figure keeps its printed word (Unavailable,
      // Unknown) as a plain word, never beside a Saved or Needed label.
      const unprinted = node => {
        const word = document.createElement('b');
        word.className = 'blend-goal-none';
        word.textContent = text(node);
        return word;
      };
      const slash = () => {
        const mark = document.createElement('span');
        mark.className = 'blend-goal-slash';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = '/';
        return mark;
      };
      const saved = sideFor('Saved');
      const planned = sideFor('Planned');
      const needed = planned || sideFor('Needed');
      const totalWord = planned ? 'Planned' : 'Needed';
      const progressBlock = row.querySelector('[data-budget-goal-paid-progress]');
      const paidState = progressBlock?.getAttribute('data-budget-goal-paid-progress') === 'paid';
      const figures = document.createElement('span');
      figures.className = 'blend-goal-status';
      figures.setAttribute('data-blend-goal-figures', '');
      // The accessible name is the row's own printed text, trust words
      // included ("calculated", "estimated"), joined in reading order.
      const spoken = [name.textContent];
      if (paidState) {
        // A paid goal says Paid. The published paid amount follows when
        // plan.js printed one; otherwise the planned cost keeps its own
        // visible label, so it is never read as an amount paid.
        const paid = document.createElement('b');
        paid.className = 'blend-goal-paid-word';
        paid.textContent = 'Paid';
        figures.appendChild(paid);
        const paidNode = row.querySelector('[data-budget-goal-paid]');
        if (printedMoney(paidNode)) {
          figures.appendChild(printed('blend-goal-paid-amount', '', paidNode, false));
          spoken.push('Paid ' + text(paidNode));
        } else {
          spoken.push('Paid');
          if (planned && printedMoney(planned.node)) {
            figures.appendChild(printed('blend-goal-needed', 'Planned', planned.node, true));
            spoken.push('Planned ' + text(planned.node));
          }
        }
      } else if (printedMoney(saved?.node) || printedMoney(needed?.node)) {
        if (saved) {
          figures.appendChild(printedMoney(saved.node) ? printed('blend-goal-saved', 'Saved', saved.node, false) : unprinted(saved.node));
          spoken.push('Saved ' + text(saved.node));
        }
        if (saved && needed) figures.appendChild(slash());
        if (needed) {
          figures.appendChild(printedMoney(needed.node) ? printed('blend-goal-needed', totalWord, needed.node, false) : unprinted(needed.node));
          spoken.push(totalWord + ' ' + text(needed.node));
        }
      } else {
        const word = document.createElement('b');
        word.textContent = status || (/Unavailable/i.test(amounts) ? 'Unavailable' : /Unknown/i.test(amounts) ? 'Unknown' : '');
        figures.appendChild(word);
        if (word.textContent) spoken.push(word.textContent);
      }
      button.setAttribute('aria-label', spoken.join('. '));
      const bar = document.createElement('span');
      bar.className = 'blend-g-bar';
      bar.setAttribute('aria-hidden', 'true');
      // Funding band from the typed stamps plan.js prints on the goal row
      // (data-budget-goal-saved-amount / data-budget-goal-required-amount):
      // saved over the TOTAL requirement, clamped to [0, 1]. A missing,
      // blank, malformed or non-finite stamp — or a negative requirement —
      // fails closed to the neutral unknown treatment, never coerced to
      // zero. A known zero requirement is its own state (no funding
      // required), distinct from missing evidence; it never divides.
      const savedValue = stampedAmount(row.getAttribute('data-budget-goal-saved-amount'));
      const requiredValue = stampedAmount(row.getAttribute('data-budget-goal-required-amount'));
      // ATLAS-024: the visible bar reflects paid + saved against the
      // published original cost, from the typed stamps on plan.js's paid
      // progress block. A goal whose published state is paid renders full
      // and green. Rows without that published geometry keep the saved /
      // required band below, unchanged.
      const paidValue = stampedAmount(progressBlock?.getAttribute('data-budget-goal-paid-amount'));
      const originalValue = stampedAmount(progressBlock?.getAttribute('data-budget-goal-original-amount'));
      let band = 'is-unknown';
      if (paidState) {
        band = 'is-paid';
      } else if (paidValue != null && originalValue != null && originalValue > 0 && savedValue != null) {
        const ratio = (paidValue + savedValue) / originalValue;
        band = ratio >= 1 ? 'is-full' : ratio >= 0.25 ? 'is-amber' : 'is-red';
        bar.style.setProperty('--w', Math.max(0, Math.min(1, ratio)).toFixed(4));
      } else if (savedValue != null && requiredValue != null && requiredValue >= 0) {
        if (requiredValue === 0) band = 'is-no-funding-required';
        else {
          const ratio = savedValue / requiredValue;
          band = ratio >= 1 ? 'is-full' : ratio >= 0.25 ? 'is-amber' : 'is-red';
          bar.style.setProperty('--w', Math.max(0, Math.min(1, ratio)).toFixed(4));
        }
      }
      bar.classList.add(band);
      item.classList.add(band);
      button.append(name, figures, bar);
      button.addEventListener('click', () => explainGoal(button, row));
      item.appendChild(button);
      list.appendChild(item);
    });
    if (goals.length) {
      // The visible rows are now the real controls. The clipped plan.js
      // rows stay in the document as the printed source (and for scripted
      // opens), out of the tab order and the accessibility tree so nothing
      // is announced or focused twice.
      face.removeAttribute('aria-hidden');
      list.setAttribute('aria-label', 'Savings goals');
      goals.forEach(row => {
        row.closest('ul')?.setAttribute('aria-hidden', 'true');
        row.querySelectorAll('button').forEach(source => source.setAttribute('tabindex', '-1'));
      });
    }
    if (!goals.length) {
      const notice = text(card.querySelector('.budget-goal-notice, p'));
      if (notice) {
        const item = document.createElement('li');
        item.textContent = notice;
        list.appendChild(item);
      }
    }
    face.appendChild(list);
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'blend-tile-head';
    const name = document.createElement('span');
    name.className = 'blend-tile-title';
    name.textContent = 'Savings goals';
    title.append(tileIcon('goals'), name);
    card.querySelector('h3')?.before(title);
    card.querySelector('h3')?.before(face);
    card.querySelectorAll(':scope > ul, :scope > .budget-surface-link:not([data-budget-funding-inventory]), :scope > .budget-goal-notice, :scope > .budget-surface-eyebrow, :scope > [data-budget-funding-savings], :scope > h3').forEach(node => {
      node.classList.add('blend-goals-source');
    });
  }

  // Refined face, step 1 (#821, owner 2026-11-11): the Budget's printed
  // "Last updated" line sits beside the logo. The header carries a verbatim
  // copy of plan.js's printed footer text, never a re-derived time; with no
  // printed line there is no header line. The footer stays in the document,
  // visually clipped, as the one read-out for assistive technology, so the
  // header copy is hidden from it and nothing is announced twice.
  function paintUpdated() {
    const brand = document.querySelector('.site-head .blend-brand');
    if (!brand) return;
    const source = document.querySelector('#operating-surface [data-account-last-updated]');
    const printed = text(source);
    let line = brand.querySelector(':scope > [data-blend-updated]');
    if (!printed) { line?.remove(); return; }
    if (!line) {
      line = document.createElement('small');
      line.className = 'blend-updated';
      line.setAttribute('data-blend-updated', '');
      line.setAttribute('aria-hidden', 'true');
      brand.appendChild(line);
    }
    line.textContent = printed;
    source.classList.add('blend-clip');
  }

  // Refined face, step 1: "Accounts & evidence" leaves the face and opens
  // from the savings detail, the pop-up the Savings goals head opens. The
  // same plan.js button moves (its dialog wiring and focus return go with
  // it). Without that pop-up the button stays on the face, so the dialog
  // never loses its only door.
  function parkInventory(card, panel) {
    const inventory = card.querySelector(':scope > [data-budget-funding-inventory]');
    if (!inventory || !panel) return;
    const summary = panel.querySelector(':scope > summary');
    moveWidget(panel, inventory, summary ? summary.nextSibling : panel.firstChild);
    inventory.classList.add('blend-goals-inventory');
  }

  function parkFunding(bento) {
    const card = bento.querySelector('[data-budget-savings-goals]');
    const section = document.querySelector('[data-budget-funding-section]');
    if (!card || !section || section.closest('.blend-goals-panel')) return;
    let panel = card.querySelector('.blend-goals-panel');
    if (!panel) {
      panel = document.createElement('details');
      panel.className = 'blend-goals-panel';
      panel.id = 'blend-savings-detail';
      const summary = document.createElement('summary');
      summary.className = 'blend-clip';
      summary.textContent = 'Savings detail';
      panel.appendChild(summary);
      card.appendChild(panel);
      const head = card.querySelector('.blend-tile-head');
      head?.setAttribute('aria-controls', panel.id);
      head?.setAttribute('aria-expanded', 'false');
      head?.addEventListener('click', event => {
        event.preventDefault();
        panel.open = !panel.open;
        head.setAttribute('aria-expanded', String(panel.open));
      });
      panel.addEventListener('toggle', () => head?.setAttribute('aria-expanded', String(panel.open)));
      panel.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !panel.open) return;
        event.preventDefault();
        event.stopPropagation();
        panel.open = false;
        head?.setAttribute('aria-expanded', 'false');
        head?.focus();
      });
    }
    section.classList.add('blend-goals-costs');
    panel.appendChild(section);
    parkInventory(card, panel);
  }

  function paintFaceBadges(bento) {
    const section = document.querySelector('[data-budget-browse="attention"]');
    if (!section || section.dataset.blendBadges === '1') return;
    section.dataset.blendBadges = '1';
    section.classList.add('blend-offstage');
    section.querySelectorAll('.budget-attention-item').forEach(item => {
      const label = text(item.querySelector('strong')) || text(item);
      if (!label) return;
      const cat = item.getAttribute('data-budget-category-open');
      const bill = item.getAttribute('data-budget-bill-open');
      const host = cat
        ? bento.querySelector('[data-blend-cat="' + CSS.escape(cat) + '"]')
        : bill
          ? bento.querySelector('#blend-bills-more')
          : null;
      const key = cat || bill || label;
      if (!host || host.classList.contains('blend-other') || host.classList.contains('blend-ring-other') || host.classList.contains('is-over') || host.querySelector('.blend-over-pill') || host.querySelector('[data-blend-badge="' + CSS.escape(key) + '"]')) return;
      const badge = document.createElement('span');
      badge.className = 'blend-face-badge';
      badge.setAttribute('data-blend-badge', key);
      badge.textContent = label;
      host.appendChild(badge);
    });
  }

  // Fritsch–Carlson monotone cubic slopes. Geometry of already chosen points.
  function monotoneSlopes(xs, ys) {
    const n = xs.length;
    const slope = new Array(n).fill(0);
    if (n < 2) return slope;
    const delta = [];
    for (let i = 0; i < n - 1; i++) delta.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1));
    slope[0] = delta[0];
    slope[n - 1] = delta[n - 2];
    for (let i = 1; i < n - 1; i++) {
      slope[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
    }
    for (let i = 0; i < n - 1; i++) {
      if (delta[i] === 0) { slope[i] = slope[i + 1] = 0; continue; }
      const a = slope[i] / delta[i];
      const b = slope[i + 1] / delta[i];
      const sum = a * a + b * b;
      if (sum > 9) {
        const scale = 3 / Math.sqrt(sum);
        slope[i] = scale * a * delta[i];
        slope[i + 1] = scale * b * delta[i];
      }
    }
    return slope;
  }

  // Geometry only. Empty text is not zero. Number('') must never become a height.
  function timelineGeometry(displayed) {
    const raw = String(displayed == null ? '' : displayed).replace(/\u2212/g, '-').trim();
    // The publisher uses money2: a signed currency string with two cents.
    // Keep the sign before '$'; never extract a number from other prose.
    if (!/^-?\$(?:\d{1,3}(?:,\d{3})*|\d+)\.\d{2}$/.test(raw)) return null;
    const number = Number(raw.replace(/[,$]/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  const RIVER_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function riverMonth(node) {
    if (!node) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(node.start)) {
      const month = Number(node.start.slice(5, 7)) - 1;
      if (month < 0 || month > 11) return null;
      return { key: node.start.slice(0, 7), name: RIVER_MONTHS[month], year: node.start.slice(0, 4) };
    }
    const named = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.exec(node.range || '');
    if (!named) return null;
    const year = /\b((?:19|20)\d{2})\b/.exec(node.range || '');
    return { key: (year ? year[1] + '-' : '') + named[1], name: named[1], year: year ? year[1] : '' };
  }

  // Every published period date stays selectable, irrespective of financial
  // coverage. Missing date identity cannot invent a navigation destination.
  function keepPastTimelineNode(li) {
    return !!li.getAttribute('data-bad-timeline-start') && !!li.getAttribute('data-bad-timeline-end');
  }

  // Reads ol[data-bad-timeline] only. The amount is the span text.
  // Native Forecast evidence qualifies historical BAD. Preserve its printed
  // trust and amount; Household coverage never removes period dates.
  // Unavailable or empty spans have no height at any date.
  // Absent list: the same neutral dashes, still focusable, and not a navigator.
  function readBadTimeline(doc) {
    const list = doc.querySelector('ol[data-bad-timeline]');
    if (!list) return { present: false, nodes: [] };
    const rows = [...list.children].filter(node => node.tagName === 'LI');
    const nodes = rows.filter(node => keepPastTimelineNode(node)).map((li, index) => {
      const trust = li.getAttribute('data-bad-term-trust') || '';
      const span = li.querySelector('[data-bad-term-amount]');
      const amount = span ? String(span.textContent == null ? '' : span.textContent).replace(/\s+/g, ' ').trim() : '';
      // The native producer owns qualification. The adapter cannot promote
      // missing trust or an empty amount, or suppress a qualified past value.
      const closed = !['calculated', 'estimated'].includes(trust) || amount.length === 0;
      const negative = !closed && li.getAttribute('data-sign') === 'negative';
      return {
        index: index,
        sourceIndex: rows.indexOf(li),
        start: li.getAttribute('data-bad-timeline-start') || '',
        end: li.getAttribute('data-bad-timeline-end') || '',
        role: li.getAttribute('data-bad-timeline-role') || '',
        range: li.getAttribute('data-bad-timeline-range-label') || '',
        trust: trust,
        face: li.getAttribute('data-bad-terms-face') || '',
        amount: amount,
        label: closed ? 'Unavailable' : amount,
        unavailable: closed,
        estimated: !closed && trust === 'estimated',
        negative: negative,
        tone: closed ? 'muted' : (negative ? 'short' : 'income'),
        magnitude: closed ? null : timelineGeometry(amount),
      };
    });
    return { present: true, nodes: nodes };
  }

  // A line may join only adjacent published, known amounts. Retain breaks
  // for missing amounts and for source rows removed from the visible strip.
  function knownTimelineRuns(nodes) {
    const runs = [];
    nodes.forEach((node, index) => {
      if (!Number.isFinite(node.magnitude)) return;
      const previous = index > 0 ? nodes[index - 1] : null;
      const adjacent = previous && Number.isFinite(previous.magnitude)
        && Number.isInteger(previous.sourceIndex) && Number.isInteger(node.sourceIndex)
        && node.sourceIndex === previous.sourceIndex + 1;
      if (!adjacent) runs.push([]);
      runs[runs.length - 1].push(index);
    });
    return runs;
  }

  // Decorative position spring adapted from the owner's g-blend/js/river.js.
  // Its state is a period position, never an interpolated financial amount.
  class RiverSpring {
    constructor(value) { this.x = this.target = value; this.v = 0; }
    set(value) { this.x = this.target = value; this.v = 0; }
    step(seconds) {
      const dt = Math.max(0, Math.min(0.05, Number.isFinite(seconds) ? seconds : 0));
      const n = Math.max(1, Math.ceil(dt / 0.008));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        this.v += (-190 * (this.x - this.target) - 27 * this.v) * h;
        this.x += this.v * h;
      }
      if (Math.abs(this.v) < 0.001 && Math.abs(this.x - this.target) < 0.001) this.set(this.target);
      return this.x;
    }
    get settled() { return this.x === this.target && this.v === 0; }
  }

  function riverKeyTarget(key, current, count) {
    if (current < 0 || count < 1) return null;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 6, PageDown: -6 }[key];
    return step ? Math.max(0, Math.min(count - 1, current + step)) : null;
  }

  function riverFlingTarget(target, velocity, spacing, count, pan, reduced) {
    const fling = !reduced && spacing > 0 && Number.isFinite(velocity)
      ? Math.max(-4, Math.min(4, (pan ? -velocity : velocity) * 140 / spacing)) : 0;
    return Math.round(Math.max(0, Math.min(count - 1, target + fling)));
  }

  function displayedTimelineIndex(nodes) {
    const progress = document.querySelector('[data-budget-window-progress]');
    const start = progress ? (progress.getAttribute('data-start') || '') : '';
    if (start) {
      const byStart = nodes.findIndex(node => node.start && node.start === start);
      if (byStart >= 0) return byStart;
    }
    const range = text(document.querySelector('[data-budget-window-range]'));
    if (range) {
      const byRange = nodes.findIndex(node => node.range && (range === node.range || range.indexOf(node.range) === 0));
      if (byRange >= 0) return byRange;
    }
    const eyebrow = text(document.querySelector('.budget-window-eyebrow'));
    if (/\bCurrent\b/.test(eyebrow)) {
      const byRole = nodes.findIndex(node => node.role === 'current');
      if (byRole >= 0) return byRole;
    }
    return -1;
  }

  function chooseBadTimeline(index, model) {
    if (!model || !model.present) return;
    const eyebrow = text(document.querySelector('.budget-window-eyebrow'));
    if (/^Calendar month/.test(eyebrow)) return;
    const target = model.nodes[index];
    if (!target || !target.start) return;
    const current = displayedTimelineIndex(model.nodes);
    if (current < 0 || current === index) return;
    // Native Previous/Next follows the unfiltered printed period order.
    // Visible-strip indices can skip past rows and must not count its steps.
    const from = model.nodes[current].sourceIndex;
    const to = target.sourceIndex;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    // The native wheel and timeline printer share the same unfiltered rows.
    // Prefer one native selection; retain steps for minimal/older mounts.
    const nativeChoice = document.querySelector('[data-budget-wheel="period"] [data-wheel-index="' + to + '"]');
    if (nativeChoice && !nativeChoice.disabled && nativeChoice.getAttribute('aria-disabled') !== 'true') {
      const wheel = nativeChoice.closest?.('[data-budget-wheel]');
      if (typeof CustomEvent === 'function' && wheel?.dispatchEvent && !wheel.dispatchEvent(
        new CustomEvent('budget-period-select', { cancelable: true, detail: { index: to } }))) return;
      nativeChoice.click();
      return;
    }
    const dir = to > from ? '1' : '-1';
    const steps = Math.abs(to - from);
    for (let i = 0; i < steps; i++) {
      const button = document.querySelector('[data-budget-window-step="' + dir + '"]');
      if (!button || button.getAttribute('aria-disabled') === 'true') return;
      button.click();
    }
  }

  let activeRiver = null;
  let pendingRiverSelection = null;
  let riverSelectionFrame = null;

  function cleanupDetachedRiver() {
    // Native selection replaces the bento, not its stable operating mount.
    // Keep the original river element/controller alive across those remounts.
    if (!activeRiver || document.querySelector('#operating-surface-body [data-budget-bento]')) return;
    activeRiver.controller.dispose(); activeRiver.wrap.remove(); activeRiver = null;
    if (riverSelectionFrame != null) cancelAnimationFrame(riverSelectionFrame);
    riverSelectionFrame = pendingRiverSelection = null;
  }

  function compactRiverAmount(value) {
    if (!Number.isFinite(value)) return '—';
    // Original fmtK: display formatting of one published amount, never a total.
    const a = Math.abs(value), sign = value < 0 ? '−' : '';
    return a >= 999.5 ? sign + '$' + (a / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : sign + '$' + Math.round(a);
  }

  function nativeRiverRange(node) {
    if (!node || !/^\d{4}-\d{2}-\d{2}$/.test(node.start) || !/^\d{4}-\d{2}-\d{2}$/.test(node.end)) return node?.range || 'Pay period';
    const startMonth = RIVER_MONTHS[Number(node.start.slice(5, 7)) - 1];
    const endMonth = RIVER_MONTHS[Number(node.end.slice(5, 7)) - 1];
    if (!startMonth || !endMonth) return node.range;
    const sameMonth = node.start.slice(0, 7) === node.end.slice(0, 7);
    const crossYear = node.start.slice(0, 4) !== node.end.slice(0, 4);
    return startMonth + ' ' + Number(node.start.slice(8)) + (crossYear ? ', ' + node.start.slice(0, 4) : '')
      + ' – ' + (sameMonth ? '' : endMonth + ' ') + Number(node.end.slice(8))
      + (crossYear ? ', ' + node.end.slice(0, 4) : '');
  }

  function publishRiverSelection(start, focus) {
    const model = readBadTimeline(document);
    const index = model.nodes.findIndex(node => node.start === start);
    if (index < 0) return;
    chooseBadTimeline(index, model);
    const nativeFocus = document.activeElement;
    if (nativeFocus?.closest('[data-budget-wheel="period"], [data-budget-window-step]')) nativeFocus.blur();
    if (activeRiver) activeRiver.restoreFocus = focus;
  }

  function paintRiver(bento) {
    cleanupDetachedRiver();
    if (!globalThis.BudgetRiver) return;
    const model = readBadTimeline(document), absent = !model.present || !model.nodes.length;
    const nodes = absent ? Array.from({ length: 12 }, (_, index) => ({ index, start: '', end: '', role: '', label: '—', unavailable: true, magnitude: null })) : model.nodes;
    const index = absent ? -1 : displayedTimelineIndex(nodes);
    const enabled = !absent && index >= 0 && !/^Calendar month/.test(text(document.querySelector('.budget-window-eyebrow')));
    const key = nodes.map(node => node.start + ':' + node.end).join('|');
    const periods = nodes.map(node => ({ ...node, bad: node.magnitude,
      state: node.unavailable ? 'unknown' : node.negative ? 'short' : 'healthy',
      fullLabel: node.label + (node.estimated ? ', estimated' : '') + ', ' + (node.range || 'Pay period') }));
    const cur = nodes.findIndex(node => node.role === 'current');
    const dark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    if (activeRiver && activeRiver.key !== key) { activeRiver.controller.dispose(); activeRiver.wrap.remove(); activeRiver = null; }
    if (!activeRiver) {
      const wrap = document.createElement('div'); wrap.className = 'g-river-wrap';
      // Original index.html river subtree; no prototype data or page generator.
      wrap.innerHTML = '<nav class="tile t-river" aria-label="Pay periods"><div class="river" role="slider" tabindex="0" aria-label="Pay period"><canvas class="river-canvas" aria-hidden="true"></canvas><div class="river-slide" aria-hidden="true"><div class="river-vals"></div><div class="months"></div></div><div class="playhead" aria-hidden="true"><div class="playhead-pill" aria-hidden="true"><span data-ph-range></span><b class="num" data-ph-value></b></div><span class="playhead-beam"></span><span class="playhead-orb"></span></div></div></nav>';
      activeRiver = { wrap, key, model, restoreFocus: false };
    }
    const record = activeRiver, wrap = record.wrap, nav = wrap.querySelector('nav'), river = wrap.querySelector('.river');
    record.model = model;
    nav.dataset.badRiver = absent ? 'absent' : 'printed';
    const updateLabel = selected => {
      const node = record.model.nodes[selected];
      wrap.querySelector('[data-ph-range]').textContent = node ? nativeRiverRange(node)
        : text(document.querySelector('[data-budget-window-range]')) || 'Pay period';
      const value = wrap.querySelector('[data-ph-value]');
      value.textContent = node?.label || '—'; value.classList.toggle('is-est', !!node?.estimated);
      nav.dataset.state = !node || node.unavailable ? 'unknown' : node.negative ? 'short' : 'healthy';
      river.setAttribute('role', enabled ? 'slider' : 'group');
      river.setAttribute('aria-label', absent ? 'Pay periods. Balance After Deductions timeline unavailable.' : 'Pay period');
      if (enabled && node) {
        river.setAttribute('aria-valuemin', '1'); river.setAttribute('aria-valuemax', String(nodes.length));
        river.setAttribute('aria-valuenow', String(selected + 1)); river.setAttribute('aria-valuetext', periods[selected].fullLabel);
      } else for (const attr of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) river.removeAttribute(attr);
      river.toggleAttribute('data-river-preview', selected !== displayedTimelineIndex(record.model.nodes));
    };
    const options = { el: river, canvas: wrap.querySelector('canvas'), playhead: wrap.querySelector('.playhead'),
      pill: wrap.querySelector('.playhead-pill'), slide: wrap.querySelector('.river-slide'),
      monthsEl: wrap.querySelector('.months'), valsEl: wrap.querySelector('.river-vals'),
      captureTarget: document.getElementById('operating-surface'), periods, knownRuns: knownTimelineRuns(nodes),
      index, cur, enabled, dark, reduce: reduceMotion(), fmt: compactRiverAmount,
      onChange: (selected, how) => {
        updateLabel(selected);
        const start = record.model.nodes[selected]?.start; if (!start) return;
        const focus = river === document.activeElement || !!record.restoreFocus;
        if (how === 'scrub') {
          // Original app.js queueSelect: one native publication per animation frame.
          pendingRiverSelection = { start, focus };
          if (riverSelectionFrame == null) riverSelectionFrame = requestAnimationFrame(() => {
            riverSelectionFrame = null; const pending = pendingRiverSelection; pendingRiverSelection = null;
            if (pending) publishRiverSelection(pending.start, pending.focus);
          });
        } else {
          if (riverSelectionFrame != null) cancelAnimationFrame(riverSelectionFrame);
          riverSelectionFrame = pendingRiverSelection = null; publishRiverSelection(start, focus);
        }
      },
      onCancel: () => {
        if (riverSelectionFrame != null) cancelAnimationFrame(riverSelectionFrame);
        riverSelectionFrame = pendingRiverSelection = null;
        const selected = displayedTimelineIndex(readBadTimeline(document).nodes); updateLabel(selected); return selected;
      },
    };
    // Original app.js leaves its river in place. Native remounts must not
    // replay the CSS entrance while the retained gesture/controller continues.
    if (record.controller) nav.classList.add('is-in');
    moveWidget(bento, wrap, bento.firstChild);
    if (record.controller) record.controller.adopt(options);
    else record.controller = globalThis.BudgetRiver.create(options);
    updateLabel(index);
    const today = document.querySelector('[data-blend-river-today]');
    if (today && document.querySelector('[data-atlas-toolbar]')) wrap.appendChild(today);
    if (today) {
      const away = enabled && cur >= 0 && index !== cur;
      today.classList.toggle('on', away); today.setAttribute('aria-hidden', String(!away)); today.tabIndex = away ? 0 : -1;
      today.onclick = () => record.controller.go(cur);
    }
  }

  let provenanceFooter = null;
  function paintQuiet() {
    const footer = provenanceFooter || document.querySelector('.wrap > footer');
    if (!footer) return;
    provenanceFooter = footer;
    const figures = document.querySelector('[data-budget-period-info-body]');
    if (figures) {
      footer.classList.add('blend-provenance');
      figures.appendChild(footer);
    }
    // The Budget is one surface; keep the provenance wording without a
    // page-navigation affordance. Native evidence controls are untouched.
    footer.querySelectorAll('a[href="/records.html"]').forEach(link => link.replaceWith(document.createTextNode(link.textContent)));
    const brand = document.querySelector('.site-head .blend-brand[href="/"]');
    if (brand) {
      brand.removeAttribute('href');
      brand.removeAttribute('aria-label');
    }
  }

  function paint(root) {
    const bento = root.querySelector('[data-budget-bento]');
    if (!bento || bento.getAttribute('data-blend-ready') === '1') return;
    bento.setAttribute('data-blend-ready', '1');
    place(bento);
    paintSheet(root);
    root.querySelector('[data-budget-detail-sheet]')?.budgetSheet?.completeDeferredRestore?.();
  }

  function paintSheet(root) {
    const dialog = root.querySelector('[data-budget-detail-sheet]');
    const header = dialog?.querySelector(':scope > header');
    const title = header?.querySelector('[data-budget-detail-title]');
    if (!dialog || !header || !title) return;
    dialog.classList.add('blend-detail-sheet');
    let titles = header.querySelector('.blend-sheet-titles');
    if (!titles) {
      titles = document.createElement('div');
      titles.className = 'blend-sheet-titles';
      const range = document.createElement('span');
      range.className = 'blend-sheet-kicker';
      range.textContent = text(root.querySelector('[data-budget-window-range]'));
      title.before(titles);
      titles.append(range, title);
    }
    root.querySelectorAll('.budget-bill-row, [data-bill-detail] > summary').forEach(row => {
      if (row.querySelector('.blend-bill-symbol')) return;
      const nativeLabel = row.querySelector('.budget-bill-label strong') || row.querySelector('span');
      const symbol = document.createElement('span');
      symbol.className = 'blend-bill-symbol';
      symbol.setAttribute('aria-hidden', 'true');
      const label = text(nativeLabel).toLowerCase();
      const hue = /hydro|electric|power/.test(label) ? 186 : /internet|wifi|telus|shaw/.test(label) ? 262
        : /\bcar\b|auto|vehicle/.test(label) ? 152 : /phone/.test(label) ? 18
          : /home.*insurance/.test(label) ? 38 : /mortgage|rent|house/.test(label) ? 222 : 230;
      symbol.style.setProperty('--bill-hue', String(hue));
      symbol.appendChild(billIcon(text(nativeLabel)));
      if (row.matches('[data-bill-detail] > summary')) {
        nativeLabel?.classList.add('blend-bill-summary-label');
        row.querySelector(':scope > span:last-child')?.classList.add('blend-bill-summary-amount');
      }
      row.prepend(symbol);
    });
    root.querySelectorAll('[data-bill-detail] .bill-detail-body:not([data-blend-bill-interior])').forEach(body => {
      body.setAttribute('data-blend-bill-interior', '');
      const original = [...body.children];
      const heading = body.querySelector(':scope > h4');
      const facts = body.querySelector(':scope > dl');
      const published = document.createElement('details');
      published.className = 'blend-bill-published';
      const summary = document.createElement('summary');
      summary.textContent = 'Published bill evidence';
      published.appendChild(summary);
      if (heading) published.appendChild(heading);
      if (facts) published.appendChild(facts);
      const matching = document.createElement('section');
      matching.className = 'blend-bill-matching';
      const matchingTitle = document.createElement('h3');
      matchingTitle.textContent = 'Matching payment';
      matching.appendChild(matchingTitle);
      const paymentEvidence = document.createElement('div');
      paymentEvidence.className = 'blend-payment-evidence';
      matching.appendChild(paymentEvidence);
      // Keep the original linked-payment evidence and every warning. No
      // candidate matching, financial calculations or prototype actions.
      original.filter(node => node !== heading && node !== facts).forEach(node => paymentEvidence.appendChild(node));
      const history = document.createElement('section');
      history.className = 'blend-bill-history';
      const historyTitle = document.createElement('h3');
      historyTitle.textContent = 'Last 6 months';
      const unavailable = document.createElement('div');
      unavailable.className = 'blend-history-unavailable';
      unavailable.textContent = 'Unavailable';
      const historyNote = document.createElement('p');
      historyNote.textContent = 'Average: Unavailable · Range: Unavailable. Forecast has not published a qualified six-month bill history. Missing history does not mean zero.';
      history.append(historyTitle, unavailable, historyNote);
      body.append(matching, history, published);
    });
  }

  function tilt(event) {
    if (reduceMotion()) return;
    const tile = event.target.closest && event.target.closest('.blend-tilt');
    if (!tile) return;
    const box = tile.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const px = (event.clientX - box.left) / box.width - 0.5;
    const py = (event.clientY - box.top) / box.height - 0.5;
    tile.style.setProperty('--ry', (px * 4).toFixed(2) + 'deg');
    tile.style.setProperty('--rx', (-py * 4).toFixed(2) + 'deg');
  }

  function untilt(event) {
    const tile = event.target.closest && event.target.closest('.blend-tilt');
    if (!tile) return;
    tile.style.removeProperty('--rx');
    tile.style.removeProperty('--ry');
  }

  function themeCycle() {
    const current = document.documentElement.getAttribute('data-theme');
    const dark = current === 'dark' || (!current && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark';
    try { localStorage.setItem('hfd-theme', next); } catch (e) {}
    document.documentElement.setAttribute('data-theme', next);
    if (window.App && typeof App.rerender === 'function') App.rerender();
    updateThemeName();
  }

  function updateThemeName() {
    const current = document.documentElement.getAttribute('data-theme');
    const dark = current === 'dark' || (!current && matchMedia('(prefers-color-scheme: dark)').matches);
    const button = document.querySelector('[data-blend-theme]');
    button?.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }

  function boot() {
    const mount = document.getElementById('operating-surface-body');
    if (!mount) return;
    mount.addEventListener('budget-before-remount', () => {
      explainClose(false);
      const stable = document.getElementById('operating-surface');
      if (!stable) return;
      if (activeRiver?.wrap.isConnected) moveWidget(stable, activeRiver.wrap);
      if (retainedAurora?.isConnected) moveWidget(stable, retainedAurora);
    });
    const run = () => {
      cleanupDetachedRiver();
      if (!mount.querySelector('[data-budget-bento]')) {
        globalThis.Aurora?.destroy?.(); retainedAurora?.remove(); retainedAurora = null; stackPlaceTiles = null;
      }
      paint(mount);
    };
    run();
    let stackFrame = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(stackFrame);
      stackFrame = requestAnimationFrame(() => stackPlaceTiles?.());
    });
    if (typeof MutationObserver === 'function') {
      new MutationObserver(run).observe(mount, { childList: true });
    }
    document.addEventListener('pointermove', tilt);
    document.addEventListener('pointerleave', untilt, true);
    document.querySelector('[data-blend-theme]')?.addEventListener('click', themeCycle);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeName);
    updateThemeName();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports.keepPastTimelineNode = keepPastTimelineNode;
    module.exports.readBadTimeline = readBadTimeline;
    module.exports.badTermNegative = badTermNegative;
    module.exports.stampedAmount = stampedAmount;
    module.exports.wholeDollarAmount = wholeDollarAmount;
    module.exports.pairSideText = pairSideText;
    module.exports.replacePrintedAmount = replacePrintedAmount;
    module.exports.knownTimelineRuns = knownTimelineRuns;
    module.exports.chooseBadTimeline = chooseBadTimeline;
    module.exports.RiverSpring = RiverSpring;
    module.exports.riverKeyTarget = riverKeyTarget;
    module.exports.riverFlingTarget = riverFlingTarget;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
