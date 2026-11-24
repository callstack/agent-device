import fs from 'node:fs';
import path from 'node:path';
import { acquireProcessLock, publishFileSync } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { CliFlags } from '@agent-device/contracts/command';
import { type EnvMap } from '@agent-device/kernel/source-value';
import {
  CLI_SESSION_FORMAT_VERSION,
  parseCliSessionRecord,
  type CliSessionRecord,
} from './cli-session-format.ts';

// The transport loads when a request is made, so a command that reads no cloud auth stays off it.
const postCloudAuthJson: typeof import('./cloud-auth-request.ts').postCloudAuthJson = async (o) =>
  (await import('./cloud-auth-request.ts')).postCloudAuthJson(o);
export const DEFAULT_CLOUD_BASE_URL = 'https://cloud.agent-device.dev';
const DEVICE_AUTH_START_PATH = '/api/control-plane/device-auth/start';
const DEVICE_AUTH_POLL_PATH = '/api/control-plane/device-auth/poll';
const CLI_SESSION_REFRESH_PATH = '/api/control-plane/cli-session/refresh';
const API_KEYS_PATH = '/api-keys';
const DEVICE_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
// The lock covers rotation and storage, including the two bounded refresh attempts.
const CLI_SESSION_LOCK_TIMEOUT_MS = 60_000;
// A response whose access token is already expired is asked again, and no further: a cloud that
// keeps answering with an expired token must not keep a command refreshing.
const MAX_CLI_SESSION_TOKEN_EXCHANGES = 2;

/** Every `details.reason` the CLI session store publishes. */
const CLI_SESSION_REASONS = {
  // The cloud answered a refresh by reporting the stored session revoked.
  revoked: { reason: 'cli_session_revoked', commands: ['connect'] },
  // The refresh answered without an access token, so the CLI has nothing to send.
  tokenless: { reason: 'cli_session_refresh_unanswered', commands: ['connect'] },
  // The directory holding the session file cannot be written, so its lock cannot be taken.
  storeUnwritable: { reason: 'cli_session_store_unwritable', commands: ['connect'] },
  // The cloud API origin named by AGENT_DEVICE_CLOUD_BASE_URL differs from the origin that issued
  // the stored CLI session, so the stored credential is not sent. Log in with the named origin, or
  // unset the override.
  loginOriginMismatch: { reason: 'cloud_login_origin_mismatch', commands: ['connect'] },
  // The stored CLI session does not record the cloud that issued its credential, as a session saved
  // by an older CLI does not, so the credential is not sent. Run agent-device auth login.
  issuerUnverified: { reason: 'cli_session_issuer_unverified', commands: ['connect'] },
} as const satisfies ReasonTable<'auth'>;

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
  error?: string | null;
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
    throw await buildNonInteractiveLoginError(options.command, env);
  }

  const login = await loginWithDeviceAuth({
    stateDir: options.stateDir,
    flags: options.flags,
    env,
    io: options.io,
    // The command sends this token itself, so a failed exchange is the command's failure.
    requiresLiveToken: true,
  });
  return {
    flags: { ...options.flags, daemonAuthToken: login.accessToken },
    source: 'login',
  };
}

export async function loginWithDeviceAuth(options: {
  stateDir: string;
  flags: CliFlags;
  env: EnvMap;
  io?: AuthIo;
  commandLabel?: string;
  // Whether the caller spends the returned access token itself. `connect` does, so a token exchange
  // that fails is its failure. `auth login` only prints the session, so it keeps the approved pair.
  requiresLiveToken?: boolean;
}): Promise<{
  accessToken: string;
  expiresAt?: string;
  session: CliSessionRecord;
}> {
  const { env } = options;
  const authMode = detectAuthMode(env, options.io);
  if (authMode === 'non-interactive') {
    throw await buildNonInteractiveLoginError(options.commandLabel ?? 'agent-device connect', env);
  }
  const cloudBaseUrl = await resolveCloudBaseUrl(env);
  const start = await postCloudAuthJson<DeviceAuthStartResponse>({
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
  const approvedToken = approved.accessToken;
  // Only a nonempty string counts as the approval's access-token expiry, so it is omitted for any
  // other value: one would reach `Date.parse` as a foreign object, which throws there after the
  // session is already saved. A string that cannot be read is kept: `isExpired` calls such a token
  // expired, so the login exchanges it instead of handing back a token of unknown age.
  const approvedExpiresAt = hasToken(approved.expiresAt) ? approved.expiresAt : undefined;
  const session: CliSessionRecord = {
    version: CLI_SESSION_FORMAT_VERSION,
    id: approved.cliSession?.id ?? `cli-${Date.now().toString(36)}`,
    cloudBaseUrl,
    workspaceId: approved.cliSession?.workspaceId,
    accountId: approved.cliSession?.accountId,
    name: approved.cliSession?.name,
    refreshCredential,
    createdAt: nowIso,
    expiresAt: approved.cliSession?.expiresAt,
  };
  return await withCliSessionLock(
    options.stateDir,
    async (): Promise<{ accessToken: string; expiresAt?: string; session: CliSessionRecord }> => {
      writeCliSession({ stateDir: options.stateDir, session });
      if (!isExpired(approvedExpiresAt, options.io?.now))
        return {
          accessToken: approvedToken,
          ...(hasToken(approvedExpiresAt) ? { expiresAt: approvedExpiresAt } : {}),
          session,
        };
      // The approval's access token already expired: its expiry says nothing about the login's
      // answer, so the transient-failure path below reports the approved pair without one.
      try {
        // The exchange runs on the record just saved, under the same acquisition that saved it:
        // another login cannot write between the two and have its credential exchanged here.
        return await exchangeCliSessionAccess({
          stateDir: options.stateDir,
          session,
          flags: options.flags,
          io: options.io,
        });
      } catch (error) {
        // A session the cloud reported revoked is refused even to an explicit login. Every other
        // failure is transient, and the approved session is already saved: a caller that spends the
        // token itself needs the live one and propagates, while `auth login` only prints the session
        // and succeeds. An exchange that stored anything returned rather than threw, so the record
        // the file holds is still the approved one written above.
        if (options.requiresLiveToken || isCliSessionRevoked(error)) throw error;
        warnBestEffort(
          options.io,
          'Warning: the saved CLI session could not be exchanged for a live access token. ' +
            'The next command will refresh it.\n',
        );
        // The approved pair, without the expiry of a token whose exchange never answered.
        return { accessToken: approvedToken, session };
      }
    },
    { io: options.io, keepWaiting: true },
  );
}

export function readCliSession(options: { stateDir: string }): CliSessionRecord | null {
  const stored = readStoredCliSession(options.stateDir);
  return stored === 'unverified' ? null : stored;
}

/** Reads the session file. A missing or unreadable file answers `null`. */
function readStoredCliSession(stateDir: string): CliSessionRecord | 'unverified' | null {
  const filePath = resolveCliSessionPath(stateDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseCliSessionRecord(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The stored session to exchange, or `null` when there is none. A session whose issuer the file does
 * not establish is refused: its credential could belong to another cloud than its URL names.
 */
function readExchangeableCliSession(stateDir: string): CliSessionRecord | null {
  const stored = readStoredCliSession(stateDir);
  if (stored !== 'unverified') return stored;
  throw new AppError(
    'UNAUTHORIZED',
    'The stored CLI session does not record the cloud that issued it, so it must be renewed.',
    {
      reason: CLI_SESSION_REASONS.issuerUnverified.reason,
      hint: 'Run agent-device auth login, or set AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
    },
  );
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
 * `keepWaiting` is for a change the cloud will not repeat — an approved login: a timed-out wait
 * warns and waits again, and the change is never dropped. A read the cloud will answer again leaves
 * it off, so a command fails with the lock's typed reason instead of queueing behind a stuck
 * sibling. A change that took effect is reported as done even when the lock is not given back
 * cleanly: that release failure is a warning, and the next contender reclaims the spent claim.
 */
async function withCliSessionLock<Result>(
  stateDir: string,
  task: () => Result | Promise<Result>,
  options: { io?: AuthIo; keepWaiting?: boolean } = {},
): Promise<Result> {
  const sessionPath = resolveCliSessionPath(stateDir);
  const release = await acquireCliSessionLock(sessionPath, options);
  let result: Result;
  try {
    result = await task();
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
  await release().catch(() => {
    warnBestEffort(
      options.io,
      'Warning: the CLI session file lock could not be released cleanly.\n',
    );
  });
  return result;
}

async function acquireCliSessionLock(
  sessionPath: string,
  options: { io?: AuthIo; keepWaiting?: boolean },
): Promise<Awaited<ReturnType<typeof acquireProcessLock>>> {
  const { io } = options;
  const authDir = path.dirname(sessionPath);
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
      fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
      release = await acquire();
    } catch (error) {
      const fault = unwritableSessionStore(error, authDir);
      if (fault) throw fault;
      if (!options.keepWaiting || !isProcessLockTimeout(error)) throw error;
      warnBestEffort(
        io,
        'Waiting for another agent-device process to release the CLI session file...\n',
      );
    }
  }
  return release;
}

function isProcessLockTimeout(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === 'process_lock_timeout';
}

function unwritableSessionStore(error: unknown, authDir: string): AppError | undefined {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') return undefined;
  const fix = `Run \`chmod 700 ${authDir}\`, or point AGENT_DEVICE_STATE_DIR at a private directory you own.`;
  return new AppError(
    'COMMAND_FAILED',
    `The CLI session store ${authDir} cannot be written.`,
    {
      reason: CLI_SESSION_REASONS.storeUnwritable.reason,
      authDir,
      fix,
      hint: fix,
    },
    error instanceof Error ? error : undefined,
  );
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

export async function resolveCliSessionAccess(options: {
  stateDir: string;
  flags: CliFlags;
  env: EnvMap;
  io?: AuthIo;
  catalog?: true;
}): Promise<{
  accessToken: string;
  expiresAt?: string;
  cloudBaseUrl: string;
  catalogCredentials?: ReadonlySet<string>;
} | null> {
  const { env, flags, io, stateDir } = options;
  // This read only asks whether there is a session to exchange, so a command that has none takes no
  // lock and writes nothing. The credential is read again once the lock is held.
  const stored = readExchangeableCliSession(stateDir);
  if (!stored) return null;
  await assertStoredSessionOrigin(stored, env);
  if (isExpired(stored.expiresAt, io?.now)) return null;
  // A refresh read is not a change the cloud will not repeat: a wait that times out fails with its
  // typed reason, and the next command asks again.
  const catalogCredentials = options.catalog ? new Set<string>() : undefined;
  const exchanged = await withCliSessionLock(
    stateDir,
    async () => {
      const session = readExchangeableCliSession(stateDir);
      if (!session) return null;
      await assertStoredSessionOrigin(session, env);
      if (isExpired(session.expiresAt, io?.now)) return null;
      return await exchangeCliSessionAccess({ stateDir, session, flags, io, catalogCredentials });
    },
    { io },
  );
  if (!exchanged) return null;
  return {
    accessToken: exchanged.accessToken,
    catalogCredentials,
    ...(hasToken(exchanged.expiresAt) ? { expiresAt: exchanged.expiresAt } : {}),
    // The refresh went to the stored URL. A same-origin override still names the connection.
    cloudBaseUrl: await resolveCloudBaseUrl(env, exchanged.session.cloudBaseUrl),
  };
}

/**
 * The stored credential goes only to the cloud that issued it. An override that names another
 * origin would send it to that origin, so the command stops before any request.
 */
async function assertStoredSessionOrigin(session: CliSessionRecord, env: EnvMap): Promise<void> {
  const requestedOrigin = new URL(await resolveCloudBaseUrl(env, session.cloudBaseUrl)).origin;
  const storedOrigin = new URL(await resolveCloudBaseUrl({}, session.cloudBaseUrl)).origin;
  if (requestedOrigin === storedOrigin) return;
  throw new AppError(
    'UNAUTHORIZED',
    'The stored CLI session belongs to another cloud API origin.',
    {
      reason: CLI_SESSION_REASONS.loginOriginMismatch.reason,
      hint: 'Run agent-device auth login with this AGENT_DEVICE_CLOUD_BASE_URL, or unset it.',
    },
  );
}

/**
 * Exchanges a session's stored credential for an access token and answers with the token and the
 * session record the exchange leaves behind: the last one known saved, not one a failed write only
 * changed in memory. When the cloud rotates the credential, the next exchange asks with the
 * replacement even when storing it failed. The session file lock is held here, so the caller's write
 * of the record it exchanges cannot be separated from this exchange.
 */
async function exchangeCliSessionAccess(options: {
  stateDir: string;
  session: CliSessionRecord;
  flags: CliFlags;
  io?: AuthIo;
  catalogCredentials?: Set<string>;
}): Promise<{ accessToken: string; expiresAt?: string; session: CliSessionRecord }> {
  const { flags, io, stateDir, catalogCredentials } = options;
  // `asked` follows cloud rotation. `saved` follows the file, which may be behind after a write fails.
  const file = { holds: options.session as CliSessionRecord | null };
  let asked = options.session;
  let saved = options.session;
  let received: { accessToken: string; expiresAt?: string } | undefined;
  for (let exchange = 1; ; exchange += 1) {
    catalogCredentials?.add(asked.refreshCredential);
    let refreshed;
    try {
      refreshed = await refreshAgentToken({
        session: asked,
        flags,
        io,
        refuseRedirects: catalogCredentials !== undefined,
      });
    } catch (error) {
      // A failed optional refresh keeps the earlier token unless its session was refused.
      if (!received || refreshRejected(error, catalogCredentials !== undefined)) throw error;
      return { ...received, session: saved };
    }
    catalogCredentials?.add(refreshed.accessToken);
    const rotation = readCredentialRotation(refreshed, asked.refreshCredential);
    if (rotation) {
      catalogCredentials?.add(rotation.refreshCredential);
      ({ asked, saved } = storeRotatedCredential({
        stateDir,
        asked,
        saved,
        file,
        rotation,
        io,
      }));
    }
    received = {
      accessToken: refreshed.accessToken,
      ...(hasToken(refreshed.expiresAt) ? { expiresAt: refreshed.expiresAt } : {}),
    };
    if (!isExpired(refreshed.expiresAt, io?.now) || exchange >= MAX_CLI_SESSION_TOKEN_EXCHANGES) {
      return { ...received, session: saved };
    }
  }
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
  // A timestamp that cannot be read would make `isExpired` call the session expired, so one bad
  // response would lock the CLI out of a working session. It is kept out of the record.
  const readable = (value: string) => Number.isFinite(Date.parse(value));
  return {
    refreshCredential,
    ...(hasToken(refreshed.sessionExpiresAt) && readable(refreshed.sessionExpiresAt)
      ? { expiresAt: refreshed.sessionExpiresAt }
      : {}),
  };
}

/**
 * Stores the credential that replaced the one this command asked with, and answers with the record
 * the next exchange asks with, together with the last record known saved. Only a record this
 * function wrote counts as saved: a rotation the disk refused is asked with again and never
 * reported, so a command cannot print an expiry the file does not hold. The session file lock is held
 * here, and the file is read again first: a change visible on that read (another command's store, a
 * login, a logout) wins, the file is no longer this command's to write, and nothing is written. A
 * failed write keeps the command's access token and warns, because the cloud refuses the old
 * credential after its grace period.
 */
function storeRotatedCredential(options: {
  stateDir: string;
  asked: CliSessionRecord;
  saved: CliSessionRecord;
  file: { holds: CliSessionRecord | null };
  rotation: { refreshCredential: string; expiresAt?: string };
  io?: AuthIo;
}): { asked: CliSessionRecord; saved: CliSessionRecord } {
  const { asked, saved, file, rotation } = options;
  const held = file.holds;
  try {
    const stored = readCliSession({ stateDir: options.stateDir });
    if (
      held &&
      stored?.id === held.id &&
      stored.cloudBaseUrl === held.cloudBaseUrl &&
      stored.refreshCredential === held.refreshCredential
    ) {
      const replaced: CliSessionRecord = { ...stored, ...rotation };
      writeCliSession({ stateDir: options.stateDir, session: replaced });
      file.holds = replaced;
      return { asked: replaced, saved: replaced };
    }
  } catch {
    warnBestEffort(
      options.io,
      'Warning: the renewed CLI session could not be saved. ' +
        'If the next command is not authenticated, run agent-device auth login.\n',
    );
    // The file is still the record this command read, and the save of the next rotation is compared
    // to it, so a later save is tried again rather than skipped.
    return { asked: { ...asked, ...rotation }, saved };
  }
  // A session this command did not write: keep asking with what the cloud last gave.
  file.holds = null;
  return { asked: { ...asked, ...rotation }, saved };
}

function refreshRejected(error: unknown, refuseRedirects: boolean): boolean {
  if (isCliSessionRevoked(error)) return true;
  return (
    refuseRedirects &&
    error instanceof AppError &&
    error.details?.reason === 'cloud_auth_redirect_refused'
  );
}

async function refreshAgentToken(options: {
  session: CliSessionRecord;
  flags: CliFlags;
  io?: AuthIo;
  refuseRedirects: boolean;
}): Promise<{
  accessToken: string;
  expiresAt?: string;
  refreshCredential?: string;
  sessionExpiresAt?: string;
}> {
  // The refresh goes to the URL stored with the session, never to an override.
  const response = await postCloudAuthJson<CliSessionRefreshResponse>({
    baseUrl: await resolveCloudBaseUrl({}, options.session.cloudBaseUrl),
    pathName: CLI_SESSION_REFRESH_PATH,
    body: {
      refreshCredential: options.session.refreshCredential,
      // Rotation is idempotent while concurrent commands still hold the original credential.
      acceptsRotatedRefreshCredential: true,
      tenant: options.flags.tenant,
      runId: options.flags.runId,
      daemonBaseUrl: options.flags.daemonBaseUrl,
      session: options.flags.session,
    },
    fetchImpl: options.io?.fetch,
    refuseRedirects: options.refuseRedirects,
    classifyRejectedBody: (parsed) => readCliSessionRevocation(parsed),
  });
  // Revocation is answered before the tokens: a response that reports it is refused even when it
  // also carries credentials. The refusal names only its own reason: `status` and `error` are
  // response-supplied text and can echo a credential back into the command's output.
  const revoked = readCliSessionRevocation(response);
  if (revoked) throw revoked;
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
    reason: CLI_SESSION_REASONS.tokenless.reason,
  });
}

/**
 * This CLI's refusal for a refresh response that reports the session revoked, or `undefined` for one
 * that carries neither revocation marker. Only the exact `revoked` marker counts, so any other
 * `status` or `error` stays whatever the generic HTTP handling makes of the response. The response's
 * own text is never copied: a hostile value under those keys can echo a credential into output.
 */
function readCliSessionRevocation(parsed: unknown): AppError | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { status, error } = parsed as { status?: unknown; error?: unknown };
  if (status !== 'revoked' && error !== 'revoked') return undefined;
  return new AppError('UNAUTHORIZED', 'Stored cloud CLI session was revoked.', {
    hint: 'Run agent-device auth login again, or set AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
    reason: CLI_SESSION_REASONS.revoked.reason,
  });
}

/** Whether a failure is this module's refusal of a session the cloud will not refresh again. */
function isCliSessionRevoked(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === CLI_SESSION_REASONS.revoked.reason;
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
    const response = await postCloudAuthJson<DeviceAuthPollResponse>({
      baseUrl: options.cloudBaseUrl,
      pathName: DEVICE_AUTH_POLL_PATH,
      body: { deviceCode: options.deviceCode },
      fetchImpl: options.fetchImpl,
    });
    if (isDeviceAuthApproved(response)) {
      return response;
    }
    const outcome = (response.error === '' ? undefined : response.error) ?? response.status;
    if (outcome === 'slow_down') {
      intervalMs += MIN_POLL_INTERVAL_MS;
    } else if (outcome !== 'authorization_pending') {
      throw new AppError('UNAUTHORIZED', 'Device authorization was not approved.');
    }
    await sleep(intervalMs);
  }
  throw new AppError('TIMEOUT', 'Device authorization expired before approval.');
}

function isDeviceAuthApproved({ status, error, accessToken }: DeviceAuthPollResponse): boolean {
  if (status === 'approved') return error === undefined || error === null || error === '';
  return status === undefined && error === undefined && hasToken(accessToken);
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

async function buildNonInteractiveLoginError(command: string, env: EnvMap): Promise<AppError> {
  const cloudBaseUrl = await resolveCloudBaseUrl(env);
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

async function resolveCloudBaseUrl(env: EnvMap, fallback?: string): Promise<string> {
  const { parseCloudUrl } = await import('./cloud-origin.ts');
  const configured = env.AGENT_DEVICE_CLOUD_BASE_URL;
  return parseCloudUrl(
    configured ?? fallback ?? DEFAULT_CLOUD_BASE_URL,
    configured === undefined ? undefined : 'AGENT_DEVICE_CLOUD_BASE_URL',
  ).href.replace(/\/+$/, '');
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
