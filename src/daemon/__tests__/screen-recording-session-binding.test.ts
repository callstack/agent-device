import { expect, test, vi } from 'vitest';
import { createScreenRecordingLiveHandle } from '@agent-device/capture-kit';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeRecordingSession } from './session-teardown.fixtures.ts';
import { bindRecordOnlyScreenRecording } from '../screen-recording-session-binding.ts';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import {
  adoptStartedScreenRecording,
  screenRecordingDurableResource,
} from '@agent-device/capture-kit/screen-recording-session-resource';

test('shutdown refuses draft publication while retaining unconfirmed recording cleanup evidence', async () => {
  const store = makeSessionStore();
  const session = makeRecordingSession({
    name: 'draft',
    sessionStore: store,
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
  });
  const { handle: initial, envelope } = session.screenRecording!;
  const cleanup = vi.fn(
    async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }) as const,
  );
  const handle = createScreenRecordingLiveHandle(initial.inspect(), {
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
    forceCleanup: cleanup,
  });
  const draft = bindRecordOnlyScreenRecording(store, 'draft', {
    ...session,
    screenRecording: undefined,
  });
  store.closeAdmission();
  await expect(
    adoptStartedScreenRecording({
      binding: draft.binding,
      admissionLedger: createScreenRecordingAdmissionLedger(),
      device: session.device,
      owner: envelope.owner,
      fence: envelope.fence,
      pendingHandle: new PendingTransferGuard(handle),
      envelope,
      throwIfCanceled: () => {},
    }),
  ).rejects.toMatchObject({ details: { reason: 'daemon_shutting_down' } });
  expect(cleanup).toHaveBeenCalledOnce();
  expect(store.lookup('draft')).toBeUndefined();
  const record = screenRecordingDurableResource.store.read(
    screenRecordingDurableResource.store.resolvePath(draft.binding.sessionDir),
  );
  expect(record).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      descriptor: envelope.descriptor,
      metadata: { phase: 'cleanup-pending' },
    },
  });
  if (record.status !== 'decoded') throw new Error('Expected recovery evidence');
  expect(record.envelope.metadata?.runtimeContractInvalid).toBeUndefined();
});
