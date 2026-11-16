require('dotenv').config();
const { createInterface } = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { getExecutionMode } = require('./execution-mode');
let config, connectDb2, connectOracle, service;
const { createDemoService, DEFAULTS } = require('./customer360-demo');
const { runVerification, parseVerificationArgs, printVerification } = require('./verification');
const { moneyToMinorUnits, databaseMoneyToMinorUnits, formatMinorUnits, validateAgainstAvailable } = require('./demo-amount');
const { isWithdrawalConfirmed } = require('./withdrawal-confirmation');

const DEMO_KYC_CUSTOMER_ID = process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId;

function initializeLocal() {
  ({ config } = require('./config'));
  ({ connectDb2, connectOracle } = require('./db'));
  service = createDemoService({
    db2Schema: config.db2.schema || 'BANKCORE',
    oracleSchema: config.oracle.schema,
    customerId: process.env.DEMO_CUSTOMER_ID || DEFAULTS.customerId,
    kycCustomerId: DEMO_KYC_CUSTOMER_ID,
    accountId: process.env.DEMO_ACCOUNT_ID || DEFAULTS.accountId,
    amount: process.env.DEMO_WITHDRAWAL_AMOUNT || DEFAULTS.amount,
    currency: process.env.DEMO_CURRENCY || DEFAULTS.currency
  });
}

async function ask(question) {
  if (!stdin.isTTY) throw new Error('Interactive input is required to enter and confirm a withdrawal amount');
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return await prompt.question(question); }
  finally { prompt.close(); }
}

async function confirmKyc(question) {
  const answer = (await ask(question)).trim().toLowerCase();
  return isWithdrawalConfirmed(answer);
}

async function confirmWithdrawal() {
  const answer = (await ask('Confirm withdrawal? (y/N): ')).trim().toLowerCase();
  if (isWithdrawalConfirmed(answer)) return true;
  if (answer === '' || answer === 'n' || answer === 'no') return false;
  console.log('Unrecognized response; withdrawal cancelled without changes.');
  return false;
}

async function withConnection(connect, action) {
  const connection = await connect();
  try { return await action(connection); }
  finally { await connection.close(); }
}

function printStatus(result) {
  if (!require('./status-output').render(result)) process.exitCode = 1;
}

async function runWithdrawal(account, submit) {
  const output = require('./withdrawal-output');
  output.header(account);
  output.line('SQL summaries below omit technical details; they are not the full executed SQL.', 'hint');
  if (account.execution) output.execution(account.execution, { preview: true, currency: account.currency });
  else {
    output.line('STEP 1  Read the current account balance (SQL details unavailable from service)', 'step');
    output.line(`  ->    Balance: ${formatMinorUnits(databaseMoneyToMinorUnits(account.balance))} ${account.currency}`);
    output.line(`  ->    Available: ${formatMinorUnits(databaseMoneyToMinorUnits(account.availableBalance))} ${account.currency}`);
  }
  if (!['AUD', 'USD', 'GBP'].includes(account.currency)) throw new Error(`Unsupported account currency: ${account.currency}`);
  if (account.accountStatus.toUpperCase() !== 'ACTIVE') throw new Error(`Account ${account.accountId} is not active`);
  const entered = (await ask(`Enter withdrawal amount in ${account.currency} (up to 2 decimal places): `)).trim();
  const amountCents = moneyToMinorUnits(entered, 'Withdrawal amount');
  validateAgainstAvailable(amountCents, account.availableBalance, account.currency);
  output.line(`Amount: ${formatMinorUnits(amountCents)} ${account.currency}`, 'amount');
  if (!(await confirmWithdrawal())) {
    console.log('Cancelled. No changes were made.');
    return;
  }
  let result;
  try { result = await submit(formatMinorUnits(amountCents)); }
  catch (error) {
    if (error.withdrawalExecution) {
      output.failure(error.withdrawalExecution);
    } else output.line('Withdrawal failed; execution details unavailable. Check the reported outcome.', 'error');
    throw error;
  }
  if (result.execution) output.execution(result.execution, { currency: result.currency });
  else output.line('SQL execution details unavailable from this service version.');
  output.summary(result);
}

async function runKyc(mode, adapter) {
  let initial;
  try { initial = await adapter.currentKyc(); }
  catch (error) {
    if (mode === 'kyc') require('./kyc-output').failure(error.kycExecution);
    throw error;
  }
  const previewCustomerId = initial.customerId;
  if (mode === 'kyc') {
    const output = require('./kyc-output');
    const preview = initial;
    output.preview(preview);
    if (preview.status === 'REVIEW_REQUIRED' && preview.riskRating === 'HIGH') {
      output.noUpdate();
      return;
    }
    if (!(await confirmKyc('Confirm KYC update? (y/N): '))) {
      console.log('Cancelled. No changes were made.');
      return;
    }
    let result;
    try { result = await adapter.setKyc(preview); }
    catch (error) { output.failure(error.kycExecution); throw error; }
    output.result(result);
    return;
  }
  if (mode === 'kyc:reset') {

    const current = initial;
    console.log(`Customer ${previewCustomerId} current KYC: ${current.status} / ${current.riskRating ?? 'N/A'}`);
    console.log('Demo reset target: VERIFIED / LOW.');
    if (current.status === 'VERIFIED' && current.riskRating === 'LOW') {
      console.log('No reset needed; Oracle already has the demo baseline.');
      return;
    }
    if (!(await confirmKyc('Confirm KYC reset? (y/N): '))) {
      console.log('KYC reset cancelled; no database changes were made.');
      return;
    }
    const reset = await adapter.resetKyc(current);
    const final = await adapter.finalKyc();
    const matches = final.status === 'VERIFIED' && final.riskRating === 'LOW';
    console.log(reset.changed ? `KYC reset ${matches ? 'PASS' : 'FAIL'}.` : `No reset needed (${matches ? 'PASS' : 'FAIL'}).`);
    console.log(`Final KYC: ${final.status} / ${final.riskRating ?? 'N/A'}`);
    if (!matches) process.exitCode = 1;
    return;
  }

}

async function main(mode) {
  if (getExecutionMode() === 'remote') {
    if (!['status', 'transaction', 'verify', 'kyc', 'kyc:reset'].includes(mode)) throw new Error('This command is not yet supported in remote mode');
    if (mode !== 'verify' && process.argv.length > 3) throw new Error(`Usage: npm run demo:${mode}`);
    const { createRemoteClient } = require('./remote-client');
    const client = createRemoteClient();
    if (mode === 'status') printStatus(await client.execute('status'));
    else if (mode === 'verify') {
      const report = await client.execute('verify', parseVerificationArgs(process.argv.slice(3)));
      printVerification(report);
      if (!report.passed) process.exitCode = 1;
    } else if (mode === 'kyc' || mode === 'kyc:reset') {
      let preview;
      try { preview = await client.execute('kycPreview'); }
      catch (error) {
        if (mode === 'kyc') require('./kyc-output').failure(error.kycExecution);
        throw error;
      }
      let result;
      await runKyc(mode, { currentKyc: async () => preview.kyc,
        setKyc: async () => client.execute('kyc', { previewId: preview.previewId, confirmed: true, idempotencyKey: require('node:crypto').randomUUID() }),
        resetKyc: async () => (result = await client.execute('kycReset', { previewId: preview.previewId, confirmed: true, idempotencyKey: require('node:crypto').randomUUID() })),
        finalKyc: async () => result.final
      });
    } else {
      const preview = await client.execute('transactionPreview');
      await runWithdrawal(preview.account, amount => client.execute('transaction', {
        amount, previewId: preview.previewId, confirmed: true,
        idempotencyKey: require('node:crypto').randomUUID()
      }));
    }
    return;
  }
  initializeLocal();
  if (mode === 'status') {
    const { withSource } = require('./status-output');
    await withSource(() => connectDb2(config), 'AS400', async db2 => {
      await withSource(() => connectOracle(config), 'Oracle', async oracle => printStatus(await service.status(db2, oracle, true)));
    });
    return;
  }
  if (mode === 'transaction') {
    await withConnection(() => connectDb2(config), async db2 => {
      try {
        const account = await service.readWithdrawalAccount(db2, true);
        await runWithdrawal(account, amount => service.transaction(db2, amount, true, account.currency));
      } catch (error) {
        throw error;
      }
    });
    return;
  }
  if (['kyc', 'kyc:reset'].includes(mode)) {
    await withConnection(() => connectOracle(config), oracle => runKyc(mode, {
      currentKyc: () => mode === 'kyc'
        ? require('./kyc-output').observe(oracle, connection => service.currentKyc(connection)) : service.currentKyc(oracle),
      setKyc: preview => require('./kyc-output').observe(oracle, connection => service.setKyc(connection, preview)),
      resetKyc: current => service.resetKyc(oracle, current), finalKyc: () => service.currentKyc(oracle)
    }));
    return;
  }
  if (mode === 'verify') {
    const { withSource } = require('./status-output');
    const report = await runVerification({ service, withDb2: action => withSource(() => connectDb2(config), 'AS400', action),
      withOracle: action => withSource(() => connectOracle(config), 'Oracle', action), env: process.env }, parseVerificationArgs(process.argv.slice(3)));
    printVerification(report);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  throw new Error('Usage: npm run demo:status | demo:transaction | demo:kyc | demo:kyc:reset | demo:verify -- --stage transaction|kyc|api [--transaction-id RT-...]');
}


main(process.argv[2]).catch(error => {
  if (process.argv[2] === 'status') require('./status-output').failure(error, process.env.FEEDER_MODE?.trim() === 'remote');
  else if (process.argv[2] === 'verify') require('./verification-output').failure(error);
  else if (['transaction', 'kyc'].includes(process.argv[2])) require('./withdrawal-output').errorMessage(error);
  else console.error(`Customer 360 demo failed: ${error.message}`);
  process.exitCode = 1;
});
