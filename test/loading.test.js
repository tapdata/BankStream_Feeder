'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { withLoading } = require('../src/loading');
const { dryRun } = require('../src/dry-run');

test('animates while pending and clears before the next output or prompt', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const writes = [];
  let complete;
  const result = withLoading('Reading current balance...', () => new Promise(resolve => {
    complete = resolve;
  }), { isTTY: true, write: text => writes.push(text) });

  assert.match(writes[0], /\| Reading current balance/);
  t.mock.timers.tick(100);
  assert.match(writes[1], /\/ Reading current balance/);
  complete(42);
  assert.equal(await result, 42);
  assert.equal(writes.at(-1), '\r\x1b[2K');
  t.mock.timers.tick(500);
  assert.equal(writes.length, 3);
});

test('clears when an action throws or a request times out', async () => {
  for (const action of [
    () => { throw new Error('connection failed'); },
    async () => { throw new Error('request timed out'); }
  ]) {
    const writes = [];
    await assert.rejects(withLoading('Checking connectivity...', action, {
      isTTY: true,
      write: text => writes.push(text)
    }), /failed|timed out/);
    assert.equal(writes.at(-1), '\r\x1b[2K');
  }
});

test('prints one plain progress line to a non-interactive stream', async () => {
  const writes = [];
  assert.equal(await withLoading('Fetching demo status...', () => 'ready', {
    write: text => writes.push(text)
  }), 'ready');
  assert.deepEqual(writes, ['Fetching demo status...\n']);
});

test('local dry run clears each operation before writing its results', async () => {
  const events = [];
  await dryRun({
    connectOracle: async () => ({ execute: async () => {}, close: async () => {} }),
    connectDb2: async () => ({ query: async () => {}, close: async () => {} }),
    log: line => events.push(line),
    loading: (message, action) => withLoading(message, action, {
      isTTY: true,
      write: text => events.push(text)
    })
  });

  for (const database of ['Oracle', 'Db2 for i']) {
    const start = events.findIndex(line => line.includes('Checking ' + database + ' connectivity'));
    assert.ok(start >= 0);
    assert.equal(events[start + 1], '\r\x1b[2K');
    assert.ok(events[start + 2].includes('[PASS] ' + database));
  }
});
