import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import type { CheckId } from '../check-affected/model.ts';
import { selectDeviceLane } from '../device-lane-impact.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

type Step = { id?: string; name?: string; if?: string; run?: string };

function jobSteps(workflow: string, job: string): Step[] {
  const doc = parse(
    fs.readFileSync(path.join(repoRoot, '.github/workflows', workflow), 'utf8'),
  ) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  return doc.jobs[job]!.steps;
}

const LANES = {
  android: ['replay-android', 'android-helpers'],
  linux: ['replay-linux', 'linux-command-evidence'],
  web: ['web-smoke'],
} as const satisfies Record<string, readonly CheckId[]>;

function select(target: keyof typeof LANES, changedPaths: string[] | null) {
  return selectDeviceLane('pull_request', changedPaths, LANES[target]).run;
}

test('a unit-test-only PR skips every device lane', () => {
  const unitTests = [
    'src/foo.test.ts',
    'packages/daemon/src/sessions/__tests__/session.test.ts',
    'packages/platform-android/src/snapshot.test.ts',
    'packages/platform-linux/src/__tests__/atspi.test.ts',
  ];
  for (const target of ['android', 'linux', 'web'] as const) {
    expect(select(target, unitTests), target).toBe(false);
  }
});

test.each([
  ['android', 'packages/platform-android/src/index.ts', true],
  ['android', 'test/integration/smoke-android-emulator.test.ts', true],
  ['android', 'examples/test-app/src/App.tsx', true],
  ['android', 'packages/platform-linux/src/index.ts', false],
  ['linux', 'packages/platform-linux/src/index.ts', true],
  ['linux', 'linux/atspi-dump.py', true],
  ['linux', 'packages/platform-android/src/index.ts', false],
  ['web', 'packages/platform-web/src/index.ts', true],
  ['web', 'packages/platform-android/src/index.ts', false],
] as const)('%s smoke selection for %s is %s', (target, file, run) => {
  expect(select(target, [file])).toBe(run);
});

test('shared runtime, uncertain, and push changes run every device lane', () => {
  for (const target of ['android', 'linux', 'web'] as const) {
    expect(select(target, ['src/index.ts']), target).toBe(true);
    expect(select(target, ['src/foo.test.ts', 'package.json']), target).toBe(true);
    expect(select(target, null), target).toBe(true);
    expect(select(target, []), target).toBe(true);
    expect(selectDeviceLane('push', ['src/foo.test.ts'], LANES[target]).run, target).toBe(true);
  }
});

const WEB_SMOKE_STEPS = [
  'Run live web smoke',
  'Execute live web smoke',
  'Upload web smoke artifacts',
];

test.each([
  ['android.yml', 'smoke-android', 'impact', 'android', null],
  ['linux.yml', 'smoke-linux', 'impact', 'linux', null],
  ['ci.yml', 'integration', 'web-impact', 'web', WEB_SMOKE_STEPS],
] as const)('%s gates its device steps on the %s selection', (workflow, job, id, target, names) => {
  const steps = jobSteps(workflow, job);
  const selection = steps.findIndex((step) => step.id === id);
  expect(steps[selection]?.run).toContain(
    `scripts/device-lane-impact.ts ${LANES[target].join(' ')}`,
  );
  // Null means every step after the selection belongs to the lane.
  const gated = names
    ? names.map((name) => steps.find((step) => step.name === name))
    : steps.slice(selection + 1);
  expect(gated.length).toBeGreaterThan(0);
  for (const step of gated) {
    expect(steps.indexOf(step!), step?.name).toBeGreaterThan(selection);
    expect(step?.if, step?.name).toContain(`steps.${id}.outputs.run != 'false'`);
  }
});
