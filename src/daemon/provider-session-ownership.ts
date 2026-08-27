import type { DeviceLease } from '@agent-device/contracts/device';

const DEFAULT_PROVIDER_SESSION_RETENTION_MS = 5 * 60_000;

export type ProviderSessionOwnership = Readonly<{
  provider: string;
  providerSessionId: string;
  leaseId: string;
  tenantId: string;
}>;

type ProviderSessionRecord = ProviderSessionOwnership & {
  retainedUntil?: number;
};

export function providerSessionIdFromData(
  providerData: Record<string, unknown> | undefined,
): string | undefined {
  const providerSessionId = providerData?.providerSessionId;
  return typeof providerSessionId === 'string' && providerSessionId.trim().length > 0
    ? providerSessionId.trim()
    : undefined;
}

export class ProviderSessionOwnershipRegistry {
  private readonly records = new Map<string, ProviderSessionRecord>();
  private readonly now: () => number;
  private readonly retentionMs: number;

  constructor(options: { now?: () => number; retentionMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.retentionMs = Number.isInteger(options.retentionMs)
      ? Math.max(0, Number(options.retentionMs))
      : DEFAULT_PROVIDER_SESSION_RETENTION_MS;
  }

  record(lease: Pick<DeviceLease, 'leaseId' | 'tenantId' | 'leaseProvider'>, rawId: string): void {
    const provider = lease.leaseProvider?.trim();
    const providerSessionId = rawId.trim();
    if (!provider || !providerSessionId) return;
    this.prune();
    const ownership: ProviderSessionOwnership = {
      provider,
      providerSessionId,
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
    };
    this.records.set(this.key(provider, providerSessionId), ownership);
  }

  markLeaseReleased(
    lease: Pick<DeviceLease, 'leaseId' | 'leaseProvider'>,
    releasedAt = this.now(),
  ): void {
    const provider = lease.leaseProvider?.trim();
    if (!provider) return;
    this.prune();
    const retainedUntil = releasedAt + this.retentionMs;
    for (const [key, record] of this.records) {
      if (record.provider !== provider || record.leaseId !== lease.leaseId) continue;
      this.records.set(key, { ...record, retainedUntil });
    }
  }

  resolve(params: {
    provider?: string;
    providerSessionId?: string;
    tenantId?: string;
  }): ProviderSessionOwnership | undefined {
    const provider = params.provider?.trim();
    const providerSessionId = params.providerSessionId?.trim();
    const tenantId = params.tenantId?.trim();
    if (!provider || !providerSessionId || !tenantId) return undefined;
    this.prune();
    const record = this.records.get(this.key(provider, providerSessionId));
    if (!record || record.tenantId !== tenantId) return undefined;
    return { ...record };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.retainedUntil !== undefined && record.retainedUntil <= now) {
        this.records.delete(key);
      }
    }
  }

  private key(provider: string, providerSessionId: string): string {
    return JSON.stringify([provider, providerSessionId]);
  }
}
