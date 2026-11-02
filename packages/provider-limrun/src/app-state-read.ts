import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import { AppError } from '@agent-device/kernel/errors';
import type { LimrunDeviceSession } from './device-session.ts';
import { awaitLimrunOperation } from './request-cancellation.ts';

/**
 * Android reads the foreground app. Limrun exposes no foreground bundle id on iOS, so an iOS read
 * only proves the instance still answers: its empty result leaves the session record to name the
 * app, and a failure stops that record answering for an instance that is gone.
 */
export async function readLimrunAppState(
  session: LimrunDeviceSession | undefined,
  signal: AbortSignal,
): Promise<AppStateRuntimeResult> {
  signal.throwIfAborted();
  if (session?.platform === 'ios') {
    await confirmLimrunIosInstanceAnswers(session, signal);
    return {};
  }
  if (session?.platform !== 'android') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Limrun Android appstate requires an active provider session',
    );
  }
  const state = await session.getForegroundApp(signal);
  signal.throwIfAborted();
  return { package: state?.appId, activity: state?.activity };
}

async function confirmLimrunIosInstanceAnswers(
  session: LimrunDeviceSession,
  signal: AbortSignal,
): Promise<void> {
  try {
    await awaitLimrunOperation(session.listApps(), signal);
  } catch (error) {
    signal.throwIfAborted();
    throw new AppError(
      'COMMAND_FAILED',
      'The Limrun iOS instance did not answer, so its app state is unknown.',
      {
        reason: 'limrun_instance_unreachable',
        hint: 'The instance may have been terminated. Run connect limrun and open again.',
      },
      error,
    );
  }
}
