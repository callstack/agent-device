import type { SessionIsolationMode } from '@agent-device/kernel/contracts';

export type { SessionIsolationMode };

// The state-dir resolution the client also needs lives at the process root, so reaching it does not
// pull a client into daemon internals; this module composes back what the daemon's own importers
// read from here, and adds the request-scoping rules only the daemon applies. The transport and
// server-mode types stay at the root leaf for the client, which imports them directly.
export {
  resolveDaemonPaths,
  resolveDaemonServerMode,
  type DaemonPaths,
} from '../daemon-resolution.ts';

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
