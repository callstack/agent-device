import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRemoteConfigPath, resolveRemoteConfigProfile } from './remote-config-core.ts';
import { AppError } from '@agent-device/kernel/errors';
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
} from '@agent-device/contracts/lease-scope';

export type RemoteConnectionState = {
  version: 1;
  session: string;
  remoteConfigPath: string;
  remoteConfigHash: string;
  daemon?: {
    baseUrl?: string;
    transport?: CliFlags['daemonTransport'];
    serverMode?: CliFlags['daemonServerMode'];
  };
  tenant: string;
  runId: string;
  leaseId?: string;
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
};

export function readRemoteConnectionState(options: {
  stateDir: string;
  session: string;
}): RemoteConnectionState | null {
  const statePath = remoteConnectionStatePath(options);
  if (!fs.existsSync(statePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    removeInvalidRemoteConnectionState(options, error);
    return null;
  }
  if (!isRemoteConnectionState(parsed)) {
    removeInvalidRemoteConnectionState(options);
    return null;
  }
  return parsed;
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
  const statePath = remoteConnectionStatePath({
    stateDir: options.stateDir,
    session: options.state.session,
  });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeJsonFile(statePath, options.state);
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
  fs.rmSync(remoteConnectionStatePath(options), { force: true });
  const activePath = activeConnectionStatePath(options.stateDir);
  const activeSession = readActiveConnectionSession(options.stateDir);
  if (activeSession === options.session) {
    fs.rmSync(activePath, { force: true });
  }
}

/** Whether any stored session record still connects through `remoteConfigPath`. */
export function isRemoteConfigReferenced(options: {
  stateDir: string;
  remoteConfigPath: string;
}): boolean {
  const recordsDir = path.join(options.stateDir, 'remote-connections');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(recordsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.json')) {
      return false;
    }
    try {
      const record: unknown = JSON.parse(
        fs.readFileSync(path.join(recordsDir, entry.name), 'utf8'),
      );
      return (
        isRemoteConnectionState(record) && record.remoteConfigPath === options.remoteConfigPath
      );
    } catch {
      return false;
    }
  });
}

/**
 * The stored connection a command runs on, and the flags it contributes.
 *
 * `session` is the session the caller named (`--session`, `AGENT_DEVICE_SESSION`, or config), or
 * `undefined` when it named none. Only a caller that named none falls back to the machine-wide
 * active-session pointer, which names whichever connection was saved last, and it is refused a
 * leased connection there (#3931).
 */
export function resolveRemoteConnectionDefaults(options: {
  stateDir: string;
  session: string | undefined;
  remoteConfig?: string;
  cwd: string;
  env: Record<string, string | undefined>;
  validateRemoteConfigHash?: boolean;
}): RemoteConnectionDefaults | null {
  const validateRemoteConfigHash = options.validateRemoteConfigHash ?? true;
  const state = selectRemoteConnectionState(options);
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
  const leaseScope = leaseScopeFromOptions(state);
  return {
    runtime: state.runtime,
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

function selectRemoteConnectionState(options: {
  stateDir: string;
  session: string | undefined;
  remoteConfig?: string;
  cwd: string;
  env: Record<string, string | undefined>;
}): RemoteConnectionState | null {
  const state =
    options.session === undefined
      ? (readRemoteConnectionState({ stateDir: options.stateDir, session: 'default' }) ??
        readActiveConnectionState({ stateDir: options.stateDir }))
      : readRemoteConnectionState({ stateDir: options.stateDir, session: options.session });
  if (!state || !matchesRequestedRemoteConfig(state, options)) return null;
  requireLeasedConnectionSession(state, options.session);
  return state;
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
  connection: Pick<RemoteConnectionState, 'leaseProvider'>,
  session: string | undefined,
): void {
  if (session !== undefined || !isLeasedConnection(connection)) return;
  throw remoteSessionRequiredError(connection.leaseProvider);
}

/** The refusal for a command on a leased connection that names no session. */
export function remoteSessionRequiredError(leaseProvider: string | undefined): AppError {
  return new AppError(
    'INVALID_ARGS',
    'A leased remote connection needs its session named: pass --session <name> or set AGENT_DEVICE_SESSION.',
    {
      reason: 'REMOTE_SESSION_REQUIRED',
      ...(leaseProvider === undefined ? {} : { leaseProvider }),
      hint: "Without a name, a command could reach another agent's connection on this machine.",
    },
  );
}

function isLeasedConnection(connection: Pick<RemoteConnectionState, 'leaseProvider'>): boolean {
  return connection.leaseProvider !== undefined;
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

function remoteConnectionStatePath(options: { stateDir: string; session: string }): string {
  return path.join(
    options.stateDir,
    'remote-connections',
    `${safeStateName(options.session)}.json`,
  );
}

function activeConnectionStatePath(stateDir: string): string {
  return path.join(stateDir, 'remote-connections', '.active-session.json');
}

export function readActiveConnectionState(options: {
  stateDir: string;
}): RemoteConnectionState | null {
  const session = readActiveConnectionSession(options.stateDir);
  return session
    ? readRemoteConnectionState({
        stateDir: options.stateDir,
        session,
      })
    : null;
}

function readActiveConnectionSession(stateDir: string): string | undefined {
  const activePath = activeConnectionStatePath(stateDir);
  if (!fs.existsSync(activePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(activePath, 'utf8')) as Record<string, unknown>;
    return typeof parsed.session === 'string' ? parsed.session : undefined;
  } catch {
    return undefined;
  }
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
): Partial<CliFlags> {
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

function removeInvalidRemoteConnectionState(
  options: { stateDir: string; session: string },
  error?: unknown,
): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'remote_connection_state_invalid',
    data: {
      session: options.session,
      cause: error instanceof Error ? error.message : error ? String(error) : undefined,
    },
  });
  removeRemoteConnectionState(options);
}

function safeStateName(value: string): string {
  const safe = value.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe) return 'default';
  if (safe === value) return safe;
  const suffix = crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `${safe}-${suffix}`;
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
      'leaseBackend',
      'leaseProvider',
      'deviceKey',
      'clientId',
    ]) &&
    isOptionalRemoteConnectionDaemonState(record.daemon) &&
    isOptionalRecord(record.leaseDeviceSpec)
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
