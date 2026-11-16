'use strict';
const { line, style, visibleWidth } = require('./withdrawal-output');
const { databaseMoneyToMinorUnits, formatMinorUnits } = require('./demo-amount');
const { RESET_BASELINE: baseline } = require('./demo-reset');
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const text = value => value == null ? 'N/A' : String(value);
function money(value) {
  try { return formatMinorUnits(databaseMoneyToMinorUnits(value)); }
  catch { return text(value); }
}
function safeError(value) {
  let message = String(value || 'Source reset or verification failed.');
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && /PASSWORD|SECRET|TOKEN|CONNECT_STRING|JDBC_URL/i.test(name)) message = message.split(secret).join('[redacted]');
  }
  return /password|secret|token|connectstring|connectionstring|jdbc:|\b(?:SELECT|UPDATE|INSERT|DELETE)\s/i.test(message)
    ? 'Source reset or verification failed; inspect operator diagnostics.' : message;
}

// Capture existing reset calls only. No SQL, transaction boundaries or driver results are changed.
function capture(connection, kind) {
  const detail = { events: [], commitAttempted: false, committed: false, rolledBack: false };
  const methods = kind === 'kyc' ? ['execute', 'commit', 'rollback'] : ['query', 'beginTransaction', 'commit', 'rollback'];
  const wrapped = new Proxy(connection, { get(db, key) {
    if (!methods.includes(key)) {
      const value = Reflect.get(db, key);
      return typeof value === 'function' ? value.bind(db) : value;
    }
    return async (...args) => {
      const event = { operation: key };
      if (key === 'query' || key === 'execute') {
        const [sql, p = kind === 'kyc' ? {} : []] = args;
        const table = sql.match(/\b([A-Za-z][\w$#]*\.(?:CUSTOMER_KYC|BANK_ACCOUNT))\b/i)?.[1];
        if (table) { event.table = table; event.schema = table.split('.')[0]; }
        event.update = /^UPDATE /.test(sql);
        event.lock = /FOR UPDATE$/.test(sql);
        if (kind === 'kyc') {
          event.customerId = String(p.customerId);
          if (event.update) event.targets = { status: p.status, riskRating: p.risk };
          event.sqlSummary = event.update ? ['UPDATE ' + table,
            '   SET KYC_STATUS = ' + quote(p.status) + ',', '       RISK_RATING = ' + quote(p.risk) + ', ...',
            ' WHERE CUSTOMER_ID = ' + quote(p.customerId) + ' AND ...'] : [];
        } else {
          event.accountId = String(event.update ? p[2] : event.lock ? p[0] : p[1]);
          if (event.update) event.targets = { balance: money(p[0]), availableBalance: money(p[1]) };
          event.sqlSummary = event.lock ? ['SELECT ... FROM ' + table,
            ' WHERE ACCOUNT_ID = ' + quote(p[0]) + ' FOR UPDATE'] : event.update ? ['UPDATE ' + table,
            '   SET BALANCE = ' + money(p[0]) + ',', '       AVAILABLE_BALANCE = ' + money(p[1]) + ', ...',
            ' WHERE ACCOUNT_ID = ' + quote(p[2])] : [];
        }
      }
      if (key === 'commit') detail.commitAttempted = true;
      detail.events.push(event);
      try {
        const result = await db[key](...args);
        event.ok = true;
        if (event.update) event.rowsAffected = kind === 'kyc'
          ? Number.isFinite(result?.rowsAffected) ? result.rowsAffected : null
          : Number.isFinite(result?.count) ? result.count : null;
        else if (key === 'query' || key === 'execute') {
          const rows = kind === 'kyc' ? result?.rows || [] : Array.isArray(result) ? result : [];
          event.rowsReturned = rows.length;
          event.values = kind === 'kyc' ? rows.map(row => ({ status: row[2], riskRating: row[3] ?? null }))
            : rows.filter(row => row.BALANCE !== undefined).map(row => ({ balance: String(row.BALANCE),
              availableBalance: String(row.AVAILABLE_BALANCE), ...(row.CURRENCY === undefined ? {} : { currency: String(row.CURRENCY).trim() }) }));
        }
        if (key === 'commit') { detail.committed = true; event.timestamp = new Date().toISOString(); }
        if (key === 'rollback') detail.rolledBack = !detail.commitAttempted;
        return result;
      } catch (error) { event.ok = false; throw error; }
    };
  } });
  return { connection: wrapped, detail };
}

function printer(log = console.log) {
  const print = (value = '', color = 'info', indent = '') => line(value, color, indent, log);
  function table(headers, rows, colors = []) {
    const widths = headers.map((header, index) => Math.max(visibleWidth(header), ...rows.map(row => visibleWidth(text(row[index])))));
    const render = (row, header = false) => {
      const cells = row.map((cell, index) => text(cell) + ' '.repeat(widths[index] - visibleWidth(text(cell))));
      const plain = '  ' + cells.join('  ').trimEnd();
      if (visibleWidth(plain) > 100 || /[\x00-\x1f\x7f-\x9f]/.test(plain)) {
        row.forEach((value, index) => print(headers[index] + ': ' + text(value), header ? 'info' : colors[index] || 'info', '  '));
      } else log('  ' + cells.map((cell, index) => style(index === cells.length - 1 ? cell.trimEnd() : cell,
        header ? 'info' : row.at(-1) === 'FAIL' && index >= 2 ? 'error' : index === cells.length - 1 && ['PASS', 'FAIL', 'SKIPPED'].includes(text(row[index]))
          ? row[index] === 'PASS' ? 'success' : row[index] === 'FAIL' ? 'error' : 'skipped' : colors[index] || 'info')).join('  '));
    };
    render(headers, true); rows.forEach(row => render(row));
  }
  function fields(current, operation) {
    const rows = [];
    if (operation !== 'account') rows.push(['Oracle', 'KYC status', text(current.kyc.status), baseline.status],
      ['Oracle', 'Risk rating', text(current.kyc.riskRating), baseline.riskRating]);
    if (operation !== 'kyc') rows.push(['AS400', 'Balance', money(current.account.balance), baseline.balance],
      ['AS400', 'Available balance', money(current.account.availableBalance), baseline.availableBalance]);
    return rows;
  }
  return {
    print,
    error(error) { print('Demo reset failed: ' + safeError(error.message), 'error'); },
    menu() {
      print('==================== RESET DEMO DATA ====================', 'title'); print();
      print('1. Reset KYC'); print('2. Reset Account Balances'); print('3. Reset Both'); print('4. Cancel'); print();
    },
    preview(current, operation) {
      print(); print('Customer ID: ' + (operation === 'kyc' ? current.kyc.customerId : current.account.customerId));
      if (operation !== 'kyc') print('Account ID: ' + current.account.accountId);
      print(); print('PREVIEW', 'title');
      table(['SYSTEM', 'FIELD', 'CURRENT', 'BASELINE'], fields(current, operation), ['info', 'info', 'info', 'value']);
    },
    execution(report, operation) {
      let step = 0;
      for (const kind of ['kyc', 'account']) {
        if ((kind === 'kyc' && operation === 'account') || (kind === 'account' && operation === 'kyc')) continue;
        const result = report[kind], detail = report.execution?.[kind];
        if (!result || (!result.changed && result.passed && !detail?.events?.some(event => event.update))) continue;
        step++; print(); print('STEP ' + step + '  ' + (kind === 'kyc' ? 'Restore customer KYC in Oracle' : 'Restore account balance in AS400'), 'step');
        if (!detail) { print('  SQL   Execution details unavailable from this service version.'); continue; }
        let shownSql = false;
        for (const event of detail.events) {
          if (event.sqlSummary?.length) {
            if (shownSql) print();
            shownSql = true;
            print('  SQL   ' + event.sqlSummary[0], 'sql');
            for (const part of event.sqlSummary.slice(1)) print(part, 'sql', '        ');
          }
          if (event.lock && event.ok) print('  ->    ' + event.rowsReturned + (event.rowsReturned === 1 ? ' row locked' : ' rows locked'), 'success');
          if (event.update && event.ok) print('  ->    ' + (event.rowsAffected === null ? 'Rows affected not reported by driver'
            : event.rowsAffected + (event.rowsAffected === 1 ? ' row updated' : ' rows updated')), 'success');
          if (event.operation === 'commit' && event.ok) print('  ->    COMMIT successful', 'success');
          if (event.operation === 'rollback' && event.ok) print('  ->    ROLLBACK completed', 'error');
          if (event.ok === false) print('  ->    Operation failed.', 'error');
        }
        if (result.passed) {
          if (kind === 'kyc') print('  ->    KYC verified: ' + result.status + ' / ' + text(result.riskRating), 'success');
          else {
            const currency = detail.events.flatMap(event => event.values || []).find(value => value.currency)?.currency;
            print('  ->    Balance verified: ' + money(result.balance) + (currency ? ' ' + currency : ''), 'success');
            print('  ->    Available balance verified: ' + money(result.availableBalance), 'success');
          }
        } else if (detail.committed) print('  ->    Commit completed; subsequent verification failed. Reconcile this database.', 'error');
        else if (detail.rolledBack && !detail.commitAttempted) print('  ->    Rolled back. No changes committed in this database.', 'error');
        else print('  ->    Commit/rollback outcome is not guaranteed. Reconciliation required.', 'error');
        if (!result.passed) {
          print('  ->    ' + safeError(result.error), 'error');
        }
      }
    },
    result(report, current, operation, nothing = false) {
      print(); print('RESULT', 'title');
      const rows = fields(current, operation).map(([system, field, before, target]) => {
        const kind = system === 'Oracle' ? 'kyc' : 'account', part = report[kind];
        const key = field === 'KYC status' ? 'status' : field === 'Risk rating' ? 'riskRating' : field === 'Balance' ? 'balance' : 'availableBalance';
        const final = part?.passed ? kind === 'kyc' ? text(part[key]) : money(part[key]) : 'NOT VERIFIED';
        return [system, field, final, !part?.passed ? 'FAIL' : before === target && final === target ? 'SKIPPED' : 'PASS'];
      });
      table(['SYSTEM', 'FIELD', 'AFTER RESET', 'CHECK'], rows, ['info', 'info', 'success', 'success']);
      print();
      if (nothing) print('Nothing to reset. Demo data is already at the baseline.', 'success');
      else if (report.passed) print('Demo data reset. Ready for the next demo.', 'success');
      else {
        print('Reset failed or partially completed. Each database commits separately.', 'error');
        print('Preserve references and reconcile failed or uncertain outcomes before retrying.', 'error');
      }
      print('Note: Transaction history is preserved.', 'hint');
    }
  };
}
module.exports = { capture, printer };
