import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSession } from '../../../__tests__/support/session-factories.ts';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import {
  activateCompleteRefFrame,
  expireRefFrame,
  markSessionSnapshotOutdated,
} from '../../../core/ref-frame.ts';
import { readSettleRequest } from './interaction-flags.ts';

const OPT_IN = { AGENT_DEVICE_SETTLE_ADAPTIVE: '1' };

/** A session whose stored tree was published as a complete ref frame (`snapshot`). */
function sessionWithFrame() {
  const session = makeSession('default', {
    snapshot: makeSnapshotState([{ index: 0, depth: 0, type: 'Button', label: 'Next' }]),
  });
  activateCompleteRefFrame(session);
  return session;
}

test('the host environment opts a settle request into the adaptive confirmation', () => {
  const session = sessionWithFrame();

  assert.deepEqual(readSettleRequest({ settle: true }, { env: OPT_IN, session }), {
    earlyExit: 'adaptive',
    observationCurrent: true,
  });
});

test('a ref frame a side effect crossed is not current for the adaptive confirmation', () => {
  const session = sessionWithFrame();
  expireRefFrame(session);

  assert.equal(
    readSettleRequest({ settle: true }, { env: OPT_IN, session })?.observationCurrent,
    false,
  );
});

test('a frame whose tree a native read outdated is not current for the adaptive confirmation', () => {
  // `wait text` reads the device natively and marks the stored tree outdated without expiring the
  // frame.
  const session = sessionWithFrame();
  markSessionSnapshotOutdated(session);

  assert.equal(
    readSettleRequest({ settle: true }, { env: OPT_IN, session })?.observationCurrent,
    false,
  );
});

test('a newer observation than the frame is not current for the adaptive confirmation', () => {
  // An Android freshness capture stores a newer tree while the frame stays active.
  const session = sessionWithFrame();
  session.snapshot = makeSnapshotState([{ index: 0, depth: 0, type: 'Button', label: 'Done' }]);

  assert.equal(
    readSettleRequest({ settle: true }, { env: OPT_IN, session })?.observationCurrent,
    false,
  );
});

test('a settle request without the opt-in keeps the quiet window rule', () => {
  const session = makeSession('default');
  const env = { AGENT_DEVICE_SETTLE_ADAPTIVE: 'true' };

  assert.deepEqual(readSettleRequest({ settle: true }, { env, session }), {});
  assert.deepEqual(readSettleRequest({ settle: true }), {});
});

test('the opt-in alone requests no settle', () => {
  assert.equal(readSettleRequest({}, { env: OPT_IN, session: makeSession('default') }), undefined);
});
