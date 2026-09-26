import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRemoteConfigPath, resolveRemoteConfigProfile } from './remote-config-core.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  deviceIdentityFlag,
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
import {
  leaseBackendForPlatform,
  platformForLeaseBackend,
  type LeaseBackend,
  type SessionRuntimeHints,
} from '@agent-device/kernel/contracts';
import {
  leaseScopeFromOptions,
  leaseScopeToCommandFlags,
  leaseScopeToConnectionMetadata,
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
  const platform = publicPlatformString(device);
  const leaseBackend = leaseBackendForPlatform(platform);
  return {
    platform,
    target: device.target,
    leaseBackend,
    identityFlag: leaseBackend ? deviceIdentityFlag(platform) : undefined,
    id: device.id,
  };
}

/** The `deviceKey` for a resolved device: its identity on the public platform and target axes. */
export function buildConnectionDeviceKey(scope: ConnectionDeviceScope): string {
  return `${scope.platform}:${scope.target ?? 'mobile'}:${scope.id}`;
}

/**
 * The platform a command records once a lease is bound: the leaf of the device the lease holds.
 *
 * `apple` is a family selection a caller makes before any device exists, and a family never
 * conflicts with a leaf — so a connection left recording `apple` accepts a later `--platform macos`
 * against the iOS device its own lease is paying for, and forwards that request to the daemon as
 * `apple` on an `ios-instance` lease (#2962's shape, one axis wider). Binding a lease decides the
 * family, so the alias collapses here and every later comparison is leaf-to-leaf.
 *
 * A backend that names no platform — `ios-simulator`, a runner guard below device leases — and a
 * connection with no backend at all keep the selector as named: nothing has decided the family yet,
 * and inventing a leaf would be the same axis mistake in the other direction.
 */
export function boundConnectionPlatform(
  evidence: Readonly<{
    platform?: CliFlags['platform'];
    leaseBackend?: LeaseBackend;
  }>,
): CliFlags['platform'] {
  if (evidence.platform !== 'apple' || !evidence.leaseBackend) return evidence.platform;
  return platformForLeaseBackend(evidence.leaseBackend) ?? evidence.platform;
}

/**
 * Whether a `--platform` selector names the platform a connection is bound to.
 *
 * Both halves are needed and neither is enough alone. The selector rule answers family-vs-leaf as a
 * match, which is right for a fresh selection — `--platform apple` and a recorded `ios` name the same
 * devices — and wrong for a record whose backend already decided the family. A record saved before
 * the collapse existed, or one whose lease already matched so nothing rewrote it, still says `apple`
 * next to an `ios-instance` backend; comparing that alias against `--platform macos` calls the
 * connection reusable and sends a macOS request against an iOS device's lease.
 */
export function connectionPlatformMatchesSelection(
  state: Readonly<{
    platform?: CliFlags['platform'];
    leaseBackend?: LeaseBackend;
  }>,
  requested: CliFlags['platform'],
): boolean {
  if (requested === undefined) return true;
  if (state.platform === undefined) return false;
  return !platformSelectorsConflict(
    requested,
    boundConnectionPlatform({ platform: state.platform, leaseBackend: state.leaseBackend }),
  );
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
}): void {
  const statePath = remoteConnectionStatePath({
    stateDir: options.stateDir,
    session: options.state.session,
  });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeJsonFile(statePath, options.state);
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

export function resolveRemoteConnectionDefaults(options: {
  stateDir: string;
  session: string;
  remoteConfig?: string;
  cwd: string;
  env: Record<string, string | undefined>;
  allowActiveFallback?: boolean;
  validateRemoteConfigHash?: boolean;
}): RemoteConnectionDefaults | null {
  const validateRemoteConfigHash = options.validateRemoteConfigHash ?? true;
  const expectedRemoteConfigPath = options.remoteConfig
    ? resolveRemoteConfigPath({
        configPath: options.remoteConfig,
        cwd: options.cwd,
        env: options.env,
      })
    : undefined;
  const state =
    readRemoteConnectionState(options) ??
    (options.allowActiveFallback
      ? readActiveConnectionState({ stateDir: options.stateDir })
      : null);
  if (!state) return null;
  if (expectedRemoteConfigPath && state.remoteConfigPath !== expectedRemoteConfigPath) {
    return null;
  }
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
    isOptionalRemoteConnectionDaemonState(record.daemon)
  );
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
