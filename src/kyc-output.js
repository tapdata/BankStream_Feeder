'use strict';
const { line, style, visibleWidth } = require('./withdrawal-output');
const headings = { 1: 'Read the current KYC record', 2: 'Update the KYC status and risk rating', 3: 'Commit and verify' };
const text = value => value == null ? 'N/A' : String(value);
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

// Observe existing Oracle calls without issuing queries or changing their order or results.
async function observe(connection, action) {
  const events = [];
  let step = 1, commitAttempted = false, committed = false, target;
  const oracle = new Proxy(connection, { get(db, key) {
    if (!['execute', 'commit', 'rollback'].includes(key)) {
      const value = Reflect.get(db, key);
      return typeof value === 'function' ? value.bind(db) : value;
    }
    return async (...args) => {
      const event = { operation: key };
      if (key === 'execute') {
        const [sql, parameters = {}] = args;
        const table = sql.match(/\b([A-Za-z][\w$#]*\.CUSTOMER_KYC)\b/i)?.[1];
        step = /^UPDATE /.test(sql) ? 2 : committed ? 3 : 1;
        if (table) {
          event.table = table;
          event.customerId = String(parameters.customerId);
          if (/^UPDATE /.test(sql)) {
            target = { status: parameters.status, riskRating: parameters.risk };
            event.sqlSummary = ['UPDATE ' + table,
              '   SET KYC_STATUS = ' + quote(parameters.status) + ',',
              '       RISK_RATING = ' + quote(parameters.risk) + ', ...',
              ' WHERE CUSTOMER_ID = ' + quote(parameters.customerId) + ' AND ...'];
          } else event.sqlSummary = ['SELECT KYC_STATUS, RISK_RATING, ...', '  FROM ' + table,
            ' WHERE CUSTOMER_ID = ' + quote(parameters.customerId)];
        }
      } else if (key === 'commit') { step = 3; commitAttempted = true; }
      event.step = step;
      event.title = headings[step];
      events.push(event);
      try {
        const result = await db[key](...args);
        event.ok = true;
        if (key === 'execute' && /^UPDATE /.test(args[0])) {
          event.rowsAffected = Number.isFinite(result?.rowsAffected) ? result.rowsAffected : null;
        } else if (key === 'execute') {
          const rows = result?.rows || [];
          event.rowsReturned = rows.length;
          event.values = rows.map(row => ({ status: row[2], riskRating: row[3] ?? null }));
          if (committed) event.verified = rows.length === 1 && rows[0][2] === target?.status && (rows[0][3] ?? null) === target?.riskRating;
        } else if (key === 'commit') {
          committed = true;
          event.timestamp = new Date().toISOString();
        }
        return result;
      } catch (error) { event.ok = false; throw error; }
    };
  } });
  try {
    const result = await action(oracle);
    return events.length ? { ...result, execution: events } : result;
  }
  catch (error) {
    error.kycExecution = { events, failedStep: step, committed, commitAttempted,
      rolledBack: !commitAttempted && events.some(event => event.operation === 'rollback' && event.ok) };
    throw error;
  }
}

function execution(events, preview = false) {
  let step;
  for (const event of events || []) {
    if (!preview && event.step === 1 && event.ok !== false) continue;
    if (step !== event.step) { step = event.step; line(); line('STEP ' + step + '  ' + headings[step], 'step'); }
    if (Array.isArray(event.sqlSummary) && event.sqlSummary.length) {
      line('  SQL   ' + event.sqlSummary[0], 'sql');
      for (const part of event.sqlSummary.slice(1)) line(part, 'sql', '        ');
    }
    if (event.ok && 'rowsAffected' in event) line('  ->    ' + (event.rowsAffected === null
      ? 'Rows affected not reported by driver' : event.rowsAffected + (event.rowsAffected === 1 ? ' row updated' : ' rows updated')), 'success');
    if (event.ok && event.operation === 'commit') line('  ->    COMMIT successful', 'success');
    if (event.ok && event.operation === 'rollback') line('  ->    ROLLBACK completed', 'error');
    for (const row of event.values || []) {
      const verified = event.step === 3 && event.verified === true;
      line('  ->    KYC status' + (verified ? ' verified' : '') + ': ' + text(row.status), verified ? 'success' : 'info');
      line('  ->    Risk rating' + (verified ? ' verified' : '') + ': ' + text(row.riskRating), verified ? 'success' : 'info');
    }
    if (event.ok === false) line('  ->    Oracle operation failed.', 'error');
  }
}

function preview(current) {
  line('==================== COMPLIANCE KYC UPDATE ====================', 'title');
  line('Source system : CRM & KYC · Oracle');
  line('Customer      : ' + current.customerId + (current.customerName ? ' · ' + current.customerName : ''));
  line('SQL summaries omit technical details; they are not the full executed SQL.', 'hint');
  if (current.execution) execution(current.execution, true);
  else {
    line(); line('STEP 1  ' + headings[1], 'step');
    line('  SQL   Details unavailable from this service version.');
    line('  ->    KYC status: ' + text(current.status));
    line('  ->    Risk rating: ' + text(current.riskRating));
  }
}
function noUpdate() {
  line(); line('No update needed. Oracle already has REVIEW_REQUIRED / HIGH.', 'success');
  line('Run "npm run demo:reset" after the demo.', 'hint');
}
function result(value) {
  if (value.execution) execution(value.execution);
  else line('SQL execution details unavailable from this service version.');
  if (!value.changed) { noUpdate(); return; }
  line(); line('RESULT', 'title');
  line('Oracle KYC updated and read back successfully.', 'success');
  const rows = [['KYC status', text(value.previous.status), text(value.current.status)],
    ['Risk rating', text(value.previous.riskRating), text(value.current.riskRating)]];
  const width = Math.max(18, ...rows.map(row => visibleWidth(row[1])));
  line('  ' + 'FIELD'.padEnd(20) + ' ' + 'BEFORE'.padEnd(width) + ' AFTER');
  for (const [field, before, after] of rows) {
    const prefix = '  ' + field.padEnd(20) + ' ' + before + ' '.repeat(width - visibleWidth(before)) + ' ';
    if (visibleWidth(prefix + after) <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(before + after)) {
      console.log(style(prefix, 'info') + style(after, 'success'));
    } else { line(field + ' BEFORE: ' + before, 'info', '  '); line('AFTER: ' + after, 'success', '        '); }
  }
  line(); line('Written directly to Oracle. No TapData API or dashboard was called.', 'success');
  line('Next: switch to the dashboard. KYC changes on the same customer page within seconds.', 'hint');
}
function failure(detail) {
  if (detail) {
    execution(detail.events);
    line('STEP ' + detail.failedStep + '  ' + headings[detail.failedStep] + ' FAILED', 'error');
    if (detail.committed) line('Commit succeeded; subsequent verification failed. Operator reconciliation required.', 'error');
    else if (detail.rolledBack && !detail.commitAttempted) line('Rolled back. No changes were made.', 'error');
    else if (!detail.commitAttempted && !detail.events.some(event => event.step === 2)) line('No update was submitted.', 'error');
    else line('Rollback outcome is not guaranteed. Retain references for operator reconciliation.', 'error');
  } else line('KYC update failed; execution and rollback details are unavailable.', 'error');
}
function failureDetails(detail) {
  if (!detail || !headings[detail.failedStep] || !Array.isArray(detail.events) || detail.events.length > 16 ||
      !detail.events.every(event => event && headings[event.step] && ['execute', 'commit', 'rollback'].includes(event.operation) &&
        (event.sqlSummary === undefined || (Array.isArray(event.sqlSummary) && event.sqlSummary.length <= 10 &&
          event.sqlSummary.every(part => typeof part === 'string' && part.length <= 10000))) &&
        (event.values === undefined || (Array.isArray(event.values) && event.values.every(row => row && typeof row === 'object'))))) return null;
  return { events: detail.events, failedStep: detail.failedStep, committed: detail.committed === true,
    commitAttempted: detail.commitAttempted === true,
    rolledBack: detail.rolledBack === true && detail.commitAttempted === false &&
      detail.events.some(event => event.operation === 'rollback' && event.ok === true) };
}
module.exports = { observe, execution, preview, noUpdate, result, failure, failureDetails };
