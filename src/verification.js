'use strict';
const { createTapDataVerifier } = require('./tapdata-api-verification');

function validateVerificationOptions({ stage, transactionId } = {}) {
  if (stage !== undefined && !['transaction', 'kyc', 'api'].includes(stage)) throw new Error('Verification stage must be transaction, kyc, or api; combined verification is available without a stage');
  if (transactionId !== undefined && (typeof transactionId !== 'string' || !transactionId || transactionId.length > 256 || /[\r\n\0]/.test(transactionId))) throw new Error('Invalid transaction ID');
  if (transactionId && !['transaction', 'api'].includes(stage)) throw new Error('--transaction-id is supported with the transaction and api stages');
  return { stage, transactionId };
}
function parseVerificationArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stage' && args[i + 1]) options.stage = args[++i];
    else if (args[i] === '--transaction-id' && args[i + 1]) options.transactionId = args[++i];
    else throw new Error('Usage: npm run demo:verify -- --stage transaction|kyc|api [--transaction-id RT-...]');
  }
  return validateVerificationOptions(options);
}
async function runVerification({ service, withDb2, withOracle, env, fetchImpl }, options = {}) {
  const { stage, transactionId } = validateVerificationOptions(options);
  const report = {};
  async function run(db2, oracle) {
    const { connection } = require('./verification-output');
    db2 = connection(db2, 'AS400');
    oracle = connection(oracle, 'Oracle');
    if (!stage || stage === 'transaction') report.transaction = await service.verifyTransaction(db2, transactionId);
    if (!stage || stage === 'kyc') report.kyc = await service.verifyKyc(oracle);
    if (!stage || stage === 'api') {
      let source;
      try {
        const result = await createTapDataVerifier({ env, fetchImpl }).verify(async selectedId => {
          source = await service.readApiVerificationSources(db2, oracle,
            selectedId || transactionId || report.transaction?.transaction?.TRANSACTION_ID, { checkLatest: !transactionId });
          return source;
        }, { transactionId });
        report.api = { result, source, passed: result.passed };
      } catch (error) { report.api = { passed: false, error: error.message,
        ...(['AS400', 'Oracle'].includes(error.sourceSystem) ? { sourceSystem: error.sourceSystem } : {}) }; }
    }
  }
  if (stage === 'transaction') await withDb2(db => run(db));
  else if (stage === 'kyc') await withOracle(db => run(undefined, db));
  else await withDb2(db2 => withOracle(oracle => run(db2, oracle)));
  report.passed = Object.values(report).every(result => result.passed);
  return report;
}

function printVerification(report) {
  require('./verification-output').render(report);
}

module.exports = { runVerification, parseVerificationArgs, validateVerificationOptions, printVerification };
