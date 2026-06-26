import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRemoteConfigPath, resolveRemoteConfigProfile } from './remote-config-core.ts';
import { AppError } from './utils/errors.ts';
import { emitDiagnostic } from './utils/diagnostics.ts';
import type { CliFlags } from './utils/cli-flags.ts';
import type { LeaseBackend, SessionRuntimeHints } from './contracts.ts';

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
  flags: Pick<CliFlags, 'daemonBaseUrl' | 'daemonTransport' | 'daemonServerMode'>,
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
  return {
    runtime: state.runtime,
    connection: buildRemoteConnectionRequestMetadata(state),
    flags: {
      ...profile,
      remoteConfig: state.remoteConfigPath,
      daemonBaseUrl: state.daemon?.baseUrl ?? profile.daemonBaseUrl,
      daemonTransport: state.daemon?.transport ?? profile.daemonTransport,
      daemonServerMode: state.daemon?.serverMode ?? profile.daemonServerMode,
      tenant: state.tenant,
      sessionIsolation: 'tenant',
      runId: state.runId,
      leaseId: state.leaseId,
      leaseBackend: state.leaseBackend,
      session: state.session,
      platform: state.platform ?? profile.platform,
      target: state.target ?? profile.target,
    },
  };
}

export function buildRemoteConnectionRequestMetadata(
  state: RemoteConnectionState,
): RemoteConnectionRequestMetadata | undefined {
  const connection = stripUndefined({
    leaseProvider: state.leaseProvider,
    deviceKey: state.deviceKey,
    clientId: state.clientId,
  });
  return Object.keys(connection).length > 0 ? connection : undefined;
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
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.chmodSync(filePath, 0o600);
}

function sanitizeDaemonBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
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

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function isRemoteConnectionState(value: unknown): value is RemoteConnectionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.session === 'string' &&
    typeof record.remoteConfigPath === 'string' &&
    typeof record.remoteConfigHash === 'string' &&
    (record.daemon === undefined ||
      (typeof record.daemon === 'object' &&
        record.daemon !== null &&
        !Array.isArray(record.daemon))) &&
    typeof record.tenant === 'string' &&
    typeof record.runId === 'string' &&
    (record.leaseId === undefined || typeof record.leaseId === 'string') &&
    (record.leaseBackend === undefined || typeof record.leaseBackend === 'string') &&
    (record.leaseProvider === undefined || typeof record.leaseProvider === 'string') &&
    (record.deviceKey === undefined || typeof record.deviceKey === 'string') &&
    (record.clientId === undefined || typeof record.clientId === 'string') &&
    typeof record.connectedAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}
