// Routed-lane witnesses (#1781 A9-2): the live ios.yml agrees with the selector, and each
// planted disagreement below is reported — an ignore that hides an Apple path or a tooling
// glob, and a missing ignore for a tree the selector says is another family's.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ROUTED_LANES } from './declarations.ts';
import { loadModel, type Model } from './model.ts';
import { routing } from './routing.ts';
import type { Lane } from './workflows.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const base = loadModel(repoRoot, tracked);
const IOS = ROUTED_LANES.find((routed) => routed.lane === 'iOS / Smoke Tests');
assert.ok(IOS, 'the iOS lane is declared routed');
const iosLane = base.lanes.find((lane) => lane.label === IOS.lane);
assert.ok(iosLane, 'ios.yml defines the routed lane');

function withIos(change: (lane: Lane) => Lane): Model {
  return {
    ...base,
    lanes: base.lanes.map((lane) => (lane.label === IOS.lane ? change(lane) : lane)),
  };
}

const messages = (model: Model) => routing(model, ROUTED_LANES).map((failure) => failure.message);

test('the live ios.yml paths-ignore agrees with the selector over every tracked path', () => {
  assert.deepEqual(messages(base), []);
});

test('the routed lane derives its needs from its declared gate plus the sampled checks', () => {
  assert.ok(iosLane.gates.includes('swift-runner-ios'), 'ios.yml still declares the runner build');
  assert.deepEqual([...IOS.sampled], ['replay-ios', 'replay-ios-device']);
});

test('ignoring an Apple-owned tree is reported with the checks the selector routes it to', () => {
  const model = withIos((lane) => ({
    ...lane,
    pathsIgnore: [...lane.pathsIgnore, 'packages/platform-apple/src/**'],
  }));
  const found = messages(model);
  assert.ok(found.length > 0);
  assert.ok(
    found.some(
      (message) =>
        /ignores packages\/platform-apple\/src\//.test(message) &&
        /routes it to "replay-ios"/.test(message),
    ),
    found.slice(0, 3).join('\n'),
  );
});

test('ignoring a tooling glob is reported as fail-open, even under .github/', () => {
  const model = withIos((lane) => ({
    ...lane,
    pathsIgnore: [...lane.pathsIgnore, '.github/actions/**', 'package.json'],
  }));
  const found = messages(model);
  assert.ok(
    found.some(
      (message) =>
        /ignores \.github\/actions\/setup-apple-runner-build\/action\.yml/.test(message) &&
        /fails open on it \(workflow-tooling\)/.test(message),
    ),
    found.slice(0, 3).join('\n'),
  );
  assert.ok(
    found.some((message) => /ignores package\.json, but the selector fails open/.test(message)),
  );
});

test('a .github path ignored by exact name stays the workflow’s own call', () => {
  // The live list names deploy.yml and the docs preview workflows explicitly; the live tree
  // is green above, so this only pins that the exemption is by exact path, not by prefix.
  const model = withIos((lane) => ({
    ...lane,
    pathsIgnore: [...lane.pathsIgnore, '.github/workflows/size.yml'],
  }));
  assert.deepEqual(messages(model), []);
});

// Review finding on #1857: the exact-name exemption was unbounded, so naming the lane's OWN
// build and boot actions skipped the lane that runs them and the manifest stayed green. The
// exemption now stops at `lane.uses` — the transitive composite-action closure plus the
// workflow file — and these are the reviewer's two planted cases.
test('the exemption cannot name an action the lane itself runs', () => {
  for (const own of [
    '.github/actions/setup-apple-runner-build/action.yml',
    '.github/actions/boot-ios-test-simulator/action.yml',
    '.github/actions/run-gate/action.yml', // reached only through a composite action
    '.github/workflows/ios.yml', // the lane's own definition
  ]) {
    assert.ok(iosLane.uses.includes(own), `${own} must be in the lane's uses closure`);
    const model = withIos((lane) => ({ ...lane, pathsIgnore: [...lane.pathsIgnore, own] }));
    assert.ok(
      messages(model).some(
        (message) => message.includes(`ignores ${own}`) && /fails open/.test(message),
      ),
      `naming ${own} exactly must still fail the routing assertion`,
    );
  }
});

// Second review finding on #1857, one level past the first: `Lane.uses` recorded only the
// composite actions' `action.yml` descriptors, so a support file the descriptor *executes*
// (`bash "$GITHUB_ACTION_PATH/fetch-artifact.sh"`) was exemptible as if it were an unrelated
// sibling workflow. The closure is the action's directory now, which also covers the two files
// referenced no closer than inside that shell script.
test('the exemption cannot name a support file of an action the lane runs', () => {
  const support = [
    '.github/actions/setup-fixture-app/fetch-artifact.sh', // named by the action.yml
    '.github/actions/setup-fixture-app/resolve-artifact-name.sh', // named only inside that script
    '.github/actions/setup-fixture-app/trusted-artifact.mjs', // likewise
  ];
  for (const file of support) {
    assert.ok(iosLane.uses.includes(file), `${file} must be in the lane's uses closure`);
    const model = withIos((lane) => ({ ...lane, pathsIgnore: [...lane.pathsIgnore, file] }));
    assert.ok(
      messages(model).some(
        (message) => message.includes(`ignores ${file}`) && /fails open/.test(message),
      ),
      `naming ${file} exactly must still fail the routing assertion`,
    );
  }
});

// The trap fires correctly for a tracked non-TS file under an ignored family root, but the
// remedy is not "remove the ignore entry" — that would un-route every sibling `.ts` in the
// tree. The selector gap is the fix, and the message has to say so.
test('an unowned path under an ignored root asks for an owner, not for the entry’s removal', () => {
  const planted = 'packages/platform-android/src/probe-fixture.json';
  const model = {
    ...base,
    trackedFiles: new Set([...base.trackedFiles, planted]),
  };
  const found = routing(model, ROUTED_LANES).map((failure) => failure.message);
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0] ?? '', /fails open on it \(unknown-path\)/);
  assert.match(found[0] ?? '', /Give it an owning check in scripts\/check-affected\//);
  assert.ok(!/Remove the ignore entry/.test(found[0] ?? ''));
});

test('dropping a family root from the ignore list fails the routing claim for that tree', () => {
  const model = withIos((lane) => ({
    ...lane,
    pathsIgnore: lane.pathsIgnore.filter(
      (pattern) => pattern !== 'packages/platform-android/src/**',
    ),
  }));
  const found = messages(model);
  assert.ok(
    found.some(
      (message) =>
        /starts on packages\/platform-android\/src\//.test(message) &&
        /android-owned \(lanes: replay-android\)/.test(message),
    ),
    found.slice(0, 3).join('\n'),
  );
});

test('dropping the unit-test ignore fails the routing claim for a unit test', () => {
  const model = withIos((lane) => ({
    ...lane,
    pathsIgnore: lane.pathsIgnore.filter((pattern) => pattern !== 'src/**/*.test.ts'),
  }));
  assert.ok(
    messages(model).some((message) =>
      /\.test\.ts, which the selector classifies as a unit test/.test(message),
    ),
  );
});

test('a routed lane that loses its pull_request trigger, or its job, is reported', () => {
  const gone = { ...base, lanes: base.lanes.filter((lane) => lane.label !== IOS.lane) };
  assert.ok(messages(gone).some((message) => /not defined by any workflow/.test(message)));
  const pushOnly = withIos((lane) => ({ ...lane, triggers: ['push'] }));
  assert.ok(messages(pushOnly).some((message) => /no pull_request trigger/.test(message)));
});
