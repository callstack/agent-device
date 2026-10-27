import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

type DiagnosticEvent = {
  level: string;
  phase: string;
  data?: Record<string, unknown>;
};

export async function statusBarDiagnosticEvents(run: () => Promise<unknown>) {
  const logPath = path.join(await mkdtempForTest('ios-status-bar-diagnostics-'), 'log.ndjson');
  await withDiagnosticsScope({ command: 'screenshot', debug: true, logPath }, run);
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as DiagnosticEvent)
    .filter((event) => event.phase.startsWith('ios_screenshot_status_bar_'))
    .map(({ level, phase, data }) => ({ level, phase, data }));
}
