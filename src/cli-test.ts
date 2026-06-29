import fs from 'node:fs';
import type { ReplaySuiteResult } from './daemon/types.ts';
import {
  getReplayTestReporterExitCode,
  resolveReplayTestReporters,
  runReplayTestReporters,
} from './cli-test-reporters/registry.ts';
import type { ReplayTestReporterContext } from './cli-test-reporters/types.ts';
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
  await runReplayTestReporters(reporters, suite, createReplayTestReporterContext({ debug }));
  if (json) {
    printJson({ success: true, data: suite });
  }
  return getReplayTestReporterExitCode(reporters, suite);
}

function createReplayTestReporterContext(options: { debug?: boolean }): ReplayTestReporterContext {
  return {
    debug: options.debug,
    writeStdout: (text) => process.stdout.write(text),
    mkdir: (directory) => fs.mkdirSync(directory, { recursive: true }),
    writeFile: (filePath, contents) => fs.writeFileSync(filePath, contents, 'utf8'),
  };
}
