import fs from 'node:fs';
import path from 'node:path';
import { acquireProcessLock, publishFileSync } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { AppError } from '@agent-device/kernel/errors';
import type { CliFlags } from '@agent-device/contracts/command';
import { type EnvMap } from '@agent-device/kernel/source-value';
import { readCloudJsonResponse } from './cloud-response.ts';

const DEFAULT_CLOUD_BASE_URL = 'https://cloud.agent-device.dev';
const DEVICE_AUTH_START_PATH = '/api/control-plane/device-auth/start';
const DEVICE_AUTH_POLL_PATH = '/api/control-plane/device-auth/poll';
const CLI_SESSION_REFRESH_PATH = '/api/control-plane/cli-session/refresh';
const API_KEYS_PATH = '/api-keys';
const DEVICE_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
// A holder keeps the session lock for one file operation, or for one token exchange, which spends
// at most two request timeouts. A dead holder is reclaimed, so only a stuck live process makes a
// contender wait this long.
const CLI_SESSION_LOCK_TIMEOUT_MS = 60_000;
// A response whose access token is already expired is asked again, and no further: a cloud that
// keeps answering with an expired token must not keep a command refreshing.
const MAX_CLI_SESSION_TOKEN_EXCHANGES = 2;

export type CliSessionRecord = {
  version: 1;
  id: string;
  cloudBaseUrl: string;
  workspaceId?: string;
  accountId?: string;
  name?: string;
  refreshCredential: string;
  createdAt: string;
  expiresAt?: string;
};

export type RemoteAuthResolution = {
  flags: CliFlags;
  source: 'flag' | 'env' | 'cli-session' | 'login' | 'none';
};

type DeviceAuthStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn?: number;
  interval?: number;
};

type DeviceAuthPollResponse = {
  status?: string;
  error?: string;
  accessToken?: string;
  expiresAt?: string;
  cliSession?: {
    id?: string;
    refreshCredential?: string;
    refreshToken?: string;
    workspaceId?: string;
    accountId?: string;
    name?: string;
    expiresAt?: string;
  };
};

type CliSessionRefreshResponse = {
  accessToken?: string;
  /** A replacement for the stored credential, when the cloud rotates it on refresh. */
  refreshCredential?: string;
  /** The access token's expiry. Not the session's: read `cliSession.expiresAt` for that. */
  expiresAt?: string;
  cliSession?: {
    /** The session expiry, which a cloud may slide with use. */
    expiresAt?: string;
  };
  status?: string;
  error?: string;
};

type AuthIo = {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  now?: () => number;
  // di-seam-approved: injects the fetch global, which has no module boundary vi.mock can
  // intercept. auth-session.test.ts injects it directly for exact per-call assertions.
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
};

export async function resolveRemoteAuthForCli(options: {
  command: string;
  flags: CliFlags;
  stateDir: string;
  env: EnvMap;
}): Promise<RemoteAuthResolution> {
  return await resolveRemoteAuth({
    command: options.command,
    flags: options.flags,
    stateDir: options.stateDir,
    allowInteractiveLogin: options.command === 'connect' && !options.flags.noLogin,
    env: options.env,
  });
}

export async function resolveRemoteAuth(options: {
  command: string;
  flags: CliFlags;
  stateDir: string;
  allowInteractiveLogin: boolean;
  env: EnvMap;
  io?: AuthIo;
}): Promise<RemoteAuthResolution> {
  const { env } = options;
  if (!options.flags.daemonBaseUrl) return { flags: options.flags, source: 'none' };
  if (hasToken(options.flags.daemonAuthToken)) return { flags: options.flags, source: 'flag' };
  if (hasToken(env.AGENT_DEVICE_DAEMON_AUTH_TOKEN)) {
    return { flags: options.flags, source: 'env' };
  }
  if (!shouldUseCloudAuth(options.flags.daemonBaseUrl, env)) {
    return { flags: options.flags, source: 'none' };
  }

  const sessionAccess = await resolveCliSessionAccess({
    stateDir: options.stateDir,
    flags: options.flags,
    env,
    io: options.io,
  });
  if (sessionAccess) {
    return {
      flags: { ...options.flags, daemonAuthToken: sessionAccess.accessToken },
      source: 'cli-session',
    };
  }

  if (!options.allowInteractiveLogin) {
    if (options.flags.noLogin) {
      throw new AppError('UNAUTHORIZED', 'Remote daemon authentication is required.', {
        hint: 'Run agent-device auth login, unset --no-login, or set AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
      });
    }
    throw buildNonInteractiveLoginError(options.command, env);
  }

  const login = await loginWithDeviceAuth({
    stateDir: options.stateDir,
    flags: options.flags,
    env,
    io: options.io,
  });
  return {
    flags: { ...options.flags, daemonAuthToken: login.accessToken },
    source: 'login',
  };
}

export async function resolveCloudAccessForConnect(options: {
  stateDir: string;
  flags: CliFlags;
  env: EnvMap;
  io?: AuthIo;
}): Promise<{
  accessToken: string;
  cloudBaseUrl: string;
}> {
  const { env } = options;
  if (hasToken(options.flags.daemonAuthToken)) {
    return {
      accessToken: options.flags.daemonAuthToken,
      cloudBaseUrl: resolveCloudBaseUrl(env),
    };
  }
  if (hasToken(env.AGENT_DEVICE_DAEMON_AUTH_TOKEN)) {
    return {
      accessToken: env.AGENT_DEVICE_DAEMON_AUTH_TOKEN,
      cloudBaseUrl: resolveCloudBaseUrl(env),
    };
  }
  const sessionAccess = await resolveCliSessionAccess({
    stateDir: options.stateDir,
    flags: options.flags,
    env,
    io: options.io,
  });
  if (sessionAccess) {
    return {
      accessToken: sessionAccess.accessToken,
      cloudBaseUrl: sessionAccess.cloudBaseUrl,
    };
  }
  if (options.flags.noLogin) {
    throw new AppError('UNAUTHORIZED', 'Cloud connection profile authentication is required.', {
      hint: 'Run agent-device auth login, unset --no-login, or set AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
    });
  }
  const login = await loginWithDeviceAuth({
    stateDir: options.stateDir,
    flags: options.flags,
    env,
    io: options.io,
    commandLabel: 'agent-device connect',
  });
  return {
    accessToken: login.accessToken,
    cloudBaseUrl: login.session.cloudBaseUrl,
  };
}

export async function loginWithDeviceAuth(options: {
  stateDir: string;
  flags: CliFlags;
  env: EnvMap;
  io?: AuthIo;
  commandLabel?: string;
}): Promise<{
  accessToken: string;
  expiresAt?: string;
  session: CliSessionRecord;
}> {
  const { env } = options;
  const authMode = detectAuthMode(env, options.io);
  if (authMode === 'non-interactive') {
    throw buildNonInteractiveLoginError(options.commandLabel ?? 'agent-device connect', env);
  }
  const cloudBaseUrl = resolveCloudBaseUrl(env);
  const start = await postJson<DeviceAuthStartResponse>({
    baseUrl: cloudBaseUrl,
    pathName: DEVICE_AUTH_START_PATH,
    body: {
      client: 'agent-device',
      tenant: options.flags.tenant,
      runId: options.flags.runId,
      daemonBaseUrl: options.flags.daemonBaseUrl,
      session: options.flags.session,
    },
    fetchImpl: options.io?.fetch,
  });
  await assertDeviceAuthStart(start);

  const verificationUrl = hasToken(start.verificationUriComplete)
    ? start.verificationUriComplete
    : start.verificationUri;
  if (authMode === 'local-browser') {
    writeStderr(
      options.io,
      `Opening ${start.verificationUri}...\n${describeUserCode(start.userCode)}`,
    );
    await openBrowser(verificationUrl, options.io);
  } else {
    const printableUrl = appendUserCode(start.verificationUri, start.userCode);
    writeStderr(
      options.io,
      `Open this URL on your machine:\n${printableUrl}\n\nWaiting for approval for 10 minutes...\n`,
    );
  }

  const approved = await pollDeviceAuth({
    cloudBaseUrl,
    deviceCode: start.deviceCode,
    expiresIn: start.expiresIn,
    interval: start.interval,
    fetchImpl: options.io?.fetch,
    now: options.io?.now,
  });
  const refreshCredential =
    approved.cliSession?.refreshCredential ?? approved.cliSession?.refreshToken;
  if (!hasToken(approved.accessToken) || !hasToken(refreshCredential)) {
    throw new AppError('UNAUTHORIZED', 'Device authorization did not return CLI credentials.');
  }
  const nowIso = new Date(options.io?.now?.() ?? Date.now()).toISOString();
  const session: CliSessionRecord = {
    version: 1,
    id: approved.cliSession?.id ?? `cli-${Date.now().toString(36)}`,
    cloudBaseUrl,
    workspaceId: approved.cliSession?.workspaceId,
    accountId: approved.cliSession?.accountId,
    name: approved.cliSession?.name,
    refreshCredential,
    createdAt: nowIso,
    expiresAt: approved.cliSession?.expiresAt,
  };
  await withCliSessionLock(
    options.stateDir,
    () => writeCliSession({ stateDir: options.stateDir, session }),
    { io: options.io, keepWaiting: true },
  );
  const refreshed = await refreshExpiredLoginToken({
    stateDir: options.stateDir,
    approved,
    flags: options.flags,
    env,
    io: options.io,
  });
  return {
    accessToken: refreshed?.accessToken ?? approved.accessToken,
    expiresAt: refreshed?.expiresAt ?? approved.expiresAt,
    session,
  };
}

/**
 * Exchanges the access token an approved login returned when it is already expired: a wait for a
 * stuck sibling's session lock can outlive the token the cloud approved with. The exchange runs on
 * the session that is saved now, which may be another process's login, and reports its own refusal
 * the way a command's refresh does.
 */
async function refreshExpiredLoginToken(options: {
  stateDir: string;
  approved: DeviceAuthPollResponse;
  flags: CliFlags;
  env: EnvMap;
  io?: AuthIo;
}): Promise<{ accessToken: string; expiresAt?: string } | null> {
  const { approved, env, flags, io, stateDir } = options;
  if (!isExpired(approved.expiresAt, io?.now)) return null;
  return await resolveCliSessionAccess({ stateDir, flags, env, io });
}

export function readCliSession(options: { stateDir: string }): CliSessionRecord | null {
  const filePath = resolveCliSessionPath(options.stateDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CliSessionRecord>;
    if (
      parsed.version !== 1 ||
      !hasToken(parsed.id) ||
      !hasToken(parsed.cloudBaseUrl) ||
      !hasToken(parsed.refreshCredential) ||
      !hasToken(parsed.createdAt)
    ) {
      return null;
    }
    return parsed as CliSessionRecord;
  } catch {
    return null;
  }
}

export function writeCliSession(options: { stateDir: string; session: CliSessionRecord }): void {
  const filePath = resolveCliSessionPath(options.stateDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  publishFileSync({
    destination: filePath,
    contents: `${JSON.stringify(options.session, null, 2)}\n`,
    mode: 0o600,
    exactMode: true,
  });
}

export async function removeCliSession(options: { stateDir: string }): Promise<boolean> {
  const filePath = resolveCliSessionPath(options.stateDir);
  if (!fs.existsSync(filePath)) return false;
  return await withCliSessionLock(options.stateDir, () => {
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath, { force: true });
    return true;
  });
}

/**
 * Serializes the changes to the session file: a login's write, a logout's removal, and the read,
 * token exchange and write that store a rotated credential. Device approval polling stays outside.
 * `keepWaiting` is for a change the cloud will not repeat (an approved login, a rotated
 * credential): a timed-out wait warns and waits again, and the change is never dropped. A change
 * that took effect is reported as done even when the lock is not given back cleanly: that release
 * failure is a warning, and the next contender reclaims the spent claim.
 */
async function withCliSessionLock<Result>(
  stateDir: string,
  task: () => Result | Promise<Result>,
  options: { io?: AuthIo; keepWaiting?: boolean } = {},
): Promise<Result> {
  const { io } = options;
  const sessionPath = resolveCliSessionPath(stateDir);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  const owner = readCurrentOwnerIdentity();
  const acquire = () =>
    acquireProcessLock({
      lockDirPath: `${sessionPath}.lock`,
      owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
      timeoutMs: CLI_SESSION_LOCK_TIMEOUT_MS,
      description: 'cloud CLI session file',
    });
  let release: Awaited<ReturnType<typeof acquire>> | undefined;
  while (!release) {
    try {
      release = await acquire();
    } catch (error) {
      if (!options.keepWaiting || !isProcessLockTimeout(error)) throw error;
      warnBestEffort(
        io,
        'Waiting for another agent-device process to release the CLI session file...\n',
      );
    }
  }
  let result: Result;
  try {
    result = await task();
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
  await release().catch(() => {
    warnBestEffort(io, 'Warning: the CLI session file lock could not be released cleanly.\n');
  });
  return result;
}

function isProcessLockTimeout(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === 'process_lock_timeout';
}

export function resolveCliSessionPath(stateDir: string): string {
  return path.join(stateDir, 'auth', 'cli-session.json');
}

export function summarizeCliSession(options: { stateDir: string; now?: () => number }): {
  authenticated: boolean;
  source: 'cli-session' | 'none';
  sessionId?: string;
  cloudBaseUrl?: string;
  workspaceId?: string;
  accountId?: string;
  name?: string;
  createdAt?: string;
  expiresAt?: string;
  expired?: boolean;
} {
  const session = readCliSession({ stateDir: options.stateDir });
  if (!session) return { authenticated: false, source: 'none' };
  return {
    authenticated: true,
    source: 'cli-session',
    sessionId: session.id,
    cloudBaseUrl: session.cloudBaseUrl,
    workspaceId: session.workspaceId,
    accountId: session.accountId,
    name: session.name,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    expired: isExpired(session.expiresAt, options.now),
  };
}

async function resolveCliSessionAccess(options: {
  stateDir: string;
  flags: CliFlags;
  env: EnvMap;
  io?: AuthIo;
}): Promise<{ accessToken: string; expiresAt?: string; cloudBaseUrl: string } | null> {
  const { env, flags, io, stateDir } = options;
  // This read only asks whether there is a session to exchange, so a command that has none takes no
  // lock and writes nothing. The credential is read again once the lock is held.
  const stored = readCliSession({ stateDir });
  if (!stored || isExpired(stored.expiresAt, io?.now)) return null;
  return await withCliSessionLock(
    stateDir,
    async () => {
      const session = readCliSession({ stateDir });
      if (!session || isExpired(session.expiresAt, io?.now)) return null;
      const cloudBaseUrl = resolveCloudBaseUrl(env, session.cloudBaseUrl);
      let sent = session;
      for (let exchange = 1; ; exchange += 1) {
        const refreshed = await refreshAgentToken({ session: sent, flags, env, io });
        const rotation = readCredentialRotation(refreshed, sent.refreshCredential);
        if (rotation) {
          sent = storeRotatedCredential({ stateDir, sent, rotation, io });
        }
        if (
          !isExpired(refreshed.expiresAt, io?.now) ||
          exchange >= MAX_CLI_SESSION_TOKEN_EXCHANGES
        ) {
          return {
            accessToken: refreshed.accessToken,
            ...(hasToken(refreshed.expiresAt) ? { expiresAt: refreshed.expiresAt } : {}),
            cloudBaseUrl,
          };
        }
      }
    },
    { io, keepWaiting: true },
  );
}

/**
 * Reads the credential rotation a refresh response asks for, or `null` when it carries none. A
 * session expiry in the response is part of the rotation: a cloud whose session expiry slides with
 * use tells the CLI so here. The response's own `expiresAt` is the access token's expiry, not this.
 */
function readCredentialRotation(
  refreshed: { refreshCredential?: string; sessionExpiresAt?: string },
  sentCredential: string,
): { refreshCredential: string; expiresAt?: string } | null {
  const refreshCredential = refreshed.refreshCredential;
  if (!hasToken(refreshCredential) || refreshCredential === sentCredential) return null;
  return {
    refreshCredential,
    ...(hasToken(refreshed.sessionExpiresAt) ? { expiresAt: refreshed.sessionExpiresAt } : {}),
  };
}

/**
 * Stores the credential that replaced the one this command sent, and answers with the record the
 * next exchange asks with. The session file lock is held here, and the file is read again first: a
 * change that is visible on that read (another command's store, a login, a logout) wins, and nothing
 * is written. A failed write keeps the command's access token and warns, because the cloud refuses
 * the old credential after its grace period. Either way the command keeps asking with the
 * replacement the cloud just gave it.
 */
function storeRotatedCredential(options: {
  stateDir: string;
  sent: CliSessionRecord;
  rotation: { refreshCredential: string; expiresAt?: string };
  io?: AuthIo;
}): CliSessionRecord {
  const { rotation, sent } = options;
  try {
    const stored = readCliSession({ stateDir: options.stateDir });
    if (stored?.id === sent.id && stored.refreshCredential === sent.refreshCredential) {
      const replaced: CliSessionRecord = { ...stored, ...rotation };
      writeCliSession({ stateDir: options.stateDir, session: replaced });
      return replaced;
    }
  } catch {
    warnBestEffort(
      options.io,
      'Warning: the renewed CLI session could not be saved. ' +
        'If the next command is not authenticated, run agent-device auth login.\n',
    );
  }
  return { ...sent, ...rotation };
}

async function refreshAgentToken(options: {
  session: CliSessionRecord;
  flags: CliFlags;
  env: EnvMap;
  io?: AuthIo;
}): Promise<{
  accessToken: string;
  expiresAt?: string;
  refreshCredential?: string;
  sessionExpiresAt?: string;
}> {
  const cloudBaseUrl = resolveCloudBaseUrl(options.env, options.session.cloudBaseUrl);
  const response = await postJson<CliSessionRefreshResponse>({
    baseUrl: cloudBaseUrl,
    pathName: CLI_SESSION_REFRESH_PATH,
    body: {
      refreshCredential: options.session.refreshCredential,
      // This CLI stores a replacement credential from the response, so the cloud may rotate it.
      // Commands run in parallel and each refreshes, so a cloud that rotates must: issue at most
      // one replacement for a credential; answer a request that still presents the replaced
      // credential with an access token and no further replacement; and keep the replaced
      // credential valid for a grace period that covers commands already in flight.
      acceptsRotatedRefreshCredential: true,
      tenant: options.flags.tenant,
      runId: options.flags.runId,
      daemonBaseUrl: options.flags.daemonBaseUrl,
      session: options.flags.session,
    },
    fetchImpl: options.io?.fetch,
  });
  // Revocation is answered before the tokens: a response that reports it is refused even when it
  // also carries credentials.
  if (response.status === 'revoked' || response.error === 'revoked') {
    throw new AppError('UNAUTHORIZED', 'Stored cloud CLI session was revoked.', {
      hint: 'Run agent-device auth login again, or set AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
      status: response.status,
      error: response.error,
    });
  }
  if (hasToken(response.accessToken)) {
    return {
      accessToken: response.accessToken,
      expiresAt: response.expiresAt,
      ...(hasToken(response.refreshCredential)
        ? { refreshCredential: response.refreshCredential }
        : {}),
      ...(hasToken(response.cliSession?.expiresAt)
        ? { sessionExpiresAt: response.cliSession.expiresAt }
        : {}),
    };
  }
  throw new AppError('UNAUTHORIZED', 'Failed to refresh CLI session.', {
    hint: 'Run agent-device auth login again, or set AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
    status: response.status,
    error: response.error,
  });
}

async function pollDeviceAuth(options: {
  cloudBaseUrl: string;
  deviceCode: string;
  expiresIn: number | undefined;
  interval: number | undefined;
  // di-seam-approved: same fetch-global seam as AuthIo.fetch above, threaded through this
  // device-auth-poll helper as fetchImpl.
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<DeviceAuthPollResponse> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.min((options.expiresIn ?? 600) * 1000, DEVICE_POLL_TIMEOUT_MS);
  const deadline = now() + timeoutMs;
  let intervalMs = Math.max(
    MIN_POLL_INTERVAL_MS,
    (options.interval ?? DEFAULT_POLL_INTERVAL_MS / 1000) * 1000,
  );
  while (now() < deadline) {
    const response = await postJson<DeviceAuthPollResponse>({
      baseUrl: options.cloudBaseUrl,
      pathName: DEVICE_AUTH_POLL_PATH,
      body: { deviceCode: options.deviceCode },
      fetchImpl: options.fetchImpl,
    });
    if (response.status === 'approved' || hasToken(response.accessToken)) return response;
    if (response.status === 'slow_down' || response.error === 'slow_down') {
      intervalMs += MIN_POLL_INTERVAL_MS;
    } else if (
      response.status !== 'authorization_pending' &&
      response.error !== 'authorization_pending'
    ) {
      throw new AppError('UNAUTHORIZED', 'Device authorization was not approved.', {
        status: response.status,
        error: response.error,
      });
    }
    await sleep(intervalMs);
  }
  throw new AppError('TIMEOUT', 'Device authorization expired before approval.');
}

async function postJson<T>(options: {
  baseUrl: string;
  pathName: string;
  body: Record<string, unknown>;
  // di-seam-approved: same fetch-global seam as AuthIo.fetch above, threaded through this
  // postJson helper as fetchImpl.
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL(options.pathName, options.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return await readCloudJsonResponse<T>(response, {
    invalidJsonMessage: `Cloud auth endpoint returned invalid JSON (${response.status}).`,
    rejectedMessage: 'Cloud auth endpoint rejected the request.',
  });
}

type UnusableDeviceAuthStartField =
  | 'deviceCode'
  | 'userCode'
  | 'verificationUri'
  | 'verificationUriComplete';

/**
 * Both verification URIs are printed and one of them is launched, so the start response is checked
 * as it arrives rather than at each use.
 */
async function assertDeviceAuthStart(response: DeviceAuthStartResponse): Promise<void> {
  if (!hasToken(response.deviceCode)) {
    throw unusableDeviceAuthStartResponse('deviceCode');
  }
  if (!hasToken(response.userCode)) {
    throw unusableDeviceAuthStartResponse('userCode');
  }
  if (!hasToken(response.verificationUri)) {
    throw unusableDeviceAuthStartResponse('verificationUri');
  }
  const { isSafeBrowserUrl } = await import('./browser-launch.ts');
  if (!isSafeBrowserUrl(response.verificationUri)) {
    throw unusableDeviceAuthStartResponse('verificationUri');
  }
  if (
    hasToken(response.verificationUriComplete) &&
    !isSafeBrowserUrl(response.verificationUriComplete)
  ) {
    throw unusableDeviceAuthStartResponse('verificationUriComplete');
  }
}

function unusableDeviceAuthStartResponse(field: UnusableDeviceAuthStartField): AppError {
  return new AppError('COMMAND_FAILED', 'Cloud auth start returned an unusable response.', {
    field,
  });
}

function detectAuthMode(
  env: EnvMap,
  io?: AuthIo,
): 'local-browser' | 'device-code' | 'non-interactive' {
  const stdinIsTTY = io?.stdinIsTTY ?? process.stdin.isTTY;
  const stdoutIsTTY = io?.stdoutIsTTY ?? process.stdout.isTTY;
  if (isCi(env) || !stdinIsTTY || !stdoutIsTTY) return 'non-interactive';
  if (isRemoteShell(env)) return 'device-code';
  return 'local-browser';
}

function isCi(env: EnvMap): boolean {
  return env.CI === 'true' || env.GITHUB_ACTIONS === 'true' || env.BUILDKITE === 'true';
}

function isRemoteShell(env: EnvMap): boolean {
  return Boolean(
    env.SSH_TTY ||
    env.SSH_CONNECTION ||
    env.CODESPACES === 'true' ||
    env.GITPOD_WORKSPACE_ID ||
    env.REMOTE_CONTAINERS === 'true',
  );
}

function buildNonInteractiveLoginError(command: string, env: EnvMap): AppError {
  const cloudBaseUrl = resolveCloudBaseUrl(env);
  return new AppError(
    'UNAUTHORIZED',
    `${command} cannot perform interactive login in CI or a non-interactive shell.`,
    {
      hint:
        `Create a service/API token: ${new URL(API_KEYS_PATH, cloudBaseUrl).toString()} ` +
        'Then set AGENT_DEVICE_DAEMON_AUTH_TOKEN=adc_live_...',
    },
  );
}

function resolveCloudBaseUrl(env: EnvMap, fallback?: string): string {
  const raw = env.AGENT_DEVICE_CLOUD_BASE_URL ?? fallback ?? DEFAULT_CLOUD_BASE_URL;
  try {
    return new URL(raw).toString().replace(/\/+$/, '');
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid AGENT_DEVICE_CLOUD_BASE_URL.',
      { cloudBaseUrl: raw },
      error instanceof Error ? error : undefined,
    );
  }
}

function shouldUseCloudAuth(daemonBaseUrl: string, env: EnvMap): boolean {
  if (env.AGENT_DEVICE_CLOUD_AUTH === '1' || env.AGENT_DEVICE_CLOUD_AUTH === 'true') return true;
  if (hasToken(env.AGENT_DEVICE_CLOUD_BASE_URL)) return true;
  try {
    const hostname = new URL(daemonBaseUrl).hostname.toLowerCase();
    return hostname === 'agent-device.dev' || hostname.endsWith('.agent-device.dev');
  } catch {
    return false;
  }
}

/**
 * The line that lets the user compare the code in the browser with the terminal. A code with
 * characters outside letters, digits and dashes is not printed.
 */
function describeUserCode(userCode: string): string {
  return /^[A-Za-z0-9-]{4,32}$/.test(userCode)
    ? `Confirm that the browser shows this code: ${userCode}\n`
    : '';
}

function appendUserCode(verificationUri: string, userCode: string): string {
  const url = new URL(verificationUri);
  url.searchParams.set('user_code', userCode);
  return url.toString();
}

async function openBrowser(url: string, io?: AuthIo): Promise<void> {
  if (io?.openBrowser) {
    await io.openBrowser(url);
    return;
  }
  const { openUrlInBrowser } = await import('./browser-launch.ts');
  if (!(await openUrlInBrowser(url))) {
    writeStderr(io, `Open this URL on your machine:\n${url}\n`);
  }
}

/** Streams that already carry the listener that absorbs a late write error. */
const errorAbsorbingStreams = new WeakSet<object>();

/**
 * Writes a warning that must not change the result of a change that already took effect. A
 * closed stderr fails the write synchronously, or later with an EPIPE `error` event; both are
 * dropped. Each stream gets one absorbing listener, because the event fires after the write callback.
 */
function warnBestEffort(io: AuthIo | undefined, text: string): void {
  const stream = io?.stderr ?? process.stderr;
  const emitter = stream as Partial<NodeJS.WriteStream>;
  if (emitter.on && !errorAbsorbingStreams.has(stream)) {
    emitter.on('error', () => {});
    errorAbsorbingStreams.add(stream);
  }
  try {
    stream.write(text);
  } catch {
    // A warning is optional output.
  }
}

function writeStderr(io: AuthIo | undefined, text: string): void {
  (io?.stderr ?? process.stderr).write(text);
}

function isExpired(expiresAt: string | undefined, now: (() => number) | undefined): boolean {
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp <= (now?.() ?? Date.now());
}

function hasToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
