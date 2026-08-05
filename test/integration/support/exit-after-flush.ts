// #1596 fixture: writes an oversized payload to piped stderr, then exits
// through `exitAfterFlush` so the parent must receive the trailing marker.
import { exitAfterFlush } from '../../../src/utils/process-exit.ts';
import { buildPayload } from './exit-payload.ts';

process.stderr.write(buildPayload());
await exitAfterFlush(1);
