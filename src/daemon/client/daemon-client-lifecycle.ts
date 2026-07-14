import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { runCmdDetachedMonitored, type ExecDetachedExit } from '../../utils/exec.ts';
import { findProjectRoot, readVersion } from '../../utils/version.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { findUnrecoveredRepairCommitFailure } from '../session-store.ts';
import {
  resolveDaemonPaths,
  resolveDaemonServerMode,
  resolveDaemonTransportPreference,
  type DaemonPaths,
  type DaemonServerMode,
  type DaemonTransportPreference,
} from '../config.ts';
import { computeDaemonCodeSignature } from '../code-signature.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { sleep } from '../../utils/timeouts.ts';
import {
  cleanupFailedDaemonStartupMetadata,
  cleanupStaleDaemonLockIfSafe,
  getDaemonMetadataState,
  isRemoteDaemon,
  readDaemonInfo,
  recoverDaemonLockHolder,
  removeDaemonInfo,
  removeDaemonLock,
  resolveDaemonStartupHint,
  stopDaemonProcessForTakeover,
  type DaemonInfo,
  type DaemonStartupCleanupResult,
} from './daemon-client-metadata.ts';
import {
  canConnect,
  DAEMON_HTTP_ENDPOINT_UNAVAILABLE_MESSAGE,
  DAEMON_SOCKET_ENDPOINT_UNAVAILABLE_MESSAGE,
  readRemoteDaemonHealth,
} from './daemon-client-transport.ts';

export type DaemonClientSettings = {
  paths: DaemonPaths;
  transportPreference: DaemonTransportPreference;
  serverMode: DaemonServerMode;
  ownedStateDir?: boolean;
  remoteBaseUrl?: string;
  remoteAuthToken?: string;
};

export type EnsuredDaemon = {
  info: DaemonInfo;
  startedByClient: boolean;
};

type DaemonStartupLaunch = {
  pid: number;
  exited: Promise<ExecDetachedExit>;
};

type DaemonStartupWaitResult =
  | { kind: 'ready'; info: DaemonInfo }
  | { kind: 'early_exit'; exit: ExecDetachedExit }
  | { kind: 'timeout' };

const DAEMON_STARTUP_TIMEOUT_MS = 15_000;
const DAEMON_STARTUP_ATTEMPTS = 2;
const DAEMON_STARTUP_LOG_TAIL_BYTES = 64_000;
const LOOPBACK_BLOCK_LIST = new net.BlockList();
LOOPBACK_BLOCK_LIST.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_BLOCK_LIST.addAddress('::1', 'ipv6');
LOOPBACK_BLOCK_LIST.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

export function resolveClientSettings(req: Omit<DaemonRequest, 'token'>): DaemonClientSettings {
  const explicitStateDir = resolveExplicitStateDir(req);
  const remote = resolveRemoteClientSettings(req);
  const transport = resolveTransportClientSettings(req, remote.remoteBaseUrl);
  const ownedStateDir = shouldUseOwnedReplayStateDir(req, explicitStateDir, remote.rawBaseUrl);
  const stateDir = ownedStateDir ? createOwnedReplayStateDir() : explicitStateDir;
  return {
    paths: resolveDaemonPaths(stateDir),
    transportPreference: transport.preference,
    serverMode: transport.serverMode,
    ownedStateDir,
    remoteBaseUrl: remote.remoteBaseUrl,
    remoteAuthToken: remote.authToken,
  };
}

function resolveExplicitStateDir(req: Omit<DaemonRequest, 'token'>): string | undefined {
  return req.flags?.stateDir ?? process.env.AGENT_DEVICE_STATE_DIR;
}

function resolveRemoteClientSettings(req: Omit<DaemonRequest, 'token'>): {
  rawBaseUrl: string | undefined;
  remoteBaseUrl?: string;
  authToken?: string;
} {
  const rawBaseUrl = req.flags?.daemonBaseUrl ?? process.env.AGENT_DEVICE_DAEMON_BASE_URL;
  const remoteBaseUrl = resolveRemoteDaemonBaseUrl(rawBaseUrl);
  const authToken = req.flags?.daemonAuthToken ?? process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  validateRemoteDaemonTrust(remoteBaseUrl, authToken);
  return { rawBaseUrl, remoteBaseUrl, authToken };
}

function resolveTransportClientSettings(
  req: Omit<DaemonRequest, 'token'>,
  remoteBaseUrl: string | undefined,
): { preference: DaemonTransportPreference; serverMode: DaemonServerMode } {
  const rawTransport = req.flags?.daemonTransport ?? process.env.AGENT_DEVICE_DAEMON_TRANSPORT;
  const preference = resolveDaemonTransportPreference(rawTransport);
  if (remoteBaseUrl && preference === 'socket') {
    throw new AppError(
      'INVALID_ARGS',
      'Remote daemon base URL only supports HTTP transport. Remove --daemon-transport socket.',
      { daemonBaseUrl: remoteBaseUrl },
    );
  }
  const rawServerMode =
    req.flags?.daemonServerMode ??
    process.env.AGENT_DEVICE_DAEMON_SERVER_MODE ??
    (rawTransport === 'dual' ? 'dual' : undefined);
  return {
    preference,
    serverMode: resolveDaemonServerMode(rawServerMode),
  };
}

function shouldUseOwnedReplayStateDir(
  req: Omit<DaemonRequest, 'token'>,
  explicitStateDir: string | undefined,
  rawRemoteBaseUrl: string | undefined,
): boolean {
  return isOneShotReplayCommand(req.command) && !explicitStateDir && !rawRemoteBaseUrl;
}

function createOwnedReplayStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-daemon-'));
}

export async function ensureDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  if (settings.remoteBaseUrl) {
    return await ensureRemoteDaemon(settings);
  }

  const reusable = await readReusableLocalDaemon(settings);
  if (reusable) return { info: reusable, startedByClient: false };

  cleanupStaleDaemonLockIfSafe(settings.paths);
  return await startLocalDaemon(settings);
}

async function ensureRemoteDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  const remoteInfo: DaemonInfo = {
    transport: 'http',
    // Remote mode reuses the auth token as the daemon token so the existing JSON-RPC contract still works.
    token: settings.remoteAuthToken ?? '',
    pid: 0,
    baseUrl: settings.remoteBaseUrl,
  };
  if ((await readRemoteDaemonHealth(remoteInfo)).reachable) {
    return { info: remoteInfo, startedByClient: false };
  }
  throw new AppError('COMMAND_FAILED', 'Remote daemon is unavailable', {
    daemonBaseUrl: settings.remoteBaseUrl,
    hint: 'Verify AGENT_DEVICE_DAEMON_BASE_URL points to a reachable daemon with GET /health and POST /rpc. If this CLI was connected with connect proxy, run agent-device disconnect to return to the local daemon.',
  });
}

async function readReusableLocalDaemon(settings: DaemonClientSettings): Promise<DaemonInfo | null> {
  const existing = readDaemonInfo(settings.paths.infoPath);
  if (!existing) return null;

  const existingReachable = await canConnectReusableDaemon(existing, settings.transportPreference);
  if (isReusableDaemonInfo(existing, existingReachable)) return existing;

  emitDaemonTakeoverNotice(existing, existingReachable, settings.paths.baseDir);
  await stopDaemonProcessForTakeover(existing);
  removeDaemonInfo(settings.paths.infoPath);
  return null;
}

async function canConnectReusableDaemon(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
): Promise<boolean> {
  try {
    return await canConnect(info, preference);
  } catch (error) {
    if (isDaemonTransportUnavailableError(error)) return false;
    throw error;
  }
}

function isDaemonTransportUnavailableError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'COMMAND_FAILED' &&
    (error.message === DAEMON_HTTP_ENDPOINT_UNAVAILABLE_MESSAGE ||
      error.message === DAEMON_SOCKET_ENDPOINT_UNAVAILABLE_MESSAGE)
  );
}

function isReusableDaemonInfo(info: DaemonInfo, reachable: boolean): boolean {
  return (
    info.version === readVersion() &&
    info.codeSignature === resolveLocalDaemonCodeSignature() &&
    reachable
  );
}

function emitDaemonTakeoverNotice(info: DaemonInfo, reachable: boolean, stateDir: string): void {
  try {
    const identity = info.version ? `pid ${info.pid}, v${info.version}` : `pid ${info.pid}`;
    const reason = resolveDaemonTakeoverReason(info, reachable);
    process.stderr.write(`Replacing daemon (${identity}) in ${stateDir}: ${reason}\n`);
  } catch {
    // The takeover notice is best effort; never fail the command on stderr issues.
  }
}

function resolveDaemonTakeoverReason(info: DaemonInfo, reachable: boolean): string {
  if (info.version !== readVersion()) return `version mismatch (client v${readVersion()})`;
  if (info.codeSignature !== resolveLocalDaemonCodeSignature()) return 'code-signature mismatch';
  if (!reachable) return 'unreachable';
  return 'not reusable';
}

async function startLocalDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  let lockRecoveryCount = 0;
  const cleanupResults: DaemonStartupCleanupResult[] = [];
  let startError: string | undefined;
  let daemonProcess: ExecDetachedExit | { pid: number } | undefined;
  for (let attempt = 1; attempt <= DAEMON_STARTUP_ATTEMPTS; attempt += 1) {
    let launch: DaemonStartupLaunch;
    try {
      launch = startDaemon(settings);
      daemonProcess = { pid: launch.pid };
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error);
      cleanupResults.push(await cleanupFailedDaemonStartupMetadata(settings.paths, 'start_error'));
      if (attempt < DAEMON_STARTUP_ATTEMPTS) {
        await sleep(150);
        continue;
      }
      break;
    }

    const startup = await waitForDaemonStartup(DAEMON_STARTUP_TIMEOUT_MS, settings, launch);
    if (startup.kind === 'ready') return { info: startup.info, startedByClient: true };
    if (startup.kind === 'early_exit') {
      daemonProcess = startup.exit;
      startError = describeDaemonEarlyExit(startup.exit);
      cleanupResults.push(await cleanupFailedDaemonStartupMetadata(settings.paths, 'start_error'));
      if (attempt < DAEMON_STARTUP_ATTEMPTS) {
        await sleep(150);
        continue;
      }
      break;
    }

    if (await recoverDaemonLockHolder(settings.paths)) {
      lockRecoveryCount += 1;
      continue;
    }

    const metadataState = getDaemonMetadataState(settings.paths);
    const hasAnotherAttempt = attempt < DAEMON_STARTUP_ATTEMPTS;
    const cleanup = await cleanupFailedDaemonStartupMetadata(settings.paths, 'startup_timeout', {
      stopLiveProcesses: false,
    });
    cleanupResults.push(cleanup);
    if (cleanup.retainedInfoProcess || cleanup.retainedLockProcess) {
      const extended = await waitForDaemonStartup(DAEMON_STARTUP_TIMEOUT_MS, settings, launch);
      if (extended.kind === 'ready') return { info: extended.info, startedByClient: true };
      if (extended.kind === 'early_exit') {
        daemonProcess = extended.exit;
        startError = describeDaemonEarlyExit(extended.exit);
      }
      break;
    }
    if (!hasAnotherAttempt) break;

    // Detached daemon startup can race on busy CI hosts; retry when no metadata exists yet.
    if (!metadataState.hasInfo && !metadataState.hasLock) await sleep(150);
  }

  const state = getDaemonMetadataState(settings.paths);
  const daemonLogTail = readRecentLogTail(settings.paths.logPath);
  throw new AppError('COMMAND_FAILED', 'Failed to start daemon', {
    kind: 'daemon_startup_failed',
    stateDir: settings.paths.baseDir,
    infoPath: settings.paths.infoPath,
    lockPath: settings.paths.lockPath,
    logPath: settings.paths.logPath,
    startupTimeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
    startupAttempts: DAEMON_STARTUP_ATTEMPTS,
    lockRecoveryCount,
    cleanupResults,
    startError,
    daemonProcess,
    ...(daemonLogTail ? { daemonLogTail } : {}),
    metadataState: state,
    hint: resolveDaemonStartupHint(state, settings.paths),
  });
}

/**
 * ADR 0012 decision 6 (BLOCKER 2, third follow-up): a one-shot repair
 * (`replay --save-script`) that COMPLETES without diverging returns SUCCESS
 * here — the actual healed-script COMMIT is deferred to daemon teardown
 * (`finalizeRepairTeardown`, run inside the daemon process's own shutdown
 * handler, triggered by `stopDaemonProcessForTakeover` below). If that
 * deferred commit then FAILS, the daemon leaves a `REPAIR_COMMIT_FAILED`
 * tombstone in this owned state dir — the only surviving record of the
 * failure, since the daemon process (and its in-memory session) is gone by
 * the time this function inspects it. Unconditionally deleting the owned
 * state dir here would silently discard both the failure and the tombstone's
 * re-run guidance, while the CALLER still holds the success response this
 * function already returned. Returns the response the caller should actually
 * use: unchanged, unless an unrecovered commit failure is found, in which
 * case the state dir is preserved (never `rmSync`'d) and the response is
 * overridden to surface it.
 */
export async function cleanupDaemonAfterRequest(
  req: Omit<DaemonRequest, 'token'>,
  daemon: EnsuredDaemon,
  settings: DaemonClientSettings,
  response: DaemonResponse | undefined,
): Promise<DaemonResponse | undefined> {
  if (
    !isOneShotReplayCommand(req.command) ||
    (!daemon.startedByClient && !settings.ownedStateDir) ||
    isRemoteDaemon(daemon.info) ||
    // ADR 0012 decision 6, R7 (Fix 1, C1): a repair-armed `--save-script`
    // replay that comes back as a HELD divergence must keep its owning daemon
    // (and the session on it) addressable for the agent's corrective press +
    // `replay --from`/`close` — tearing it down here is what turns a
    // recoverable divergence into a later bare SESSION_NOT_FOUND. The daemon
    // then bounds the held session's own lifetime via idle-reap (writing a
    // `REPAIR_SESSION_EXPIRED` tombstone on reap), so an abandoned repair still
    // cannot leak indefinitely; this only stops the ONE-SHOT-COMMAND teardown
    // below from racing ahead of that window.
    isHeldRepairDivergence(response)
  ) {
    return response;
  }

  const result = {
    pid: daemon.info.pid,
    removedInfo: false,
    removedLock: false,
    removedStateDir: false,
    error: undefined as string | undefined,
  };
  let surfacedResponse = response;

  try {
    await stopDaemonProcessForTakeover(daemon.info);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    const infoExists = fs.existsSync(settings.paths.infoPath);
    removeDaemonInfo(settings.paths.infoPath);
    result.removedInfo = infoExists && !fs.existsSync(settings.paths.infoPath);

    const lockExists = fs.existsSync(settings.paths.lockPath);
    removeDaemonLock(settings.paths.lockPath);
    result.removedLock = lockExists && !fs.existsSync(settings.paths.lockPath);

    if (settings.ownedStateDir) {
      // `stopDaemonProcessForTakeover` above waits for the (real) daemon
      // process to actually exit, which only happens AFTER its shutdown
      // handler finishes `finalizeRepairTeardown` for every session — so by
      // now any commit-failure tombstone it would leave is already on disk.
      const unrecovered = findUnrecoveredRepairCommitFailure(settings.paths.sessionsDir);
      if (unrecovered) {
        surfacedResponse = surfaceUnrecoveredRepairCommitFailure(response, unrecovered);
      } else {
        fs.rmSync(settings.paths.baseDir, { recursive: true, force: true });
        result.removedStateDir = !fs.existsSync(settings.paths.baseDir);
      }
    }
  }

  emitDiagnostic({
    level: result.error ? 'warn' : 'info',
    phase: 'daemon_replay_cleanup',
    data: result,
  });
  return surfacedResponse;
}

/**
 * ADR 0012 decision 6 (BLOCKER 2, third follow-up): converts an unrecovered
 * shutdown-time commit failure into the response the CALLER actually sees.
 * The original response may have been a genuine SUCCESS — the replay/plan
 * itself completed with no divergence, only the deferred healed-script
 * publish failed afterward at teardown — so there is no existing error to
 * attach a hint to (unlike `attachRepairSessionAddressHint`, which only ever
 * runs on an already-`ok:false` divergence): this REPLACES the response with
 * the same `REPAIR_COMMIT_FAILED` error the daemon's own
 * `repairExpiredIfTombstoned` (request-router.ts) would surface to a
 * follow-up request on this session — a one-shot command has no follow-up
 * request to receive it, so the client raises it here instead. An existing
 * `ok:false` response (e.g. the platform close itself failed for a different,
 * more specific reason) is returned unchanged.
 */
function surfaceUnrecoveredRepairCommitFailure(
  response: DaemonResponse | undefined,
  unrecovered: NonNullable<ReturnType<typeof findUnrecoveredRepairCommitFailure>>,
): DaemonResponse {
  if (response && !response.ok) return response;
  const { sessionName, tombstone } = unrecovered;
  const reRun = tombstone.sourcePath
    ? `re-run: replay ${tombstone.sourcePath} --save-script`
    : 're-run your replay <script> --save-script from the start';
  const message =
    `The repair transaction for session "${sessionName}" completed, but committing its ` +
    `healed script failed at teardown: ${tombstone.commitFailure.message}. ${reRun}.`;
  return { ok: false, error: normalizeError(new AppError('REPAIR_COMMIT_FAILED', message)) };
}

/**
 * ADR 0012 decision 6, R7 (Fix 1, C1): true when this response must keep the
 * owning daemon alive — a `REPLAY_DIVERGENCE` whose payload carries the
 * daemon's `resume.repairSessionHeld` liveness signal. The daemon sets that
 * signal from the PERSISTED repair-transaction state (the session is
 * repair-armed and not yet committed), NOT from the current request's
 * `--save-script` flag — so a `replay --from` continuation that does not
 * repeat `--save-script` (R2) is still kept alive if it diverges. Keying the
 * client purely off the signal (the daemon is the authority on transaction
 * state) is what makes that continuation work; a plain, non-repair divergence
 * carries no signal and gets no keep-alive. Also independent of
 * `resume.allowed` (plan-resumability): a held divergence with `allowed: false`
 * still holds the session so the agent can inspect and `close` cleanly.
 */
export function isHeldRepairDivergence(response: DaemonResponse | undefined): boolean {
  if (!response || response.ok) return false;
  if (response.error.code !== 'REPLAY_DIVERGENCE') return false;
  const divergence = response.error.details?.divergence;
  if (!divergence || typeof divergence !== 'object') return false;
  const resume = (divergence as Record<string, unknown>).resume;
  if (!resume || typeof resume !== 'object') return false;
  return (resume as Record<string, unknown>).repairSessionHeld === true;
}

/**
 * ADR 0012 decision 6 (Fix 1): "keep it addressable" — an owned ephemeral
 * daemon lives at a randomly generated `--state-dir` (`createOwnedReplayStateDir`)
 * that no other invocation knows about, so keeping the process alive is not
 * enough on its own. Appended (never overwriting an existing hint, e.g. a
 * selector-miss's own guidance) so the agent's next command knows to target
 * the SAME daemon instead of resolving to the default one.
 */
export function attachRepairSessionAddressHint(
  response: Extract<DaemonResponse, { ok: false }>,
  stateDir: string,
): Extract<DaemonResponse, { ok: false }> {
  const addressHint =
    `This repair session's daemon was kept alive to continue the repair; pass ` +
    `--state-dir ${stateDir} on your next command (press, replay --from, or ` +
    `close --save-script) to reach it.`;
  const existingHint = response.error.hint;
  return {
    ...response,
    error: {
      ...response.error,
      hint: existingHint ? `${existingHint} ${addressHint}` : addressHint,
    },
  };
}

function isOneShotReplayCommand(command: string | undefined): boolean {
  return command === PUBLIC_COMMANDS.replay || command === PUBLIC_COMMANDS.test;
}

async function waitForDaemonStartup(
  timeoutMs: number,
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
): Promise<DaemonStartupWaitResult> {
  const start = Date.now();
  let earlyExit: ExecDetachedExit | undefined;
  void launch.exited.then((exit) => {
    earlyExit = exit;
  });

  while (Date.now() - start < timeoutMs) {
    if (earlyExit) return { kind: 'early_exit', exit: earlyExit };
    const info = readDaemonInfo(settings.paths.infoPath);
    if (info && (await canConnect(info, settings.transportPreference))) {
      return { kind: 'ready', info };
    }
    if (earlyExit) return { kind: 'early_exit', exit: earlyExit };
    await sleep(100);
  }
  return { kind: 'timeout' };
}

function startDaemon(settings: DaemonClientSettings): DaemonStartupLaunch {
  const launchSpec = resolveDaemonLaunchSpec();
  const args = launchSpec.useSrc
    ? ['--experimental-strip-types', launchSpec.srcPath]
    : [launchSpec.distPath];
  const env = {
    ...process.env,
    AGENT_DEVICE_STATE_DIR: settings.paths.baseDir,
    AGENT_DEVICE_DAEMON_SERVER_MODE: settings.serverMode,
  };

  fs.mkdirSync(settings.paths.baseDir, { recursive: true });
  const stdoutFd = fs.openSync(settings.paths.logPath, 'a');
  const stderrFd = fs.openSync(settings.paths.logPath, 'a');
  try {
    return runCmdDetachedMonitored(process.execPath, args, {
      env,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

type DaemonLaunchSpec = {
  root: string;
  distPath: string;
  distPaths: string[];
  srcPath: string;
  useSrc: boolean;
};

function resolveDaemonLaunchSpec(): DaemonLaunchSpec {
  const root = findProjectRoot();
  const distPaths = [
    path.join(root, 'dist', 'src', 'internal', 'daemon.js'),
    path.join(root, 'dist', 'src', 'daemon.js'),
  ];
  const defaultDistPath = distPaths[0];
  if (defaultDistPath === undefined) {
    throw new AppError('COMMAND_FAILED', 'Daemon dist path list is empty');
  }
  const distPath = distPaths.find((candidate) => fs.existsSync(candidate)) ?? defaultDistPath;
  const srcPath = path.join(root, 'src', 'daemon.ts');

  const hasDist = distPaths.some((candidate) => fs.existsSync(candidate));
  const hasSrc = fs.existsSync(srcPath);
  if (!hasDist && !hasSrc) {
    throw new AppError('COMMAND_FAILED', 'Daemon entry not found', { distPaths, srcPath });
  }
  const runningFromSource = process.execArgv.includes('--experimental-strip-types');
  const useSrc = runningFromSource ? hasSrc : !hasDist && hasSrc;
  return { root, distPath, distPaths, srcPath, useSrc };
}

function resolveLocalDaemonCodeSignature(): string {
  const launchSpec = resolveDaemonLaunchSpec();
  const entryPath = launchSpec.useSrc ? launchSpec.srcPath : launchSpec.distPath;
  return computeDaemonCodeSignature(entryPath, launchSpec.root);
}

function describeDaemonEarlyExit(exit: ExecDetachedExit): string {
  if (exit.error) return `daemon process ${exit.pid} failed to start: ${exit.error}`;
  if (exit.signal)
    return `daemon process ${exit.pid} exited before readiness with signal ${exit.signal}`;
  return `daemon process ${exit.pid} exited before readiness with code ${exit.exitCode ?? 0}`;
}

function readRecentLogTail(logPath: string): string | undefined {
  try {
    if (!fs.existsSync(logPath)) return undefined;
    const stats = fs.statSync(logPath);
    if (stats.size <= 0) return undefined;
    const length = Math.min(stats.size, DAEMON_STARTUP_LOG_TAIL_BYTES);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stats.size - length);
      const text = buffer.toString('utf8').trim();
      return text.length > 0 ? text : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function resolveRemoteDaemonBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      'Invalid daemon base URL',
      {
        daemonBaseUrl: raw,
      },
      error instanceof Error ? error : undefined,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('INVALID_ARGS', 'Daemon base URL must use http or https', {
      daemonBaseUrl: raw,
    });
  }
  return parsed.toString().replace(/\/+$/, '');
}

function validateRemoteDaemonTrust(
  remoteBaseUrl: string | undefined,
  remoteAuthToken: string | undefined,
): void {
  if (!remoteBaseUrl) return;
  const hostname = new URL(remoteBaseUrl).hostname;
  if (isLoopbackHostname(hostname)) return;
  if (typeof remoteAuthToken === 'string' && remoteAuthToken.trim().length > 0) return;
  throw new AppError(
    'INVALID_ARGS',
    'Remote daemon base URL for non-loopback hosts requires daemon authentication',
    {
      daemonBaseUrl: remoteBaseUrl,
      hint: 'Provide --daemon-auth-token or AGENT_DEVICE_DAEMON_AUTH_TOKEN when using a non-loopback remote daemon URL.',
    },
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost') return true;
  if (net.isIPv4(normalized)) return LOOPBACK_BLOCK_LIST.check(normalized, 'ipv4');
  if (net.isIPv6(normalized)) return LOOPBACK_BLOCK_LIST.check(normalized, 'ipv6');
  return false;
}
