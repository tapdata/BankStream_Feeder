'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { transactionTimeUtc } = require('../src/transaction-time');

test('Db2 Shanghai wall time displays as UTC independently of the process time zone', () => {
  assert.equal(transactionTimeUtc('2026-11-09T16:33:17.223623'), '2026-11-09T08:33:17.223Z');
  assert.equal(transactionTimeUtc('2026-11-09 01:00:00'), '2026-11-08T17:00:00.000Z');
});

test('already zoned timestamps retain their instant', () => {
  assert.equal(transactionTimeUtc('2026-11-09T08:32:28.068Z'), '2026-11-09T08:32:28.068Z');
  assert.equal(transactionTimeUtc('2026-11-09T16:33:17+08:00'), '2026-11-09T08:33:17.000Z');
});
