async function dryRun({ connectOracle, connectDb2, log = console.log, errorLog = console.error, formatError = error => error.message }) {
  let failed = false;
  const color = (code, text, stream = process.stdout) =>
    stream.isTTY && !('NO_COLOR' in process.env) ? `\x1b[${code}m${text}\x1b[0m` : text;
  log('');
  log(color('1;36', 'BankStream | Database Connectivity Check'));
  log(color('90', '---------------------------------------'));
  log(color('90', 'Mode: Dry run (read-only)'));
  log('');
  for (const [label, connect, check] of [
    ['Oracle', connectOracle, connection => connection.execute('SELECT 1 FROM DUAL')],
    ['Db2 for i', connectDb2, connection => connection.query('SELECT 1 FROM SYSIBM.SYSDUMMY1')]
  ]) {
    let connection;
    try {
      connection = await connect();
      await check(connection);
      log(`  ${color('1;32', '[PASS]')} ${color('1', label.padEnd(12))} Connection and query verified`);
    } catch (error) {
      failed = true;
      errorLog(color('31', `  [FAIL] ${label.padEnd(12)} ${formatError(error)}`, process.stderr));
    } finally {
      if (connection) {
        try { await connection.close(); } catch (error) {
          failed = true;
          errorLog(color('31', `${label} close: FAILED (${formatError(error)})`, process.stderr));
        }
      }
    }
  }
  log('');
  if (failed) throw new Error('One or more database connectivity checks failed');
  log(color('1;32', 'Result: All database connectivity checks passed.'));
  log(color('90', 'No data was changed.'));
  log('');
}

module.exports = { dryRun };
