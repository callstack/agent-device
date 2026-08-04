// Counterpart to exit-naive.ts using the #1596 fix: same oversized write,
// exited through `exitAfterFlush` instead of a bare `process.exit()`.
import { exitAfterFlush } from '../../../src/utils/process-exit.ts';
import { buildPayload } from './exit-payload.ts';

process.stderr.write(buildPayload());
await exitAfterFlush(1);
