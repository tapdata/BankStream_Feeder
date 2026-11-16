'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripVTControlCharacters } = require('node:util');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { compare } = require('../src/tapdata-api-verification');
const { printVerification, runVerification } = require('../src/verification');

const footer = [
  'This is a demo end-to-end check (source DB vs published API).',
  'In-pipeline data validation is a separate TapData product capability.'
];
function fixture() {
  const source = { customerId: '100007', customerName: 'Sophia Walker', accountId: 'AC1000071', currency: 'USD',
    balance: '35466.0000', availableBalance: '35466.0000', transactionValid: true,
    transaction: { id: 'RT-cdafe133-61f4-405a-a75a-b278e403381e', amount: '4534.0000', currency: 'USD',
      type: 'WITHDRAWAL', stage: 'POSTED', status: 'COMPLETED', timestamp: '2026-11-13T15:54:43.771901' },
    kyc: { customerId: '100007', status: 'REVIEW_REQUIRED', riskRating: 'HIGH' } };
  source.latestTransactionId = source.transaction.id;
  const account = { BALANCE: '35466', AVAILABLE_BALANCE: '35466', CURRENCY: 'USD', ACCOUNT_TRANSACTION: [{
    TRANSACTION_ID: source.transaction.id, TRANSACTION_AMOUNT: '4534', CURRENCY: 'USD', TRANSACTION_TYPE: 'WITHDRAWAL',
    TRANSACTION_STAGE: 'POSTED', TRANSACTION_STATUS: 'COMPLETED'
  }] };
  const customer = { CUSTOMER_ID: source.customerId, CUSTOMER_NAME: source.customerName,
    ACCOUNT_CUSTOMER_RELATIONSHIP: [{ ACCOUNT_ID: source.accountId, ACCOUNT: account }] };
  const kyc = [{ CUSTOMER_ID: source.customerId, KYC_STATUS: source.kyc.status, RISK_RATING: source.kyc.riskRating }];
  const comparisons = compare(source, { core: { customer, relationship: customer.ACCOUNT_CUSTOMER_RELATIONSHIP[0], account }, kyc });
  return { source, customer, kyc, report: { passed: true,
    api: { passed: true, source, result: { passed: true, comparisons, attempts: 1, timedOut: false, transactionId: source.transaction.id } } } };
}
function capture(report) {
  const lines = [], original = console.log;
  console.log = value => lines.push(String(value));
  try { printVerification(report); } finally { console.log = original; }
  return lines;
}
function summary(lines, label, expected) {
  assert.match(lines.map(stripVTControlCharacters).join('\n'), new RegExp('^  ' + label + '\\s+: ' + expected + '$', 'm'));
}
function assertFooter(lines) { assert.deepEqual(lines.slice(-2).map(stripVTControlCharacters), footer); }
function displayWidth(line) {
  return [...stripVTControlCharacters(line)].reduce((width, char) => width + (/[\u4e00-\u9fff]/.test(char) ? 2 : 1), 0);
}

test('verification renders ordered comparison sections, all fields, dynamic IDs and footer without mutation', () => {
  const { report, source } = fixture(), before = structuredClone(report);
  const lines = capture(report), output = lines.join('\n');
  const headings = ['ACCOUNT COMPARISON (AS400 vs TapData API)', 'KYC COMPARISON (Oracle vs TapData API)',
    'TRANSACTION COMPARISON (AS400 vs TapData API)'];
  assert.ok(lines.indexOf(headings[0]) < lines.indexOf(headings[1]));
  assert.ok(lines.indexOf(headings[1]) < lines.indexOf(headings[2]));
  assert.ok(output.includes('Customer : ' + source.customerId + ' · ' + source.customerName));
  assert.ok(output.includes('Account  : ' + source.accountId + ' · USD'));
  for (const field of ['Customer ID', 'Account ID', 'Balance', 'Available balance', 'KYC status', 'Risk rating',
    'Transaction ID', 'Amount', 'Currency', 'Type', 'Stage', 'Status']) assert.ok(lines.some(line => line.startsWith(field)));
  assert.ok(output.includes('Source DB   : ' + source.transaction.id));
  assert.ok(output.includes('TapData API : ' + source.transaction.id));
  for (const label of ['Account verification', 'KYC verification', 'Transaction verification', 'Overall status']) summary(lines, label, 'PASS');
  assertFooter(lines);
  assert.deepEqual(report, before);
  assert.ok(lines.every(line => displayWidth(line) <= 100));
});

for (const [group, field, label] of [['Account', 'Balance', 'Account verification'], ['KYC', 'KYC Status', 'KYC verification'],
  ['Transaction', 'Amount', 'Transaction verification']]) {
  test(group + ' mismatch remains visible and fails both its section and overall result', () => {
    const { report } = fixture();
    const row = report.api.result.comparisons.find(row => row.group === group && row.field === field);
    row.api = group === 'KYC' ? 'PENDING' : '8'; row.passed = false;
    report.passed = report.api.passed = report.api.result.passed = false;
    const before = structuredClone(report), lines = capture(report);
    const display = lines.find(line => line.startsWith(field === 'KYC Status' ? 'KYC status' : field));
    assert.ok(display.includes(group === 'KYC' ? 'PENDING' : '8.00'));
    assert.match(display, /FAIL$/);
    summary(lines, label, 'FAIL'); summary(lines, 'Overall status', 'FAIL');
    assertFooter(lines); assert.deepEqual(report, before);
  });
}

test('long IDs remain complete below the table and differing suffixes cannot be hidden', () => {
  const { report } = fixture();
  const sourceId = 'RT-' + 'a'.repeat(252) + 'X', apiId = sourceId.slice(0, -1) + 'Y';
  const row = report.api.result.comparisons.find(row => row.field === 'Transaction ID');
  Object.assign(row, { source: sourceId, api: apiId, passed: false });
  report.passed = report.api.passed = report.api.result.passed = false;
  const lines = capture(report), idRow = lines.find(line => line.startsWith('Transaction ID'));
  assert.ok(idRow.includes('...')); assert.match(idRow, /FAIL$/);
  const full = lines.slice(lines.indexOf('Full transaction IDs:') + 1, lines.indexOf('OVERALL RESULT')).join('').replace(/\s/g, '');
  assert.ok(full.includes(sourceId)); assert.ok(full.includes(apiId));
  assert.ok(lines.every(line => displayWidth(line) <= 100));
  summary(lines, 'Transaction verification', 'FAIL');
});

test('monetary display preserves sub-cent mismatch evidence and large exact values', () => {
  const { report } = fixture();
  const rows = report.api.result.comparisons;
  Object.assign(rows.find(row => row.field === 'Amount'), { source: '1.0001', api: '1.0002', passed: false });
  Object.assign(rows.find(row => row.field === 'Balance'), { source: '9007199254740993.0100', api: '9007199254740993.01' });
  report.passed = report.api.passed = report.api.result.passed = false;
  const lines = capture(report), output = lines.join('\n');
  assert.match(output, /Raw source : 1\.0001/); assert.match(output, /Raw API    : 1\.0002/);
  assert.ok(output.includes('9007199254740993.01'));
  summary(lines, 'Overall status', 'FAIL');
});

test('missing API data is unavailable rather than PASS and the failure footer is still displayed', () => {
  const { report } = fixture();
  report.passed = report.api.passed = false;
  delete report.api.result;
  report.api.error = 'TapData authentication failed with HTTP 401';
  const lines = capture(report);
  for (const label of ['Account verification', 'KYC verification', 'Transaction verification']) summary(lines, label, 'UNAVAILABLE');
  summary(lines, 'Overall status', 'FAIL');
  assert.ok(lines.join('\n').includes(report.api.error)); assertFooter(lines);
});

test('incomplete comparison payloads cannot display a misleading overall or API PASS', () => {
  const { report } = fixture();
  report.api.result.comparisons = [];
  const lines = capture(report);
  summary(lines, 'Overall status', 'UNAVAILABLE');
  summary(lines, 'API verification', 'UNAVAILABLE');
  for (const label of ['Account verification', 'KYC verification', 'Transaction verification']) summary(lines, label, 'UNAVAILABLE');
  assertFooter(lines);
});

test('caught source errors retain component attribution without leaking configured secrets', async () => {
  for (const source of ['AS400', 'Oracle']) {
    const failure = new Error('simulated source unavailable');
    const report = await runVerification({
      service: { readApiVerificationSources: async (db2, oracle) => source === 'AS400' ? db2.query('fixture') : oracle.execute('fixture') },
      withDb2: async action => action({ query: async () => { throw failure; } }),
      withOracle: async action => action({ execute: async () => { throw failure; } }), env: {}
    }, { stage: 'api' });
    assert.equal(report.passed, false); assert.equal(report.api.sourceSystem, source);
    assert.ok(capture(report).join('\n').includes(source + ' verification detail: simulated source unavailable'));
  }
  const previous = process.env.DEMO_API_TOKEN;
  process.env.DEMO_API_TOKEN = 'fixture-sensitive-value';
  try {
    const report = { passed: false, api: { passed: false, error: 'Authentication rejected fixture-sensitive-value' } };
    const lines = capture(report);
    assert.ok(!lines.join('\n').includes('fixture-sensitive-value'));
    assert.ok(lines.join('\n').includes('[redacted]'));
    assert.equal(report.api.error, 'Authentication rejected fixture-sensitive-value');
    assertFooter(lines);
  } finally { if (previous === undefined) delete process.env.DEMO_API_TOKEN; else process.env.DEMO_API_TOKEN = previous; }
});

test('source KYC demo-state failure is preserved even when every API comparison passes', () => {
  const { report } = fixture();
  report.kyc = { customerId: '100007', status: 'VERIFIED', riskRating: 'MEDIUM', retrieved: true,
    expectedState: 'unexpected state', passed: false };
  report.passed = false;
  const lines = capture(report);
  assert.match(lines.join('\n'), /Expected demo state: unexpected state/);
  assert.match(lines.join('\n'), /Oracle KYC demo-state verification: FAIL/);
  summary(lines, 'KYC verification', 'FAIL'); summary(lines, 'Overall status', 'FAIL'); assertFooter(lines);
});

test('unselected stages are SKIPPED and additional failure comparisons are retained', () => {
  const lines = capture({ passed: true, kyc: { customerId: '100007', status: 'VERIFIED', riskRating: 'LOW',
    retrieved: true, expectedState: 'fixed demo baseline', passed: true } });
  summary(lines, 'Account verification', 'SKIPPED'); summary(lines, 'Transaction verification', 'SKIPPED');
  summary(lines, 'KYC verification', 'PASS'); summary(lines, 'Overall status', 'PASS'); assertFooter(lines);
  const { report } = fixture();
  report.api.result.comparisons.push({ group: 'Transaction', field: 'Latest transaction remained stable', source: 'RT-old', api: 'RT-new', passed: false });
  report.api.result.comparisons.push({ group: 'Additional', field: 'Extra check', source: 'actual', api: 'different', passed: false });
  report.passed = report.api.passed = report.api.result.passed = false;
  report.api.result.timedOut = true; report.api.result.attempts = 7;
  const failed = capture(report);
  assert.ok(failed.some(line => line.startsWith('Latest transaction remained')));
  assert.ok(failed.includes('ADDITIONAL COMPARISON'));
  assert.match(failed.join('\n'), /CDC comparison timed out after 7 attempt\(s\)/);
  summary(failed, 'Overall status', 'FAIL'); assertFooter(failed);
});

test('TTY colors, NO_COLOR, redirected output and Unicode width follow the shared theme', () => {
  const { report } = fixture(); report.api.source.customerName = '客户'.repeat(60);
  report.api.result.comparisons[0].source = '客户'.repeat(60);
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const previous = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM, FORCE_COLOR: process.env.FORCE_COLOR };
  try {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete process.env.NO_COLOR; process.env.TERM = 'xterm';
    const tty = capture(report); assert.ok(tty.some(line => /\x1b\[/.test(line)));
    assert.ok(tty.every(line => displayWidth(line) <= 100));
    process.env.NO_COLOR = ''; assert.ok(capture(report).every(line => !/\x1b\[/.test(line)));
    delete process.env.NO_COLOR; Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    process.env.FORCE_COLOR = '1'; assert.ok(capture(report).every(line => !/\x1b\[/.test(line)));
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor); else delete process.stdout.isTTY;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

function cli(mode, stage, failed = false, extraEnv = {}) {
  const { source, customer, kyc, report } = fixture();
  const sourceAccount = { CUSTOMER_ID: source.customerId, CUSTOMER_NAME: source.customerName, ACCOUNT_ID: source.accountId,
    CURRENCY: source.currency, BALANCE: source.balance, AVAILABLE_BALANCE: source.availableBalance };
  const transaction = { passed: true, selectedBy: 'latest posted completed withdrawal', relationshipValid: true,
    transactionValid: true, stableSelection: true, stableAccount: true, account: sourceAccount,
    transaction: { TRANSACTION_ID: source.transaction.id, TRANSACTION_TIMESTAMP: source.transaction.timestamp } };
  const kycCheck = { ...source.kyc, retrieved: true, expectedState: 'demo updated state', passed: true };
  if (failed) {
    customer.ACCOUNT_CUSTOMER_RELATIONSHIP[0].ACCOUNT.BALANCE = '8';
    Object.assign(report.api.result.comparisons.find(row => row.field === 'Balance'), { api: '8', passed: false });
    report.passed = report.api.passed = report.api.result.passed = false;
    report.api.result.timedOut = true;
  }
  if (!stage) Object.assign(report, { transaction, kyc: kycCheck });
  const script = `
    const Module = require('node:module'); const load = Module._load;
    const source = ${JSON.stringify(source)}, report = ${JSON.stringify(report)};
    Module._load = function(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === './remote-https') return { createHttpsFetch: () => globalThis.fetch };
      if (${JSON.stringify(mode)} === 'remote' && ['./config','./db','oracledb','odbc'].includes(name)) throw Error('FORBIDDEN DATABASE IMPORT');
      if (name === './config') return { config: { db2: {}, oracle: {} } };
      if (name === './db') return { connectDb2: async () => ({close:async()=>{}}), connectOracle:async()=>({close:async()=>{}}) };
      if (${JSON.stringify(mode)} === 'local' && name === './customer360-demo') return { DEFAULTS: {}, createDemoService: options => {
        if (options.customerId !== source.customerId || options.accountId !== source.accountId) throw Error('Incorrect configured assignment');
        return { verifyTransaction: async()=>(${JSON.stringify(transaction)}), verifyKyc:async()=>(${JSON.stringify(kycCheck)}),
          readApiVerificationSources:async()=>source };
      }};
      return load.apply(this, arguments);
    };
    globalThis.fetch = async (url, options) => {
      if (url.pathname === '/api/demo/verify') {
        const body = JSON.parse(options.body);
        if (JSON.stringify(body) !== ${JSON.stringify(JSON.stringify(stage ? { stage } : {}))}) throw Error('Verification flags changed');
        return {ok:true,status:200,json:async()=>({version:1,exitCode:${failed ? 1 : 0},result:report})};
      }
      if (options.headers.authorization !== 'Bearer fixture-api-token') throw Error('API authorization changed');
      return {ok:true,status:200,json:async()=>({data:url.pathname.endsWith('CUSTOMER_KYC')?${JSON.stringify(kyc)}:[${JSON.stringify(customer)}]})};
    };
    process.argv=[process.execPath,'demo-cli.js','verify',...${JSON.stringify(stage ? ['--stage', stage] : [])}];
    require(${JSON.stringify(path.resolve(__dirname, '../src/demo-cli.js'))});
  `;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(FEEDER_|DEMO_|DB2I_|ORACLE_|TAPDATA_)/.test(key)) delete env[key];
  Object.assign(env, { FEEDER_MODE: mode, DEMO_CUSTOMER_ID: source.customerId, DEMO_ACCOUNT_ID: source.accountId,
    DEMO_API_URL: 'https://control.test', DEMO_API_TOKEN: 'fixture-control-token',
    TAPDATA_API_BASE_URL: 'https://api.test', TAPDATA_ACCESS_TOKEN: 'fixture-api-token', DEMO_API_CDC_TIMEOUT_MS: '0' }, extraEnv);
  return spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 10000 });
}

test('remote verification displays the service assignment rather than local customer/account overrides', () => {
  const remote = cli('remote', 'api', false, { DEMO_CUSTOMER_ID: '999999', DEMO_ACCOUNT_ID: 'WRONG-CLI-ACCOUNT' });
  assert.equal(remote.status, 0, remote.stderr);
  assert.match(remote.stdout, /Customer : 100007 · Sophia Walker/);
  assert.match(remote.stdout, /Account  : AC1000071 · USD/);
  assert.doesNotMatch(remote.stdout, /999999|WRONG-CLI-ACCOUNT/);
});
for (const stage of [undefined, 'api']) for (const failed of [false, true]) {
  test('local/remote CLI parity and exit codes: ' + (stage || 'combined') + ', failed=' + failed, () => {
    const local = cli('local', stage, failed), remote = cli('remote', stage, failed);
    assert.equal(local.status, failed ? 1 : 0, local.stderr);
    assert.equal(remote.status, failed ? 1 : 0, remote.stderr);
    assert.equal(local.stdout, remote.stdout);
    assert.match(local.stdout, /Customer : 100007 · Sophia Walker/);
    assert.match(local.stdout, /Account  : AC1000071 · USD/);
    assert.match(local.stdout, new RegExp('Overall status\\s+: ' + (failed ? 'FAIL' : 'PASS')));
    for (const sentence of footer) assert.ok(local.stdout.includes(sentence));
  });
}
