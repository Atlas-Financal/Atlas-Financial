'use strict';
// Independent invented fee/bill fixture; never read canonical financial rows.
const seed = require('./card-purchase-coverage-data');
function fixture(posted = 16, unexpected = false, observationDate = '2026-09-30') {
  const x = seed('before');
  x.asOf = observationDate;
  x.data.plan.obligations = [];
  x.data.plan.startingCash.breakdown[1].value = 100;
  x.data.plan.bills = [{id:'tdfees',label:'Invented scheduled monthly fee',
    frequency:'monthly',day:30,amount:24,confidence:'confirmed',payingAccount:'chequing-a'}];
  x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
  x.payload.accounts.forEach(row => { row.updated_at = x.asOf + 'T17:00:00Z'; row.balance_last_update = x.asOf + 'T17:00:00Z'; });
  x.payload.transactionWindow.endDate = x.asOf;
  x.payload.categories = [{id:9910,name:'Bank fees',archived:false,is_group:false,
    is_income:false,exclude_from_totals:false,exclude_from_budget:false}];
  const tx = (id,account,amount,payee) => ({id,account_id:account,date:x.asOf,
    amount,currency:'cad',is_pending:false,category_id:9910,payee});
  x.payload.transactions = [tx(99001,3001,posted/2,'MONTHLY ACCOUNT FEE'),
    tx(99002,3002,posted/2,'MONTHLY ACCOUNT FEE')];
  if (unexpected) x.payload.transactions.push(
    tx(99003,3001,4.19,'OVERDRAFT FEE'), tx(99004,3004,13.37,'ANNUAL FEE'));
  x.payload.accounts[0].balance = 500 - posted/2 - (unexpected ? 4.19 : 0);
  x.payload.accounts[1].balance = 100 - posted/2;
  x.payload.accounts[3].balance = 400 + (unexpected ? 13.37 : 0);
  return x;
}
function internetFixture() {
  const x = fixture(0);
  x.data.plan.bills = [{id:'shaw',label:'Invented scheduled internet bill',frequency:'once',
    date:x.asOf,amount:17.23,confidence:'confirmed',payingAccount:'chequing-a'}];
  x.payload.categories = [{id:9911,name:'Internet and cable',is_income:false,is_group:false,
    archived:false,exclude_from_budget:false,exclude_from_totals:false}];
  x.payload.transactions = [{id:99101,account_id:3001,date:x.asOf,amount:17.23,
    currency:'cad',is_pending:false,category_id:9911,payee:'SHAW CABLE TV BPY'}];
  x.payload.accounts[0].balance = 482.77;
  x.payload.accounts[1].balance = 100;
  return x;
}

module.exports = fixture;
module.exports.internet = internetFixture;

module.exports.early = (posted, unexpected) => fixture(posted, unexpected, '2026-09-29');
