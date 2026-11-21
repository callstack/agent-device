import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { publishFileSync } from '@agent-device/host-kit/file';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
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
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  now?: () => number;
  // di-seam-approved: injects the fetch global, which has no module boundary vi.mock can
  // intercept. auth-session.test.ts injects it directly for exact per-call assertions.
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
};

/**
 * The one guard over one state directory's auth state, shared by every write of it: an explicit
 * `auth login`, an `auth logout`, and the deferred save of a `connect` login this run holds while the
 * cloud names its provider. The guard is a revision record beside the session it governs, republished by
 * every write of that session. An explicit auth command writes what it approves and republishes the
 * revision. A held login reads the revision before its device authorization and saves only while that
 * revision still stands, so the newest auth command wins: an explicit login or logout that completed
 * while a connect held its login approved is never overwritten by that connect's later save. A counter is
 * used rather than the stored session itself, because a logout leaves the state directory holding no
 * session, which is what a first login finds too, and the two cannot tell a newer write from no write.
 *
 * The compare and the publish of a held login are separate filesystem calls, so an auth write landing
 * between them is still overwritten. What this guard rules out is the reported shape: a write that
 * finished before a held login read the revision is always seen by that read.
 */
const AUTH_REVISION_FILE_NAME = 'cli-session.revision.json';
/** The shape of a revision record. A record of another version is unreadable, not absent. */
const AUTH_REVISION_RECORD_VERSION = 1;

type AuthRevisionRecord = Readonly<{ version: 1; generation: number }>;

/**
 * The auth revision of one state directory, as the guard answers it: no auth write recorded yet, a
 * recorded generation, or a record the reader cannot parse. An unreadable record is unknown evidence,
 * so a held login is not saved on it rather than concluding nothing changed.
 */
type AuthRevision =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'recorded'; generation: number }>
  | Readonly<{ state: 'unreadable' }>;

/**
 * A login of one `connect` run, held between its approval and the admission of the provider that run
 * discovers. `revision` is the auth revision this state directory carried when the cloud approved the
 * login, and the held session is saved only while that revision still stands.
 */
type PendingLogin = {
  stateDir: string;
  session: CliSessionRecord;
  revision: AuthRevision;
};

const pendingLoginScope = new AsyncLocalStorage<{ pending?: PendingLogin }>();

/**
 * Runs one command, holding a login it approves until that run's provider is admitted. Only
 * `defersLogin` defers, and the CLI sets it for the one `connect` that learns its provider from the
 * cloud control plane, which is the only route that can approve a login before it knows the provider.
 * That route saves the pending login with {@link savePendingLoginAtAdmission} once the provider is
 * admitted, or drops it with {@link discardPendingLoginAtRefusal} when the provider's plugin is
 * refused. A run that ends with its login still pending, because discovery failed before any provider
 * was named, saves it, so a failure unrelated to a provider does not cost the login. Every other
 * route, including explicit `auth login`, saves a login as soon as it is approved. A held login is
 * published only while the auth revision it captured still stands, so it never overwrites auth state
 * an explicit `auth login` or `auth logout` wrote meanwhile: see {@link publishHeldLogin}.
 */
export async function withDeferredLogin<T>(
  options: { defersLogin: boolean },
  run: () => Promise<T>,
): Promise<T> {
  if (!options.defersLogin) return await run();
  const scope: { pending?: PendingLogin } = {};
  try {
    return await pendingLoginScope.run(scope, run);
  } finally {
    // Only a run that ended before it names a provider gets here with a pending login.
    if (scope.pending) publishHeldLogin(scope.pending);
  }
}

/**
 * Saves the login this run holds because its provider was just admitted. A route saves before it
 * generates or publishes connection state, so a login it cannot save stops the command there. A login
 * an explicit `auth login` or `auth logout` superseded while it was held is not saved and is not an
 * error: the state directory already holds the auth state its caller asked for last.
 */
export function savePendingLoginAtAdmission(): void {
  const scope = pendingLoginScope.getStore();
  const pending = scope?.pending;
  if (scope === undefined) return;
  scope.pending = undefined;
  if (pending) publishHeldLogin(pending);
}

/** Drops the login this run holds: its provider plugin was refused, so the route keeps no auth state. */
export function discardPendingLoginAtRefusal(): void {
  const scope = pendingLoginScope.getStore();
  if (scope) scope.pending = undefined;
}

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
  // The revision is read before the control plane is asked, so it is the answer this state directory
  // gave when this login started, which is what a held login is compared with when it is saved.
  const revisionAtStart = readAuthRevision(options.stateDir);
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
    writeStderr(options.io, `Opening ${start.verificationUri}...\n`);
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
  const scope = pendingLoginScope.getStore();
  if (scope) scope.pending = { stateDir: options.stateDir, session, revision: revisionAtStart };
  else writeCliSession({ stateDir: options.stateDir, session });
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

/**
 * Saves the session an explicit auth command approved. The write is unconditional: an explicit login is
 * the newest answer for this state directory, and recording its revision is what makes a login another
 * run still holds stand down.
 */
export function writeCliSession(options: { stateDir: string; session: CliSessionRecord }): void {
  writeCliSessionRecord(options);
  recordAuthRevision(options.stateDir);
}

/**
 * Removes the stored session on an explicit `auth logout`, and records that revision so a login another
 * run holds stands down instead of signing this state directory back in. Nothing is removed and nothing
 * is recorded when no session was stored, since that command changed nothing here.
 */
export function removeCliSession(options: { stateDir: string }): boolean {
  const filePath = resolveCliSessionPath(options.stateDir);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  recordAuthRevision(options.stateDir);
  return true;
}

/**
 * Saves a login this run held, only while the auth revision it read before its device authorization
 * still stands. A login that no longer stands is not saved, and is not a failure of this command: the
 * state directory holds the auth state its caller asked for last, which is why the stand-down is logged
 * rather than thrown. The revision is recorded after the session is written, so a reader that finds the
 * newer session always finds its revision too.
 */
function publishHeldLogin(pending: PendingLogin): void {
  const current = readAuthRevision(pending.stateDir);
  if (!sameAuthRevision(pending.revision, current)) {
    emitDiagnostic({
      level: 'info',
      phase: 'cli_deferred_login_superseded',
      data: {
        reason: current.state === 'unreadable' ? 'auth-revision-unreadable' : 'newer-auth-revision',
        held: pending.revision,
        current,
      },
    });
    return;
  }
  writeCliSessionRecord({ stateDir: pending.stateDir, session: pending.session });
  recordAuthRevision(pending.stateDir);
}

function writeCliSessionRecord(options: { stateDir: string; session: CliSessionRecord }): void {
  const filePath = resolveCliSessionPath(options.stateDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  publishFileSync({
    destination: filePath,
    contents: `${JSON.stringify(options.session, null, 2)}\n`,
    mode: 0o600,
    exactMode: true,
  });
}

/**
 * The auth revision this state directory's guard holds: the number of auth writes it has recorded. A
 * record that cannot be read is its own answer, so a caller never mistakes unknown for unchanged.
 */
function readAuthRevision(stateDir: string): AuthRevision {
  let contents: string;
  try {
    contents = fs.readFileSync(resolveAuthRevisionPath(stateDir), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'absent' } : { state: 'unreadable' };
  }
  const generation = parseAuthRevisionGeneration(contents);
  return generation === undefined ? { state: 'unreadable' } : { state: 'recorded', generation };
}

/** Publishes the revision that follows the one held, so the newest auth write of this directory owns it. */
function recordAuthRevision(stateDir: string): void {
  const current = readAuthRevision(stateDir);
  const marker: AuthRevisionRecord = {
    version: AUTH_REVISION_RECORD_VERSION,
    generation: current.state === 'recorded' ? current.generation + 1 : 1,
  };
  publishFileSync({
    destination: resolveAuthRevisionPath(stateDir),
    contents: `${JSON.stringify(marker, null, 2)}\n`,
    mode: 0o600,
    exactMode: true,
  });
}

/**
 * Whether a held login's reading is still the reading the guard holds. An unreadable reading on either
 * side answers no: a record that cannot be read says nothing about what was written since, which is not
 * proof that nothing was, so a held login is not saved on it.
 */
function sameAuthRevision(left: AuthRevision, right: AuthRevision): boolean {
  if (left.state === 'absent') return right.state === 'absent';
  return (
    left.state === 'recorded' && right.state === 'recorded' && right.generation === left.generation
  );
}

function parseAuthRevisionGeneration(contents: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const marker = parsed as Record<string, unknown> | null;
  if (marker === null || typeof marker !== 'object') return undefined;
  if (marker.version !== AUTH_REVISION_RECORD_VERSION) return undefined;
  const generation = marker.generation;
  return typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0
    ? generation
    : undefined;
}

function resolveAuthRevisionPath(stateDir: string): string {
  return path.join(stateDir, 'auth', AUTH_REVISION_FILE_NAME);
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
