import type { CommandFlags } from '@agent-device/contracts/command';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest, SessionScope, SessionState } from './types.ts';
import { SessionStore } from './session-store.ts';

const DEFAULT_SESSION_NAME = 'default';
const IMPLICIT_SESSION_KEY_PREFIX = 'cwd';

export function resolveEffectiveSessionName(
  req: DaemonRequest,
  _sessionStore: SessionStore,
): string {
  const requested = req.session || DEFAULT_SESSION_NAME;
  if (hasExplicitSessionFlag(req)) return requested;
  const scope = resolveSessionScope(req);
  if (scope.kind === 'cwd') return formatScopedSessionName(scope.id, requested);
  return requested;
}

export function resolvePublicSessionName(req: DaemonRequest): string {
  return req.session || DEFAULT_SESSION_NAME;
}

export function resolveImplicitSessionScope(
  req: DaemonRequest,
): Extract<SessionScope, { kind: 'cwd' }> | undefined {
  const scope = resolveSessionScope(req);
  return scope.kind === 'cwd' ? scope : undefined;
}

export function resolveSessionScope(req: DaemonRequest): SessionScope {
  if (req.meta?.sessionIsolation === 'tenant' || req.flags?.sessionIsolation === 'tenant') {
    const tenantId = req.meta?.tenantId;
    if (!tenantId) {
      throw new AppError(
        'INTERNAL_ERROR',
        'Tenant-scoped request reached session routing without an admitted tenant id',
      );
    }
    return { kind: 'tenant', id: tenantId };
  }
  if (
    hasExplicitSessionFlag(req) ||
    (req.session || DEFAULT_SESSION_NAME) !== DEFAULT_SESSION_NAME
  ) {
    return { kind: 'named-local' };
  }
  const scopeRoot = resolveCallerScopeRoot(req.meta?.cwd);
  return scopeRoot ? { kind: 'cwd', id: hashScopeRoot(scopeRoot) } : { kind: 'global-default' };
}

export function sessionMatchesInventoryScope(
  session: SessionState,
  requestScope: SessionScope,
): boolean {
  const sessionScope = session.sessionScope;
  if (!sessionScope) return false;
  if (requestScope.kind === 'tenant') {
    return sessionScope.kind === 'tenant' && sessionScope.id === requestScope.id;
  }
  if (sessionScope.kind === 'tenant') return false;
  if (requestScope.kind !== 'cwd') return true;
  return (
    sessionScope.kind === 'named-local' ||
    (sessionScope.kind === 'cwd' && sessionScope.id === requestScope.id)
  );
}

export function isImplicitSessionScopeConflict(req: DaemonRequest, session: SessionState): boolean {
  const scope = resolveImplicitSessionScope(req);
  if (!scope || session.sessionScope?.kind !== 'cwd') return false;
  return session.sessionScope.id !== scope.id;
}

export function hasExplicitSessionFlag(req: DaemonRequest): boolean {
  if (req.meta?.sessionExplicit === true) return true;
  const value = (req.flags as CommandFlags | undefined)?.session;
  return typeof value === 'string' && value.trim().length > 0;
}

function formatScopedSessionName(scopeId: string, sessionName: string): string {
  return `${IMPLICIT_SESSION_KEY_PREFIX}:${scopeId}:${sessionName}`;
}

function hashScopeRoot(scopeRoot: string): string {
  return crypto.createHash('sha256').update(scopeRoot).digest('hex').slice(0, 16);
}

function resolveCallerScopeRoot(rawCwd: string | undefined): string | undefined {
  if (!rawCwd || rawCwd.trim().length === 0) return undefined;
  const cwd = resolveExistingPath(rawCwd);
  return findGitWorktreeRoot(cwd) ?? cwd;
}

function resolveExistingPath(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function findGitWorktreeRoot(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
