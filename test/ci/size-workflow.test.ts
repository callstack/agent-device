import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const preservedReportDir = '/tmp/agent-device-size-report';

type WorkflowStep = { name?: string; run?: string };
type WorkflowDoc = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

function workflowStep(name: string): WorkflowStep {
  const workflow = parse(
    fs.readFileSync(path.join(repoRoot, '.github/workflows/size.yml'), 'utf8'),
  ) as WorkflowDoc;
  const step = workflow.jobs?.['bundle-size']?.steps?.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`size.yml must declare the ${JSON.stringify(name)} step`);
  }
  return step;
}

test('the preserved size reporter keeps its entrypoint and relative modules together', () => {
  const preserve = workflowStep('Preserve report scripts').run ?? '';
  const measureBase = workflowStep('Measure base size').run ?? '';

  expect(preserve).toContain(`mkdir -p ${preservedReportDir}`);
  expect(preserve).toContain(`cp scripts/size-report*.mjs ${preservedReportDir}/`);
  expect(measureBase).toContain(`node ${preservedReportDir}/size-report.mjs`);

  const reportSource = fs.readFileSync(path.join(repoRoot, 'scripts/size-report.mjs'), 'utf8');
  const relativeModules = [...reportSource.matchAll(/from '\.\/(size-report-[^']+\.mjs)'/g)].map(
    (match) => match[1],
  );
  expect(relativeModules.length).toBeGreaterThan(0);
  for (const moduleName of relativeModules) {
    if (!moduleName) throw new Error('relative size-report import has no module name');
    expect(fs.existsSync(path.join(repoRoot, 'scripts', moduleName)), moduleName).toBe(true);
  }
});
