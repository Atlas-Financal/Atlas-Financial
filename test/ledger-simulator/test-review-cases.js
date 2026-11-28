'use strict';

// Counterexamples from the independent review of #1683. Run directly from the repository root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, replayReport } = require('./run');
const { build, habits } = require('./habits');
const { evaluate } = require('./witness');
const { faults } = require('./transport');
const { replay, observation, digest } = require('./replay');
const { inspect } = require('./oracle');
const { date, labels, ids, providerId, world, terms } = require('./household');

async function main() {
  const seed = 73,
    events = [build(seed, 'manual-row', 1)];
  const manual = await replay(seed, 1, events);
  const packet = manual.raw.data.liveOverlay.currentPeriodActuals;
  const tx = packet.transactions.find((r) => r.atlasAccountId === 'mbna');
  assert.ok(manual.raw.qualified && packet.transactionCoverage === 'complete' && tx);
  assert.equal(tx.accountRole, 'revolving-credit');
  assert.deepEqual(manual.raw.data.plan.cardPurchaseCoverage.payDownOnly, ['mbna']);
  assert.ok(manual.raw.payload.transactions.some((r) => r.manual_account_id === providerId('manual')));
  assert.ok(manual.view.coverageIssues.includes('coverage-pay-down-card-activity-unexpected'));
  const noManual = await replay(seed, 1, []);
  assert.ok(!noManual.view.coverageIssues.includes('coverage-pay-down-card-activity-unexpected'));

  // Recreate the original unmapped clean-day input independently. The same
  // evaluator is used for reduction, cold history and saved-report replay.
  const missingMap = async (s, d, es, f) => {
    const input = world(s, d, es);
    input.accountMap.mappings = input.accountMap.mappings.filter(
      (m) => m.providerAccountId !== String(providerId('manual'))
    );
    return observation(s, d, es, f, input);
  };
  const cleanContext = { seed, day: 1, firstDay: 0 };
  const legacy = await evaluate(cleanContext, events, missingMap, true);
  assert.deepEqual(
    [
      legacy.prior.view.qualified,
      legacy.current.view.qualified,
      legacy.current.view.retained,
      legacy.current.view.sourceDay,
    ],
    [true, false, true, 0]
  );
  const short = await evaluate({ ...cleanContext, firstDay: 1 }, events, missingMap);
  assert.ok(!short.current.view.retained);
  const frozen = [build(seed, 'manual-row', 5)];
  for (const fault of [null, 'missing-balance']) {
    const multi = await evaluate({ seed, firstDay: 4, day: 6, fault }, frozen, missingMap, true);
    assert.equal(multi.prior.view.qualified, false);
    assert.deepEqual(
      [multi.prior.view.sourceDay, multi.current.view.retained, multi.current.view.sourceDay],
      [4, true, 4]
    );
    if (fault) assert.deepEqual(multi.clean.view.amounts, multi.current.view.amounts);
    assert.equal(multi.observations.find((o) => o.role === 'reading').sourceDay, date(4));
  }
  const older = await evaluate(
    {
      seed,
      firstDay: 3,
      day: 6,
      priorFaults: { 4: 'thin-card', 5: 'missing-balance' },
      fault: 'missing-balance',
    },
    []
  );
  assert.deepEqual(
    [older.prior.view.sourceDay, older.current.view.sourceDay, older.current.view.cardObservedAt],
    [4, 4, date(3) + 'T18:00:00.000Z']
  );
  for (const day of [14, 15]) {
    const crossing = await evaluate(
      {
        seed,
        firstDay: 12,
        day,
        priorFaults: { 13: 'thin-card', 14: 'missing-balance' },
        fault: 'missing-balance',
      },
      []
    );
    assert.ok(crossing.clean.view.qualified);
    assert.equal(crossing.clean.view.cardObservedAt, null);
    assert.ok(crossing.current.view.retained);
    assert.equal(crossing.current.view.sourceDay, 13);
    assert.equal(crossing.current.view.cardObservedAt, date(12) + 'T18:00:00.000Z');
    assert.deepEqual(crossing.current.view.amounts, crossing.prior.view.amounts);
    assert.ok(!crossing.failures.some((f) => f.cause === 'retention/missing-balance'));
  }
  const flags = {
    mode: 'advisory',
    seed,
    seeds: 1,
    months: 1,
    rates: Object.fromEntries(
      [...Object.keys(habits), ...Object.keys(faults)].map((n) => [n, n === 'manual-row' ? 1 : 0])
    ),
  };
  const report = await run(flags);
  assert.equal(report.stats.habits['manual-row'], 7);
  const held = report.consensus
    .find((g) => g.cause === 'topup')
    .witnesses.find((p) => p.panel === 'retained-pending-topup');
  assert.equal(held.kept, 2);
  const pending = held.rows.findIndex((r) => r.is_pending);
  assert.ok(pending >= 0);
  assert.ok(held.reads.some((o) => o.day === date(4) && o.role === 'history' && o.rows.includes(pending)));
  assert.ok(
    held.reads.some(
      (o) => o.day === date(5) && o.role === 'reading' && !o.rows.includes(pending) && o.sourceDay === date(4)
    )
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-review-replay-'));
  const file = path.join(dir, 'report.json');
  try {
    fs.writeFileSync(file, JSON.stringify(report));
    assert.ok((await replayReport(file)).verified >= 10);
    // Even a re-signed report cannot remove evidence used only yesterday.
    held.reads.find((o) => o.day === date(4) && o.role === 'history').rows = [];
    delete report.reportId;
    report.reportId = digest(report);
    fs.writeFileSync(file, JSON.stringify(report));
    await assert.rejects(() => replayReport(file), /historical input or qualification mismatch/);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }

  const base = (await replay(seed, 3, [])).view;
  const findings = (day, es, v, opts = {}) => inspect({ seed, day, events: es, view: v, ...opts }).failures;
  for (const day of [3, 14]) {
    const y = await replay(seed, day - 1, []),
      c = await replay(seed, day, [], null, y.raw),
      x = await replay(seed, day, [], 'thin-card', y.raw);
    assert.ok(x.view.qualified && !x.view.unresolved && x.view.moves.length);
    const opts = { fault: 'thin-card', prior: y.view, clean: c.view };
    assert.ok(!findings(day, [], x.view, opts).some((f) => f.check === 'no-move'));
    assert.ok(findings(day, [], { ...x.view, unresolved: true }, opts).some((f) => f.check === 'no-move'));
  }
  const excluded = new Set(['Transfer', 'Payment, Transfer', 'Payroll', 'Income', 'Credit Card Payment']);
  for (const name of labels) {
    const es = [build(seed, 'category-' + ids[name], 3)],
      v = (await replay(seed, 3, es)).view;
    const buy = es[0].purchases[0];
    const counted = v.buys.filter((r) => buy.ids.includes(r.id));
    assert.equal(counted.length, excluded.has(name) ? 0 : 1, name);
    assert.ok(!findings(3, es, v, { baseline: base }).some((f) => f.check === 'purchase-once'), name);
    if (excluded.has(name)) {
      const amount = buy.versions[0].cents;
      assert.equal(v.heldRows.find((r) => buy.ids.includes(r.id))?.cents, amount);
      assert.ok(
        findings(3, es, { ...v, heldRows: [] }, { baseline: base }).some(
          (f) => f.cause === 'classification/hold'
        )
      );
      assert.ok(
        findings(
          3,
          es,
          { ...v, buys: [...v.buys, { id: buy.ids[0], cents: amount }] },
          { baseline: base }
        ).some((f) => f.cause.startsWith('classification/forbidden-spending'))
      );
    } else if (name === 'Groceries') {
      assert.ok(
        findings(
          3,
          es,
          { ...v, buys: v.buys.filter((r) => !buy.ids.includes(r.id)) },
          { baseline: base }
        ).some((f) => f.cause === 'purchase/category-' + ids.Groceries)
      );
    }
  }
  for (const n of ['studio-groceries', 'paypal-transfer', 'topup-studio']) {
    const es = [build(seed, n, 3)],
      v = (await replay(seed, 3, es)).view;
    assert.ok(
      !findings(3, es, v, { baseline: base }).some((f) => f.check === 'purchase-once' || f.cause === 'topup'),
      n
    );
    if (n === 'topup-studio') assert.equal(es[0].transfers[0].to, 'studio');
    if (n === 'studio-groceries')
      assert.ok(
        findings(3, es, { ...v, heldRows: [{ id: es[0].rows[0].id, cents: 37 }] }, { baseline: base }).some(
          (f) => f.cause === 'classification/external-held'
        )
      );
  }
  assert.ok(
    !report.consensus.find((g) => g.cause === 'topup').witnesses.some((w) => w.habit === 'topup-studio')
  );
  const bills = [build(seed, 'parked-purchase', 13)];
  for (const fault of ['edit-between-pages', 'missing-balance']) {
    const y = await replay(seed, 13, bills),
      c = await replay(seed, 14, bills, null, y.raw),
      x = await replay(seed, 14, bills, fault, y.raw);
    assert.ok(c.view.qualified && !x.view.qualified && x.view.retained);
    assert.notEqual(c.view.amounts.cash, y.view.amounts.cash);
    assert.equal(x.view.amounts.cash, y.view.amounts.cash);
    if (fault === 'edit-between-pages') {
      const target = bills[0].purchases[0].ids[0];
      assert.deepEqual(
        x.raw.payload.transactions
          .filter((r) => r.id === target && r.plaid_account_id === providerId('bills'))
          .map((r) => r.category_id),
        [ids.Groceries, ids.Restaurants]
      );
    }
    const opts = { prior: y.view, clean: c.view, fault };
    assert.deepEqual(findings(14, bills, x.view, opts), []);
    assert.ok(
      findings(14, bills, { ...x.view, qualified: true }, opts).some((f) => f.cause === 'admission/' + fault)
    );
    const changed = structuredClone(x.view);
    changed.amounts.cash++;
    assert.ok(findings(14, bills, changed, opts).some((f) => f.cause === 'retention/' + fault));
    const signed = structuredClone(x.view);
    signed.retainedReceipt.asOf = date(14);
    assert.ok(findings(14, bills, signed, opts).some((f) => f.cause === 'retention/' + fault));
    const crashed = { ...x.view, exception: { code: 'TypeError', message: 'invented crash' } };
    assert.ok(findings(14, bills, crashed, opts).some((f) => f.check === 'refresh'));
  }
  for (const n of [
    'savings-short-history',
    'savings-refund-excess',
    'savings-refund-untagged',
    'savings-purchase',
  ]) {
    const es = [build(seed, n, 3)],
      v = (await replay(seed, 5, es)).view,
      b = (await replay(seed, 5, [])).view;
    assert.ok(!findings(5, es, v, { baseline: b }).some((f) => f.check === 'purchase-once'), n);
    const item = v.goalFigures.find((x) => x.id === 'commitment:kite');
    if (n === 'savings-purchase') {
      const broken = structuredClone(v);
      broken.amounts.goalKiteSpent = null;
      broken.buys = broken.buys.filter((r) => r.id !== es[0].rows[0].id);
      broken.withheldPurchases = [{ id: es[0].rows[0].id, goal: item.id, reasons: [] }];
      assert.ok(
        findings(5, es, broken, { baseline: b }).some((f) => f.cause === 'purchase/' + n && f.actual === null)
      );
    } else {
      assert.equal(item.spent, null, n);
      const invented = structuredClone(v);
      invented.goalFigures.find((x) => x.id === item.id).spent = 0;
      assert.ok(findings(5, es, invented, { baseline: b }).some((f) => f.cause === 'savings/unprovable'));
    }
  }
  const y = await replay(seed, 4, []),
    c = await replay(seed, 5, [], null, y.raw),
    x = await replay(seed, 5, [], 'thin-payer', y.raw),
    opts = { fault: 'thin-payer', prior: y.view, clean: c.view };
  const sync = x.raw.data.liveOverlay.currentPeriodActuals.syncEvidence;
  assert.ok(
    sync
      .filter((r) => ['household-cash', 'household-reserve'].includes(r.role))
      .every((r) => r.syncEvidence === 'absent')
  );
  assert.ok(sync.some((r) => r.id === 'travelvisa' && r.syncEvidence === 'proven'));
  assert.ok(x.view.payerGap.reasons.includes('paying-account-not-observed'));
  assert.deepEqual([x.view.payerGap.amounts.cardSpent, x.view.payerGap.amounts.cardPaid], [211, null]);
  assert.deepEqual(
    [x.view.amounts.cardPaid, x.view.amounts.cardRemainder, x.view.trust.cardPaid, x.view.cardObservedAt],
    [0, terms(seed).min, 'estimated', y.raw.payload.fetchedAt]
  );
  assert.ok(inspect({ seed, day: 5, events: [], view: x.view, ...opts }).exercised.includes('last-known'));
  assert.ok(!findings(5, [], x.view, opts).some((f) => f.check === 'last-known'));
  // A still-visible payer debit can prove payment even without a sync stamp.
  // Withdraw that row alone on day five to make the older nonzero payment
  // eligible for display-only retention.
  const pay = build(seed, 'card-noted', 2);
  const paid = await replay(seed, 4, [pay]);
  const readable = await replay(seed, 5, [pay], 'thin-payer', paid.raw);
  assert.equal(readable.view.cardObservedAt, null);
  assert.equal(readable.view.amounts.cardPaid, pay.transfers[0].cents);
  pay.rows.find((r) => r.id === pay.transfers[0].debit).until = 5;
  const heldPayment = await replay(seed, 5, [pay], 'thin-payer', paid.raw);
  assert.deepEqual(
    [
      heldPayment.view.payerGap.amounts.cardPaid,
      heldPayment.view.amounts.cardPaid,
      heldPayment.view.trust.cardPaid,
      heldPayment.view.cardObservedAt,
    ],
    [null, pay.transfers[0].cents, 'estimated', paid.raw.payload.fetchedAt]
  );
  assert.ok(
    inspect({
      seed,
      day: 5,
      events: [pay],
      view: heldPayment.view,
      fault: 'thin-payer',
      prior: paid.view,
    }).exercised.includes('last-known')
  );
  const broken = structuredClone(x.view);
  broken.amounts.cardPaid = null;
  assert.ok(findings(5, [], broken, opts).some((f) => f.cause === 'last-known/thin-payer'));
  console.log(
    JSON.stringify({
      seed,
      manualRowDayOne: 'qualified, mapped pay-down-only activity',
      oldUnmappedCleanDay: 'retained day 0',
      twoRefusedDays: 'retained day 4',
      historyOnlyPendingRow: held.rows[pending].id,
      tamperedEvidence: 'rejected',
      categories: labels.length,
      excludedCashDebits: excluded.size,
      payerGap: { cold: null, warm: x.view.amounts.cardPaid, asOf: x.view.cardObservedAt },
      heldNonzeroCents: heldPayment.view.amounts.cardPaid,
      knownFamilies: report.consensus.length,
    })
  );
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
