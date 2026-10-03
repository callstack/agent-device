import { test, expect } from 'vitest';
import {
  buildDeviceInUseBySessionError,
  buildForeignWorkspaceSessionConflict,
} from '../../../session-recovery-hints.ts';
import type { SessionRef } from '../../../session-state.ts';
import { IOS_SIMULATOR } from '../../../../__tests__/test-utils/device-fixtures.ts';

// DEVICE_IN_USE named `SessionState.name`, and for an implicitly cwd-scoped session that is
// `default` while the session is stored — and addressable — as `cwd:<hash>:default`. Both the
// message and the recovery hint therefore pointed at a session no `--session` value could reach
// (#2031). The producer now takes the store key and reports that.

const SCOPED_ADDRESS = 'cwd:8bea844ab16aa9b3:default';

const scopedRef: SessionRef = {
  address: SCOPED_ADDRESS,
  session: {
    name: 'default',
    sessionScope: { kind: 'cwd', id: '8bea844ab16aa9b3' },
    device: IOS_SIMULATOR,
    createdAt: 0,
    actions: [],
  },
};

test('the by-session conflict reports the address, in the message, details and hint', () => {
  const response = buildDeviceInUseBySessionError(scopedRef, IOS_SIMULATOR);

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error?.message).toBe(`Device is already in use by session "${SCOPED_ADDRESS}".`);
  expect(response.error?.details?.session).toBe(SCOPED_ADDRESS);
  expect(String(response.error?.details?.hint)).toContain(
    `agent-device close --session ${SCOPED_ADDRESS}`,
  );
});

// The other workspace's session used to be reported as "another workspace session" with no
// address at all: the caller was told to wait for a session it could neither name, reach with
// --session, nor close.
test('the foreign-workspace conflict names the owning session address', () => {
  const foreignAddress = 'cwd:1d9b7c2f4a6e8b03:default';
  const foreignRef: SessionRef = {
    address: foreignAddress,
    session: {
      name: 'default',
      sessionScope: { kind: 'cwd', id: '1d9b7c2f4a6e8b03' },
      device: IOS_SIMULATOR,
      createdAt: 0,
      actions: [],
    },
  };

  const response = buildForeignWorkspaceSessionConflict(foreignRef, IOS_SIMULATOR);

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error?.code).toBe('DEVICE_IN_USE');
  expect(response.error?.message).toContain(foreignAddress);
  expect(response.error?.details).toMatchObject({
    reason: 'WORKSPACE_SESSION_SCOPE_CONFLICT',
    session: foreignAddress,
    deviceId: IOS_SIMULATOR.id,
  });
  const hint = String(response.error?.details?.hint);
  expect(hint).toContain(`agent-device close --session ${foreignAddress}`);
});

// A caller that already spent a --wait budget is not helped by being told to wait, and is misled
// by a hint that reads as though nothing was tried. The spend flips the phrasing.
test('a spent wait budget is reported as spent and never re-offered', () => {
  const response = buildForeignWorkspaceSessionConflict(scopedRef, IOS_SIMULATOR, {
    waitedMs: 30_000,
    offersDeviceWait: true,
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error?.details?.waitedMs).toBe(30_000);
  const hint = String(response.error?.details?.hint);
  expect(hint).toMatch(/^Waited 30000ms for this device and it stayed busy\./);
  expect(hint).not.toContain('--wait');
});

test('an open that never waited offers the wait instead of claiming one', () => {
  const hint = String(
    buildDeviceInUseBySessionError(scopedRef, IOS_SIMULATOR, { offersDeviceWait: true }).error
      ?.details?.hint,
  );

  expect(hint).not.toMatch(/Waited/);
  expect(hint).toContain('--wait <ms>');
});

// Only `open` carries --wait. An interaction refused by a busy device has to reuse or close the
// owning session, and a hint ending in a flag its command rejects sends it away from both.
test('a refusal from a command that cannot wait never offers the flag', () => {
  const hints = [
    buildDeviceInUseBySessionError(scopedRef, IOS_SIMULATOR),
    buildForeignWorkspaceSessionConflict(scopedRef, IOS_SIMULATOR),
  ];

  for (const response of hints) {
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(String(response.error?.details?.hint)).not.toContain('--wait');
  }
});
