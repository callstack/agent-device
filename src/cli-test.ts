import type { ReplaySuiteResult } from './daemon/types.ts';
import {
  getReplayTestReporterExitCode,
  resolveReplayTestReporters,
  runReplayTestReporters,
} from './cli-test-reporters/registry.ts';
import { printJson } from './utils/output.ts';

export async function renderReplayTestResponse(options: {
  suite: ReplaySuiteResult;
  json?: boolean;
  debug?: boolean;
  reporter?: string[];
  reportJunit?: string;
}): Promise<number> {
  const { suite, json, debug, reporter, reportJunit } = options;
  const reporters = await resolveReplayTestReporters({ reporters: reporter, reportJunit, json });
  await runReplayTestReporters(reporters, suite, { debug });
  if (json) {
    printJson({ success: true, data: suite });
  }
  return getReplayTestReporterExitCode(reporters, suite);
}
