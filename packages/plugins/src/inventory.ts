import { normalizeError } from '@agent-device/kernel/errors';
import type { PluginInventoryError } from '@agent-device/contracts/plugin-inventory';

export function describePluginFailure(error: unknown): PluginInventoryError {
  const normalized = normalizeError(error);
  const reason = normalized.details?.reason;
  return {
    code: normalized.code,
    message: normalized.message,
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(normalized.hint ? { hint: normalized.hint } : {}),
  };
}
