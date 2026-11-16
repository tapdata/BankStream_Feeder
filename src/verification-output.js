'use strict';
const { line, style, visibleWidth } = require('./withdrawal-output');
const { decimalUnits } = require('./tapdata-api-verification');
const headings = [
  ['account', 'ACCOUNT COMPARISON (AS400 vs TapData API)', ['Customer ID', 'Account ID', 'Balance', 'Available Balance', 'Currency']],
  ['kyc', 'KYC COMPARISON (Oracle vs TapData API)', ['KYC Status', 'Risk Rating']],
  ['transaction', 'TRANSACTION COMPARISON (AS400 vs TapData API)', ['Transaction ID', 'Amount', 'Currency', 'Type', 'Stage', 'Status']]
];
const clean = value => value == null ? 'UNAVAILABLE' : String(value)
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const outcome = value => value === true ? 'PASS' : value === false ? 'FAIL' : 'UNAVAILABLE';
const color = value => value === 'PASS' ? 'success' : value === 'SKIPPED' ? 'skipped' : 'error';
const widths = [29, 29, 29, 6];
function chunks(value, width) {
  const chars = Array.from(clean(value)), parts = [];
  while (chars.length) {
    let count = 0, used = 0;
    while (count < chars.length && used + visibleWidth(chars[count]) <= width) used += visibleWidth(chars[count++]);
    parts.push(chars.splice(0, count).join(''));
  }
  return parts.length ? parts : [''];
}
function money(value) {
  const units = decimalUnits(value);
  if (units === null) return clean(value);
  const negative = units < 0n;
  const cents = ((negative ? -units : units) + 50n) / 100n;
  return (negative && cents !== 0n ? '-' : '') + cents / 100n + '.' + String(cents % 100n).padStart(2, '0');
}
function fieldName(value) {
  return ({ 'Available Balance': 'Available balance', 'KYC Status': 'KYC status', 'Risk Rating': 'Risk rating' })[value] || clean(value);
}
function shortId(value) {
  return visibleWidth(clean(value)) <= widths[1] ? clean(value) : chunks(value, widths[1] - 3)[0] + '...';
}
function tableRow(values, result, header = false) {
  const parts = values.map((value, index) => chunks(value, widths[index]));
  for (let index = 0; index < Math.max(...parts.map(part => part.length)); index++) {
    console.log(parts.map((part, column) => {
      const value = part[index] || '';
      const padded = column === widths.length - 1 ? value : value + ' '.repeat(widths[column] - visibleWidth(value));
      return style(padded, header ? 'keyword' : column === 3 ? color(result) : column === 0 && result === 'FAIL' ? 'error' : 'info');
    }).join('  '));
  }
}
function comparisons(rows) {
  tableRow(['FIELD', 'SOURCE DB', 'TAPDATA API', 'RESULT'], undefined, true);
  line('-'.repeat(widths.reduce((sum, width) => sum + width, 0) + 6));
  for (const row of rows) {
    const monetary = ['Balance', 'Available Balance', 'Amount'].includes(row.field);
    const source = monetary ? money(row.source) : clean(row.source);
    const api = monetary ? money(row.api) : clean(row.api);
    const id = row.field === 'Transaction ID';
    tableRow([fieldName(row.field), id ? shortId(source) : source, id ? shortId(api) : api, outcome(row.passed)], outcome(row.passed));
    // Two-decimal display must not conceal a difference detected at greater source precision.
    if (monetary && row.passed === false && source === api && clean(row.source) !== clean(row.api)) {
      fullValue('  Raw source : ', row.source, 'error');
      fullValue('  Raw API    : ', row.api, 'error');
    }
  }
}
function fullValue(label, value, tone = 'info') {
  const parts = chunks(value, 100 - visibleWidth(label));
  parts.forEach((part, index) => line((index ? ' '.repeat(visibleWidth(label)) : label) + part, tone));
}
function groupResult(rows, required, apiSelected) {
  if (!apiSelected) return 'SKIPPED';
  if (rows.some(row => row.passed === false)) return 'FAIL';
  if (required.some(field => !rows.some(row => row.field.toLowerCase() === field.toLowerCase())) ||
      rows.some(row => row.passed !== true)) return 'UNAVAILABLE';
  return 'PASS';
}
function sourceChecks(report) {
  if (!report.transaction && !report.kyc) return;
  line(); line('SOURCE CHECKS', 'step');
  const check = (label, value) => line('  ' + label + ': ' + outcome(value), color(outcome(value)));
  if (report.transaction) {
    const result = report.transaction;
    if (result.selectedBy) line('  Selected by: ' + clean(result.selectedBy));
    if (!result.transaction) line('  Source transaction: NOT FOUND', 'error');
    else if (result.transaction.TRANSACTION_TIMESTAMP) line('  Source transaction timestamp: ' + clean(result.transaction.TRANSACTION_TIMESTAMP));
    check('Customer/account relationship', result.relationshipValid);
    check('Completed posted withdrawal in account currency', result.transactionValid);
    if (result.selectedBy !== 'exact transaction ID') check('Latest transaction remained stable', result.stableSelection);
    if (result.account) line('  Current source balance: ' + money(result.account.BALANCE) + ' ' + clean(result.account.CURRENCY) +
      ' | available ' + money(result.account.AVAILABLE_BALANCE));
    else line('  Source account: NOT FOUND', 'error');
    check('Source account remained stable', result.stableAccount);
    check('Source transaction verification', result.passed);
  }
  if (report.kyc) {
    const result = report.kyc;
    line('  Oracle KYC customer ' + clean(result.customerId) + ': ' + clean(result.status) + ' / ' + clean(result.riskRating));
    check('Oracle KYC retrieved', result.retrieved);
    if (result.expectedState) line('  Expected demo state: ' + clean(result.expectedState));
    check('Oracle KYC demo-state verification', result.passed);
  }
}
function render(report) {
  const api = report.api, source = api?.source || {}, account = report.transaction?.account || {};
  const rows = Array.isArray(api?.result?.comparisons) ? api.result.comparisons : [];
  const customerId = source.customerId ?? account.CUSTOMER_ID ?? report.kyc?.customerId;
  const customerName = source.customerName ?? account.CUSTOMER_NAME;
  const accountId = source.accountId ?? account.ACCOUNT_ID;
  const currency = source.currency ?? account.CURRENCY;
  line('==================== DEMO DATA VERIFICATION ====================', 'title'); line();
  line('Customer : ' + clean(customerId) + (customerName ? ' · ' + clean(customerName) : ' (name unavailable)'));
  line('Account  : ' + clean(accountId) + (currency ? ' · ' + clean(currency) : ''));
  const states = {};
  for (const [key, heading, required] of headings) {
    const selected = rows.filter(row => String(row.group).toLowerCase() === key);
    line(); line(heading, 'step'); line();
    if (selected.length) comparisons(selected);
    else line(api ? 'Comparison data UNAVAILABLE.' : 'SKIPPED: API comparison was not selected.', api ? 'error' : 'skipped');
    states[key] = groupResult(selected, required, Boolean(api));
  }
  for (const group of [...new Set(rows.map(row => row.group))]) {
    if (headings.some(([key]) => key === String(group).toLowerCase())) continue;
    line(); line(clean(group).toUpperCase() + ' COMPARISON', 'step');
    comparisons(rows.filter(row => row.group === group));
  }
  const transactionId = rows.find(row => row.field === 'Transaction ID');
  const sourceId = transactionId?.source ?? source.transaction?.id ?? report.transaction?.transaction?.TRANSACTION_ID;
  line(); line('Full transaction IDs:', 'step');
  fullValue('  Source DB   : ', sourceId);
  fullValue('  TapData API : ', transactionId ? transactionId.api : api ? 'UNAVAILABLE' : 'NOT CHECKED');
  sourceChecks(report);
  if (api?.error || api?.result?.error) {
    line();
    line((api.sourceSystem || 'Source DB / TapData API') + ' verification detail: ' + safeError(api.error || api.result.error), 'error');
  }
  if (api?.result?.timedOut) line('CDC comparison timed out after ' + clean(api.result.attempts) + ' attempt(s).', 'error');
  for (const [key, value] of [['transaction', report.transaction], ['kyc', report.kyc]]) {
    if (!value) continue;
    if (value.passed === false) states[key] = 'FAIL';
    else if (value.passed === true && !api) states[key] = 'PASS';
    else if (value.passed !== true && states[key] !== 'FAIL') states[key] = 'UNAVAILABLE';
  }
  // Render the existing result. Never turn missing rows or contradictory failures into a displayed PASS.
  let overall = outcome(report.passed);
  if (rows.some(row => row.passed === false) || api?.result?.passed === false || Object.values(report).some(value => value && typeof value === 'object' && value.passed === false)) overall = 'FAIL';
  else if (api && overall === 'PASS' && (Object.values(states).some(state => state === 'UNAVAILABLE') || rows.some(row => row.passed !== true))) overall = 'UNAVAILABLE';
  line(); line('OVERALL RESULT', 'title'); line();
  for (const [key, label] of [['account', 'Account verification'], ['kyc', 'KYC verification'], ['transaction', 'Transaction verification']])
    line('  ' + label.padEnd(26) + ': ' + states[key], color(states[key]));
  if (api) {
    const apiOutcome = api.result?.passed === false || rows.some(row => row.passed === false) ? 'FAIL' : api.passed === true &&
      (headings.some(([key]) => states[key] === 'UNAVAILABLE') || rows.some(row => row.passed !== true)) ? 'UNAVAILABLE' : outcome(api.passed);
    line('  ' + 'API verification'.padEnd(26) + ': ' + apiOutcome, color(apiOutcome));
  }
  line('  ' + 'Overall status'.padEnd(26) + ': ' + overall, color(overall));
  line();
  line('This is a demo end-to-end check (source DB vs published API).', 'hint');
  line('In-pipeline data validation is a separate TapData product capability.', 'hint');
}
function connection(db, source) {
  if (!db) return db;
  return new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    if (!['query', 'execute'].includes(key)) return value.bind(target);
    return async (...args) => {
      try { return await value.apply(target, args); }
      catch (error) { error.sourceSystem = source; throw error; }
    };
  } });
}
function safeError(value) {
  let message = String(value || 'Verification unavailable');
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /PASSWORD|TOKEN|SECRET|CONNECT_STRING|JDBC_URL/i.test(name)) message = message.split(value).join('[redacted]');
  }
  if (/password|secret|connectionstring|jdbc:|\b(?:SELECT|UPDATE|INSERT|DELETE)\s/i.test(message)) message = 'Verification unavailable; inspect operator diagnostics.';
  return clean(message);
}
function failure(error) {
  line((error.sourceSystem || 'Source DB / TapData API') + ': ' + safeError(error.message), 'error', '', console.error);
}
module.exports = { render, connection, failure };
