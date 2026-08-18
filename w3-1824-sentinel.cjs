// fallow-ignore-file unused-file
// SCRATCH (w3-1824): a process that sits at a chosen pid and records which
// signal reached it. SIGKILL cannot be logged; its death is the record.
const fs = require('node:fs');
const out = process.argv[2];
const log = (line) =>
  fs.appendFileSync(out, `${new Date().toISOString()} pid=${process.pid} ${line}\n`);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    log(`received ${signal}`);
    process.exit(0);
  });
}
log('started');
setInterval(() => {}, 1_000_000);
