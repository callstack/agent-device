import { test, expect } from 'vitest';
import { buildDeviceInUseBySessionError } from '../../../session-recovery-hints.ts';
import type { SessionRef } from '../../../types.ts';
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
