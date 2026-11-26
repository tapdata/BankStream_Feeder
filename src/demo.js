require('dotenv').config();
const { withLoading } = require('./loading');
const { getExecutionMode } = require('./execution-mode');
const { parseRealtimeArgs, helpText } = require('./cli');

async function main() {
  const mode = process.argv[2] || 'realtime';
  if (!['realtime', 'dry-run'].includes(mode)) throw new Error('Usage: npm run realtime -- [options]');
  if (mode === 'dry-run' && process.argv.length > 3) throw new Error('Usage: npm run dry-run');
  const realtimeOptions = mode === 'realtime' ? parseRealtimeArgs(process.argv.slice(3)) : null;
  if (realtimeOptions?.help) { console.log(helpText); return; }
  if (getExecutionMode() === 'remote') {
    if (mode === 'dry-run') {
      const result = await withLoading('Checking remote database connectivity...', () => require('./remote-client').createRemoteClient().execute('dryRun'));
      for (const line of result.output) {
        const isError = line.stream === 'stderr';
        const stream = isError ? process.stderr : process.stdout;
        let text = line.text;
        if (stream.isTTY && !('NO_COLOR' in process.env) && !text.includes('\x1b[')) {
          const color = isError || /\[FAIL\]|FAILED/.test(text) ? '31'
            : /\[PASS\]|connection: OK|^Result:.*passed/.test(text) ? '1;32'
            : /^BankStream/.test(text) ? '1;36' : '90';
          text = `\x1b[${color}m${text}\x1b[0m`;
        }
        (isError ? console.error : console.log)(text);
      }
      if (!result.passed) process.exitCode = 1;
      return;
    }
    const { help, ...options } = realtimeOptions;
    process.exitCode = await require('./remote-realtime').runRemoteRealtime({ client: require('./remote-client').createRemoteClient(), options, loading: withLoading });
    return;
  }
  const { config, validate: validateConfig } = require('./config');
  const { connect, connectDb2, connectOracle } = require('./db');
  const { createRealtimeService } = require('./realtime');
  validateConfig(mode);
  if (mode === 'dry-run') {
    await require('./dry-run').dryRun({ connectOracle: () => connectOracle(config), connectDb2: () => connectDb2(config), loading: withLoading });
    return;
  }
  const {db2,oracle}=await withLoading('Connecting to Db2 and Oracle for the realtime workload...', () => connect(config));
  const controller = new AbortController();
  const stop=()=>controller.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    await createRealtimeService(config,{signal:controller.signal, loading: withLoading}).realtime(db2,oracle,realtimeOptions);
  } finally {
    process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop);
    try{await withLoading('Closing Db2 connection...', () => db2.close());}finally{await withLoading('Closing Oracle connection...', () => oracle.close());}
  }
}
main().catch(e=>{ console.error(`BankStream failed: ${e.message}`); process.exitCode=1; });
