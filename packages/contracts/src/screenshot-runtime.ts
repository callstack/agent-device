import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { Interactor, RunnerContext, ScreenshotOptions } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';

export type { ScreenshotOptions } from './interactor-types.ts';

/** Runner metadata needed by the selected capture implementation, without request-owned state. */
export type ScreenshotRuntimeExecution = Readonly<Omit<RunnerContext, 'appBundleId' | 'signal'>>;

/**
 * Neutral capture intent. The destination is the caller's already-reserved artifact path — the
 * runtime never invents one — and the request binding supplies cancellation and exact-owner
 * authority.
 */
export type CaptureScreenshotInput = Readonly<{
  outPath: string;
  options?: Readonly<ScreenshotOptions>;
  execution?: ScreenshotRuntimeExecution;
}>;

export type ScreenshotRuntimeOperations = Readonly<{
  captureScreenshot(input: CaptureScreenshotInput): Promise<void>;
}>;

export type ScreenshotRuntimeOperationFacts = Readonly<{
  captureScreenshot: RuntimeOperationFact;
}>;

/** Builds the owner claim for the single capture requirement. */
export function screenshotRuntimeOperationFacts(
  input: Readonly<{ capture: RuntimeOperationFact }>,
): ScreenshotRuntimeOperationFacts {
  return Object.freeze({ captureScreenshot: input.capture });
}

/**
 * Captures one selected owner's interactor authority for the lifetime of a request binding. The
 * owner is already chosen by the time a binder is called, so each entry point supplies its own
 * resolution and this holds only what both share: the runner context and the capture itself.
 */
function bindScreenshotCapture(
  signal: AbortSignal,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): ScreenshotRuntimeOperations {
  return Object.freeze({
    captureScreenshot: async (input: CaptureScreenshotInput) => {
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal,
      });
      await interactor.screenshot(input.outPath, input.options);
    },
  });
}

export function bindLocalScreenshotInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: (device: DeviceInfo, runner: RunnerContext) => Promise<Interactor>;
  }>,
): ScreenshotRuntimeOperations {
  return bindScreenshotCapture(
    params.signal,
    async (runner) => await params.resolveInteractor(params.device, runner),
  );
}

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderScreenshotInteractor(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: (runner: RunnerContext) => Interactor | undefined;
  }>,
): ScreenshotRuntimeOperations {
  return bindScreenshotCapture(params.signal, async (runner) => {
    const interactor = params.resolveInteractor(runner);
    if (interactor) return interactor;
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Provider-owned screenshot operation has no bound provider interactor.',
      { reason: 'provider-runtime-interactor-missing', deviceId: params.device.id },
    );
  });
}
