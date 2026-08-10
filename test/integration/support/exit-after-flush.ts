// #1596/#1706 fixture: writes an oversized payload through a real piped CLI
// process so the parent must receive the trailing marker before either exit.
import { exitAfterFlush } from '../../../src/utils/process-exit.ts';
import { buildPayload, PAYLOAD_MARKER } from './exit-payload.ts';

if (process.argv.includes('--success')) {
  const { runCliProcess } = await import('../../../src/cli/process-entry.ts');
  const { printJson } = await import('../../../src/utils/output.ts');
  await runCliProcess([], async () => ({
    runCli: async () => {
      printJson({ success: true, data: { payload: `${'x'.repeat(256_000)}${PAYLOAD_MARKER}` } });
    },
  }));
} else {
  process.stderr.write(buildPayload());
  await exitAfterFlush(1);
}
