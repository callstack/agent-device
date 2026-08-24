import { isCommandSupportedOnDevice, unsupportedHintForDevice } from '../../core/capabilities.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonResponse } from '../types.ts';

export type DaemonFailureResponse = Extract<DaemonResponse, { ok: false }>;

export const NO_ACTIVE_SESSION_MESSAGE = 'No active session. Run open first.';

export function errorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  options?: { hint?: string; retriable?: boolean },
): DaemonFailureResponse {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(options?.hint ? { hint: options.hint } : {}),
      ...(options?.retriable === undefined ? {} : { retriable: options.retriable }),
      ...(details ? { details } : {}),
    },
  };
}

/**
 * Shared "No active session. Run open first." failure used by handlers that require
 * an open session before dispatching.
 */
export function noActiveSessionError(): DaemonFailureResponse {
  return errorResponse('SESSION_NOT_FOUND', NO_ACTIVE_SESSION_MESSAGE);
}

/**
 * Capability guard: returns an `UNSUPPORTED_OPERATION` failure when `command` is not supported on
 * `device`, otherwise `null`. Pass `hint: true` to attach the device-specific unsupported hint.
 *
 * The `message` override left with R61: `react-native` was its only caller, and a migrated command
 * states its own refusal through the admission seam's `unavailableResponse` instead.
 */
export function requireCommandSupported(
  command: string,
  device: DeviceInfo,
  options?: { hint?: boolean },
): DaemonFailureResponse | null {
  if (isCommandSupportedOnDevice(command, device)) return null;
  const hint = options?.hint ? unsupportedHintForDevice(command, device) : undefined;
  return {
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: `${command} is not supported on this device`,
      ...(hint ? { hint } : {}),
    },
  };
}
