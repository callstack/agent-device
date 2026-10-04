import { attachActiveSessionAddressHint } from './daemon-client-address-hints.ts';
import fs from 'node:fs';
import { processLockHoldsDaemonIdentity } from '../daemon-registration.ts';
import net from 'node:net';
import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import { readReplayDivergenceResume } from '@agent-device/ad-replay/divergence';
import type { DaemonRequest, DaemonResponse } from '../daemon/daemon-request.ts';
import { type ExecDetachedExit } from '@agent-device/host-kit/command';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { sleep } from '@agent-device/host-kit/retry';
import { inspectProcessLock, type ProcessLockInspection } from '@agent-device/host-kit/file';

import type { findUnrecoveredRepairCommitFailure } from '../session-repair-tombstone.ts';
import {
  DAEMON_STARTUP_EXIT_CODES,
  createOwnedReplayStateDir,
  recoverAbandonedDaemonRegistration,
  type DaemonRetirementResult,
  launchDaemonProcess,
  stopAndRetireDaemon,
  type OwnedReplayStateDir,
  type DaemonStartupLaunch,
} from '../daemon-registration-owner.ts';
import {
  resolveDaemonPaths,
  resolveDaemonServerMode,
  resolveDaemonTransportPreference,
  type DaemonPaths,
  type DaemonServerMode,
  type DaemonTransportPreference,
} from '../daemon-resolution.ts';
import {
  resolveDaemonLaunchSpec,
  resolveDaemonTakeover,
  type DaemonTakeoverDecision,
} from './daemon-launch-spec.ts';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';

import {
  getDaemonMetadataState,
  isRemoteDaemon,
  readDaemonInfo,
  resolveDaemonStartupHint,
  type DaemonInfo,
} from './daemon-client-metadata.ts';
import {
  canConnect,
  cachedRemoteDaemonHealth,
  isDaemonTransportUnavailableError,
} from './daemon-client-transport.ts';

export type DaemonClientSettings = {
  paths: DaemonPaths;
  transportPreference: DaemonTransportPreference;
  serverMode: DaemonServerMode;
  ownedStateDir?: OwnedReplayStateDir;
  remoteBaseUrl?: string;
  remoteAuthToken?: string;
};

export type EnsuredDaemon = {
  info: DaemonInfo;
  startedByClient: boolean;
};

type DaemonStartupWaitResult =
  | { kind: 'ready'; daemon: EnsuredDaemon }
  | { kind: 'early_exit'; exit: ExecDetachedExit }
  | { kind: 'unproven'; error: AppError }
  | { kind: 'retry' | 'timeout' };

const DAEMON_STARTUP_TIMEOUT_MS = 15_000;
const MINIMUM_DAEMON_TAKEOVER_BUDGET_MS = 5_000;
const LIVE_DAEMON_PROBE_RETRIES = 3;
const LIVE_DAEMON_PROBE_RETRY_DELAY_MS = 200;
const DAEMON_STARTUP_ATTEMPTS = 2;
const DAEMON_STARTUP_LOG_TAIL_BYTES = 64_000;
const LOOPBACK_BLOCK_LIST = new net.BlockList();
LOOPBACK_BLOCK_LIST.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_BLOCK_LIST.addAddress('::1', 'ipv6');
LOOPBACK_BLOCK_LIST.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

export function resolveClientSettings(
  req: Omit<DaemonRequest, 'token'>,
  suppliedAuthToken?: string,
): DaemonClientSettings {
  const explicitStateDir = resolveExplicitStateDir(req);
  const remote = resolveRemoteClientSettings(req, suppliedAuthToken);
  const transport = resolveTransportClientSettings(req, remote.remoteBaseUrl);
  const ownedStateDir = shouldUseOwnedReplayStateDir(req, explicitStateDir, remote.rawBaseUrl)
    ? createOwnedReplayStateDir()
    : undefined;
  return {
    paths: ownedStateDir?.paths ?? resolveDaemonPaths(explicitStateDir),
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

function resolveRemoteClientSettings(
  req: Omit<DaemonRequest, 'token'>,
  suppliedAuthToken: string | undefined,
): {
  rawBaseUrl: string | undefined;
  remoteBaseUrl?: string;
  authToken?: string;
} {
  const rawBaseUrl = req.flags?.daemonBaseUrl ?? process.env.AGENT_DEVICE_DAEMON_BASE_URL;
  const remoteBaseUrl = resolveRemoteDaemonBaseUrl(rawBaseUrl);
  const authToken = suppliedAuthToken ?? process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
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

export async function ensureDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  if (settings.remoteBaseUrl) {
    return await ensureRemoteDaemon(settings);
  }

  const ensured = await ensureLocalDaemon(settings);
  // Checked on both branches: a startup can resolve to a daemon another caller raced in.
  await assertDaemonPolicyMatches(ensured.info, settings.paths.baseDir);
  return ensured;
}

async function ensureLocalDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  const reusable = await readReusableLocalDaemon(settings);
  if (reusable) return { info: reusable, startedByClient: false };

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
  const health = await cachedRemoteDaemonHealth(remoteInfo);
  if (health.reachable) {
    remoteInfo.remoteInstanceId = health.instanceId;
    remoteInfo.remoteUpstreamInstanceId = health.upstream?.instanceId;
    return { info: remoteInfo, startedByClient: false };
  }
  throw new AppError('COMMAND_FAILED', 'Remote daemon is unavailable', {
    daemonBaseUrl: settings.remoteBaseUrl,
    hint: 'Verify AGENT_DEVICE_DAEMON_BASE_URL points to a reachable daemon with GET /health and POST /rpc. If this CLI was connected with connect proxy, run agent-device disconnect to return to the local daemon.',
  });
}

async function readReusableLocalDaemon(
  settings: DaemonClientSettings,
  options: { deadline?: number; waitForLiveStartup?: boolean } = {},
): Promise<DaemonInfo | null> {
  const { deadline } = options;
  const inspection = inspectProcessLock(settings.paths.lockPath);
  if (inspection.state === 'unproven') throw daemonRegistrationUnprovenError(settings, inspection);
  const existing = readDaemonInfo(settings.paths.infoPath);
  if (!existing) return null;
  if (!registrationAllowsDaemonObservation(inspection, existing)) return null;
  if (options.waitForLiveStartup && (await isAwaitingDaemonStartup(existing, deadline)))
    return null;

  const decision = await resolveDaemonTakeover(existing, {
    onClientTransport: () =>
      canReachReusableDaemon(existing, settings.transportPreference, deadline),
    onAnyAdvertisedTransport: () => canReachReusableDaemon(existing, 'auto', deadline),
  });
  if (decision.kind === 'reuse') return existing;
  if (decision.kind === 'refuseNewer') {
    throw newerDaemonRefusedError(existing, decision, settings.paths.baseDir);
  }

  if (remainingStartupBudget(deadline) < MINIMUM_DAEMON_TAKEOVER_BUDGET_MS) return null;
  emitDaemonTakeoverNotice(existing, decision.reason, settings.paths.baseDir);
  await retireDaemonForTakeover(existing, settings.paths);
  return null;
}

async function isAwaitingDaemonStartup(
  info: DaemonInfo,
  deadline: number | undefined,
): Promise<boolean> {
  return (
    isProcessAlive(info.pid) && !(await canConnect(info, 'auto', remainingStartupBudget(deadline)))
  );
}

function registrationAllowsDaemonObservation(
  inspection: ProcessLockInspection,
  info: DaemonInfo,
): boolean {
  return (
    inspection.state === 'absent' ||
    processLockHoldsDaemonIdentity(inspection, {
      pid: info.pid,
      startTime: info.processStartTime ?? null,
    })
  );
}

function daemonRegistrationUnprovenError(
  settings: DaemonClientSettings,
  inspection?: ProcessLockInspection,
): AppError {
  return new AppError('COMMAND_FAILED', 'Daemon registration ownership could not be verified.', {
    reason: 'daemon_registration_unproven',
    inspection,
    stateDir: settings.paths.baseDir,
    hint: resolveDaemonStartupHint(getDaemonMetadataState(settings.paths), settings.paths),
  });
}

async function retireDaemonForTakeover(existing: DaemonInfo, paths: DaemonPaths): Promise<void> {
  const retirement = await stopAndRetireDaemon({
    paths: paths,
    observed: { pid: existing.pid, startTime: existing.processStartTime ?? null },
    mode: 'graceful',
  });
  if (retirement.status === 'retained') {
    throw new AppError('COMMAND_FAILED', 'Daemon replacement could not be confirmed.', {
      reason: 'daemon_retirement_unconfirmed',
      retirement,
      hint:
        retirement.error?.hint ?? resolveDaemonStartupHint(getDaemonMetadataState(paths), paths),
    });
  }
}

/**
 * A daemon whose pid is still alive is probed again before it can be judged unreachable. A probe's
 * budget is wall-clock time on this client's event loop, so a client that stalls past it (a large
 * synchronous parse, a GC pause on a loaded host) reads a listening daemon as unreachable, and
 * replacing it ends every session the daemon holds. Liveness is the signal-0 check, not the `ps`
 * identity read: under the load that stalls the probe, `ps` misses its deadline too, and the
 * takeover still proves identity before it signals anything.
 */
async function canReachReusableDaemon(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
  deadline?: number,
): Promise<boolean> {
  if (await canConnectReusableDaemon(info, preference, deadline)) return true;
  for (let retry = 1; retry <= LIVE_DAEMON_PROBE_RETRIES; retry += 1) {
    if (!isProcessAlive(info.pid) || (deadline !== undefined && Date.now() >= deadline))
      return false;
    await sleep(Math.min(LIVE_DAEMON_PROBE_RETRY_DELAY_MS, remainingStartupBudget(deadline)));
    if (await canConnectReusableDaemon(info, preference, deadline)) {
      emitDiagnostic({
        level: 'warn',
        phase: 'daemon_probe_recovered',
        data: { pid: info.pid, retry },
      });
      return true;
    }
  }
  return false;
}

/**
 * ADR 0029: a caller that names a daemon policy must not silently use a daemon that enforces a
 * different one (or none). A caller that names no policy uses whatever the daemon enforces.
 */
async function assertDaemonPolicyMatches(existing: DaemonInfo, stateDir: string): Promise<void> {
  if (!process.env.AGENT_DEVICE_DAEMON_POLICY?.trim()) return;
  const { loadDaemonPolicy } = await import('../daemon-policy-file.ts');
  const expected = loadDaemonPolicy(process.env)?.digest;
  if (expected === existing.policyDigest) return;
  throw new AppError(
    'COMMAND_FAILED',
    'The running daemon does not enforce the daemon policy named by AGENT_DEVICE_DAEMON_POLICY.',
    {
      reason: 'DAEMON_POLICY_MISMATCH',
      expectedPolicyDigest: expected,
      daemonPolicyDigest: existing.policyDigest ?? null,
      hint: `Stop the running daemon (agent-device daemon stop --state-dir ${shellQuoteIfNeeded(stateDir)}), then retry so a daemon starts with this policy.`,
    },
  );
}

async function canConnectReusableDaemon(
  info: DaemonInfo,
  preference: DaemonTransportPreference,
  deadline?: number,
): Promise<boolean> {
  try {
    return await canConnect(info, preference, remainingStartupBudget(deadline));
  } catch (error) {
    if (isDaemonTransportUnavailableError(error)) return false;
    throw error;
  }
}

function newerDaemonRefusedError(
  info: DaemonInfo,
  decision: Extract<DaemonTakeoverDecision, { kind: 'refuseNewer' }>,
  stateDir: string,
): AppError {
  const { daemonVersion, clientVersion } = decision;
  return new AppError(
    'COMMAND_FAILED',
    `Daemon (pid ${info.pid}, v${daemonVersion}) is newer than this client (v${clientVersion}); refusing to replace it.`,
    {
      daemonPid: info.pid,
      daemonVersion,
      clientVersion,
      hint: `Use the agent-device v${daemonVersion} CLI that started it, or stop it deliberately: agent-device daemon stop --state-dir ${shellQuoteIfNeeded(stateDir)}`,
    },
  );
}

function emitDaemonTakeoverNotice(info: DaemonInfo, reason: string, stateDir: string): void {
  try {
    const identity = info.version ? `pid ${info.pid}, v${info.version}` : `pid ${info.pid}`;
    process.stderr.write(`Replacing daemon (${identity}) in ${stateDir}: ${reason}\n`);
  } catch {
    // The takeover notice is best effort; never fail the command on stderr issues.
  }
}

type FailedDaemonStartup = {
  cleanup?: DaemonRetirementResult;
  startError?: string;
  startupError?: NormalizedError;
  daemonProcess?: ExecDetachedExit | { pid: number };
  retry: boolean;
};

async function startLocalDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
  const cleanupResults: DaemonRetirementResult[] = [];
  let failure: FailedDaemonStartup | undefined;
  let attempts = 0;
  while (attempts < DAEMON_STARTUP_ATTEMPTS && Date.now() < deadline) {
    attempts += 1;
    const result = await attemptLocalDaemonStartup(settings, deadline);
    if ('daemon' in result) return result.daemon;
    failure = result;
    if (result.cleanup) cleanupResults.push(result.cleanup);
    if (!result.retry) break;
    await sleep(Math.min(150, Math.max(0, deadline - Date.now())));
  }
  const { startError, startupError, daemonProcess }: Partial<FailedDaemonStartup> = failure ?? {};
  const state = getDaemonMetadataState(settings.paths);
  const daemonLogTail = readRecentLogTail(settings.paths.logPath);
  throw new AppError('COMMAND_FAILED', 'Failed to start daemon', {
    kind: 'daemon_startup_failed',
    stateDir: settings.paths.baseDir,
    infoPath: settings.paths.infoPath,
    lockPath: settings.paths.lockPath,
    logPath: settings.paths.logPath,
    startupTimeoutMs: DAEMON_STARTUP_TIMEOUT_MS,
    startupAttempts: attempts,
    cleanupResults,
    startError,
    startupError,
    daemonProcess,
    ...(daemonLogTail ? { daemonLogTail } : {}),
    metadataState: state,
    hint: resolveDaemonStartupHint(state, settings.paths),
  });
}

async function attemptLocalDaemonStartup(
  settings: DaemonClientSettings,
  deadline: number,
): Promise<{ daemon: EnsuredDaemon } | FailedDaemonStartup> {
  let launch: DaemonStartupLaunch;
  try {
    launch = startDaemon(settings);
  } catch (error) {
    return await recoverFailedDaemonLaunch(settings, error);
  }
  const startup = await waitForDaemonStartup(deadline, settings, launch);
  if (startup.kind === 'ready') return { daemon: startup.daemon };
  if (startup.kind === 'retry') return { retry: true };
  if (startup.kind === 'unproven') {
    const startupError = normalizeError(startup.error);
    return {
      retry: false,
      startError: startupError.message,
      startupError,
      daemonProcess: { pid: launch.pid },
    };
  }
  const { cleanup, joined } = await retireStartupAttempt(settings, launch, deadline);
  const available = isRegistrationAvailable(inspectProcessLock(settings.paths.lockPath));
  return {
    cleanup,
    retry: joined && startup.kind === 'early_exit' && available,
    startError: startup.kind === 'early_exit' ? describeDaemonEarlyExit(startup.exit) : undefined,
    daemonProcess: startup.kind === 'early_exit' ? startup.exit : { pid: launch.pid },
  };
}

async function recoverFailedDaemonLaunch(
  settings: DaemonClientSettings,
  error: unknown,
): Promise<FailedDaemonStartup> {
  const cleanup = settings.ownedStateDir
    ? await stopAndRetireDaemon({
        paths: settings.paths,
        observed: null,
        mode: 'graceful',
        ownedStateDir: settings.ownedStateDir,
        lockTimeoutMs: 0,
      })
    : await recoverAbandonedDaemonRegistration({
        paths: settings.paths,
        observed: null,
        lockTimeoutMs: 0,
      });
  return {
    cleanup,
    startError: normalizeError(error).message,
    retry: !settings.ownedStateDir && cleanup.status !== 'retained',
  };
}

async function retireStartupAttempt(
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
  deadline: number,
): Promise<{ cleanup: DaemonRetirementResult; joined: boolean }> {
  const cleanup = await stopAndRetireDaemon({
    paths: settings.paths,
    observed: launch.readIdentity(),
    mode: 'graceful',
    ownedStateDir: settings.ownedStateDir,
    termTimeoutMs: Math.min(3_000, remainingStartupBudget(deadline)),
    killTimeoutMs: 1_000,
    lockTimeoutMs: 0,
  });
  const joined = await joinStartup(launch);
  return { cleanup, joined };
}

async function joinStartup(launch: DaemonStartupLaunch): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      launch.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function remainingStartupBudget(deadline?: number): number {
  return deadline === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadline - Date.now());
}

function isRegistrationAvailable(inspection: ProcessLockInspection): boolean {
  return (
    inspection.state === 'absent' ||
    (inspection.state === 'held' &&
      (inspection.liveness === 'owner-process-dead' ||
        inspection.liveness === 'owner-process-reused'))
  );
}

/**
 * ADR 0012 decision 6 (BLOCKER 2, third follow-up): a one-shot repair
 * (`replay --save-script`) that COMPLETES without diverging returns SUCCESS
 * here — the actual healed-script COMMIT is deferred to daemon teardown
 * (`finalizeRepairTeardown`, run inside the daemon process's own shutdown
 * handler, triggered by `stopAndRetireDaemon`). If that
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
    isHeldRepairDivergence(response) ||
    // ADR 0016: a `replay` whose script had no terminal `close` reports its
    // session as still active by design (the consumption contract this ADR
    // defines) — tearing down its owning daemon here would make that contract
    // unaddressable over the real CLI path the instant the response is sent.
    // Keyed off the session surviving the run (`sessionActive`), never off
    // parsing the script for `close`, so a `--from` resume is covered too.
    // Unlike the repair case, this session has no bounded reap of its own: an
    // unattended close-less replay leaves a live daemon+app session until
    // ordinary idle-reap or an explicit `close` ends it — the same lifetime an
    // interactively opened session already has, and exactly what the ADR's
    // "caller owns close" contract asks for.
    isActiveReplaySessionResponse(req, response)
  ) {
    return response;
  }

  const result = await stopAndRetireDaemon({
    paths: settings.paths,
    observed: { pid: daemon.info.pid, startTime: daemon.info.processStartTime ?? null },
    mode: 'graceful',
    ownedStateDir: settings.ownedStateDir,
  });
  emitDiagnostic({
    level: result.status === 'retained' ? 'warn' : 'info',
    phase: 'daemon_replay_cleanup',
    data: { pid: daemon.info.pid, ...result },
  });
  if (result.status !== 'absent' && result.repairCommitFailure) {
    return surfaceUnrecoveredRepairCommitFailure(
      response,
      result.repairCommitFailure,
      result.status === 'retained' ? result.error : undefined,
    );
  }
  if (result.status === 'retained' && response?.ok) {
    return {
      ok: false,
      error: normalizeError(
        new AppError(
          'COMMAND_FAILED',
          'Replay completed, but daemon cleanup could not be confirmed.',
          {
            reason: 'daemon_retirement_unconfirmed',
            retirement: result,
            stateDir: settings.paths.baseDir,
            hint:
              result.error?.hint ??
              `State and diagnostics were retained at ${settings.paths.baseDir}. Resolve the reported cleanup failure before retrying.`,
          },
        ),
      ),
    };
  }
  return response;
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
  cleanupFailure?: NormalizedError,
): DaemonResponse {
  if (response && !response.ok) return response;
  const { sessionName, tombstone } = unrecovered;
  const reRun = tombstone.sourcePath
    ? `re-run: replay ${tombstone.sourcePath} --save-script`
    : 're-run your replay <script> --save-script from the start';
  const message =
    `The repair transaction for session "${sessionName}" completed, but committing its ` +
    `healed script failed at teardown: ${tombstone.commitFailure.message}. ${reRun}.`;
  return {
    ok: false,
    error: normalizeError(
      new AppError(
        'REPAIR_COMMIT_FAILED',
        message,
        cleanupFailure ? { cleanupFailure } : undefined,
      ),
    ),
  };
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
function isHeldRepairDivergence(response: DaemonResponse | undefined): boolean {
  if (!response || response.ok) return false;
  if (response.error.code !== 'REPLAY_DIVERGENCE') return false;
  const resume = readReplayDivergenceResume(response.error.details?.divergence);
  return resume?.repairSessionHeld === true;
}

/**
 * ADR 0012 decision 6 (Fix 1): "keep it addressable" — an owned ephemeral
 * daemon lives at a randomly generated `--state-dir` (`createOwnedReplayStateDir`)
 * that no other invocation knows about, so keeping the process alive is not
 * enough on its own. Appended (never overwriting an existing hint, e.g. a
 * selector-miss's own guidance) so the agent's next command knows to target
 * the SAME daemon instead of resolving to the default one.
 */
function attachRepairSessionAddressHint(
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

/**
 * ADR 0016: true when a successful `replay` response reports its session as
 * still active (`ReplayCommandResult.sessionActive`, set by the daemon from
 * whether the session survived in its own store — never derived here by
 * re-parsing the script). Restricted to `replay` itself, never `test`: a
 * `test` run's own per-file runner already closes each session before the
 * suite summary is built, and its `ReplaySuiteResult` carries no such field
 * anyway, but the explicit command check keeps that carve-out a decision
 * rather than an accident of the response shape.
 */
function isActiveReplaySessionResponse(
  req: Omit<DaemonRequest, 'token'>,
  response: DaemonResponse | undefined,
): boolean {
  if (req.command !== PUBLIC_COMMANDS.replay) return false;
  if (!response || !response.ok) return false;
  return response.data?.sessionActive === true;
}

async function waitForDaemonStartup(
  deadline: number,
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
): Promise<DaemonStartupWaitResult> {
  let earlyExit: ExecDetachedExit | undefined;
  void launch.exited.then((exit) => {
    earlyExit = exit;
  });
  while (Date.now() < deadline) {
    if (earlyExit) {
      const kind = classifyDaemonStartupExit(earlyExit);
      if (kind === 'unproven')
        return { kind: 'unproven', error: daemonRegistrationUnprovenError(settings) };
      if (kind === 'failed') return { kind: 'early_exit', exit: earlyExit };
      const contender = await observeContendingDaemon(settings, deadline);
      if (contender) return contender;
    } else {
      const info = await readReadyLaunchedDaemon(settings, launch, deadline);
      if (info && !earlyExit) return { kind: 'ready', daemon: { info, startedByClient: true } };
    }
    await sleep(Math.min(100, remainingStartupBudget(deadline)));
  }
  return { kind: 'timeout' };
}

function classifyDaemonStartupExit(exit: ExecDetachedExit): 'busy' | 'unproven' | 'failed' {
  if (exit.error || exit.signal) return 'failed';
  switch (exit.exitCode) {
    case DAEMON_STARTUP_EXIT_CODES.busy:
      return 'busy';
    case DAEMON_STARTUP_EXIT_CODES.unproven:
      return 'unproven';
    default:
      return 'failed';
  }
}

async function observeContendingDaemon(
  settings: DaemonClientSettings,
  deadline: number,
): Promise<DaemonStartupWaitResult | null> {
  let winner: DaemonInfo | null;
  try {
    winner = await readReusableLocalDaemon(settings, { deadline, waitForLiveStartup: true });
  } catch (error) {
    if (error instanceof AppError && error.details?.reason === 'daemon_registration_unproven')
      return { kind: 'unproven', error };
    throw error;
  }
  if (Date.now() >= deadline) return null;
  if (winner) return { kind: 'ready', daemon: { info: winner, startedByClient: false } };
  const inspection = inspectProcessLock(settings.paths.lockPath);
  if (inspection.state === 'unproven')
    return { kind: 'unproven', error: daemonRegistrationUnprovenError(settings, inspection) };
  return isRegistrationAvailable(inspection) ? { kind: 'retry' } : null;
}

async function readReadyLaunchedDaemon(
  settings: DaemonClientSettings,
  launch: DaemonStartupLaunch,
  deadline: number,
): Promise<DaemonInfo | null> {
  const info = readDaemonInfo(settings.paths.infoPath);
  if (!info || !isLaunchedDaemon(info, launch)) return null;
  try {
    return (await canConnect(
      info,
      settings.transportPreference,
      remainingStartupBudget(deadline),
    )) && Date.now() < deadline
      ? info
      : null;
  } catch (error) {
    const { cleanup, joined } = await retireStartupAttempt(settings, launch, deadline);
    emitDiagnostic({
      level: 'warn',
      phase: 'daemon_startup_observation_failed',
      data: { stateDir: settings.paths.baseDir, cleanup, joined, error: normalizeError(error) },
    });
    if (error instanceof AppError) {
      error.details = {
        ...error.details,
        stateDir: settings.paths.baseDir,
        cleanupResults: [cleanup],
        startupJoined: joined,
      };
    }
    throw error;
  }
}

/** Whether `info` names the daemon process this client launched: same pid and start time. */
function isLaunchedDaemon(info: DaemonInfo, launch: DaemonStartupLaunch): boolean {
  const identity = launch.readIdentity();
  return (
    info.pid === identity.pid &&
    identity.startTime !== null &&
    info.processStartTime === identity.startTime
  );
}

function startDaemon(settings: DaemonClientSettings): DaemonStartupLaunch {
  const launchSpec = resolveDaemonLaunchSpec();
  return launchDaemonProcess({
    paths: settings.paths,
    serverMode: settings.serverMode,
    ownedStateDir: settings.ownedStateDir,
    args: launchSpec.useSrc
      ? ['--experimental-strip-types', launchSpec.srcPath]
      : [launchSpec.distPath],
  });
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

export function attachSessionAddressHints(
  response: DaemonResponse,
  req: Omit<DaemonRequest, 'token'>,
  settings: DaemonClientSettings,
): DaemonResponse {
  if (!response.ok) {
    return settings.ownedStateDir && isHeldRepairDivergence(response)
      ? attachRepairSessionAddressHint(response, settings.paths.baseDir)
      : response;
  }
  return isActiveReplaySessionResponse(req, response)
    ? attachActiveSessionAddressHint(
        response,
        settings.ownedStateDir ? settings.paths.baseDir : undefined,
        settings.remoteBaseUrl,
      )
    : response;
}
