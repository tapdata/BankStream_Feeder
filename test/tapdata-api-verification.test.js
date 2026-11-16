'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTapDataVerifier, compare, decimalUnits } = require('../src/tapdata-api-verification');

test('verification table displays money consistently without changing comparison values', () => {
  const comparisons = [
    { group: 'Account', field: 'Balance', source: '40000.0000', api: '40000', passed: true },
    { group: 'Account', field: 'Available Balance', source: '9007199254740993.0100', api: '9007199254740993.01', passed: true },
    { group: 'Transaction', field: 'Amount', source: '600.0000', api: '600', passed: true },
    { group: 'Transaction', field: 'Amount', source: '-2.5000', api: 'MISSING API FIELD/RECORD', passed: false }
  ];
  const before = JSON.stringify(comparisons);
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(line);
  try {
    require('../src/tapdata-api-verification').printReport({ passed: false, comparisons }, {});
  } finally { console.log = originalLog; }
  for (const value of ['40000.00', '9007199254740993.01', '600.00']) {
    assert.ok(lines.some(line => line.split(value).length === 3 && line.endsWith('PASS')));
  }
  assert.ok(lines.some(line => line.includes('-2.50') && line.includes('MISSING API FIELD/RECORD') && line.endsWith('FAIL')));
  assert.equal(JSON.stringify(comparisons), before);
});

test('verification table keeps API and result columns aligned with long transaction IDs', () => {
  const id = 'RT-13e93b4f-322f-444d-8264-67ed8a8f2a24';
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(line);
  try {
    require('../src/tapdata-api-verification').printReport({ passed: false, comparisons: [
      { group: 'transaction', field: 'Transaction ID', source: id, api: id, passed: true },
      { group: 'transaction', field: 'Currency', source: 'GBP', api: 'USD', passed: false }
    ] }, { customerId: '100002', accountId: 'AC1000021' });
  } finally { console.log = originalLog; }
  const section = lines.indexOf('TRANSACTION COMPARISON (AS400 vs TapData API)');
  const header = lines.slice(section).find(line => line.startsWith('FIELD'));
  const longRow = lines.find(line => line.startsWith('Transaction ID'));
  const shortRow = lines.find(line => line.startsWith('Currency'));
  const shortId = id.slice(0, 26) + '...';
  assert.equal(longRow.indexOf(shortId, longRow.indexOf(shortId) + shortId.length), header.indexOf('TAPDATA API'));
  assert.equal(shortRow.indexOf('USD'), header.indexOf('TAPDATA API'));
  assert.equal(longRow.lastIndexOf('PASS'), header.indexOf('RESULT'));
  assert.equal(shortRow.lastIndexOf('FAIL'), header.indexOf('RESULT'));
  assert.ok(lines.some(line => line.includes('Source DB   : ' + id)));
  assert.ok(lines.some(line => line.includes('TapData API : ' + id)));
  assert.ok(lines.every(line => line.length <= 100));
});

const source = {
  customerId: '100002', accountId: 'AC1000021', balance: 3381.32, availableBalance: 3281.32, currency: 'GBP',
  transaction: { id: 'RT-04a1932f-1234-4234-9234-123456789012', amount: 200, currency: 'GBP', type: 'WITHDRAWAL', stage: 'POSTED', status: 'COMPLETED' },
  kyc: { customerId: '100002', status: 'VERIFIED', riskRating: 'LOW' }
};

function payload({ omitTransaction = false, omitBalance = false, balance = 3381.32, transactionId = source.transaction.id, kycStatus = 'VERIFIED' } = {}) {
  const transactions = omitTransaction ? [] : [{
    TRANSACTION_ID: transactionId, TRANSACTION_AMOUNT: '200.0000', CURRENCY: 'GBP', TRANSACTION_TYPE: 'WITHDRAWAL',
    TRANSACTION_STAGE: 'POSTED', TRANSACTION_STATUS: 'COMPLETED'
  }];
  const account = { AVAILABLE_BALANCE: '3281.3200', CURRENCY: 'GBP', ACCOUNT_TRANSACTION: transactions };
  if (!omitBalance) account.BALANCE = String(balance);
  return {
    customers: { data: [{ CUSTOMER_ID: '100002', ACCOUNT_CUSTOMER_RELATIONSHIP: [{ ACCOUNT_ID: 'AC1000021', ACCOUNT: account }] }], count: 1 },
    kyc: { data: [{ CUSTOMER_ID: '100002', KYC_STATUS: kycStatus, RISK_RATING: 'LOW' }], count: 1 }
  };
}

function mockFetch(data, { authStatus, statuses } = {}) {
  const calls = [];
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname.includes('oauth')) return { ok: authStatus ? authStatus === 200 : true, status: authStatus || 200, json: async () => ({ access_token: 'test-bearer' }) };
    const status = statuses?.[url.pathname] || 200;
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const body = url.pathname.endsWith('/MDM_CUSTOMER360') ? data.customers : data.kyc;
    return { ok: true, status, json: async () => body };
  };
  return { fetch, calls };
}

function verifier(fetchImpl, overrides = {}) {
  let time = 0;
  const env = {
    TAPDATA_API_BASE_URL: 'https://tapdata.test', TAPDATA_ACCESS_TOKEN: 'mock-token',
    TAPDATA_COLLECTION_MAP: '{"CUSTOMER":"MDM_CUSTOMER360"}', TAPDATA_KYC_COLLECTION: 'CUSTOMER_KYC',
    TAPDATA_PAGE_SIZE: '100', TAPDATA_SCAN_LIMIT: '200', TAPDATA_REQUEST_TIMEOUT_MS: '1000',
    DEMO_API_CDC_RETRY_INTERVAL_MS: '10', DEMO_API_CDC_TIMEOUT_MS: '20', ...overrides
  };
  return createTapDataVerifier({ env, fetchImpl, now: () => time, sleep: async ms => { time += ms; } });
}

test('TapData API stage matches account, exact transaction ID, and separate KYC API values', async () => {
  const responses = payload();
  const mocked = mockFetch(responses);
  const result = await verifier(mocked.fetch).verify(source);
  assert.equal(result.passed, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.comparisons.length, 13);
  assert.ok(mocked.calls.some(call => call.url.pathname === '/api/v1/MDM_CUSTOMER360'));
  assert.ok(mocked.calls.some(call => call.url.pathname === '/api/v1/CUSTOMER_KYC'));
  assert.ok(mocked.calls.every(call => call.options.headers.authorization === 'Bearer mock-token'));
  assert.equal(mocked.calls[0].options.method, 'GET');
});

test('mismatched balances and KYC values fail while displaying actual API values', async () => {
  const mocked = mockFetch(payload({ balance: 8, kycStatus: 'PENDING' }));
  const result = await verifier(mocked.fetch, { DEMO_API_CDC_TIMEOUT_MS: '0' }).verify(source);
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.comparisons.find(item => item.field === 'Balance').api, '8');
  assert.equal(result.comparisons.find(item => item.field === 'KYC Status').api, 'PENDING');
});

test('missing exact transaction in API records fails comparison', () => {
  const api = payload({ omitTransaction: true });
  const core = api.customers.data[0];
  const relationship = core.ACCOUNT_CUSTOMER_RELATIONSHIP[0];
  const result = compare(source, { core: { customer: core, relationship, account: relationship.ACCOUNT }, kyc: api.kyc.data });
  assert.equal(result.find(item => item.field === 'Transaction ID').api, 'MISSING API FIELD/RECORD');
  assert.equal(result.find(item => item.field === 'Transaction ID').passed, false);
});

test('KYC API comparison selects the explicitly returned KYC customer independently from the account customer', () => {
  const sourceForOtherAccount = { ...source, customerId: '100011', accountId: 'AC1000111', kyc: { ...source.kyc, customerId: '100002' } };
  const api = payload();
  const core = api.customers.data[0];
  const relationship = core.ACCOUNT_CUSTOMER_RELATIONSHIP[0];
  const result = compare(sourceForOtherAccount, { core: { customer: core, relationship, account: relationship.ACCOUNT }, kyc: api.kyc.data });
  assert.equal(result.find(item => item.field === 'KYC Status').passed, true);
  assert.equal(result.find(item => item.field === 'Risk Rating').passed, true);
});

test('missing API fields are reported and never pass', async () => {
  const result = await verifier(mockFetch(payload({ omitBalance: true })).fetch, { DEMO_API_CDC_TIMEOUT_MS: '0' }).verify(source);
  const row = result.comparisons.find(item => item.field === 'Balance');
  assert.equal(row.api, 'MISSING API FIELD/RECORD');
  assert.equal(row.passed, false);
  assert.equal(result.passed, false);
});

test('TapData authentication errors fail clearly without leaking credentials', async () => {
  const fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const api = verifier(fetch, { TAPDATA_ACCESS_TOKEN: '', TAPDATA_TOKEN_URL: 'https://tapdata.test/oauth', TAPDATA_CLIENT_ID: 'id', TAPDATA_CLIENT_SECRET: 'secret' });
  const result = await api.verify(source);
  assert.equal(result.passed, false);
  assert.match(result.error, /authentication failed with HTTP 401/);
  assert.ok(result.comparisons.every(row => row.api === 'MISSING API FIELD/RECORD' || row.api === 'NOT APPLICABLE'));
});

test('CDC synchronization timeout returns a failed comparison after configured retries', async () => {
  const mocked = mockFetch(payload({ transactionId: 'RT-another-id' }));
  const result = await verifier(mocked.fetch).verify(source);
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.attempts, 3);
});

test('API verification reads fresh source values before and after each API comparison and pins the selected transaction', async () => {
  const mocked = mockFetch(payload());
  const reads = [];
  const result = await verifier(mocked.fetch).verify(async selectedId => {
    reads.push(selectedId);
    return { ...source, latestTransactionId: source.transaction.id };
  });
  assert.equal(result.passed, true);
  assert.deepEqual(reads, [null, source.transaction.id]);
  assert.equal(result.transactionId, source.transaction.id);
});

test('source changes during API retrieval are discarded and retried with refreshed values and the same transaction ID', async () => {
  let reads = 0;
  let customerApiCalls = 0;
  const fetchImpl = async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/MDM_CUSTOMER360')) {
      customerApiCalls++;
      const responseBalance = customerApiCalls === 1 ? 3381.32 : 3000;
      return { ok: true, status: 200, json: async () => payload({ balance: responseBalance }).customers };
    }
    return { ok: true, status: 200, json: async () => payload().kyc };
  };
  const result = await verifier(fetchImpl).verify(async selectedId => {
    reads++;
    const current = reads === 1 ? source : { ...source, balance: '3000.00' };
    return { ...current, latestTransactionId: source.transaction.id };
  });
  assert.equal(result.passed, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.transactionId, source.transaction.id);
  assert.equal(customerApiCalls, 2);
});

test('a newer latest transaction appearing mid-run fails clearly without silently switching IDs', async () => {
  const mocked = mockFetch(payload());
  let reads = 0;
  const newerId = 'RT-newer-transaction';
  const result = await verifier(mocked.fetch).verify(async selectedId => {
    reads++;
    return { ...source, transaction: { ...source.transaction, id: selectedId || source.transaction.id },
      latestTransactionId: reads === 1 ? source.transaction.id : newerId };
  });
  assert.equal(result.passed, false);
  assert.equal(result.sourceChanged, true);
  assert.equal(result.transactionId, source.transaction.id);
  assert.match(result.error, /No transaction was silently substituted/);
});

test('decimal comparison preserves exact precision without floating point arithmetic', () => {
  assert.equal(decimalUnits('200.0000'), decimalUnits(200));
  assert.equal(decimalUnits('3381.3200'), decimalUnits('3381.32'));
  assert.notEqual(decimalUnits('1.0001'), decimalUnits('1.0002'));
});
