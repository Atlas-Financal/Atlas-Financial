'use strict';
/* Reorderable stacks (Dale, 2026-11-24): the order rule (StackBlocks.orderOf in public/stack-shell.js). The saved order
 * applies to the cards drawn now; a card the saved order does not name keeps its default place (right after the card
 * before it in the default order, or first); a saved name with no card, a duplicate or junk changes nothing.
 * The browser proof (drag, reload, fixed stacks, blocked storage, tap and scroll) is test/browser-stack-reorder.js.
 * `node test/test-stack-order.js` */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const box = { window: {}, location: { search: '' }, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON, Math, console };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-shell.js'), 'utf8'), box);
const orderOf = box.window.StackBlocks.orderOf;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const D = ['bills', 'budget', 'savings', 'credit'];

ok(eq(orderOf(D, []), D), 'nothing saved: the default order');
ok(eq(orderOf(D, ['credit', 'savings', 'budget', 'bills']), ['credit', 'savings', 'budget', 'bills']), 'a full saved order is applied');
ok(eq(orderOf(['bills', 'budget', 'savings', 'billsacct', 'credit'], ['credit', 'bills', 'budget', 'savings']),
  ['credit', 'bills', 'budget', 'savings', 'billsacct']), 'a new card goes right after its default neighbour (Savings)');
ok(eq(orderOf(['newfirst', 'bills', 'budget'], ['budget', 'bills']), ['newfirst', 'budget', 'bills']), 'a new first card goes first');
ok(eq(orderOf(['bills', 'budget', 'credit'], ['savings', 'credit', 'bills', 'budget']), ['credit', 'bills', 'budget']),
  'a saved card not drawn now (Savings on another period) is skipped');
ok(eq(orderOf(D, ['budget', 'budget', 'nope', 'bills']), ['budget', 'savings', 'credit', 'bills']),
  'a duplicate and an unknown name are ignored; unnamed cards follow their default neighbours (Savings after Budget, Credit after Savings)');
ok(eq(orderOf([], ['bills']), []), 'no cards: nothing');
console.log(`\n${checks} checks passed`);
