import { isCommandSupportedOnDevice, unsupportedHintForDevice } from '../../core/capabilities.ts';
import type { DeviceInfo } from '../../utils/device.ts';
import type { DaemonResponse } from '../types.ts';

export type DaemonFailureResponse = Extract<DaemonResponse, { ok: false }>;

export const NO_ACTIVE_SESSION_MESSAGE = 'No active session. Run open first.';

export function errorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DaemonFailureResponse {
  return {
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
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
 * Capability guard: returns an `UNSUPPORTED_OPERATION` failure when `command` is not
 * supported on `device`, otherwise `null`. Pass `message` to override the default
 * "<command> is not supported on this device" text, or `hint: true` to attach the
 * device-specific unsupported hint (as generic command dispatch does).
 */
export function requireCommandSupported(
  command: string,
  device: DeviceInfo,
  options?: { message?: string; hint?: boolean },
): DaemonFailureResponse | null {
  if (isCommandSupportedOnDevice(command, device)) return null;
  const hint = options?.hint ? unsupportedHintForDevice(command, device) : undefined;
  return {
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: options?.message ?? `${command} is not supported on this device`,
      ...(hint ? { hint } : {}),
    },
  };
}
