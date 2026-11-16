'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRealtimeService } = require('../src/realtime');
const { createHostedService } = require('../src/hosted-service');
const { parseRealtimeArgs } = require('../src/cli');

function fixture(prefix, currencies) {
  const records = currencies.map((currency, index) => ({ CUSTOMER_ID: index + 1,
    ACCOUNT_ID: prefix + '-' + index, CURRENCY: currency }));
  const byAccount = new Map(records.map(row => [row.ACCOUNT_ID, row]));
  const inserted = [], transactions = new Map(), queries = [];
  const db2 = { close: async () => {}, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    query: async (sql, binds = []) => {
      queries.push(sql); assert.ok(sql.includes(prefix + '_CORE.'), 'must stay within the partner AS400 schema');
      if (sql.includes('JOIN')) return records;
      if (sql.includes("WHERE TRANSACTION_STATUS='PENDING' ORDER")) return [];
      if (sql.startsWith('INSERT')) {
        const account = byAccount.get(binds[1]);
        assert.ok(account, 'insert must reference a real eligible account');
        assert.equal(binds[4], account.CURRENCY.trim().toUpperCase(), 'transaction currency must match that account');
        inserted.push({ accountId: binds[1], currency: binds[4] });
        transactions.set(binds[0], { TRANSACTION_STATUS: 'PENDING', ACCOUNT_ID: binds[1],
          TRANSACTION_TYPE: binds[2], TRANSACTION_AMOUNT: binds[3], CURRENCY: binds[4] });
        return { count: 1 };
      }
      if (sql.startsWith('SELECT TRANSACTION_STATUS')) return [transactions.get(binds[0])];
      if (sql.startsWith('SELECT BALANCE')) {
        assert.ok(byAccount.has(binds[0])); return [{ BALANCE: 100000, AVAILABLE_BALANCE: 100000 }];
      }
      if (sql.startsWith('UPDATE') && sql.includes('.BANK_ACCOUNT')) assert.ok(byAccount.has(binds[2]));
      else if (sql.startsWith('UPDATE')) transactions.get(binds[0]).TRANSACTION_STATUS = sql.includes("='COMPLETED'") ? 'COMPLETED' : 'REJECTED';
      else assert.fail('Unexpected AS400 statement: ' + sql);
      return { count: 1 };
    } };
  const oracle = { close: async () => {}, execute: async sql => {
    assert.ok(sql.includes(prefix + '_CRM.'), 'must stay within the partner Oracle schema');
    if (sql.startsWith('SELECT CUSTOMER_ID,CUSTOMER_PROFILE_ID')) return { rows: records
      .map(row => [row.CUSTOMER_ID, 'PROFILE-' + row.CUSTOMER_ID]) };
    assert.match(sql, /^(UPDATE|INSERT)/);
    return { rowsAffected: 1 };
  } };
  const settings = { db2: { schema: prefix + '_CORE', host: 'fixture', user: 'fixture', password: 'fixture' },
    oracle: { schema: prefix + '_CRM', user: 'fixture', password: 'fixture', connectString: 'fixture' },
    demo: { customerId: '1', accountId: prefix + '-0' }, retryLimit: 0 };
  return { records, inserted, queries, db2, oracle, settings };
}

async function generate(mode, prefix, currencies, count) {
  const f = fixture(prefix, currencies), controller = new AbortController(), output = [];
  let intents = 0;
  const execution = { signal: controller.signal, output: text => output.push(text), progress: () => {}, coordinate: action => action(),
    onIntent: async intent => { if (intent.kind === 'generation' && ++intents === count) controller.abort(); } };
  const { help, ...parsed } = parseRealtimeArgs(['--duration', '5m', '--interval', '15s']);
  assert.deepEqual(parsed, { durationMs: 300000, intervalMs: 15000, eventsPerCycle: 1 });
  // Complete the small test batch before the first interval; production scheduling is untouched.
  const options = { ...parsed, eventsPerCycle: count };
  let summary;
  if (mode === 'remote') {
    const service = createHostedService(f.settings, { connections: {
      connectDb2: async () => f.db2, connectOracle: async () => f.oracle
    } });
    summary = await service.realtime(options, execution);
  } else {
    summary = await createRealtimeService(f.settings, { signal: execution.signal, log: execution.output,
      progress: execution.progress, coordinate: execution.coordinate, onIntent: execution.onIntent }).realtime(f.db2, f.oracle, options);
  }
  assert.equal(summary.failures.length, 0);
  assert.equal(f.inserted.length, count);
  assert.deepEqual(options, { durationMs: 300000, intervalMs: 15000, eventsPerCycle: count });
  return { ...f, output };
}

for (const mode of ['local', 'remote']) {
  test(mode + ' realtime cycles through AUD, USD and GBP using currency-matched accounts', async () => {
    const f = await generate(mode, 'PARTNER', ['USD', 'AUD', 'GBP', 'AUD', 'EUR'], 6);
    assert.deepEqual(f.inserted.map(row => row.currency), ['AUD', 'USD', 'GBP', 'AUD', 'USD', 'GBP']);
    assert.ok(!f.inserted.some(row => row.accountId === 'PARTNER-4'), 'unsupported EUR account must not be used');
    assert.ok(f.output.some(line => line.includes('Workload currencies: AUD, USD, GBP')));
  });

  test(mode + ' realtime uses available supported currencies without inventing other accounts', async () => {
    const f = await generate(mode, 'USD_ONLY', ['USD'], 3);
    assert.deepEqual(f.inserted, Array.from({ length: 3 }, () => ({ accountId: 'USD_ONLY-0', currency: 'USD' })));
    assert.ok(f.output.some(line => line.includes('Workload currencies: USD (existing matching accounts only)')));
  });
}

test('workload eligibility excludes unsupported currencies and accounts without Oracle profiles', async () => {
  const f = fixture('SCOPED', ['AUD', 'USD', 'GBP', 'EUR']);
  const oracle = { execute: async () => ({ rows: [[1, 'P1'], [3, 'P3'], [4, 'P4']] }) };
  const records = await createRealtimeService(f.settings).loadWorkloadRecords(f.db2, oracle);
  assert.deepEqual(records.map(row => [row.accountId, row.currency]), [['SCOPED-0', 'AUD'], ['SCOPED-2', 'GBP']]);
  const unsupported = fixture('UNSUPPORTED', ['EUR']);
  await assert.rejects(createRealtimeService(unsupported.settings).loadWorkloadRecords(unsupported.db2, unsupported.oracle), /No active Db2 customer accounts in AUD, USD, or GBP/);
  assert.equal(unsupported.inserted.length, 0);
});

test('partner executions keep independent currency rotations and account/schema scopes', async () => {
  const first = await generate('local', 'FIRST', ['AUD', 'USD', 'GBP'], 3);
  const second = await generate('remote', 'SECOND', ['AUD', 'USD', 'GBP'], 3);
  assert.deepEqual(first.inserted.map(row => row.currency), ['AUD', 'USD', 'GBP']);
  assert.deepEqual(second.inserted.map(row => row.currency), ['AUD', 'USD', 'GBP']);
  assert.ok(first.inserted.every(row => row.accountId.startsWith('FIRST-')));
  assert.ok(second.inserted.every(row => row.accountId.startsWith('SECOND-')));
});
