import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

export const TENANT_RESOURCE_REASONS = {
  // The artifact, upload, or path id expired or never existed; the daemon cannot tell which.
  expired: { reason: 'RESOURCE_EXPIRED' },
} as const satisfies ReasonTable<'daemon resources'>;

type TenantOwnedEntry = { tenantId?: string | null };

/** An explicit null owner restricts access to the shared, unnamed tenant scope. */
export function matchesTenantOwnedEntry(
  entry: TenantOwnedEntry,
  tenantId: string | undefined,
): boolean {
  return entry.tenantId === null
    ? tenantId === undefined
    : !entry.tenantId || entry.tenantId === tenantId;
}

export type TenantOwnedResourceKind = {
  label: string;
  /** Set when the label is grammatically plural ("Materialized paths belong ..."). */
  plural?: boolean;
  expiredHint: string;
};

/**
 * TTL registries GC entries silently, so a missing id is indistinguishable
 * from one that never existed — report both as expiry, not INVALID_ARGS.
 */
export function expiredTenantOwnedEntryError(kind: TenantOwnedResourceKind, id: string): AppError {
  return new AppError('COMMAND_FAILED', `${kind.label} not found or expired: ${id}`, {
    reason: TENANT_RESOURCE_REASONS.expired.reason,
    hint: kind.expiredHint,
  });
}

export function requireTenantOwnedEntry<T extends TenantOwnedEntry>(
  map: Map<string, T>,
  id: string,
  tenantId: string | undefined,
  kind: TenantOwnedResourceKind,
): T {
  const entry = map.get(id);
  if (!entry) {
    throw expiredTenantOwnedEntryError(kind, id);
  }
  if (!matchesTenantOwnedEntry(entry, tenantId)) {
    throw new AppError(
      'UNAUTHORIZED',
      `${kind.label} ${kind.plural ? 'belong' : 'belongs'} to a different tenant`,
    );
  }
  return entry;
}
