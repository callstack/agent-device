import fs from 'node:fs';
import path from 'node:path';

import {
  MACOS_LIVE_SCENARIOS,
  MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
  liveCommandsForScenario,
} from './coverage-manifest.ts';

export function writeCoverageReport(artifactDir: string): string {
  fs.mkdirSync(artifactDir, { recursive: true });
  const reportPath = path.join(artifactDir, 'coverage-report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        classificationSummary: MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
        liveCommands: MACOS_LIVE_SCENARIOS.flatMap(({ id }) => liveCommandsForScenario(id)),
        liveScenarios: MACOS_LIVE_SCENARIOS.map(({ id }) => id),
      },
      null,
      2,
    ),
  );
  return reportPath;
}
