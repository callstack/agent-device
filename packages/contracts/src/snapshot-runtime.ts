import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  Interactor,
  RunnerContext,
  SnapshotOptions,
  SnapshotResult,
} from './interactor-types.ts';

export type { SnapshotResult } from './interactor-types.ts';

/** Runner metadata needed by the selected snapshot implementation, without request-owned state. */
export type SnapshotRuntimeExecution = Readonly<Omit<RunnerContext, 'appBundleId' | 'signal'>>;

/** Neutral snapshot intent. The request binding supplies cancellation and exact-owner authority. */
export type CaptureSnapshotInput = Readonly<{
  options?: Readonly<Omit<SnapshotOptions, 'signal'>>;
  execution?: SnapshotRuntimeExecution;
}>;

export type SnapshotRuntimeOperations = Readonly<{
  captureSnapshot(input: CaptureSnapshotInput): Promise<SnapshotResult>;
}>;

/** Existing desktop-surface mechanics injected without exposing daemon/session ownership. */
export type SnapshotRuntimeHost = Readonly<{
  apple: Readonly<{
    captureSurface(
      device: DeviceInfo,
      options: CaptureSnapshotInput['options'],
      signal: AbortSignal,
    ): Promise<SnapshotResult>;
  }>;
  linux: Readonly<{
    captureSurface(
      device: DeviceInfo,
      options: CaptureSnapshotInput['options'],
      signal: AbortSignal,
    ): Promise<SnapshotResult>;
  }>;
}>;

export type LocalSnapshotInteractorResolver = (
  device: DeviceInfo,
  runner: RunnerContext,
) => Promise<Interactor>;

export type ProviderSnapshotInteractorResolver = (runner: RunnerContext) => Interactor | undefined;

type SnapshotInteractorBindingParams =
  | Readonly<{
      device: DeviceInfo;
      signal: AbortSignal;
      ownership: 'local';
      resolveInteractor: LocalSnapshotInteractorResolver;
    }>
  | Readonly<{
      device: DeviceInfo;
      signal: AbortSignal;
      ownership: 'provider';
      resolveInteractor: ProviderSnapshotInteractorResolver;
    }>;

/** Captures one selected owner's interactor authority for the lifetime of a request binding. */
function bindSnapshotInteractor(
  params: SnapshotInteractorBindingParams,
): SnapshotRuntimeOperations {
  return Object.freeze({
    captureSnapshot: async (input) => {
      const runner: RunnerContext = {
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal: params.signal,
      };
      const interactor =
        params.ownership === 'local'
          ? await params.resolveInteractor(params.device, runner)
          : params.resolveInteractor(runner);
      if (!interactor) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Provider-owned snapshot operation has no bound provider interactor.',
          { reason: 'provider-runtime-interactor-missing', deviceId: params.device.id },
        );
      }
      return await interactor.snapshot({ ...input.options, signal: params.signal });
    },
  });
}

export function bindLocalSnapshotInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalSnapshotInteractorResolver;
  }>,
): SnapshotRuntimeOperations {
  return bindSnapshotInteractor({ ...params, ownership: 'local' });
}

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderSnapshotInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: ProviderSnapshotInteractorResolver;
  }>,
): SnapshotRuntimeOperations {
  return bindSnapshotInteractor({ ...params, ownership: 'provider' });
}
