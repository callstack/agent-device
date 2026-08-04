// Regression fixture for #1596: writes a payload larger than a pipe's kernel
// buffer to stderr, then exits the way `src/cli.ts` used to (a bare
// `process.exit()` right after the write). Run as a real subprocess by
// process-exit.test.ts — Node flushes stdout/stderr synchronously only to a
// file or TTY, so a piped parent reliably observes the write truncated.
import { buildPayload } from './exit-payload.ts';

process.stderr.write(buildPayload());
process.exit(1);
