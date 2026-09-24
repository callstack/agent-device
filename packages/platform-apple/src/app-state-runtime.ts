import type {
  AppStateRuntimeInput,
  AppStateRuntimeOperations,
  AppStateRuntimeResult,
} from '@agent-device/contracts/app-state-runtime';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

/** Resolves the selected owner's interactor, exactly as the element text runtime does. */
export type AppStateInteractorResolver = (
  device: DeviceInfo,
  runner: RunnerContext,
) => Promise<Interactor>;

/**
 * Binds the runner's read of the session app's state for the lifetime of a request binding, on the
 * `Interactor` seam the point reads use. The read never starts a runner: with no live runner session
 * (a bridge simulator right after `open`, an idle-stopped runner, a device whose runner is down) it
 * answers nothing and the session record alone answers upstream. That is what keeps `appState` on
 * the simulator host in the runner-demand table, since it demands no runner of its own.
 */
export function bindAppleAppStateRuntime(
  host: Pick<PlatformRuntimeHost, 'appleApplications'>,
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: AppStateInteractorResolver;
  }>,
): AppStateRuntimeOperations {
  return Object.freeze({
    appState: async (input?: AppStateRuntimeInput): Promise<AppStateRuntimeResult> => {
      params.signal.throwIfAborted();
      if (!(await host.appleApplications.hasLiveRunnerSession(params.device, {}))) return {};
      const interactor = await params.resolveInteractor(params.device, {
        appBundleId: input?.appBundleId,
        signal: params.signal,
      });
      if (typeof interactor.appState !== 'function') {
        // Facts advertised the read but the interactor cannot perform it: a contract bug (ADR 0019
        // §2), not a refusal, so nothing upstream may answer from the session record instead.
        throw new AppError(
          'COMMAND_FAILED',
          'Runtime owner advertised appState without an interactor implementation',
          {
            reason: 'runtime-contract-invalid',
            hint: 'This is an agent-device runtime contract bug; report the selected device and command.',
          },
        );
      }
      return await interactor.appState();
    },
  });
}
