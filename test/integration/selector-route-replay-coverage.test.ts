import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseReplayScriptDetailed } from '@agent-device/ad-script';

type ReplayAction = ReturnType<typeof parseReplayScriptDetailed>['actions'][number];

const IOS_SELECTOR_ROUTE_STEPS = [
  ['get', 'text', 'id="automation-title"'],
  ['get', 'attrs', 'id="automation-title"'],
  ['is', 'visible', 'id="automation-title"'],
  ['find', 'id', 'automation-title', 'get', 'attrs'],
  ['app-switcher'],
  ['snapshot'],
  ['click', 'id="gearshape.fill"'],
] as const;

const ANDROID_SELECTOR_ROUTE_STEPS = [
  ['get', 'text', 'id="field-name"'],
  ['get', 'attrs', 'id="field-name"'],
  ['is', 'visible', 'id="field-name"'],
  ['find', 'id', 'field-name', 'get', 'attrs'],
  ['orientation', 'landscape-left'],
  ['click', 'id="field-name"'],
  ['click', 'id="field-name"'],
] as const;

test('mobile fixture replay suites exercise selector reads before covered-target diagnosis', () => {
  const missing = (
    [
      ['Android', 'test/integration/replays/android/fixture', ANDROID_SELECTOR_ROUTE_STEPS],
      ['iOS', 'test/integration/replays/ios/fixture', IOS_SELECTOR_ROUTE_STEPS],
    ] as const
  ).flatMap(([platform, directory, steps]) =>
    replaySuiteCarriesSteps(directory, steps) ? [] : [platform],
  );

  assert.deepEqual(
    missing,
    [],
    `${missing.join(' and ')} fixture replay suites must exercise get text, get attrs, non-exists is, find get attrs, and deliberate covered-target diagnosis`,
  );
});

function replaySuiteCarriesSteps(
  directory: string,
  expectedSteps: readonly (readonly string[])[],
): boolean {
  return fs
    .readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.ad'))
    .some((fileName) => {
      const source = fs.readFileSync(path.join(directory, fileName), 'utf8');
      const actions = parseReplayScriptDetailed(source).actions;
      return containsStepsInOrder(actions, expectedSteps);
    });
}

function containsStepsInOrder(
  actions: readonly ReplayAction[],
  expectedSteps: readonly (readonly string[])[],
): boolean {
  let nextStep = 0;
  for (const action of actions) {
    const actual = [action.command, ...(action.positionals ?? [])];
    if (arraysEqual(actual, expectedSteps[nextStep] ?? [])) nextStep += 1;
  }
  return nextStep === expectedSteps.length;
}

function arraysEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}
