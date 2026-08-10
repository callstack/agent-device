import {
  CLOUD_TEXT_ENTRY_READINESS,
  type CloudTextEntryReadiness,
  type FillBackendResult,
  type FillVerificationTarget,
} from '@agent-device/contracts/interaction';

type RawUnconfirmedVerification = Record<string, unknown> & {
  requested: string;
  before: string | null;
  after: string | null;
};

export function readFillBackendResult(result: Record<string, unknown> | void): FillBackendResult {
  const readiness = result ? result.textEntryReadiness : undefined;
  const textEntryReadiness = isCloudTextEntryReadiness(readiness)
    ? { textEntryReadiness: readiness }
    : {};
  const unconfirmed = readFillUnconfirmedVerification(result);
  return unconfirmed ? { ...textEntryReadiness, ...unconfirmed } : textEntryReadiness;
}

function readFillUnconfirmedVerification(
  result: Record<string, unknown> | void,
): Extract<FillBackendResult, { verification: 'unconfirmed' }> | null {
  if (!isRawUnconfirmedVerification(result)) return null;
  const target = readFillVerificationTarget(result.target);
  if (!target) return null;
  return {
    verification: 'unconfirmed',
    requested: result.requested,
    before: result.before,
    after: result.after,
    target,
  };
}

function isRawUnconfirmedVerification(
  value: Record<string, unknown> | void,
): value is RawUnconfirmedVerification {
  return Boolean(
    value &&
    value.verification === 'unconfirmed' &&
    typeof value.requested === 'string' &&
    isNullableString(value.before) &&
    isNullableString(value.after),
  );
}

function readFillVerificationTarget(value: unknown): FillVerificationTarget | null {
  if (!isRecord(value) || !hasFillVerificationTargetIdentity(value)) return null;
  const rect = readRect(value.rect);
  if (!rect) return null;
  return {
    resourceId: value.resourceId,
    className: value.className,
    packageName: value.packageName,
    rect,
  };
}

function hasFillVerificationTargetIdentity(
  value: Record<string, unknown>,
): value is Record<string, unknown> & Omit<FillVerificationTarget, 'rect'> {
  return (
    isNullableString(value.resourceId) &&
    isNullableString(value.className) &&
    isNullableString(value.packageName)
  );
}

function isCloudTextEntryReadiness(value: unknown): value is CloudTextEntryReadiness {
  return (
    typeof value === 'string' && (CLOUD_TEXT_ENTRY_READINESS as readonly string[]).includes(value)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function readRect(value: unknown): FillVerificationTarget['rect'] | null {
  if (!isRecord(value)) return null;
  const parts = [value.x, value.y, value.width, value.height];
  if (!parts.every((part) => typeof part === 'number')) return null;
  return value as FillVerificationTarget['rect'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
