'use strict';

function capture(connection) {
  const events = [];
  let step = 1;
  let commitAttempted = false;
  const db = new Proxy(connection, { get(target, key) {
    if (!['query', 'beginTransaction', 'commit', 'rollback'].includes(key)) return Reflect.get(target, key);
    return async (...args) => {
      if (key === 'query') {
        const sql = args[0];
        step = /FOR UPDATE$/.test(sql) ? 2 : /^INSERT /.test(sql) ? 3
          : /^UPDATE /.test(sql) ? 4 : /^SELECT (BALANCE|TRANSACTION_TIMESTAMP)/.test(sql) ? 5 : 1;
      }
      if (key === 'commit') { step = 5; commitAttempted = true; }
      const event = { step, title: headings[step], operation: key, ...(key === 'query' ? { sql: args[0], parameters: args[1] || [] } : {}) };
      events.push(event);
      try {
        const result = await target[key](...args);
        event.ok = true;
        if (key === 'query') {
          if (/^SELECT /.test(args[0])) event.rows = Array.isArray(result) ? result : [];
          else event.rowsAffected = Number.isFinite(result?.count) ? result.count : null;
        }
        if (key === 'commit') event.timestamp = new Date().toISOString();
        return result;
      } catch (error) {
        event.ok = false;
        error.withdrawalExecution = { events, failedStep: step, commitAttempted };
        throw error;
      }
    };
  } });
  return { db, events, failure(error) {
    error.withdrawalExecution = { events, failedStep: step, commitAttempted,
      rolledBack: !commitAttempted && events.some(e => e.operation === 'rollback' && e.ok) };
  } };
}

const theme = { title: '1;96', info: '37', step: '1;94', label: '1;33',
  keyword: '36', table: '97', value: '93', success: '1;92', amount: '1;93',
  error: '1;91', hint: '36;2', skipped: '2;33' };
const clean = value => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
function paint(text, style) {
  return process.stdout.isTTY && !Object.hasOwn(process.env, 'NO_COLOR') && process.env.TERM !== 'dumb'
    ? `\x1b[${theme[style] || theme.info}m${text}\x1b[0m` : text;
}
function sqlColor(text) {
  return text.replace(/'[^']*(?:''[^']*)*'|\b[A-Za-z][\w$#]*\.[A-Za-z][\w$#]*\b|\b(?:SQL|SELECT|FROM|JOIN|ON|WHERE|AND|OR|IS|NULL|NOT|FOR|UPDATE|INSERT|INTO|VALUES|SET|CAST|AS|DECIMAL|CURRENT_TIMESTAMP|CURRENT_DATE)\b|\?/g,
    token => paint(token, token === 'SQL' ? 'label' : token.startsWith("'") || token === '?' ? 'value' : token.includes('.') ? 'table' : 'keyword'));
}
function charWidth(char) {
  const code = char.codePointAt(0);
  if (/\p{Mark}/u.test(char) || code === 0x200d || code === 0xfe0f) return 0;
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) || code >= 0x20000) ? 2 : 1;
}
function line(value = '', style = 'info', indent = '', write = console.log) {
  let chars = Array.from(clean(value));
  do {
    const width = 100 - Array.from(indent).length;
    let count = 0, used = 0;
    while (count < chars.length && used + charWidth(chars[count]) <= width) used += charWidth(chars[count++]);
    if (count < chars.length) {
      const space = chars.slice(0, count + 1).lastIndexOf(' ');
      if (space > Math.floor(width / 2)) count = space;
    }
    const text = indent + chars.splice(0, count).join('');
    if (chars[0] === ' ') chars.shift();
    write(style === 'sql' ? sqlColor(text) : paint(text, style));
  } while (chars.length);
}
function header(account) {
  line('==================== SIMULATED BRANCH WITHDRAWAL ====================', 'title');
  line('Source system : Core banking · IBM DB2 for i (AS400)');
  line(`Customer      : ${account.customerId} · ${account.customerName}`);
  line(`Account       : ${account.accountId} · ${account.currency}`);
}
const headings = { 1: 'Read the current account balance', 2: 'Lock the account row',
  3: 'Insert the withdrawal transaction', 4: 'Deduct the withdrawal amount', 5: 'Verify and commit' };
// Abbreviated presentations only; executed SQL remains unchanged.
function sqlSummary(e) {
 if (Array.isArray(e.sqlSummary)) return e.sqlSummary;
 const p=e.parameters||[], sql=e.sql||'';
 const table=name=>sql.match(new RegExp('\\b([A-Za-z][\\w$#]*\\.'+name+')\\b','i'))?.[1];
 const a=table('BANK_ACCOUNT'), t=table('ACCOUNT_TRANSACTION');
 const q=v=>"'"+clean(v).replaceAll("'","''")+"'";
 if(e.step===1&&a)return ['SELECT BALANCE, AVAILABLE_BALANCE, ...','  FROM '+a+' ...',' WHERE ACCOUNT_ID = '+q(p[1])+' AND ...'];
 if(e.step===2&&a)return ['SELECT ... FROM '+a,' WHERE ACCOUNT_ID = '+q(p[0])+' FOR UPDATE'];
 if(e.step===3&&t)return ['INSERT INTO '+t+' (...)','VALUES ('+q(String(p[0]).length>15?String(p[0]).slice(0,12)+'...':p[0])+', '+q(p[1])+", 'WITHDRAWAL',",'        '+money('amount',p[2])+', '+q(p[3])+', ...)'];
 if(e.step===4&&a)return ['UPDATE '+a,'   SET BALANCE = BALANCE - '+money('amount',p[0])+',','       AVAILABLE_BALANCE = AVAILABLE_BALANCE - '+money('amount',p[1])+', ...',' WHERE ACCOUNT_ID = '+q(p[2])+" AND ACCOUNT_STATUS = 'ACTIVE'",'   AND CURRENCY = '+q(p[3])+' AND BALANCE >= '+money('amount',p[4]),'   AND AVAILABLE_BALANCE >= '+money('amount',p[5])];
 if(e.step===5&&a)return ['SELECT BALANCE, AVAILABLE_BALANCE','  FROM '+a,' WHERE ACCOUNT_ID = '+q(p[0])];
 if(e.step===5&&t)return ['SELECT TRANSACTION_TIMESTAMP FROM '+t+' ...',' WHERE TRANSACTION_ID = '+q(p[0])+' AND ...'];
 return null;
}
function execution(events,{preview=false,currency='GBP'}={}) {
 let step;
 for(const e of events||[]) {
  currency = e.currency || e.rows?.find(row => row.CURRENCY)?.CURRENCY || currency;
  if((!preview&&e.step===1&&e.ok!==false)||e.operation==='beginTransaction')continue;
  if(e.step!==step){step=e.step;line();line('STEP '+step+'  '+headings[step],'step');}
  if(e.sql || Array.isArray(e.sqlSummary)){
   const parts=sqlSummary(e);
   if(parts&&!(e.step===5&&(/ACCOUNT_TRANSACTION/.test(e.sql || e.table || ''))&&e.ok)){
    line('  SQL   '+parts[0],'sql');for(const part of parts.slice(1))line(part,'sql','        ');
   }else if(!parts)line('  SQL   Concise operation details unavailable.');
   if(e.ok&&e.step===2)line('  ->    '+(e.rowsReturned??e.rows?.length??'Unknown')+' '+((e.rowsReturned??e.rows?.length)===1?'row':'rows')+' locked','success');
   if(e.ok&&(e.step===3||e.step===4))line('  ->    '+(e.rowsAffected==null?'Rows affected not reported by driver':e.rowsAffected+' '+(e.rowsAffected===1?'row':'rows')+' '+(e.step===3?'inserted':'updated')),'success');
   if(e.ok&&e.rows?.length&&(e.step===1||e.step===5)){
    const row=e.rows[0];
    if(row.BALANCE!==undefined)line('  ->    Balance'+(e.step===5?' verified':'')+': '+money('BALANCE',row.BALANCE)+' '+currency,'success');
    if(row.AVAILABLE_BALANCE!==undefined)line('  ->    Available: '+money('AVAILABLE_BALANCE',row.AVAILABLE_BALANCE)+' '+currency,'success');
    if(row.TRANSACTION_TIMESTAMP!==undefined)line('  ->    Transaction verified','success');
   }
   if(e.ok&&e.verification?.transaction)line('  ->    Transaction verified','success');
  }else if(e.ok&&e.operation==='commit')line('  ->    COMMIT successful','success');
  else if(e.ok&&e.operation==='rollback')line('  ->    ROLLBACK completed','error');
  if(e.ok===false)line('  ->    STEP '+e.step+' FAILED: database operation failed.','error');
 }
}
function money(key, value) {
  if (!['BALANCE', 'AVAILABLE_BALANCE', 'amount'].includes(key)) return clean(value);
  try {
    const { databaseMoneyToMinorUnits, formatMinorUnits } = require('./demo-amount');
    return formatMinorUnits(databaseMoneyToMinorUnits(value));
  } catch { return clean(value); }
}
function summary(result) {
  line(); line('RESULT', 'title');
  const rows = [['Balance', money('BALANCE', result.previousBalance), money('BALANCE', result.newBalance)],
    ['Available balance', money('AVAILABLE_BALANCE', result.previousAvailableBalance), money('AVAILABLE_BALANCE', result.newAvailableBalance)],
    ['Withdrawal', '-', money('amount', result.amount) + ' ' + result.currency]];
  const fieldWidth = Math.max(21, ...rows.map(row => row[0].length));
  const beforeWidth = Math.max(15, ...rows.map(row => row[1].length));
  line(`  ${'FIELD'.padEnd(fieldWidth)} ${'BEFORE'.padEnd(beforeWidth)} AFTER`);
  for (const [field, before, after] of rows) {
    const prefix = `  ${field.padEnd(fieldWidth)} ${before.padEnd(beforeWidth)} `;
    const text = prefix + after;
    if (text.length <= 100) console.log(paint(prefix, 'info') + paint(after, 'success'));
    else { line(`${field} BEFORE: ${before}`, 'info', '  '); line(`AFTER: ${after}`, 'success', '        '); }
  }
  line();
  line('  Withdrawal committed: ' + result.transactionId, 'value');
  line();
  line('Written directly to AS400. No TapData API or dashboard was called.', 'success');
  line('Next: switch to the dashboard. The customer page updates by itself within seconds.', 'hint');
}
function failure(detail) {
  execution(detail.events);
  line(`STEP ${detail.failedStep}  ${headings[detail.failedStep] || 'Withdrawal'} FAILED`, 'error');
  if (detail.rolledBack && !detail.commitAttempted) line('Rolled back. No changes were made.', 'error');
  else if (!detail.events.some(event => event.operation === 'beginTransaction' && event.ok))
    line('No database transaction was started.', 'error');
  else line('Rollback could not guarantee the outcome. Retain references for operator reconciliation.', 'error');
}
function failureDetails(detail) {
  if (!detail || !Number.isInteger(detail.failedStep) || !headings[detail.failedStep] ||
      !Array.isArray(detail.events) || detail.events.length > 32 ||
      !detail.events.every(event => event && headings[event.step] &&
        ['query', 'beginTransaction', 'commit', 'rollback'].includes(event.operation) &&
        (event.operation !== 'query' || ((typeof event.sql === 'string' && event.sql.length <= 10000 &&
          Array.isArray(event.parameters) && event.parameters.length <= 32) ||
          (Array.isArray(event.sqlSummary) && event.sqlSummary.length <= 16 &&
            event.sqlSummary.every(part => typeof part === 'string' && part.length <= 10000)))) &&
        (event.rows === undefined || Array.isArray(event.rows)))) return null;
  return { events: detail.events, failedStep: detail.failedStep,
    commitAttempted: detail.commitAttempted === true,
    rolledBack: detail.rolledBack === true && detail.commitAttempted === false &&
      detail.events.some(event => event.operation === 'rollback' && event.ok === true) };
}
function errorMessage(error) {
  let message = String(error.message || 'Withdrawal failed');
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /PASSWORD|TOKEN|SECRET|CONNECT_STRING|JDBC_URL/i.test(name)) message = message.split(value).join('[redacted]');
  }
  line(`Customer 360 demo failed: ${message}`, 'error', '', console.error);
}
module.exports = { capture, execution, summary, line, header, failure, failureDetails, errorMessage, style: paint,
  visibleWidth: value => Array.from(clean(value)).reduce((width, char) => width + charWidth(char), 0) };
