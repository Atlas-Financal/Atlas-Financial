'use strict';
// Part 6 of the G1 figures-check coverage cases (test/lib/figures-coverage-cases.js).
const parts = require('./lib/suite-parts');
parts.select('figures-coverage', 6);
require('./lib/figures-coverage-cases.js');
parts.verify();
