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
import type { ScreenshotCaptureBackend } from './screenshot.ts';

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
  options?: Readonly<ScreenshotOptions & { preferredCaptureBackend?: ScreenshotCaptureBackend }>;
  execution?: ScreenshotRuntimeExecution;
}>;

export type ScreenshotRuntimeOperations = Readonly<{
  captureScreenshot(input: CaptureScreenshotInput): Promise<ScreenshotCaptureFacts>;
}>;

export type ScreenshotCaptureCapabilities = Readonly<{
  screenMask?: boolean;
  /** The backends a request can select on this owner; an absent list selects none. */
  captureBackends?: readonly ScreenshotCaptureBackend[];
  /** Why this owner cannot serve a selected backend. */
  captureBackendRefusal?: string;
}>;

type ScreenshotCaptureBindingOptions = Readonly<{
  signal: AbortSignal;
  captureCapabilities: (options: Readonly<ScreenshotOptions>) => ScreenshotCaptureCapabilities;
}>;

/** The declaration of an owner that captures one way only, and why. */
export function defaultCaptureOnly(
  captureBackendRefusal: string,
): (options: Readonly<ScreenshotOptions>) => ScreenshotCaptureCapabilities {
  return () => ({ captureBackendRefusal });
}

export async function assertScreenshotCaptureSupport(
  options: Readonly<ScreenshotOptions> | undefined,
  capabilities: ScreenshotCaptureCapabilities = {},
): Promise<void> {
  const backend = options?.captureBackend;
  if (backend !== undefined && !capabilities.captureBackends?.includes(backend)) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `--capture-backend ${backend} is not supported: ${capabilities.captureBackendRefusal ?? 'this capture owner declares no such backend'}`,
      { reason: 'screenshot-capture-backend-unsupported' },
    );
  }
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

/** A preference, unlike `captureBackend`, keeps the owner's default where it declares no such backend. Maestro's comparison capture asks for one. */
function resolveCaptureOptions(
  input: CaptureScreenshotInput['options'],
  binding: ScreenshotCaptureBindingOptions,
): Readonly<ScreenshotOptions> {
  const { captureBackend: explicit, preferredCaptureBackend: preferred, ...options } = input ?? {};
  if (explicit) return { ...options, captureBackend: explicit };
  return preferred && binding.captureCapabilities(options).captureBackends?.includes(preferred)
    ? { ...options, captureBackend: preferred }
    : options;
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
      const options = resolveCaptureOptions(input.options, binding);
      await assertScreenshotCaptureSupport(options, binding.captureCapabilities(options));
      const interactor = await resolveInteractor({
        ...input.execution,
        appBundleId: input.options?.appBundleId,
        signal: binding.signal,
      });
      return (await interactor.screenshot(input.outPath, options)) ?? {};
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
