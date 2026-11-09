'use strict';
// Part 3 of the G1 figures-check coverage cases (test/lib/figures-coverage-cases.js).
const parts = require('./lib/suite-parts');
parts.select('figures-coverage', 3);
require('./lib/figures-coverage-cases.js');
parts.verify();
