'use strict';
// Part 5 of the Savings consumer contract cases (test/test-savings-consumer-contract.js).
const parts = require('./lib/suite-parts');
parts.select('savings-consumer-contract', 5);
require('./test-savings-consumer-contract.js');
parts.verify();
