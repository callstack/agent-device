import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonRequest, SessionState } from './types.ts';
import { SessionStore } from './session-store.ts';
import type { CommandFlags } from '../core/dispatch.ts';

const DEFAULT_SESSION_NAME = 'default';
const IMPLICIT_SESSION_KEY_PREFIX = 'cwd';

export function resolveEffectiveSessionName(
  req: DaemonRequest,
  _sessionStore: SessionStore,
): string {
  const requested = req.session || DEFAULT_SESSION_NAME;
  if (hasExplicitSessionFlag(req)) return requested;
  const scope = resolveImplicitSessionScope(req);
  if (scope) return formatScopedSessionName(scope.id, requested);
  return requested;
}

export function resolvePublicSessionName(req: DaemonRequest): string {
  return req.session || DEFAULT_SESSION_NAME;
}

export function resolveImplicitSessionScope(
  req: DaemonRequest,
): SessionState['sessionScope'] | undefined {
  if (req.meta?.sessionExplicit === true) return undefined;
  if ((req.session || DEFAULT_SESSION_NAME) !== DEFAULT_SESSION_NAME) return undefined;
  if (req.meta?.sessionIsolation === 'tenant' || req.flags?.sessionIsolation === 'tenant') {
    return undefined;
  }
  const scopeRoot = resolveCallerScopeRoot(req.meta?.cwd);
  if (!scopeRoot) return undefined;
  return {
    kind: 'cwd',
    id: hashScopeRoot(scopeRoot),
  };
}

export function sessionMatchesScope(
  session: SessionState,
  scope: SessionState['sessionScope'] | undefined,
): boolean {
  if (!scope) return true;
  return session.sessionScope?.kind === scope.kind && session.sessionScope.id === scope.id;
}

export function isImplicitSessionScopeConflict(req: DaemonRequest, session: SessionState): boolean {
  const scope = resolveImplicitSessionScope(req);
  if (!scope || !session.sessionScope) return false;
  return !sessionMatchesScope(session, scope);
}

function hasExplicitSessionFlag(req: DaemonRequest): boolean {
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
