import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRemoteConfigPath, resolveRemoteConfigProfile } from './remote-config-core.ts';
import type { RemoteConfigProfile } from './remote-config-schema.ts';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import {
  deviceIdentityFlag,
  isDeviceTarget,
  isPublicPlatform,
  platformSelectorsConflict,
  publicPlatformString,
  type DeviceIdentityFlag,
  type DeviceInfo,
  type DeviceTarget,
  type PublicPlatform,
} from '@agent-device/kernel/device';
import { publishFileSync } from '@agent-device/host-kit/file';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { CliFlags } from '@agent-device/contracts/command';
import type { LeaseDevice, LeaseDeviceSpec } from '@agent-device/contracts/client';
import {
  canonicalLeaseProvider,
  leaseBackendForPlatform,
  platformForLeaseBackend,
  type LeaseBackend,
  type SessionRuntimeHints,
} from '@agent-device/kernel/contracts';
import {
  leaseDeviceKey,
  leaseScopeFromOptions,
  leaseScopeToCommandFlags,
  leaseScopeToConnectionMetadata,
  parseLeaseDeviceKey,
  remoteSessionRequiredError,
} from '@agent-device/contracts/lease-scope';

export type CloudSessionBinding = {
  id: string;
  baseUrl: string;
  vendor: string;
  transport: 'agent-device-daemon';
  viewerAvailable?: boolean;
  deadlineAt: string;
  generation: string;
};

export type RemoteConnectionState = {
  version: 1;
  session: string;
  remoteConfigPath: string;
  remoteConfigHash: string;
  cloudSession?: CloudSessionBinding;
  daemon?: {
    baseUrl?: string;
    transport?: CliFlags['daemonTransport'];
    serverMode?: CliFlags['daemonServerMode'];
  };
  tenant: string;
  runId: string;
  leaseId?: string;
  /** The lease that a close on this connection ended. `artifacts` sends it while no lease is held. */
  endedLeaseId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  platform?: CliFlags['platform'];
  target?: CliFlags['target'];
  /**
   * The device spec a proxy lease was allocated by and the device its backend granted. It describes
   * only the lease `leaseId` names: once that lease ends or is replaced, it describes nothing.
   */
  leaseDeviceSpec?: { leaseId: string; spec: LeaseDeviceSpec; device?: LeaseDevice };
  runtime?: SessionRuntimeHints;
  metro?: {
    projectRoot: string;
    profileKey: string;
    consumerKey: string;
  };
  connectedAt: string;
  updatedAt: string;
};

export type RemoteConnectionRequestMetadata = Pick<
  RemoteConnectionState,
  'leaseProvider' | 'deviceKey' | 'clientId'
>;

/**
 * A resolved device projected onto the axes a remote connection records it on.
 *
 * A `DeviceInfo` carries the INTERNAL platform axis (`apple`, with `appleOs` as the OS
 * discriminant), while every field above — `platform`, `target`, `deviceKey`, `leaseBackend` —
 * speaks the PUBLIC leaf axis (`ios`/`macos`, ADR 0009). This is where the two axes meet, so those
 * fields can never disagree about which axis a device was named on. Reading `device.platform`
 * directly instead was #2962: an iOS device recorded `apple` while the connection held `ios`, and
 * the scope check compared the two and refused every iOS install and open on a proxy lease.
 *
 * Each rule it composes stays with its owning module; this answers only "which device, named how,
 * rented by whom".
 */
export type ConnectionDeviceScope = Readonly<{
  platform: PublicPlatform;
  /** The target as the device records it; `undefined` leaves an existing selection untouched. */
  target: DeviceTarget | undefined;
  /** The lease backend that rents this device, or `undefined` when no backend leases it. */
  leaseBackend: LeaseBackend | undefined;
  /**
   * The flag that names this device to a request, or `undefined` when it names none.
   *
   * Only a device a backend can rent gets one. A platform with no lease backend cannot be bound by
   * a remote connection at all, so its identity is never sent — and for the macOS desktop host it
   * must not be: the daemon's own selector rule reads `--udid` as an iOS-family selector and would
   * report a conflict against the session this very command is opening. Such a device fails on the
   * missing backend, which names the real problem, instead of on a selector it could never use.
   */
  identityFlag: DeviceIdentityFlag | undefined;
  id: string;
}>;

export function resolveConnectionDeviceScope(device: DeviceInfo): ConnectionDeviceScope {
  return connectionDeviceScope(publicPlatformString(device), device.target, device.id);
}

function connectionDeviceScope(
  platform: PublicPlatform,
  target: DeviceTarget | undefined,
  id: string,
): ConnectionDeviceScope {
  const leaseBackend = leaseBackendForPlatform(platform);
  return {
    platform,
    target,
    leaseBackend,
    identityFlag: leaseBackend ? deviceIdentityFlag(platform) : undefined,
    id,
  };
}

/** The `deviceKey` for a resolved device: its identity on the public platform and target axes. */
export function buildConnectionDeviceKey(scope: ConnectionDeviceScope): string {
  return leaseDeviceKey(scope);
}

/** The device scope a {@link buildConnectionDeviceKey} key names, or `undefined` for any other key. */
export function parseConnectionDeviceKey(
  deviceKey: string | undefined,
): ConnectionDeviceScope | undefined {
  const parsed = parseLeaseDeviceKey(deviceKey);
  if (!parsed || !isPublicPlatform(parsed.platform) || !isDeviceTarget(parsed.target)) {
    return undefined;
  }
  return connectionDeviceScope(parsed.platform, parsed.target, parsed.id);
}

/**
 * The one platform a connection command runs as: the narrowest of what its lease backend rents, what
 * its record already holds, and what the command asked for.
 *
 * `apple` is a family selection a caller makes before any device exists, and a family never conflicts
 * with a leaf. Left as three separate compares that is exactly where a request gets retargeted: a
 * record saying `apple` beside an `ios-instance` lease accepts `--platform macos`, and the recorded
 * value then overwrites the asked-for one, so a macOS request goes out as `apple` against the iOS
 * device the lease is paying for (#2962). One rule covers all of it — a requested selector may narrow
 * what a connection is bound to and can never widen it, and two candidates that cannot name the same
 * device are a conflict rather than something to pick a winner from.
 *
 * The backend is asked first because it is the evidence a device exists behind: a backend that rents
 * iOS instances has decided the family whether or not the record ever wrote it. A backend that names
 * no platform — `ios-simulator`, a runner guard below device leases — decides nothing, and inventing a
 * leaf there would be the same axis mistake in the other direction.
 */
export function narrowConnectionPlatform(
  evidence: Readonly<{
    leaseBackend?: LeaseBackend;
    recordedPlatform?: CliFlags['platform'];
    requestedPlatform?: CliFlags['platform'];
  }>,
):
  | Readonly<{ ok: true; platform: CliFlags['platform'] }>
  | Readonly<{
      ok: false;
      /** What the connection is bound to, independent of the request that was refused. */
      boundPlatform?: CliFlags['platform'];
      requestedPlatform?: CliFlags['platform'];
    }> {
  const backendPlatform = evidence.leaseBackend
    ? platformForLeaseBackend(evidence.leaseBackend)
    : undefined;
  const bound = [backendPlatform, evidence.recordedPlatform].filter(
    (candidate): candidate is NonNullable<CliFlags['platform']> => candidate !== undefined,
  );
  // The bound side settles itself first: a record and a backend that disagree about which device they
  // hold is a conflict no request can be served under, whatever it asked for.
  if (bound.some((left) => bound.some((right) => platformSelectorsConflict(left, right)))) {
    return { ok: false, boundPlatform: bound[0], requestedPlatform: evidence.requestedPlatform };
  }
  if (
    platformSelectorsConflict(evidence.requestedPlatform, bound[0] ?? evidence.recordedPlatform)
  ) {
    return { ok: false, boundPlatform: bound[0], requestedPlatform: evidence.requestedPlatform };
  }
  const candidates = [...bound, evidence.requestedPlatform].filter(
    (candidate): candidate is NonNullable<CliFlags['platform']> => candidate !== undefined,
  );
  return {
    ok: true,
    platform: candidates.find((candidate) => candidate !== 'apple') ?? candidates[0],
  };
}

/**
 * Whether a `--platform` selector can be served by an existing connection.
 *
 * A reuse decision, not a rewrite: the same narrowing the request path applies decides this too, so a
 * record saved before a backend decided its family cannot make a connection look reusable for a leaf
 * it does not hold.
 */
export function connectionPlatformMatchesSelection(
  state: Readonly<{
    platform?: CliFlags['platform'];
    leaseBackend?: LeaseBackend;
  }>,
  requested: CliFlags['platform'],
): boolean {
  if (requested !== undefined && state.platform === undefined) return false;
  return narrowConnectionPlatform({
    leaseBackend: state.leaseBackend,
    recordedPlatform: state.platform,
    requestedPlatform: requested,
  }).ok;
}

type RemoteConnectionDefaults = {
  flags: Partial<CliFlags>;
  runtime?: SessionRuntimeHints;
  connection?: RemoteConnectionRequestMetadata;
  /** Set only by {@link claimRemoteConnectionDefaults}: the record it claimed, or `null` for none. */
  claimed?: RemoteConnectionState | null;
  cloudSession?: CloudSessionBinding;
};

const REMOTE_CONNECTION_STATE_REASONS = {
  // A saved connection file cannot be used for the session a command named: it names another session,
  // a record from an older build cannot move to its session file because that file already exists, or
  // the active-session pointer path holds a record whose owner is unproven. The refused file is kept,
  // and so is the occupied session file.
  sessionMismatch: { reason: 'connection_session_mismatch' },
  // The session's own saved connection file, or the active-session pointer, could not be read or
  // parsed, so no session is known to own it. It was neither replaced nor removed.
  ownerUnknown: { reason: 'connection_record_owner_unknown' },
} as const satisfies ReasonTable<'remote connections'>;

/**
 * The saved connection `session` owns, read without a change to any file.
 *
 * A record an older build wrote for exactly this session is reported where it is. A record that names
 * the session but fails validation is reported as no connection and is kept. Only
 * {@link writeRemoteConnectionState}, {@link claimRemoteConnectionState} and
 * {@link removeRemoteConnectionState} move or remove files.
 */
export function readRemoteConnectionState(options: {
  stateDir: string;
  session: string;
}): RemoteConnectionState | null {
  const recordsDir = path.join(options.stateDir, 'remote-connections');
  const canonical = canonicalRemoteConnectionStatePath(recordsDir, options.session);
  const file = readRecordFile(canonical);
  if (file.kind === 'unknown') {
    throw recordOwnerUnknownError(options.session, canonical, file.cause);
  }
  // A record that another session's older build left at this path moves away on the next save.
  if (file.kind === 'owned' && !isMovableLegacyRecord(recordsDir, canonical, file)) {
    if (file.session !== options.session) {
      throw sessionMismatchError(
        options.session,
        canonical,
        'The saved connection belongs to a different session.',
      );
    }
    return observedRemoteConnectionState(options.session, canonical, file.record);
  }
  const legacyPath = path.join(recordsDir, legacyRemoteConnectionFileName(options.session));
  const legacy = readRecordFile(legacyPath);
  return legacy.kind === 'owned' &&
    legacy.session === options.session &&
    isMovableLegacyRecord(recordsDir, legacyPath, legacy)
    ? observedRemoteConnectionState(options.session, legacyPath, legacy.record)
    : null;
}

/**
 * The first step of a removal: the saved connection `session` owns, moved to its session's own path.
 *
 * A caller runs this before any remote teardown, so a record it cannot remove is refused before a lease
 * ends, and finishes with {@link removeRemoteConnectionState}. `session` is `undefined` when the caller
 * named none: the `default` session comes first, then the active-session pointer. A record that names
 * its session but fails validation is removed on the way, and the next candidate is tried. A missing
 * record returns `null`.
 */
export function claimRemoteConnectionState(options: {
  stateDir: string;
  session: string | undefined;
}): RemoteConnectionState | null {
  const { stateDir, session } = options;
  if (session !== undefined) return claimSessionRecord({ stateDir, session }).state;
  const claimed = claimSessionRecord({ stateDir, session: 'default' }).state;
  if (claimed) return claimed;
  const activeSession = activeRecordOwner(stateDir);
  return activeSession === undefined
    ? null
    : claimSessionRecord({ stateDir, session: activeSession }).state;
}

/**
 * The session's own path and its valid record there, if any. Records an older build wrote for the
 * session move there first, and a record there that names the session but fails validation is removed.
 * A file there that no session is proven to own, or that another session owns, refuses the claim.
 */
function claimSessionRecord(options: { stateDir: string; session: string }): {
  statePath: string;
  state: RemoteConnectionState | null;
} {
  const recordsDir = path.join(options.stateDir, 'remote-connections');
  const statePath = canonicalRemoteConnectionStatePath(recordsDir, options.session);
  // A record at the name an older build wrote for this session moves to its owner's own path first.
  // That name can also open another session's record: it can be this session's own path, or a case
  // alias of the other session's older name. A hashed path is never a name an older build wrote.
  migrateLegacyRemoteConnectionState({
    recordsDir,
    source: path.join(recordsDir, legacyRemoteConnectionFileName(options.session)),
    session: options.session,
  });
  const file = readRecordFile(statePath);
  if (file.kind === 'absent') return { statePath, state: null };
  if (file.kind === 'unknown') {
    throw recordOwnerUnknownError(options.session, statePath, file.cause);
  }
  // Ownership is settled before shape: a record another session owns is never removed as invalid.
  if (file.session !== options.session) {
    throw sessionMismatchError(
      options.session,
      statePath,
      'The saved connection belongs to a different session.',
    );
  }
  if (isRemoteConnectionState(file.record))
    return { statePath, state: normalizeStoredProvider(file.record) };
  warnInvalidRecord(options.session, statePath);
  removeRemoteConnectionStateFile(options, statePath);
  return { statePath, state: null };
}

function observedRemoteConnectionState(
  session: string,
  recordPath: string,
  record: Record<string, unknown>,
): RemoteConnectionState | null {
  if (isRemoteConnectionState(record)) return normalizeStoredProvider(record);
  warnInvalidRecord(session, recordPath);
  return null;
}

function normalizeStoredProvider(record: RemoteConnectionState): RemoteConnectionState {
  if (record.leaseProvider === undefined) return record;
  return { ...record, leaseProvider: canonicalLeaseProvider(record.leaseProvider) };
}

function warnInvalidRecord(session: string, recordPath: string): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'remote_connection_state_invalid',
    data: { session, recordPath },
  });
}

function sessionMismatchError(session: string, recordPath: string, message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: REMOTE_CONNECTION_STATE_REASONS.sessionMismatch.reason,
    session,
    recordPath,
    hint: `Remove ${recordPath} only if no session needs the connection it holds.`,
  });
}

function recordOwnerUnknownError(session: string, recordPath: string, cause: unknown): AppError {
  return new AppError('COMMAND_FAILED', 'The saved connection file could not be read.', {
    reason: REMOTE_CONNECTION_STATE_REASONS.ownerUnknown.reason,
    session,
    recordPath,
    cause: cause instanceof Error ? cause.message : String(cause),
    hint: `Make ${recordPath} readable, or remove it if no session needs it.`,
  });
}

export function writeRemoteConnectionState(options: {
  stateDir: string;
  state: RemoteConnectionState;
  /**
   * Runs once the session record has landed, before the active-session pointer is updated. A caller
   * that was holding the lease this record names until it was durable acts here: from this point the
   * record owns it, and a later pointer failure must not be read as a record that never came to be.
   */
  onSessionRecordCommitted?: () => void;
}): void {
  retireRecordAtActivePointer(options.stateDir, options.state.session);
  const { statePath } = claimSessionRecord({
    stateDir: options.stateDir,
    session: options.state.session,
  });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeJsonFile(statePath, {
    ...options.state,
    leaseProvider: canonicalLeaseProvider(options.state.leaseProvider),
  });
  options.onSessionRecordCommitted?.();
  writeJsonFile(activeConnectionStatePath(options.stateDir), { session: options.state.session });
}

export function buildRemoteConnectionDaemonState(
  flags: Pick<
    CliFlags,
    'daemonBaseUrl' | 'daemonAuthToken' | 'daemonTransport' | 'daemonServerMode'
  >,
): RemoteConnectionState['daemon'] {
  return {
    baseUrl: sanitizeDaemonBaseUrl(flags.daemonBaseUrl),
    transport: flags.daemonTransport,
    serverMode: flags.daemonServerMode,
  };
}

export function removeRemoteConnectionState(options: { stateDir: string; session: string }): void {
  removeRemoteConnectionStateFile(options, claimSessionRecord(options).statePath);
}

function removeRemoteConnectionStateFile(
  options: { stateDir: string; session: string },
  statePath: string,
): void {
  fs.rmSync(statePath, { force: true });
  // Only a pointer is removed here. A full record an older build wrote at the pointer path leaves only
  // through the checked move in migrateLegacyRemoteConnectionState.
  const activePath = activeConnectionStatePath(options.stateDir);
  const active = readRecordFile(activePath);
  if (
    active.kind === 'owned' &&
    active.session === options.session &&
    isActiveSessionPointer(active.record)
  ) {
    fs.rmSync(activePath, { force: true });
  }
}

/**
 * Whether any stored session record still connects through `remoteConfigPath`. A record that cannot
 * be read or parsed, or that parses but fails validation, also counts as a reference, so a caller
 * deciding whether to delete the profile keeps it.
 */
export function isRemoteConfigReferenced(options: {
  stateDir: string;
  remoteConfigPath: string;
}): boolean {
  const recordsDir = path.join(options.stateDir, 'remote-connections');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(recordsDir, { withFileTypes: true });
  } catch (error) {
    return !isMissingPathError(error);
  }
  return entries.some((entry) => {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.json')) {
      return false;
    }
    let text: string;
    try {
      text = fs.readFileSync(path.join(recordsDir, entry.name), 'utf8');
    } catch (error) {
      return !isMissingPathError(error);
    }
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      return true;
    }
    return !isRemoteConnectionState(record) || record.remoteConfigPath === options.remoteConfigPath;
  });
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Reads the named connection, or the default session and then the active-session pointer. */
export function readRemoteConnectionDefault(options: {
  stateDir: string;
  session: string | undefined;
}): RemoteConnectionState | null {
  const { stateDir, session } = options;
  if (session !== undefined) return readRemoteConnectionState({ stateDir, session });
  const defaultState = readRemoteConnectionState({ stateDir, session: 'default' });
  if (defaultState) return defaultState;
  const activeSession = activeRecordOwner(stateDir);
  return activeSession && activeSession !== 'default'
    ? readRemoteConnectionState({ stateDir, session: activeSession })
    : null;
}

export function resolveRemoteConnectionDefaults(options: {
  state: RemoteConnectionState | null;
  session: string | undefined;
  remoteConfig?: string;
  cwd: string;
  env: Record<string, string | undefined>;
  validateRemoteConfigHash?: boolean;
}):
  | (RemoteConnectionDefaults & { profile: RemoteConfigProfile; state: RemoteConnectionState })
  | null {
  const { state } = options;
  if (!state || !matchesRequestedRemoteConfig(state, options)) return null;
  requireLeasedConnectionSession(state, options.session);
  const resolved = remoteConnectionDefaults(state, options);
  return resolved ? { ...resolved.defaults, profile: resolved.profile, state } : null;
}

/**
 * The defaults for `disconnect`, taken from the record {@link claimRemoteConnectionState} claims.
 *
 * The returned `claimed` record also drives the teardown, so the record is resolved once. A leased
 * record is refused when the caller named no session. The defaults are empty when no record is
 * claimed or the record connects through another `remoteConfig` than the one requested.
 */
export function claimRemoteConnectionDefaults(options: {
  stateDir: string;
  session: string | undefined;
  remoteConfig?: string;
  cwd: string;
  env: Record<string, string | undefined>;
}): RemoteConnectionDefaults {
  const claimed = claimRemoteConnectionState(options);
  if (claimed) requireLeasedConnectionSession(claimed, options.session);
  const selected = claimed && matchesRequestedRemoteConfig(claimed, options) ? claimed : null;
  const defaults = remoteConnectionDefaults(selected, {
    ...options,
    validateRemoteConfigHash: false,
  });
  return { flags: {}, ...defaults?.defaults, claimed };
}

function remoteConnectionDefaults(
  state: RemoteConnectionState | null,
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    validateRemoteConfigHash?: boolean;
  },
): { defaults: RemoteConnectionDefaults; profile: RemoteConfigProfile } | null {
  const validateRemoteConfigHash = options.validateRemoteConfigHash ?? true;
  if (!state) return null;
  if (
    validateRemoteConfigHash &&
    hashRemoteConfigFile(state.remoteConfigPath) !== state.remoteConfigHash
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'Active remote connection config changed. Run agent-device connect --force to refresh it.',
      { remoteConfig: state.remoteConfigPath },
    );
  }
  const profile = resolveConnectionProfile(state, options);
  return { defaults: buildRemoteConnectionDefaults(state, profile), profile };
}

export function buildRemoteConnectionDefaults(
  state: RemoteConnectionState,
  profile: RemoteConfigProfile,
): RemoteConnectionDefaults {
  const leaseScope = leaseScopeFromOptions(state);
  return {
    runtime: state.runtime,
    cloudSession: state.cloudSession,
    connection: leaseScopeToConnectionMetadata(leaseScope),
    flags: {
      ...profile,
      remoteConfig: state.remoteConfigPath,
      daemonBaseUrl: state.daemon?.baseUrl ?? profile.daemonBaseUrl,
      // Deliberately not sourced from state: the daemon bearer token is never
      // persisted to the connection-state file (ADR 0007). It is resolved
      // from the profile here, and from the flag/env/CLI-session chain in
      // resolveRemoteAuth (src/cli/auth-session.ts) at command dispatch time.
      daemonAuthToken: profile.daemonAuthToken,
      daemonTransport: state.daemon?.transport ?? profile.daemonTransport,
      daemonServerMode: state.daemon?.serverMode ?? profile.daemonServerMode,
      ...leaseScopeToCommandFlags(leaseScope),
      sessionIsolation: 'tenant',
      session: state.session,
      platform: state.platform ?? profile.platform,
      target: state.target ?? profile.target,
    },
  };
}

function matchesRequestedRemoteConfig(
  state: RemoteConnectionState,
  options: { remoteConfig?: string; cwd: string; env: Record<string, string | undefined> },
): boolean {
  if (!options.remoteConfig) return true;
  const expected = resolveRemoteConfigPath({
    configPath: options.remoteConfig,
    cwd: options.cwd,
    env: options.env,
  });
  return state.remoteConfigPath === expected;
}

// The daemon accepts run ids of up to 128 characters.
const MAX_RUN_ID_LENGTH = 128;

/**
 * The client and run a session allocates under on a leased remote-config profile.
 *
 * Every session that names one profile would otherwise carry the profile's client and run, and the
 * daemon reuses a lease for a matching run binding, so one session could take over, and release,
 * another's lease (#3931). Each session gets its own client and run, derived from its name, so the
 * same session finds its own lease again. A profile that names a lease the host issued keeps that
 * lease's scope.
 */
export function sessionLeaseScope(
  profile: Pick<RemoteConnectionState, 'leaseProvider' | 'leaseId' | 'clientId'> & {
    runId: string | undefined;
  },
  session: string,
): { runId: string | undefined; clientId: string | undefined } {
  if (!isLeasedConnection(profile) || profile.leaseId !== undefined) {
    return { runId: profile.runId, clientId: profile.clientId };
  }
  const suffix = crypto.createHash('sha256').update(session).digest('hex').slice(0, 16);
  return {
    runId:
      profile.runId && `${profile.runId.slice(0, MAX_RUN_ID_LENGTH - suffix.length - 1)}.${suffix}`,
    clientId:
      profile.clientId === undefined ? suffix : `${profile.clientId.slice(0, 111)}.${suffix}`,
  };
}

/**
 * Refuses a caller that named no session the use of a leased connection: one whose device a lease
 * provider (proxy, a device cloud, or a provider plugin) leases for a single agent.
 *
 * On a machine several agents share, an unnamed session resolves to whichever connection was saved
 * last, which may be another agent's.
 */
export function requireLeasedConnectionSession(
  connection: Pick<RemoteConnectionState, 'leaseProvider' | 'cloudSession'>,
  session: string | undefined,
): void {
  if (session !== undefined || !isLeasedConnection(connection)) return;
  throw remoteSessionRequiredError(connection.leaseProvider);
}

function isLeasedConnection(
  connection: Pick<RemoteConnectionState, 'leaseProvider' | 'cloudSession'>,
): boolean {
  return connection.leaseProvider !== undefined || connection.cloudSession !== undefined;
}

export function buildRemoteConnectionRequestMetadata(
  state: RemoteConnectionRequestMetadata,
): RemoteConnectionRequestMetadata | undefined {
  return leaseScopeToConnectionMetadata(leaseScopeFromOptions(state));
}

export function mergeRemoteConnectionRequestMetadata(
  primary: RemoteConnectionRequestMetadata,
  fallback: RemoteConnectionRequestMetadata,
): RemoteConnectionRequestMetadata {
  return {
    leaseProvider: primary.leaseProvider ?? fallback.leaseProvider,
    clientId: primary.clientId ?? fallback.clientId,
    deviceKey: primary.deviceKey ?? fallback.deviceKey,
  };
}

export function remoteConnectionLeaseIdentityMatches(
  state: RemoteConnectionState,
  metadata: RemoteConnectionRequestMetadata | undefined,
): boolean {
  if (!metadata) return true;
  return (
    (metadata.leaseProvider === undefined || state.leaseProvider === metadata.leaseProvider) &&
    (metadata.clientId === undefined || state.clientId === metadata.clientId)
  );
}

export function hashRemoteConfigFile(configPath: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Remote config file not found: ${configPath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The pointer to the machine-wide active session. It is not a session record and never names one. */
const ACTIVE_SESSION_FILE_NAME = '.active-session.json';

/** A session name that is a file name on its own. It cannot start with `.`, so it never names the pointer. */
const PLAIN_SESSION_NAME = /^[a-z0-9_-][a-z0-9._-]*$/;

/**
 * Where a session's saved connection lives. The name alone decides it, and no two sessions share it.
 *
 * A plain name is stored under itself. Any other name is stored under the SHA-256 of its UTF-16 code
 * units, so names that differ only in case, or in lone surrogates, get different files. Neither form
 * can be a case alias of another session's file or of the active-session pointer.
 */
function canonicalRemoteConnectionStatePath(recordsDir: string, session: string): string {
  if (PLAIN_SESSION_NAME.test(session)) return path.join(recordsDir, `${session}.json`);
  const identity = crypto
    .createHash('sha256')
    .update(Buffer.from(session, 'utf16le'))
    .digest('hex');
  return path.join(recordsDir, `~${identity}.json`);
}

/**
 * The file name a build that sanitized session names wrote for `session`. On a case-insensitive
 * filesystem it also opens the file of any session whose name differs only in case.
 */
function legacyRemoteConnectionFileName(session: string): string {
  if (session === '') return 'default.json';
  const safe = session.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  if (safe === session) return `${safe}.json`;
  const suffix = crypto.createHash('sha256').update(session).digest('hex').slice(0, 8);
  return `${safe}-${suffix}.json`;
}

type RecordFile =
  | { kind: 'absent' }
  /** The file exists but could not be read or parsed, or names no session: its owner is unknown. */
  | { kind: 'unknown'; cause: unknown }
  | OwnedRecordFile;

type OwnedRecordFile = { kind: 'owned'; session: string; record: Record<string, unknown> };

/** What the file at `filePath` holds. Only `ENOENT` means absent. */
function readRecordFile(filePath: string): RecordFile {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'unknown', cause: error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: 'unknown', cause: error };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unknown', cause: 'The file holds no JSON object.' };
  }
  const record = parsed as Record<string, unknown>;
  return typeof record.session === 'string'
    ? { kind: 'owned', session: record.session, record }
    : { kind: 'unknown', cause: 'The file names no session.' };
}

/** Whether a parsed file is an active-session pointer, which holds only the session it points at. */
function isActiveSessionPointer(record: Record<string, unknown>): boolean {
  return Object.keys(record).every((key) => key === 'session');
}

/**
 * Moves a record an older build left at `source` to its owner's own path, then removes `source`.
 *
 * The owner is the session the record names, and only when `source` is a name an older build wrote
 * for that session, compared case-insensitively. A file whose owner is unknown or unproven is left
 * in place. When the owner's own path is already taken by a different file, `source` is kept and the
 * command is refused: one of the two records would otherwise be lost.
 */
function migrateLegacyRemoteConnectionState(options: {
  recordsDir: string;
  source: string;
  session: string;
}): boolean {
  const file = readRecordFile(options.source);
  if (file.kind !== 'owned' || !isMovableLegacyRecord(options.recordsDir, options.source, file)) {
    return false;
  }
  const target = canonicalRemoteConnectionStatePath(options.recordsDir, file.session);
  try {
    fs.linkSync(options.source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!isSameFile(options.source, target)) {
      throw sessionMismatchError(
        options.session,
        options.source,
        'An older saved connection cannot move to its session file, because that file already exists.',
      );
    }
  }
  fs.rmSync(options.source, { force: true });
  return true;
}

/**
 * Whether `file` is a record an older build left at `source` for the session it names: `source` is a
 * name an older build wrote for that session, compared case-insensitively, and not its own path. A
 * pointer at the active-session pointer path, or at a case alias of it, is no record.
 */
function isMovableLegacyRecord(recordsDir: string, source: string, file: OwnedRecordFile): boolean {
  const sourceName = path.basename(source).toLowerCase();
  if (sourceName === ACTIVE_SESSION_FILE_NAME && isActiveSessionPointer(file.record)) return false;
  // Canonical names hold no upper-case letters, so a name that folds onto the target IS the target.
  if (path.basename(canonicalRemoteConnectionStatePath(recordsDir, file.session)) === sourceName) {
    return false;
  }
  return legacyRemoteConnectionFileName(file.session).toLowerCase() === sourceName;
}

function isSameFile(left: string, right: string): boolean {
  const a = fs.statSync(left);
  const b = fs.statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Keeps a full record an older build wrote at the active-session pointer path, or at a case alias of
 * it, from being replaced by the next pointer write. A record whose owner is proven moves to that
 * owner's own path first. A file whose owner is unknown refuses the write.
 */
function retireRecordAtActivePointer(stateDir: string, session: string): void {
  const recordsDir = path.join(stateDir, 'remote-connections');
  const activePath = activeConnectionStatePath(stateDir);
  const file = readRecordFile(activePath);
  if (file.kind === 'absent') return;
  if (file.kind === 'unknown') throw recordOwnerUnknownError(session, activePath, file.cause);
  if (isActiveSessionPointer(file.record)) return;
  if (migrateLegacyRemoteConnectionState({ recordsDir, source: activePath, session })) return;
  throw sessionMismatchError(
    session,
    activePath,
    'The active-session pointer path holds a saved connection whose owner is unproven.',
  );
}

function activeConnectionStatePath(stateDir: string): string {
  return path.join(stateDir, 'remote-connections', ACTIVE_SESSION_FILE_NAME);
}

/**
 * The connection the active-session pointer names, read without a change to any file.
 *
 * A full record an older build wrote at the pointer path counts only when that path is the older name
 * of the session the record names.
 */
export function readActiveConnectionState(options: {
  stateDir: string;
}): RemoteConnectionState | null {
  const session = activeRecordOwner(options.stateDir);
  return session === undefined
    ? null
    : readRemoteConnectionState({ stateDir: options.stateDir, session });
}

/**
 * The session the active-session pointer names, or the owner of a full record an older build wrote at
 * the pointer path when that path is the older name of the session the record names.
 */
function activeRecordOwner(stateDir: string): string | undefined {
  const activePath = activeConnectionStatePath(stateDir);
  const file = readRecordFile(activePath);
  if (file.kind !== 'owned') return undefined;
  const isPointer = isActiveSessionPointer(file.record);
  return isPointer || isMovableLegacyRecord(path.dirname(activePath), activePath, file)
    ? file.session
    : undefined;
}

export function fingerprint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function resolveConnectionProfile(
  state: RemoteConnectionState,
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    validateRemoteConfigHash?: boolean;
  },
): RemoteConfigProfile {
  try {
    return resolveRemoteConfigProfile({
      configPath: state.remoteConfigPath,
      cwd: options.cwd,
      env: options.env,
    }).profile;
  } catch (error) {
    // Disconnect tolerates a missing/unparseable profile; other paths already failed hash checks.
    if (options.validateRemoteConfigHash === false) {
      return {};
    }
    throw error;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  publishFileSync({
    destination: filePath,
    contents: `${JSON.stringify(value, null, 2)}\n`,
    mode: 0o600,
  });
}

function sanitizeDaemonBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const key of Array.from(url.searchParams.keys())) {
    if (/(auth|key|password|secret|token)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString().replace(/\/+$/, '');
}

function isRemoteConnectionState(value: unknown): value is RemoteConnectionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    hasStringFields(record, [
      'session',
      'remoteConfigPath',
      'remoteConfigHash',
      'tenant',
      'runId',
      'connectedAt',
      'updatedAt',
    ]) &&
    hasOptionalStringFields(record, [
      'leaseId',
      'endedLeaseId',
      'leaseBackend',
      'leaseProvider',
      'deviceKey',
      'clientId',
    ]) &&
    isOptionalRemoteConnectionDaemonState(record.daemon) &&
    isOptionalCloudSessionBinding(record.cloudSession) &&
    isOptionalRecord(record.leaseDeviceSpec)
  );
}

function isOptionalCloudSessionBinding(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasStringFields(record, ['id', 'baseUrl', 'deadlineAt', 'generation']) &&
    typeof record.vendor === 'string' &&
    (record.viewerAvailable === undefined || typeof record.viewerAvailable === 'boolean') &&
    record.transport === 'agent-device-daemon'
  );
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value));
}

function hasStringFields(record: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof record[field] === 'string');
}

function hasOptionalStringFields(record: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => record[field] === undefined || typeof record[field] === 'string');
}

function isOptionalRemoteConnectionDaemonState(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return isRemoteConnectionDaemonState(value);
}

function isRemoteConnectionDaemonState(value: object): boolean {
  const record = value as Record<string, unknown>;
  return (
    (record.baseUrl === undefined || typeof record.baseUrl === 'string') &&
    (record.authToken === undefined || typeof record.authToken === 'string') &&
    (record.transport === undefined || typeof record.transport === 'string') &&
    (record.serverMode === undefined || typeof record.serverMode === 'string')
  );
}
