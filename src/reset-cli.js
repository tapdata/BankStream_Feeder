'use strict';
require('dotenv').config();
const { createInterface } = require('node:readline/promises');
const { getExecutionMode } = require('./execution-mode');
const { createDemoReset } = require('./demo-reset');
const { createDemoService, DEFAULTS } = require('./customer360-demo');
const { isWithdrawalConfirmed } = require('./withdrawal-confirmation');
const { databaseMoneyToMinorUnits } = require('./demo-amount');

const choices = { '1': ['kyc', 'Reset KYC'], '2': ['account', 'Reset Account Balances'], '3': ['both', 'Reset Both'] };

async function runResetCommand({ preview, execute, ask, log = console.log }) {
  const output = require('./reset-output').printer(log);
  output.menu();
  let choice;
  while (true) {
    choice = String(await ask('Enter your choice (1-4): ')).trim();
    if (choice === '4') { output.print('Demo reset cancelled; no database changes were made.'); return; }
    if (choices[choice]) break;
    output.print('Invalid selection. Enter a number from 1 to 4.', 'error');
  }
  const [operation] = choices[choice];
  const current = await preview(operation);
  output.preview(current, operation);
  const needsKyc = operation !== 'account' && !(current.kyc.status === 'VERIFIED' && current.kyc.riskRating === 'LOW');
  const needsAccount = operation !== 'kyc' && !(databaseMoneyToMinorUnits(current.account.balance) === 4000000n &&
    databaseMoneyToMinorUnits(current.account.availableBalance) === 4000000n);
  if (!needsKyc && !needsAccount) {
    output.result({ passed: true, kyc: operation === 'account' ? undefined : { ...current.kyc, passed: true, changed: false },
      account: operation === 'kyc' ? undefined : { ...current.account, passed: true, changed: false } }, current, operation, true);
    return;
  }
  const resetOperation = needsKyc && needsAccount ? 'both' : needsKyc ? 'kyc' : 'account';
  output.print(`Will reset: ${[needsKyc ? 'KYC to VERIFIED / LOW' : null, needsAccount ? 'balance and available balance to 40000' : null].filter(Boolean).join('; ')}.`, 'value');
  if (!isWithdrawalConfirmed(String(await ask('Are you sure you want to continue? (y/N): ')).trim().toLowerCase())) {
    output.print('Cancelled. No changes were made.'); return;
  }
  let result;
  try { result = await execute(current, resetOperation); }
  catch (error) {
    output.print('Reset failed before execution details were returned. Do not assume either database rolled back.', 'error');
    throw error;
  }
  if (operation === 'both') {
    if (!needsKyc) result.kyc = { passed: true, changed: false, status: current.kyc.status, riskRating: current.kyc.riskRating };
    if (!needsAccount) result.account = { passed: true, changed: false, balance: current.account.balance, availableBalance: current.account.availableBalance };
  }
  output.execution(result, operation);
  output.result(result, current, operation);
  return result;
}

async function main() {
  if (process.argv.length > 2) throw new Error('Usage: npm run demo:reset');
  if (!process.stdin.isTTY) throw new Error('Interactive input is required to select and confirm a demo reset');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let adapter;
    const initialize = () => {
      if (adapter) return adapter;
      if (getExecutionMode() === 'remote') {
        const client = require('./remote-client').createRemoteClient();
        adapter = { preview: () => client.execute('resetPreview'), execute: (preview, operation) => client.execute('reset', {
          previewId: preview.previewId, operation, confirmed: true, idempotencyKey: require('node:crypto').randomUUID()
        }) };
      } else {
        const { config } = require('./config');
        const connections = require('./db');
        const settings = { db2Schema: config.db2.schema || 'BANKCORE', oracleSchema: config.oracle.schema,
          customerId: process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId,
          accountId: process.env.DEMO_ACCOUNT_ID || DEFAULTS.accountId };
        const service = createDemoService({ ...settings, kycCustomerId: settings.customerId });
        const withDb = kind => async action => {
          const connection = await connections[kind](config);
          try { return await action(connection); } finally { await connection.close(); }
        };
        const withDb2 = withDb('connectDb2'); const withOracle = withDb('connectOracle');
        adapter = { preview: async operation => ({
          account: { customerId: settings.customerId, accountId: settings.accountId },
          ...(operation !== 'account' ? { kyc: await withOracle(oracle => service.currentKyc(oracle)) } : {}),
          ...(operation !== 'kyc' ? { account: await withDb2(db2 => service.readWithdrawalAccount(db2)) } : {})
        }), execute: (_preview, operation) => createDemoReset(settings).run({ withDb2, withOracle }, operation, true) };
      }
      return adapter;
    };
    const report = await runResetCommand({ preview: operation => initialize().preview(operation),
      execute: (preview, operation) => initialize().execute(preview, operation), ask: question => prompt.question(question) });
    if (report && !report.passed) process.exitCode = 1;
  } finally { prompt.close(); }
}

if (require.main === module) main().catch(error => { require('./reset-output').printer(console.error).error(error); process.exitCode = 1; });
module.exports = { runResetCommand };
