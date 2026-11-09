'use strict';
// Part 3 of the Savings consumer contract cases (test/test-savings-consumer-contract.js).
const parts = require('./lib/suite-parts');
parts.select('savings-consumer-contract', 3);
require('./test-savings-consumer-contract.js');
parts.verify();
