import {
  DEFAULT_IOS_SCROLL_AMOUNT,
  DEFAULT_IOS_SCROLL_DURATION_MS,
  type ScrollExecutionOptions,
} from '@agent-device/contracts/scroll-command';
import { SCROLL_KEYBOARD_OCCLUDES_SURFACE_DETAILS } from '@agent-device/contracts/scroll-gesture';
import { AppError } from '@agent-device/kernel/errors';
import { SCROLL_KEYBOARD_OCCLUDES_SURFACE_RUNNER_CODE } from '@agent-device/apple-runner';

export type AppleScrollOptions = ScrollExecutionOptions;

/**
 * Gives the runner's keyboard-occlusion refusal the shared reason and hint (#2500). The runner
 * measured the keyboard in its own coordinate space, so its message and transport details
 * (`runnerErrorCode`, `logPath`) are kept as they are; only the details every platform publishes
 * are added, matched on the typed runner code rather than on error text.
 */
export function withAppleScrollKeyboardOcclusion(error: unknown): unknown {
  if (!(error instanceof AppError)) return error;
  if (error.details?.['runnerErrorCode'] !== SCROLL_KEYBOARD_OCCLUDES_SURFACE_RUNNER_CODE) {
    return error;
  }
  return new AppError(error.code, error.message, {
    ...error.details,
    ...SCROLL_KEYBOARD_OCCLUDES_SURFACE_DETAILS,
  });
}

export function materializeIosScrollOptions(
  options: AppleScrollOptions | undefined,
): AppleScrollOptions {
  const hasExplicitDistance = options?.amount !== undefined || options?.pixels !== undefined;
  return {
    ...options,
    ...(!hasExplicitDistance ? { amount: DEFAULT_IOS_SCROLL_AMOUNT } : {}),
    durationMs: options?.durationMs ?? DEFAULT_IOS_SCROLL_DURATION_MS,
    releaseBehavior: options?.releaseBehavior ?? 'controlled',
  };
}
