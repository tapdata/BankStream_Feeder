'use strict';
const { line, style, visibleWidth } = require('./withdrawal-output');
const { databaseMoneyToMinorUnits, formatMinorUnits } = require('./demo-amount');
const { transactionTimeUtc } = require('./transaction-time');
const text = value => value == null || String(value).trim() === '' ? 'Unavailable' : String(value).trim()
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
function money(value) {
  try { return formatMinorUnits(databaseMoneyToMinorUnits(value)); }
  catch { return 'Unavailable'; }
}
function wrap(value, width) {
  const parts = [], chars = Array.from(text(value));
  while (chars.length) {
    let count = 0, used = 0;
    while (count < chars.length && used + visibleWidth(chars[count]) <= width) used += visibleWidth(chars[count++]);
    parts.push(chars.splice(0, count).join(''));
  }
  return parts.length ? parts : [''];
}
function table(headers, rows, limits, colors) {
  const widths = headers.map((header, index) => Math.min(limits[index],
    Math.max(visibleWidth(header), ...rows.map(row => visibleWidth(text(row[index]))))));
  const print = (row, heading = false) => {
    const cells = row.map((value, index) => wrap(value, widths[index]));
    for (let part = 0; part < Math.max(...cells.map(cell => cell.length)); part++) {
      console.log('  ' + cells.map((cell, index) => {
        const value = cell[part] || '';
        return style(value + (index === cells.length - 1 ? '' : ' '.repeat(widths[index] - visibleWidth(value))),
          heading ? 'info' : colors?.(row, index) || 'info');
      }).join('  ').trimEnd());
    }
  };
  print(headers, true); rows.forEach(row => print(row));
}
function timestamp(value) {
  if (value == null || String(value).trim() === '') return 'Unavailable';
  const utc = transactionTimeUtc(value);
  return /^\d{4}-\d{2}-\d{2}T/.test(utc) && utc.endsWith('Z') ? utc.slice(0, -1).replace('T', ' ') : text(value);
}
function render(result) {
  const customer = result?.customer || {}, kyc = result?.kyc || [], transactions = result?.transactions;
  line('==================== BANKING DEMO STATUS ====================', 'title'); line();
  line('Customer : ' + text(customer.CUSTOMER_ID) + ' · ' + text(customer.CUSTOMER_NAME));
  line('Account  : ' + text(customer.ACCOUNT_ID) + ' · ' + text(customer.CURRENCY));
  line(); line('ACCOUNT (AS400)', 'step');
  const account = [['Account ID', text(customer.ACCOUNT_ID)], ['Account status', text(customer.ACCOUNT_STATUS)],
    ['Currency', text(customer.CURRENCY)], ['Balance', money(customer.BALANCE)],
    ['Available balance', money(customer.AVAILABLE_BALANCE)]];
  table(['FIELD', 'VALUE'], account, [20, 76], (row, index) => index === 1 && /balance/i.test(row[0]) && row[1] !== 'Unavailable' ? 'success' : 'info');
  line(); line('KYC (Oracle)', 'step');
  table(['FIELD', 'VALUE'], [['KYC status', text(kyc[2])], ['Risk rating', kyc[3] == null ? 'N/A' : text(kyc[3])]],
    [20, 76], (row, index) => index === 1 ? row[0] === 'Risk rating' && row[1].toUpperCase() === 'HIGH' ? 'value' : 'keyword' : 'info');
  line(); line('RECENT TRANSACTIONS (AS400)', 'step');
  if (!Array.isArray(transactions)) line('Recent transactions unavailable.', 'error');
  else if (!transactions.length) line('No recent transactions found.');
  else {
    // Preserve the existing order and original IDs; shortening applies only to terminal cells.
    const rows = transactions.map(row => {
      const id = text(row?.TRANSACTION_ID);
      const shortId = visibleWidth(id) > 24 ? wrap(id, 21)[0] + '...' : id;
      return [timestamp(row?.TRANSACTION_TIMESTAMP), shortId, text(row?.TRANSACTION_TYPE),
        money(row?.TRANSACTION_AMOUNT) + ' ' + text(row?.CURRENCY), text(row?.TRANSACTION_STATUS)];
    });
    table(['TIME (UTC)', 'TRANSACTION ID', 'TYPE', 'AMOUNT', 'STATUS'], rows, [23, 24, 12, 18, 13], (row, index) =>
      index === 4 ? row[4].toUpperCase() === 'COMPLETED' ? 'success'
        : /FAIL|REJECT|DECLIN|ERROR/.test(row[4].toUpperCase()) ? 'error' : 'info' : 'info');
  }
  const missing = [];
  if (account.some(row => row[1] === 'Unavailable') || !Array.isArray(transactions)) missing.push('AS400');
  if (kyc[2] == null || String(kyc[2]).trim() === '') missing.push('Oracle');
  line();
  if (missing.length) { line('Status incomplete: required ' + missing.join(' and ') + ' data is unavailable.', 'error'); return false; }
  line('Status retrieved successfully.', 'success');
  return true;
}
function mark(error, source) { if (!error.sourceSystem) error.sourceSystem = source; return error; }
async function withSource(connect, source, action, loading = (_message, operation) => operation()) {
  let connection;
  try { connection = await loading('Connecting to ' + source + '...', connect); } catch (error) { throw mark(error, source); }
  try { return await action(connection); }
  finally { try { await loading('Closing ' + source + ' connection...', () => connection.close()); } catch (error) { throw mark(error, source); } }
}
function failure(error, remote = false) {
  const source = ['AS400', 'Oracle'].includes(error.sourceSystem) ? error.sourceSystem : remote ? 'Remote service' : 'Source system';
  let message = String(error.message || 'Status unavailable');
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && /PASSWORD|SECRET|TOKEN|CONNECT_STRING|JDBC_URL/i.test(name)) message = message.split(secret).join('[redacted]');
  }
  if (/password|secret|token|connectionstring|jdbc:|\b(?:SELECT|UPDATE|INSERT|DELETE)\s/i.test(message) &&
      !message.startsWith('Demo Control Service authentication failed;')) message = 'Status retrieval failed; inspect operator diagnostics.';
  line(source + ': ' + message, 'error', '', console.error);
}
module.exports = { render, withSource, failure };
