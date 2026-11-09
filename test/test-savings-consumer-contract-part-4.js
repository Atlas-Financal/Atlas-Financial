'use strict';
// Part 4 of the Savings consumer contract cases (test/test-savings-consumer-contract.js).
const parts = require('./lib/suite-parts');
parts.select('savings-consumer-contract', 4);
require('./test-savings-consumer-contract.js');
parts.verify();
