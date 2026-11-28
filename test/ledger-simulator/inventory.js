'use strict';

const assert = require('node:assert/strict');
const { build, habits, generate } = require('./habits');
const { world, labels, ids, date } = require('./household');
const { replay } = require('./replay');

// Exercise the forced side of EVERY dial even when it misses the random draw.
// Replay the last evidence transition, as well as the event's first read.
async function inventory(seed, record) {
  const controls = new Map();
  const result = { habits: 0, labelShapes: labels.length, reads: 0, qualified: 0, refreshExceptions: [] };
  const disabled = Object.fromEntries(Object.keys(habits).map((key) => [key, 0]));
  assert.deepEqual(generate(seed, 40, disabled), []);
  for (const [name, h] of Object.entries(habits)) {
    let start = 1;
    while (start <= 40 && !h.eligible(start, name)) start++;
    assert.ok(start <= 40, 'unreachable habit ' + name);
    const [e] = generate(seed, start, { ...disabled, [name]: 1 });
    assert.ok(e && e.habit === name && e.start === start, 'ineffective dial ' + name);
    const rebuilt = build(seed, name, start);
    assert.deepEqual(e.rows, rebuilt.rows);
    const end = Math.max(
      start,
      ...e.rows.map((r) => r.sync),
      start + (['savings-rename', 'savings-redate'].includes(name) ? 2 : 0)
    );
    for (const day of new Set([start, end])) {
      const x = world(seed, day, [e]),
        raw = x.payload.transactions;
      for (const r of e.rows.filter((r) => r.sync > day))
        assert.ok(
          !raw.some((t) => t.id === r.id && t.is_pending === Boolean(r.pending)),
          'future row leaked: ' + name
        );
      if (name.startsWith('category-'))
        assert.ok(raw.some((r) => r.id === e.rows[0].id && r.category_id === ids[e.rows[0].label]));
      const { view } = await replay(seed, day, [e]);
      if (record) {
        if (!controls.has(day)) controls.set(day, (await replay(seed, day, [])).view);
        record({ seed, day, events: [e], panel: 'inventory/' + name, baseline: controls.get(day) }, view);
      }
      result.reads++;
      if (view.qualified) result.qualified++;
      if (view.exception) result.refreshExceptions.push({ name, day: date(day), exception: view.exception });
    }
    result.habits++;
  }
  return result;
}
module.exports = { inventory };
