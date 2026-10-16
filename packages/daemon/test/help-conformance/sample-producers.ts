import type { DeviceInfo } from '@agent-device/kernel/device';
import { buildAmbiguousMatchError } from '../../src/execution/selector-match-errors.ts';
import { refMutationAdmissionResponse } from '../../src/execution/interaction/internal/interaction-ref-policy.ts';
import { resolveRefStalenessWarning } from '../../src/execution/session-snapshot.ts';
import { activateCompleteRefFrame, readRefMutationFrame } from '../../src/core/ref-frame.ts';
import type { SessionState } from '../../src/core/session-state.ts';
import { buildDeviceInUseBySessionError } from '../../src/core/session-recovery-hints.ts';
import { buildDeviceClaimConflictError } from '../../src/resources/device/device-claim-conflict.ts';

function buildDaemonErrorSampleResponses() {
  const owningSession = {
    address: 'checkout',
    session: { name: 'checkout' } as SessionState,
  };
  const device = { id: 'SIM-001', name: 'iPhone 17 Pro' } as Parameters<
    typeof buildDeviceInUseBySessionError
  >[1];
  const deviceInUse = buildDeviceInUseBySessionError(owningSession, device);

  const claimDevice: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
  };
  const deviceClaimInUse = buildDeviceClaimConflictError(claimDevice, {
    fileName: 'claim.json',
    deviceKey: 'local:android:none:emulator-5554',
    classification: 'live',
    claim: {
      schemaVersion: 2,
      deviceKey: 'local:android:none:emulator-5554',
      device: {
        family: 'android',
        id: 'emulator-5554',
        name: 'Pixel',
        kind: 'emulator',
      },
      session: 'checkout',
      workspace: '/worktrees/checkout',
      stateDir: '/state/checkout',
      ownerPid: 4242,
      ownerStartTime: 'start',
      ownerToken: 'token',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  });

  const session = { snapshotGeneration: 7 } as SessionState;
  activateCompleteRefFrame(session);
  const ref = '@e12';
  const mintedGeneration = 5;
  const staleRef = refMutationAdmissionResponse({
    ref,
    mintedGeneration,
    staleRefsWarning: resolveRefStalenessWarning({ session, ref, mintedGeneration }),
    frame: readRefMutationFrame({ session, ref, mintedGeneration }),
  });
  if (!staleRef) throw new Error('Expected the stale ref producer to refuse the mutation');

  const matches = [
    { ref: 'e2', type: 'Button', label: 'Follow' },
    { ref: 'e5', type: 'Button', label: 'Follow' },
    { ref: 'e9', type: 'Button', label: 'Follow' },
  ] as Parameters<typeof buildAmbiguousMatchError>[0];

  return {
    deviceInUse,
    deviceClaimInUse,
    staleRef,
    ambiguousMatch: buildAmbiguousMatchError(matches, 'text', 'Follow'),
  };
}

process.stdout.write(JSON.stringify(buildDaemonErrorSampleResponses()));
