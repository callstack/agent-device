import type { SessionIsolationMode } from '@agent-device/kernel/contracts';

export type { SessionIsolationMode };

// The request-scoping rules only the daemon applies. What the client shares with it — state-dir,
// server-mode, and transport resolution — lives at the process root in `src/daemon-resolution.ts`,
// which both sides import directly. Composing those helpers back in here would cost every importer
// that only needs a state dir one extra evaluated module, which ADR 0019's eager-closure probe
// caught at `src/cli.ts`.

export function resolveSessionIsolationMode(raw: string | undefined): SessionIsolationMode {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'tenant') return 'tenant';
  return 'none';
}

export function normalizeTenantId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) return undefined;
  return value;
}
