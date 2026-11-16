'use strict';
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { getExecutionMode } = require('../src/execution-mode');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const fileEnv = fs.existsSync(envPath) ? require('dotenv').parse(fs.readFileSync(envPath)) : null;
const skip = !fileEnv ? 'No .env: offline tests only'
  : getExecutionMode(fileEnv) !== 'local' && 'Remote mode: checked by remote live test';

function runChild(command, args, label) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: root, env: { ...process.env, ...fileEnv }, timeout: 60000,
      maxBuffer: 1024 * 1024
    }, error => {
      // Do not expose customer data, credentials, or driver diagnostics in test logs.
      if (error) reject(new Error(`${label} FAILED${error.killed ? ' (60 second timeout)' : ''}`));
      else resolve();
    });
  });
}

for (const [name, connect] of [['Db2', 'connectDb2'], ['Oracle', 'connectOracle']]) {
  test(`live local .env ${name} connection`, { skip }, async t => {
    await runChild(process.execPath, ['-e', `
      const { createConfig } = require('./src/config');
      const { ${connect} } = require('./src/db');
      (async () => {
        const connection = await ${connect}(createConfig());
        try { await connection.${connect === 'connectDb2' ? 'query' : 'execute'}(${JSON.stringify(connect === 'connectDb2' ? 'SELECT 1 FROM SYSIBM.SYSDUMMY1' : 'SELECT 1 FROM DUAL')}); }
        finally { await connection.close(); }
      })().catch(() => { process.exitCode = 1; });
    `], `${name} database connection`);
    t.diagnostic(`${name} database connection OK`);
  });
}

test('live local .env TapData APIs connection and authentication', { skip }, async t => {
  try {
    let token = fileEnv.TAPDATA_ACCESS_TOKEN?.trim();
    const request = (url, options) => fetch(url, { ...options,
      signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!token && fileEnv.TAPDATA_TOKEN_URL) {
      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      const body = new URLSearchParams({ grant_type: 'client_credentials' });
      const method = (fileEnv.TAPDATA_TOKEN_AUTH_METHOD || 'client_secret_post').toLowerCase();
      if (method === 'client_secret_basic') headers.authorization = `Basic ${Buffer.from(`${fileEnv.TAPDATA_CLIENT_ID}:${fileEnv.TAPDATA_CLIENT_SECRET}`).toString('base64')}`;
      else if (method === 'client_secret_post') {
        body.set('client_id', fileEnv.TAPDATA_CLIENT_ID || '');
        body.set('client_secret', fileEnv.TAPDATA_CLIENT_SECRET || '');
      } else throw Error('Unsupported OAuth method');
      const response = await request(fileEnv.TAPDATA_TOKEN_URL, { method: 'POST', headers, body });
      if (!response.ok) throw Error('OAuth failed');
      token = (await response.json()).access_token;
      if (!token) throw Error('Missing access token');
    }
    const map = JSON.parse(fileEnv.TAPDATA_COLLECTION_MAP || '{"CUSTOMER":"MDM_CUSTOMER360"}');
    for (const collection of [map.CUSTOMER, fileEnv.TAPDATA_KYC_COLLECTION || 'CUSTOMER_KYC']) {
      if (!collection) throw Error('Missing collection');
      const template = fileEnv.TAPDATA_FIND_PATH_TEMPLATE || '/api/v1/{collection}';
      const apiPath = template.replaceAll('{collection}', encodeURIComponent(collection));
      const url = new URL(apiPath.startsWith('/') ? apiPath : `/${apiPath}`, fileEnv.TAPDATA_API_BASE_URL || fileEnv.BANKING_API_BASE_URL);
      const filter = { ...JSON.parse(fileEnv.TAPDATA_FIND_FILTER || '{}'), limit: 1, skip: 0 };
      const headers = { accept: 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const method = (fileEnv.TAPDATA_FIND_METHOD || 'GET').toUpperCase();
      const options = { method, headers };
      if (method === 'POST') {
        headers['content-type'] = 'application/json';
        options.body = JSON.stringify(fileEnv.TAPDATA_FIND_REQUEST_STYLE === 'filter' ? { filter } : filter);
      } else url.searchParams.set('filter', JSON.stringify(filter));
      const response = await request(url, options);
      if (!response.ok || !Array.isArray((await response.json()).data)) throw Error('API failed');
    }
  } catch {
    throw new Error('TapData APIs connection/authentication FAILED; check API URL, OAuth credentials, token and published collections.');
  }
  t.diagnostic('TapData APIs connection and authentication OK');
});

