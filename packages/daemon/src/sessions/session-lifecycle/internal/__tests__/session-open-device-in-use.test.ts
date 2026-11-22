import { makeStoredSessionRef } from '../../../../__tests__/support/store-factory.ts';
import { test, expect } from 'vitest';
import {
  buildDeviceInUseBySessionError,
  buildForeignWorkspaceSessionConflict,
} from '../../../../core/session-recovery-hints.ts';
import type { SessionRef } from '../../../../core/session-state.ts';
import { IOS_SIMULATOR } from '@agent-device/test-kit';

// DEVICE_IN_USE named `SessionState.name`, and for an implicitly cwd-scoped session that is
// `default` while the session is stored — and addressable — as `cwd:<hash>:default`. Both the
// message and the recovery hint therefore pointed at a session no `--session` value could reach
// (#2031). The producer now takes the store key and reports that.

const SCOPED_ADDRESS = 'cwd:8bea844ab16aa9b3:default';

const scopedRef: SessionRef = makeStoredSessionRef(
  {
    name: 'default',
    sessionScope: { kind: 'cwd', id: '8bea844ab16aa9b3' },
    device: IOS_SIMULATOR,
    createdAt: 0,
    actions: [],
  },
  SCOPED_ADDRESS,
);

test('the by-session conflict reports the address, in the message, details and hint', () => {
  const response = buildDeviceInUseBySessionError(scopedRef, IOS_SIMULATOR, {}, 'named');

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error?.message).toBe(`Device is already in use by session "${SCOPED_ADDRESS}".`);
  expect(response.error?.details?.session).toBe(SCOPED_ADDRESS);
  expect(String(response.error?.details?.hint)).toContain(
    `agent-device close --session ${SCOPED_ADDRESS}`,
  );
});

// The session of another client on a proxy shared under one token is another client's handle
// (#4923): the refusal keeps the device fields and stays actionable through `session list`, and
// names nothing.
test('the by-session conflict names no session to a request that may not name it', () => {
  const response = buildDeviceInUseBySessionError(scopedRef, IOS_SIMULATOR, {}, 'anonymous');

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error?.code).toBe('DEVICE_IN_USE');
  expect(response.error?.message).toBe('Device is already in use by another session.');
  expect(response.error?.details?.session).toBeUndefined();
  expect(String(response.error?.details?.hint)).not.toContain(SCOPED_ADDRESS);
  expect(String(response.error?.details?.hint)).toContain('session list');
  expect(response.error?.details).toMatchObject({
    deviceId: IOS_SIMULATOR.id,
    deviceName: IOS_SIMULATOR.name,
  });
});

// The foreign-workspace conflict keeps naming its holder: the address is the only handle that
// reaches another workspace's implicit session, and its owner can close it from that folder
// (#2580).
test('the foreign-workspace conflict names the holder address it can be closed with', () => {
  const response = buildForeignWorkspaceSessionConflict(scopedRef, IOS_SIMULATOR, {
    offersDeviceWait: true,
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error?.code).toBe('DEVICE_IN_USE');
  expect(response.error?.message).toBe(
    `Device is already in use by workspace session "${SCOPED_ADDRESS}".`,
  );
  expect(response.error?.details).toMatchObject({
    reason: 'WORKSPACE_SESSION_SCOPE_CONFLICT',
    session: SCOPED_ADDRESS,
    deviceId: IOS_SIMULATOR.id,
  });
  expect(String(response.error?.details?.hint)).toContain(
    `agent-device close --session ${SCOPED_ADDRESS}`,
  );
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
    buildDeviceInUseBySessionError(scopedRef, IOS_SIMULATOR, { offersDeviceWait: true }, 'named')
      .error?.details?.hint,
  );

  expect(hint).not.toMatch(/Waited/);
  expect(hint).toContain('--wait <ms>');
});

// Only `open` carries --wait. An interaction refused by a busy device has to reuse or close the
// owning session, and a hint ending in a flag its command rejects sends it away from both.
test('a refusal from a command that cannot wait never offers the flag', () => {
  const hints = [
    buildDeviceInUseBySessionError(scopedRef, IOS_SIMULATOR, {}, 'named'),
    buildDeviceInUseBySessionError(scopedRef, IOS_SIMULATOR, {}, 'anonymous'),
    buildForeignWorkspaceSessionConflict(scopedRef, IOS_SIMULATOR, {}),
  ];

  for (const response of hints) {
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(String(response.error?.details?.hint)).not.toContain('--wait');
  }
});
