import { AppError } from '@agent-device/kernel/errors';
import { readCloudJsonResponse } from '../cloud-response.ts';

const VENDORS_PATH = '/v1/vendors';
const LIVE_QUERY = '?availability=live';
const AVAILABILITY_STATES = ['available', 'unavailable', 'unknown'] as const;
const AVAILABILITY_REASONS = [
  'sessions_paused',
  'vendor_disabled',
  'vendor_unconfigured',
  'broker_capacity',
  'capacity_unknown',
  'live_availability_unsupported',
] as const;
const MICROS_PATTERN = /^\d{1,15}$/;

export type CloudVendorAvailability = {
  state: (typeof AVAILABILITY_STATES)[number];
  reason?: (typeof AVAILABILITY_REASONS)[number];
  checkedAt: string;
  scope: 'broker_vendor';
};

export type CloudVendorRow = {
  vendor: string;
  platform: string;
  usdPerMinute: number;
  capabilities: string[];
  viewer: boolean;
  /** Configured and operator-enabled. It says nothing about occupancy or provider stock. */
  available: boolean;
  usdMicrosPerMinute?: string;
  minMinutes?: number;
  /** Present only on a live listing. */
  availability?: CloudVendorAvailability;
};

/**
 * The authenticated vendor catalog. A static listing returns the server's rows as sent.
 * A live listing guarantees every row carries
 * `availability`: rows from a server that predates the signal get a typed unknown state.
 */
export async function listCloudVendors(
  baseUrl: string,
  accessToken: string,
  options: { live?: boolean; now?: () => number } = {},
): Promise<CloudVendorRow[]> {
  const response = await requestCloud(baseUrl, `${VENDORS_PATH}${options.live ? LIVE_QUERY : ''}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const rows = await readCloudJsonResponse<unknown>(response, {
    invalidJsonMessage: 'Cloud session API returned invalid JSON.',
    rejectedMessage: 'Cloud session API could not list vendors.',
  });
  if (!Array.isArray(rows) || !rows.every(isCloudVendorRow)) {
    throw new AppError('COMMAND_FAILED', 'Cloud session API returned an invalid vendor list.');
  }
  if (!options.live) return rows;
  const checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  return rows.map((row) =>
    row.availability ? row : { ...row, availability: unsupportedAvailability(checkedAt) },
  );
}

function unsupportedAvailability(checkedAt: string): CloudVendorAvailability {
  return {
    state: 'unknown',
    reason: 'live_availability_unsupported',
    checkedAt,
    scope: 'broker_vendor',
  };
}

function isCloudVendorRow(value: unknown): value is CloudVendorRow {
  const row = asRecord(value);
  return (
    !!row &&
    nonEmpty(row.vendor) &&
    nonEmpty(row.platform) &&
    typeof row.usdPerMinute === 'number' &&
    Number.isFinite(row.usdPerMinute) &&
    isStringArray(row.capabilities) &&
    typeof row.viewer === 'boolean' &&
    typeof row.available === 'boolean' &&
    isOptional(row.usdMicrosPerMinute, isMicros) &&
    isOptional(row.minMinutes, isPositiveInteger) &&
    isOptional(row.availability, isAvailability)
  );
}

function isOptional(value: unknown, valid: (value: unknown) => boolean): boolean {
  return value === undefined || valid(value);
}

function isMicros(value: unknown): boolean {
  return typeof value === 'string' && MICROS_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isAvailability(value: unknown): boolean {
  const availability = asRecord(value);
  return (
    !!availability &&
    isMember(AVAILABILITY_STATES, availability.state) &&
    isOptional(availability.reason, (reason) => isMember(AVAILABILITY_REASONS, reason)) &&
    typeof availability.checkedAt === 'string' &&
    Number.isFinite(Date.parse(availability.checkedAt)) &&
    availability.scope === 'broker_vendor'
  );
}

function isMember(set: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && set.includes(value);
}

export function formatCloudVendorRow(row: CloudVendorRow): string {
  const minimum = row.minMinutes === undefined ? '' : `  minimum: ${row.minMinutes} min`;
  const { availability } = row;
  const live = availability
    ? `  availability: ${availability.state}${availability.reason ? ` (${availability.reason})` : ''}`
    : '';
  return `${row.vendor} ${row.platform}  $${row.usdPerMinute}/min${minimum}  capabilities: ${row.capabilities.join(', ') || 'none'}  live view: ${row.viewer ? 'yes' : 'no'}  available: ${row.available ? 'yes' : 'no'}${live}`;
}

async function requestCloud(baseUrl: string, pathname: string, init: RequestInit) {
  try {
    return await fetch(new URL(pathname, baseUrl), {
      ...init,
      redirect: 'error',
    });
  } catch {
    throw new AppError('COMMAND_FAILED', 'Could not reach the cloud session API.');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmpty);
}
