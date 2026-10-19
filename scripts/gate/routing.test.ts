import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTED_LANES, type RoutedLane } from './declarations.ts';
import type { Model } from './model.ts';
import { routing } from './routing.ts';
import type { Lane } from './workflows.ts';

const declaration: RoutedLane = { lane: 'Planted', sampled: ['replay-ios'] };
const lane: Lane = {
  workflow: 'planted.yml',
  label: 'Planted',
  qualifying: true,
  triggers: ['pull_request'],
  gates: ['swift-runner-ios'],
  uses: ['.github/actions/setup-apple-runner-build/action.yml'],
  verbatim: [],
  paths: [],
  pathsIgnore: ['packages/platform-android/**', 'src/foo.test.ts'],
  unsupported: [],
};
const files = [
  'packages/platform-apple/src/foo.ts',
  'packages/platform-android/src/foo.ts',
  'src/foo.test.ts',
];
function messages(change: Partial<Lane> = {}, trackedFiles = files) {
  const model = {
    lanes: [{ ...lane, ...change }],
    trackedFiles: new Set(trackedFiles),
    packageEntryFiles: [],
    scripts: {},
    vitestProjects: [],
    opaque: {},
  } satisfies Model;
  return routing(model, [declaration]).map((failure) => failure.message);
}

test('ownership-selected phases have no parallel paths-ignore routing declaration', () => {
  assert.deepEqual(ROUTED_LANES, []);
});
test('literal workflow routing still checks both directions', () => {
  assert.deepEqual(messages(), []);
  assert.ok(
    messages({ pathsIgnore: [...lane.pathsIgnore, 'packages/platform-apple/**'] }).some((text) =>
      /ignores packages\/platform-apple/.test(text),
    ),
  );
  assert.ok(
    messages({ pathsIgnore: ['src/foo.test.ts'] }).some((text) =>
      /starts on packages\/platform-android/.test(text),
    ),
  );
  assert.ok(
    messages({ pathsIgnore: ['packages/platform-android/**'] }).some((text) =>
      /unit test/.test(text),
    ),
  );
});
test('a routed workflow must exist and have a PR trigger', () => {
  assert.ok(
    messages({ triggers: ['workflow_dispatch'] }).some((text) => /no pull_request/.test(text)),
  );
  const absent: Model = {
    lanes: [],
    trackedFiles: new Set(files),
    packageEntryFiles: [],
    scripts: {},
    vitestProjects: [],
    opaque: {},
  };
  assert.ok(routing(absent, [declaration]).some((failure) => /not defined/.test(failure.message)));
});
test('own action and tooling ignores cannot bypass fail-open routing', () => {
  for (const file of ['.github/actions/setup-apple-runner-build/action.yml', 'package.json']) {
    assert.ok(messages({ pathsIgnore: [file] }, [file]).some((text) => /fails open/.test(text)));
  }
});
