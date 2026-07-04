import { AppError } from '../kernel/errors.ts';

type TenantOwnedEntry = { tenantId?: string };

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
    reason: 'RESOURCE_EXPIRED',
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
  if (entry.tenantId && entry.tenantId !== tenantId) {
    throw new AppError(
      'UNAUTHORIZED',
      `${kind.label} ${kind.plural ? 'belong' : 'belongs'} to a different tenant`,
    );
  }
  return entry;
}
