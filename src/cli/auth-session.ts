import fs from 'node:fs';
import path from 'node:path';
import { runCmd } from '../utils/exec.ts';
import { AppError } from '../kernel/errors.ts';
import type { CliFlags } from '../utils/cli-flags.ts';
import type { EnvMap } from '../utils/env-map.ts';
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
  expiresAt?: string;
  status?: string;
  error?: string;
};

type AuthIo = {
  env?: EnvMap;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  now?: () => number;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
};

export async function resolveRemoteAuthForCli(options: {
  command: string;
  flags: CliFlags;
  stateDir: string;
  env?: EnvMap;
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
  env?: EnvMap;
  io?: AuthIo;
}): Promise<RemoteAuthResolution> {
  const env = options.env ?? options.io?.env ?? process.env;
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
  env?: EnvMap;
  io?: AuthIo;
}): Promise<{
  accessToken: string;
  cloudBaseUrl: string;
}> {
  const env = options.env ?? options.io?.env ?? process.env;
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
  env?: EnvMap;
  io?: AuthIo;
  commandLabel?: string;
}): Promise<{
  accessToken: string;
  expiresAt?: string;
  session: CliSessionRecord;
}> {
  const env = options.env ?? options.io?.env ?? process.env;
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
  assertDeviceAuthStart(start);

  const verificationUrl = start.verificationUriComplete ?? start.verificationUri;
  const printableUrl =
    authMode === 'local-browser'
      ? start.verificationUri
      : appendUserCode(start.verificationUri, start.userCode);
  if (authMode === 'local-browser') {
    writeStderr(options.io, `Opening ${start.verificationUri}...\n`);
    await openBrowser(verificationUrl, options.io);
  } else {
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
  writeCliSession({ stateDir: options.stateDir, session });
  return {
    accessToken: approved.accessToken,
    expiresAt: approved.expiresAt,
    session,
  };
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
  fs.writeFileSync(filePath, `${JSON.stringify(options.session, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX mode bits.
  }
}

export function removeCliSession(options: { stateDir: string }): boolean {
  const filePath = resolveCliSessionPath(options.stateDir);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
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
}): Promise<{ accessToken: string; cloudBaseUrl: string } | null> {
  const session = readCliSession({ stateDir: options.stateDir });
  if (!session || isExpired(session.expiresAt, options.io?.now)) {
    return null;
  }
  const refreshed = await refreshAgentToken({
    session,
    flags: options.flags,
    env: options.env,
    io: options.io,
  });
  return {
    accessToken: refreshed.accessToken,
    cloudBaseUrl: resolveCloudBaseUrl(options.env, session.cloudBaseUrl),
  };
}

async function refreshAgentToken(options: {
  session: CliSessionRecord;
  flags: CliFlags;
  env: EnvMap;
  io?: AuthIo;
}): Promise<{ accessToken: string; expiresAt?: string }> {
  const cloudBaseUrl = resolveCloudBaseUrl(options.env, options.session.cloudBaseUrl);
  const response = await postJson<CliSessionRefreshResponse>({
    baseUrl: cloudBaseUrl,
    pathName: CLI_SESSION_REFRESH_PATH,
    body: {
      refreshCredential: options.session.refreshCredential,
      tenant: options.flags.tenant,
      runId: options.flags.runId,
      daemonBaseUrl: options.flags.daemonBaseUrl,
      session: options.flags.session,
    },
    fetchImpl: options.io?.fetch,
  });
  if (hasToken(response.accessToken)) {
    return { accessToken: response.accessToken, expiresAt: response.expiresAt };
  }
  if (response.status === 'revoked' || response.error === 'revoked') {
    throw new AppError('UNAUTHORIZED', 'Stored cloud CLI session was revoked.', {
      hint: 'Run agent-device auth login again, or set AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
      status: response.status,
      error: response.error,
    });
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

function assertDeviceAuthStart(response: DeviceAuthStartResponse): void {
  if (
    !hasToken(response.deviceCode) ||
    !hasToken(response.userCode) ||
    !hasToken(response.verificationUri)
  ) {
    throw new AppError('COMMAND_FAILED', 'Cloud auth start returned an unusable response.');
  }
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
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      await runCmd('open', [url], { allowFailure: true, timeoutMs: 5000 });
    } else if (platform === 'win32') {
      await runCmd('cmd', ['/c', 'start', '', url], { allowFailure: true, timeoutMs: 5000 });
    } else {
      await runCmd('xdg-open', [url], { allowFailure: true, timeoutMs: 5000 });
    }
  } catch {
    writeStderr(io, `Open this URL on your machine:\n${url}\n`);
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
