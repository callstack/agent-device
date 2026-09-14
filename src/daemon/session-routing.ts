import type { CommandFlags } from '@agent-device/contracts/command';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  PLATFORM_SELECTORS,
  type PlatformSelector,
  publicPlatformString,
} from '@agent-device/kernel/device';
import type { DaemonRequest } from './daemon-request.ts';
import type { SessionRef, SessionScope, SessionState } from './session-state.ts';
import { SessionStore } from './session-store.ts';
import { listSessionSelectorConflicts, type SessionSelectorConflict } from './session-selector.ts';

const DEFAULT_SESSION_NAME = 'default';
const IMPLICIT_SESSION_KEY_PREFIX = 'cwd';
const IMPLICIT_PLATFORM_SELECTORS = new Set<string>(PLATFORM_SELECTORS);

export type ImplicitSessionRoutingOptions = {
  /**
   * Whether the routed command runs inside a session at all, i.e. whether its selectors must agree
   * with the session it resolves to. Inventory and diagnostics commands route only to locate their
   * own artifacts, so they must keep resolving an address even when the workspace owns several
   * implicit sessions — refusing those would refuse the very command that resolves the ambiguity.
   */
  attachesToSession?: boolean;
};

/**
 * Resolves the store key a request addresses. An explicit `--session` is used verbatim; an
 * implicit one is scoped to the caller's workspace *and* to the platform it selected, so one
 * checkout can hold an iOS session and an Android session without either caller naming them
 * (#2580).
 */
export function resolveEffectiveSessionName(
  req: DaemonRequest,
  sessionStore: SessionStore,
  options: ImplicitSessionRoutingOptions = {},
): string {
  const requested = req.session || DEFAULT_SESSION_NAME;
  if (hasExplicitSessionFlag(req)) return requested;
  const scope = resolveSessionScope(req);
  if (scope.kind === 'cwd') {
    return resolveImplicitWorkspaceSession(req, sessionStore, scope.id, options);
  }
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

/**
 * Picks which implicit workspace session a request runs in. A named platform addresses that
 * platform's own session, so binding Android never displaces the workspace's iOS session; a request
 * naming no platform falls back to the sessions this workspace already owns. Both branches refuse
 * rather than choosing between several acceptable sessions by open order.
 */
function resolveImplicitWorkspaceSession(
  req: DaemonRequest,
  sessionStore: SessionStore,
  scopeId: string,
  options: ImplicitSessionRoutingOptions,
): string {
  const candidates = listImplicitWorkspaceSessions(sessionStore, scopeId);
  const platform = resolveImplicitPlatformSelector(req);
  return platform
    ? resolvePlatformSessionAddress(req, sessionStore, scopeId, platform, candidates, options)
    : resolveUnselectedSessionAddress(scopeId, candidates, options);
}

type PlatformSessionMismatch = {
  ref: SessionRef;
  conflicts: SessionSelectorConflict[];
};

/**
 * A named platform owns an implicit session of its own. When that session does not exist yet, the
 * request joins the one workspace session it genuinely agrees with, which keeps a session opened
 * without `--platform` reachable from commands that do name one — and keeps it writing to the
 * artifact directory of the session it joined rather than opening a second one beside it.
 */
function resolvePlatformSessionAddress(
  req: DaemonRequest,
  sessionStore: SessionStore,
  scopeId: string,
  platform: PlatformSelector,
  candidates: SessionRef[],
  options: ImplicitSessionRoutingOptions,
): string {
  const platformAddress = formatScopedSessionName(scopeId, platform);
  if (sessionStore.get(platformAddress)) return platformAddress;
  const claimedFlags = withImplicitPlatform(req.flags, platform);
  const mismatches = candidates.map((ref) => ({
    ref,
    conflicts: listSessionSelectorConflicts(ref.session, claimedFlags),
  }));
  const agreeing = mismatches.filter((candidate) => candidate.conflicts.length === 0);
  const [soleAgreeing] = agreeing;
  if (soleAgreeing && agreeing.length === 1) return soleAgreeing.ref.address;
  if (agreeing.length > 1) {
    // A broad selector such as `--platform apple` can match this workspace's iPhone *and* its Mac.
    // Their order says nothing about intent, so a session-attaching request refuses rather than
    // acting on whichever device was opened first.
    throwIfAmbiguousWorkspaceSession(
      options,
      agreeing.map((candidate) => candidate.ref),
    );
    return platformAddress;
  }
  return (
    findSessionOwningThisPlatform(mismatches)?.address ??
    // Every workspace session disagrees on platform, so this request really does want a session of
    // another platform — the case #2580 exists for.
    platformAddress
  );
}

/**
 * The workspace session that already serves this platform when only its device or target disagrees.
 * Handing the request to it keeps the shared selector rules in charge of the mismatch; quietly
 * opening a second same-platform session would leave one `--platform` naming two sessions, which is
 * the ambiguity this routing is meant to remove.
 */
function findSessionOwningThisPlatform(
  mismatches: PlatformSessionMismatch[],
): SessionRef | undefined {
  return mismatches.find((candidate) => !disagreesOnPlatform(candidate.conflicts))?.ref;
}

/**
 * Only a platform disagreement opens a session of its own. A `--target` disagreement does not:
 * tvOS and iOS share the `ios` label, so a second `--platform ios --target tv` session would land
 * on the same label as the phone session this workspace already owns.
 */
function disagreesOnPlatform(conflicts: SessionSelectorConflict[]): boolean {
  return conflicts.some((conflict) => conflict.key === 'platform');
}

/**
 * The selectors this request claims, with the platform it named filled in. A `--session-lock`
 * platform reaches `flags` only after the key is chosen, so matching on `flags` alone would let an
 * Android lock join this workspace's iPhone session — and the lock policy leaves the platform unset
 * once a session is bound, so nothing downstream corrects the choice.
 */
function withImplicitPlatform(
  flags: CommandFlags | undefined,
  platform: PlatformSelector,
): CommandFlags {
  return { ...flags, platform };
}

/**
 * A request that names no platform has nothing to disambiguate with, so it joins the workspace's
 * only implicit session — what every single-platform caller does today — and refuses when the
 * workspace holds several. The `default` leaf is not preferred: opening iOS without `--platform`
 * leaves it owning that leaf beside a platform-keyed session, and a caller who stopped naming a
 * platform has expressed no preference for either.
 */
function resolveUnselectedSessionAddress(
  scopeId: string,
  candidates: SessionRef[],
  options: ImplicitSessionRoutingOptions,
): string {
  const [soleCandidate] = candidates;
  if (soleCandidate && candidates.length === 1) return soleCandidate.address;
  throwIfAmbiguousWorkspaceSession(options, candidates);
  return formatScopedSessionName(scopeId, DEFAULT_SESSION_NAME);
}

/**
 * The sessions this workspace opened implicitly, i.e. without an explicit `--session` name. Named
 * sessions are excluded: a caller chose those addresses, and an implicit request must never
 * attach to a name it was never given.
 */
function listImplicitWorkspaceSessions(sessionStore: SessionStore, scopeId: string): SessionRef[] {
  const seen = new Set<SessionState>();
  const candidates: SessionRef[] = [];
  for (const ref of sessionStore.listRefs()) {
    const sessionScope = ref.session.sessionScope;
    if (sessionScope?.kind !== 'cwd' || sessionScope.id !== scopeId) continue;
    // Counting sessions is what decides whether a request may attach, so one session reachable
    // under two addresses must not read as two. Every writer takes the store's own key; a writer
    // that stored by `SessionState.name` instead would otherwise fabricate an ambiguity no caller
    // could resolve, since only one of those addresses is real.
    if (seen.has(ref.session)) continue;
    seen.add(ref.session);
    candidates.push(ref);
  }
  return candidates;
}

/**
 * The `--platform` selector the caller named, verbatim. This is a label for the implicit session,
 * not a device claim: `--platform apple` and `--platform ios` get distinct labels, and the shared
 * selector rules still decide whether a request may join the session it lands on.
 */
function resolveImplicitPlatformSelector(req: DaemonRequest): PlatformSelector | undefined {
  return (
    normalizeImplicitPlatformSelector((req.flags as CommandFlags | undefined)?.platform) ??
    // `--session-lock` backfills its platform into `flags` only after routing has chosen the session
    // key, and the CLI keeps a configured default platform out of `flags` whenever a lock policy is
    // set, so the lock's platform is the only platform this request carries at routing time.
    normalizeImplicitPlatformSelector(req.meta?.lockPlatform)
  );
}

function normalizeImplicitPlatformSelector(
  value: string | undefined,
): PlatformSelector | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return IMPLICIT_PLATFORM_SELECTORS.has(normalized) ? (normalized as PlatformSelector) : undefined;
}

function throwIfAmbiguousWorkspaceSession(
  options: ImplicitSessionRoutingOptions,
  candidates: SessionRef[],
): void {
  if (candidates.length > 1 && options.attachesToSession === true) {
    throw buildAmbiguousWorkspaceSessionError(candidates);
  }
}

function buildAmbiguousWorkspaceSessionError(candidates: SessionRef[]): AppError {
  const addresses = candidates.map((candidate) => candidate.address);
  const platforms = candidates.map((candidate) => publicPlatformString(candidate.session.device));
  const platformSelectors = platforms.map((platform) => `--platform ${platform}`).join(' or ');
  return new AppError(
    'AMBIGUOUS_MATCH',
    `This workspace has ${candidates.length} implicit sessions (${addresses.join(', ')}); select one explicitly.`,
    {
      sessions: addresses,
      platforms,
      hint:
        `Run agent-device session list to inspect them. ` +
        `Add ${platformSelectors} to run in that platform's session, ` +
        `or pass --session <address> copied from that list.`,
    },
  );
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
