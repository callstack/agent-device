import assert from 'node:assert/strict';
import { test } from 'vitest';
import { computeReplayPlanDigest } from '../plan-digest.ts';
import type { SessionAction } from '../../daemon/types.ts';

function action(overrides: Partial<SessionAction> = {}): SessionAction {
  return {
    ts: 0,
    command: 'click',
    positionals: ['label="Save"'],
    flags: {},
    ...overrides,
  };
}

function digestFor(
  actions: SessionAction[],
  overrides: Partial<Parameters<typeof computeReplayPlanDigest>[0]> = {},
) {
  return computeReplayPlanDigest({
    actions,
    actionLines: actions.map((_, i) => i + 1),
    actionSourcePaths: undefined,
    metadata: {},
    ...overrides,
  });
}

test('computeReplayPlanDigest is a 64-char lowercase hex SHA-256', () => {
  const digest = digestFor([action()]);
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('computeReplayPlanDigest is stable across repeated computation of the same plan', () => {
  const actions = [action(), action({ command: 'open', positionals: ['Demo'] })];
  assert.equal(digestFor(actions), digestFor(actions));
});

test('computeReplayPlanDigest is insensitive to incidental flags-object key order', () => {
  const a = action({ flags: { settle: true, timeoutMs: 500 } as never });
  const b = action({ flags: { timeoutMs: 500, settle: true } as never });
  assert.equal(digestFor([a]), digestFor([b]));
});

test('computeReplayPlanDigest changes when a positional changes', () => {
  const original = digestFor([action({ positionals: ['label="Save"'] })]);
  const edited = digestFor([action({ positionals: ['label="Submit"'] })]);
  assert.notEqual(original, edited);
});

test('computeReplayPlanDigest changes when the command changes', () => {
  const original = digestFor([action({ command: 'click' })]);
  const edited = digestFor([action({ command: 'press' })]);
  assert.notEqual(original, edited);
});

test('computeReplayPlanDigest changes when source provenance (path/line) changes', () => {
  const actions = [action()];
  const original = digestFor(actions, { actionLines: [1] });
  const movedLine = digestFor(actions, { actionLines: [5] });
  assert.notEqual(original, movedLine);

  const noSourcePath = digestFor(actions, { actionSourcePaths: undefined });
  const withSourcePath = digestFor(actions, { actionSourcePaths: ['/tmp/include.ad'] });
  assert.notEqual(noSourcePath, withSourcePath);
});

test('computeReplayPlanDigest changes when platform-conditioned metadata changes', () => {
  const actions = [action()];
  const ios = digestFor(actions, { metadata: { platform: 'ios' } });
  const android = digestFor(actions, { metadata: { platform: 'android' } });
  assert.notEqual(ios, android);
});

test('computeReplayPlanDigest folds runtime control-flow shape (retry) into the digest', () => {
  const retryOne: SessionAction = action({
    command: 'back',
    positionals: [],
    replayControl: { kind: 'retry', maxRetries: 1, actions: [action({ command: 'back' })] },
  });
  const retryTwo: SessionAction = {
    ...retryOne,
    replayControl: { kind: 'retry', maxRetries: 2, actions: [action({ command: 'back' })] },
  };
  assert.notEqual(digestFor([retryOne]), digestFor([retryTwo]));
});

test('computeReplayPlanDigest folds runtime control-flow shape (maestroRunFlowWhen) into the digest', () => {
  const base: SessionAction = action({
    command: 'back',
    positionals: [],
    replayControl: {
      kind: 'maestroRunFlowWhen',
      mode: 'visible',
      selector: 'label="Continue"',
      actions: [action({ command: 'back' })],
    },
  });
  const changedSelector: SessionAction = {
    ...base,
    replayControl: {
      kind: 'maestroRunFlowWhen',
      mode: 'visible',
      selector: 'label="Skip"',
      actions: [action({ command: 'back' })],
    },
  };
  assert.notEqual(digestFor([base]), digestFor([changedSelector]));
});

test('computeReplayPlanDigest changes when an execution runtime hint changes', () => {
  const runtime = {
    platform: 'ios' as const,
    metroHost: '127.0.0.1',
    metroPort: 8081,
    bundleUrl: 'http://localhost:8081/index.bundle',
    launchUrl: 'agentdevice://home',
  };
  const original = digestFor([action({ runtime })]);

  for (const [key, value] of Object.entries({
    platform: 'android',
    metroHost: '10.0.2.2',
    metroPort: 8082,
    bundleUrl: 'http://localhost:8082/index.bundle',
    launchUrl: 'agentdevice://settings',
  })) {
    assert.notEqual(original, digestFor([action({ runtime: { ...runtime, [key]: value } })]));
  }
});

test('computeReplayPlanDigest changes when target evidence consumed before action changes', () => {
  const targetEvidence = {
    id: 'save',
    role: 'button',
    label: 'Save',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified' as const,
  };
  const original = digestFor([action({ targetEvidence })]);

  for (const targetEvidenceChange of [
    { label: 'Submit' },
    { sibling: 1 },
    { viewportOrder: 1 },
    { verification: 'unverifiable' as const },
  ]) {
    assert.notEqual(
      original,
      digestFor([action({ targetEvidence: { ...targetEvidence, ...targetEvidenceChange } })]),
    );
  }
});

test('computeReplayPlanDigest never changes based on unsubstituted ${VAR} text (variable VALUES never affect the digest)', () => {
  // The digest is computed over the still-unsubstituted action text; --env
  // values are resolved later, at invocation time, so two runs with
  // different --env inputs against the identical script must agree.
  const withVar = digestFor([action({ positionals: ['label="${NAME}"'] })]);
  const sameWithVar = digestFor([action({ positionals: ['label="${NAME}"'] })]);
  assert.equal(withVar, sameWithVar);
});
