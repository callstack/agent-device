import fs from 'node:fs';
import path from 'node:path';

import {
  WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
  liveCommandsForWebSmoke,
} from './coverage-manifest.ts';

export type WebSmokeStep = {
  command: string;
  status: number;
};

export async function runCleanupWithCoverageReport(
  artifactDir: string,
  steps: readonly WebSmokeStep[],
  cleanup: () => Promise<void>,
): Promise<void> {
  let cleanupFailed = false;
  let cleanupError: unknown;
  let reportFailed = false;
  let reportError: unknown;
  try {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
  } finally {
    try {
      writeCoverageReport(artifactDir, steps);
    } catch (error) {
      reportFailed = true;
      reportError = error;
    }
  }
  if (cleanupFailed && reportFailed) {
    throw new AggregateError(
      [cleanupError, reportError],
      'web smoke cleanup and coverage reporting failed',
    );
  }
  if (cleanupFailed) throw cleanupError;
  if (reportFailed) throw reportError;
}

export function writeCoverageReport(artifactDir: string, steps: readonly WebSmokeStep[]): string {
  const reportPath = path.join(artifactDir, 'coverage-report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        classificationSummary: WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
        liveCommands: liveCommandsForWebSmoke(),
        steps,
      },
      null,
      2,
    ),
  );
  return reportPath;
}
