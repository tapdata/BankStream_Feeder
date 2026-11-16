'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function cancel(command, mode, answer, resetChoice) {
  const entry = path.resolve(__dirname, '../src', command === 'reset' ? 'reset-cli.js' : 'demo-cli.js');
  const script = `
    const Module = require('node:module'); const load = Module._load;
    const mode = ${JSON.stringify(mode)};
    const answers = ${JSON.stringify(command === 'reset' ? [resetChoice, answer] : command === 'transaction' ? ['12.5', answer] : [answer])};
    const account = {customerId:'123456',customerName:'Cancellation fixture',accountId:'AC1234561',
      accountStatus:'ACTIVE',currency:'USD',balance:'100.00',availableBalance:'100.00'};
    const kyc = {customerId:'123456',kycRecordId:'K1',status:'VERIFIED',riskRating:'MEDIUM'};
    const forbidden = () => {console.error('FORBIDDEN MUTATION OR COMMIT');throw Error('Unexpected write or commit');};
    const db2 = {close:async()=>{},beginTransaction:forbidden,commit:forbidden,rollback:forbidden,
      query:async sql=>{if(!sql.startsWith('SELECT '))return forbidden();return [{
        CUSTOMER_ID:account.customerId,CUSTOMER_NAME:account.customerName,CUSTOMER_STATUS:'ACTIVE',
        ACCOUNT_ID:account.accountId,ACCOUNT_STATUS:'ACTIVE',CURRENCY:'USD',BALANCE:'100.00',AVAILABLE_BALANCE:'100.00'}];}};
    const oracle = {close:async()=>{},commit:forbidden,rollback:forbidden,
      execute:async sql=>{if(!sql.startsWith('SELECT '))return forbidden();return {rows:[[kyc.customerId,'K1',kyc.status,kyc.riskRating]]};}};
    Object.defineProperty(process.stdin,'isTTY',{value:true});
    Module._load = function(name) {
      if(name==='dotenv')return {config(){}};
      if(name==='node:readline/promises')return {createInterface:()=>({
        question:async question=>{console.log('PROMPT '+question);return answers.shift();},close(){}})};
      if(name==='./remote-https')return {createHttpsFetch:()=>globalThis.fetch};
      if(mode==='remote'&&['./db','./config','oracledb','odbc'].includes(name))throw Error('FORBIDDEN DATABASE IMPORT');
      if(name==='./config')return {config:{db2:{schema:'CORE'},oracle:{schema:'CRM'}}};
      if(name==='./db')return {connectDb2:async()=>db2,connectOracle:async()=>oracle};
      return load.apply(this,arguments);
    };
    globalThis.fetch=async(url,options)=>{
      console.error('HTTP '+options.method+' '+url.pathname);
      if(options.method!=='GET')return forbidden();
      const result=url.pathname.includes('/reset/')?{previewId:'preview-cancel',account,kyc}:
        url.pathname.includes('/kyc/')?{previewId:'preview-cancel',kyc}:{previewId:'preview-cancel',account};
      return {ok:true,status:200,json:async()=>({version:1,exitCode:0,result})};
    };
    process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(command === 'reset' ? [] : [command])}];
    Module.runMain(${JSON.stringify(entry)});
  `;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(FEEDER_|DEMO_|DB2I_|ORACLE_|TAPDATA_)/.test(key)) delete env[key];
  Object.assign(env, { FEEDER_MODE: mode, DEMO_CUSTOMER_ID: '123456', DEMO_ACCOUNT_ID: 'AC1234561',
    DEMO_API_URL: 'https://control.test', DEMO_API_TOKEN: 'fixture-token', NO_COLOR: '1' });
  return spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 10000 });
}

for (const command of ['reset', 'transaction', 'kyc']) for (const mode of ['local', 'remote']) {
  for (const choice of command === 'reset' ? ['1', '2', '3'] : [undefined]) {
  for (const answer of ['N', 'n', '']) {
    test(command + (choice ? ' option ' + choice : '') + ' ' + mode + ' confirmation ' + JSON.stringify(answer) + ' cancels without writes or commits', () => {
      const result = cancel(command, mode, answer, choice);
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.trimEnd().split(/\r?\n/);
      assert.equal(lines.at(-1), 'Cancelled. No changes were made.');
      assert.equal(lines.filter(line => line === 'Cancelled. No changes were made.').length, 1);
      assert.match(result.stdout, /PROMPT .*\(y\/N\)/);
      assert.doesNotMatch(result.stdout, /COMMIT successful|^RESULT$/m);
      assert.doesNotMatch(result.stderr, /FORBIDDEN|HTTP POST/);
      if (mode === 'remote') assert.match(result.stderr, /HTTP GET .*\/preview/);
    });
  }
  }
}
