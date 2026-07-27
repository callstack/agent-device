// Which workflows are scheduled lanes (#1430).
//
// Derived from .github/workflows/ rather than a hand-maintained list: a lane added without being
// registered anywhere is the failure mode the health job exists to prevent.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { cadenceHours, type LaneCadence } from './health-model.ts';

type WorkflowDocument = {
  name?: string;
  on?: { schedule?: { cron?: string }[] } | string | string[];
};

function cronExpressionsOf(document: WorkflowDocument): string[] {
  const on = document.on;
  if (typeof on !== 'object' || Array.isArray(on) || on === null) return [];
  return (on.schedule ?? []).flatMap((entry) => (entry.cron === undefined ? [] : [entry.cron]));
}

export function discoverScheduledLanes(workflowDir: string): LaneCadence[] {
  const lanes: LaneCadence[] = [];
  for (const file of fs.readdirSync(workflowDir).sort()) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    const document = parse(
      fs.readFileSync(path.join(workflowDir, file), 'utf8'),
    ) as WorkflowDocument | null;
    const cronExpressions = cronExpressionsOf(document ?? {});
    if (cronExpressions.length === 0) continue;
    lanes.push({
      workflow: file,
      name: document?.name ?? file,
      cronExpressions,
      cadenceHours: cadenceHours(cronExpressions),
    });
  }
  return lanes;
}
