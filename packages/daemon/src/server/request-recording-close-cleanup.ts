import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  finishRecordingClaimClose,
  holdRecordingClaimForClose,
  type DeviceClaimSessionOwnership,
  type RetainedRecordingCleanup,
} from '@agent-device/daemon-contracts/device-claims';
import type { SessionStore } from '../core/session-store.ts';
import type { DeviceClaimAdmission } from '../resources/device/device-claim-admission.ts';

/** Keeps a promoted recording claim until close bindings have settled. */
export function createRequestRecordingCloseCleanup(params: {
  env: EnvMap;
  sessionName: string;
  sessionStore: SessionStore;
  claimAdmission: DeviceClaimAdmission;
}) {
  let finish: (() => Promise<void>) | undefined;
  let retain:
    | ((retry: () => Promise<'native-settled' | void>) => RetainedRecordingCleanup)
    | undefined;
  let recordingRetry: (() => Promise<void>) | undefined;
  let markEffectsStarted: (() => void) | undefined;
  return {
    recordingPending(retry: () => Promise<void>) {
      params.claimAdmission.runtimeDisposalFailed();
      recordingRetry = retry;
    },
    retainPending(bindingRetry?: () => Promise<void>) {
      if (!bindingRetry && !recordingRetry) return;
      const retry = async () => {
        await bindingRetry?.();
        await recordingRetry?.();
        if (recordingRetry) return 'native-settled' as const;
      };
      const retained = retain?.(retry) ?? params.claimAdmission.retainedRecordingCleanup(retry);
      if (retained) params.sessionStore.retainRecordingCleanup(params.sessionName, retained);
    },
    async retry(): Promise<'none' | 'settled' | 'released'> {
      const retained = params.sessionStore.recordingCleanup(params.sessionName);
      if (!retained || retained.purpose !== 'close') return 'none';
      const result = await params.claimAdmission.retryRecordingCleanup(retained.device, retained);
      if (result !== 'none')
        params.sessionStore.clearRecordingCleanup(params.sessionName, retained);
      if (result === 'none')
        throw new AppError('COMMAND_FAILED', 'Session close effects are not confirmed', {
          reason: 'cleanup-unconfirmed',
          retriable: true,
        });
      return result;
    },
    async hold(ownership: DeviceClaimSessionOwnership, device: DeviceInfo) {
      if (finish)
        throw new AppError('COMMAND_FAILED', 'Recording claim cleanup is already pending', {
          reason: 'cleanup-unconfirmed',
        });
      const held = await holdRecordingClaimForClose(ownership, params.env);
      if (held.status === 'ordinary') return undefined;
      if (held.status === 'cleanup-pending')
        throw new AppError('COMMAND_FAILED', 'Recording runtime cleanup is not confirmed', {
          reason: 'cleanup-unconfirmed',
          retriable: true,
        });
      if (held.status !== 'held') throw changedClaim();
      let release = false;
      let effectsStarted = held.resumed;
      markEffectsStarted = () => {
        effectsStarted = true;
      };
      retain = (retry) => ({
        device,
        owner: held.owner,
        fence: held.fence,
        ownership,
        purpose: 'close',
        releaseWhenComplete: release,
        sessionOwner: held.sessionOwner,
        retry,
      });
      finish = async () => {
        if (recordingRetry || (!release && effectsStarted)) return;
        const result = await finishRecordingClaimClose(
          ownership,
          held.fence,
          held.owner,
          held.sessionOwner,
          params.env,
          release,
        );
        if (result !== 'settled') throw changedClaim();
      };
      return () => {
        release = true;
      };
    },
    effectsStarted() {
      if (markEffectsStarted) markEffectsStarted();
    },
    finish: async () => await finish?.(),
  };
}

function changedClaim(): AppError {
  return new AppError('DEVICE_IN_USE', 'The recording device claim changed', {
    reason: 'DEVICE_CLAIM_OWNER_UNCERTAIN',
  });
}
