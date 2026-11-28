'use strict';

const assert = require('node:assert/strict');
// Remove unrelated economic operations together with their simulated bank
// effects. Within a surviving operation, remove observed legs/copies separately.
function subset(events, tokens) {
  const selected = new Set(tokens);
  return events.flatMap((e, i) => {
    const rows = e.rows.filter((r, j) => selected.has(i + '/' + j));
    const configured = !e.rows.length && selected.has(i + '/config');
    if (!rows.length && !configured) return [];
    const ids = new Set(rows.map((r) => r.id));
    const transfers = e.transfers.filter((m) => ids.has(m.receipt) || ids.has(m.debit));
    const purchases = e.purchases
      .filter((p) => p.ids.some((id) => ids.has(id)))
      .map((p) => ({
        ...p,
        // One economic purchase may still have several independent readable
        // versions. A removed posting cannot determine the oracle's known price.
        versions: p.versions.length > 1 ? p.versions.filter((v) => ids.has(v.id)) : p.versions,
      }));
    const economic = new Set([
      ...ids,
      ...transfers.flatMap((t) => [t.debit, t.receipt]),
      ...purchases.flatMap((p) => p.ids),
    ]);
    return [
      {
        ...e,
        rows,
        transfers,
        purchases,
        entries: e.entries.filter((r) => economic.has(r.id) || (configured && r.id == null)),
      },
    ];
  });
}
function tokensFor(events, day) {
  return events.flatMap((e, i) =>
    e.start > day ? [] : !e.rows.length ? [i + '/config'] : e.rows.map((_, j) => i + '/' + j)
  );
}
// Delta debugging followed by individual deletions and an uncached final replay.
// A predicate includes the cause, affected figure and habit. Magnitudes may
// fall as independent copies of a failing operation are removed.
async function shrink(tokens, reproduces) {
  assert.ok(await reproduces(tokens), 'unreproducible original failure');
  let kept = tokens.slice(),
    granularity = 2;
  while (kept.length) {
    const width = Math.ceil(kept.length / granularity);
    let smaller = false;
    for (let at = 0; at < kept.length; at += width) {
      const candidate = kept.slice(0, at).concat(kept.slice(at + width));
      if (await reproduces(candidate)) {
        kept = candidate;
        granularity = 2;
        smaller = true;
        break;
      }
    }
    if (!smaller) {
      if (width === 1) break;
      granularity = Math.min(kept.length, granularity * 2);
    }
  }
  for (let i = 0; i < kept.length; i++)
    assert.equal(Boolean(await reproduces(kept.filter((_, j) => j !== i))), false, 'removable witness row');
  const proof = await reproduces(kept, true);
  assert.ok(proof, 'failure disappeared on final replay');
  return { kept, proof };
}
module.exports = { subset, tokensFor, shrink };
