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
  let retain: ((retry: () => Promise<void>) => RetainedRecordingCleanup) | undefined;
  let recordingRetry: (() => Promise<void>) | undefined;
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
      };
      const retained = retain?.(retry) ?? params.claimAdmission.retainedRecordingCleanup(retry);
      if (retained) params.sessionStore.retainRecordingCleanup(params.sessionName, retained);
    },
    async retry(): Promise<boolean> {
      const retained = params.sessionStore.recordingCleanup(params.sessionName);
      if (!retained || retained.purpose !== 'close') return false;
      const result = await params.claimAdmission.retryRecordingCleanup(retained.device, retained);
      if (result !== 'none')
        params.sessionStore.clearRecordingCleanup(params.sessionName, retained);
      if (result !== 'released')
        throw new AppError('COMMAND_FAILED', 'Session close effects are not confirmed', {
          reason: 'cleanup-unconfirmed',
          retriable: true,
        });
      return true;
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
      retain = (retry) => ({
        device,
        owner: held.owner,
        fence: held.fence,
        ownership,
        purpose: 'close',
        releaseWhenComplete: release,
        retry,
      });
      finish = async () => {
        const result = await finishRecordingClaimClose(
          ownership,
          held.fence,
          held.owner,
          params.env,
          release,
        );
        if (result !== 'settled') throw changedClaim();
      };
      return () => {
        release = true;
      };
    },
    finish: async () => await finish?.(),
  };
}

function changedClaim(): AppError {
  return new AppError('DEVICE_IN_USE', 'The recording device claim changed', {
    reason: 'DEVICE_CLAIM_OWNER_UNCERTAIN',
  });
}
