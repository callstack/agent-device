import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  localInteractorSource,
  providerInteractorSource,
  type LocalInteractorOperationResolver,
  type ProviderInteractorOperationResolver,
} from './interactor-operation-binding.ts';
import type {
  Interactor,
  RunnerContext,
  ScreenshotCaptureFacts,
  ScreenshotOptions,
} from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';

export type { ScreenshotCaptureFacts, ScreenshotOptions } from './interactor-types.ts';

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
  captureScreenshot(input: CaptureScreenshotInput): Promise<ScreenshotCaptureFacts>;
}>;

export type ScreenshotCaptureCapabilities = Readonly<{
  screenMask?: boolean;
}>;

type ScreenshotCaptureBindingOptions = Readonly<{
  signal: AbortSignal;
  captureCapabilities?: (options: Readonly<ScreenshotOptions>) => ScreenshotCaptureCapabilities;
}>;

export async function assertScreenshotCaptureSupport(
  options: Readonly<ScreenshotOptions> | undefined,
  capabilities: ScreenshotCaptureCapabilities = {},
): Promise<void> {
  if (options?.screenMask === undefined) return;
  const { readScreenshotScreenMask } = await import('./screenshot.ts');
  const screenMask = readScreenshotScreenMask(options?.screenMask);
  if (screenMask !== undefined && capabilities.screenMask !== true) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      '--screen-mask requires a handheld iOS simulator simctl capture',
      { reason: 'screenshot-screen-mask-unsupported' },
    );
  }
}

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
  binding: ScreenshotCaptureBindingOptions,
  resolveInteractor: (runner: RunnerContext) => Promise<Interactor>,
): ScreenshotRuntimeOperations {
  return Object.freeze({
    captureScreenshot: async (input: CaptureScreenshotInput) => {
      await assertScreenshotCaptureSupport(
        input.options,
        binding.captureCapabilities?.(input.options ?? {}),
      );
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal: binding.signal,
      });
      return (await interactor.screenshot(input.outPath, input.options)) ?? {};
    },
  });
}

export function bindLocalScreenshotInteractor(
  params: ScreenshotCaptureBindingOptions &
    Readonly<{
      device: DeviceInfo;
      resolveInteractor: LocalInteractorOperationResolver;
    }>,
): ScreenshotRuntimeOperations {
  return bindScreenshotCapture(params, localInteractorSource(params));
}

/** Provider bindings fail closed when their exact owner no longer exposes its interactor. */
export function bindProviderScreenshotInteractor(
  params: ScreenshotCaptureBindingOptions &
    Readonly<{
      device: DeviceInfo;
      resolveInteractor: ProviderInteractorOperationResolver;
    }>,
): ScreenshotRuntimeOperations {
  return bindScreenshotCapture(
    params,
    providerInteractorSource({ ...params, operation: 'screenshot' }),
  );
}
