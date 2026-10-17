import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonLifecycle, EnsureDaemonOptions } from '@agent-device/contracts/client';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import net from 'node:net';
import { AppError, normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';
import { readReplayDivergenceResume } from '@agent-device/ad-replay/divergence';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  createOwnedReplayStateDir,
  stopAndRetireDaemon,
  type OwnedReplayStateDir,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  resolveDaemonPaths,
  resolveDaemonServerMode,
  resolveDaemonTransportPreference,
  type DaemonPaths,
  type DaemonServerMode,
  type DaemonTransportPreference,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';

import type { findUnrecoveredRepairCommitFailure } from '@agent-device/daemon-contracts/session-repair-tombstone';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { attachActiveSessionAddressHint } from './daemon-client-address-hints.ts';
import { isRemoteDaemon } from './daemon-client-metadata.ts';
import { cachedRemoteDaemonHealth } from './daemon-client-transport.ts';
import {
  assertDaemonPolicyMatches,
  readReusableLocalDaemon,
  startLocalDaemon,
} from './daemon-client-startup.ts';

export type DaemonClientSettings = {
  /** The environment and working directory this client reads, for every setting below and the launch. */
  host: HostEnvironment;
  paths: DaemonPaths;
  daemonLifecycle: DaemonLifecycle;
  /**
   * Whether a daemon that wins a startup race may be retired when this client cannot use it. A
   * managed client may; `ensureDaemon` may not, because it replaces a daemon only through a quiesce
   * and judges the winner again instead.
   */
  retireIncompatibleContender: boolean;
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

const LOOPBACK_BLOCK_LIST = new net.BlockList();
LOOPBACK_BLOCK_LIST.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_BLOCK_LIST.addAddress('::1', 'ipv6');
LOOPBACK_BLOCK_LIST.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

export function resolveClientSettings(
  req: Omit<DaemonWireRequest, 'token'>,
  suppliedAuthToken: string | undefined,
  host: HostEnvironment,
  daemonLifecycle: DaemonLifecycle = 'managed',
): DaemonClientSettings {
  const explicitStateDir = resolveExplicitStateDir(req, host.env);
  const remote = resolveRemoteClientSettings(req, suppliedAuthToken, host.env);
  const transport = resolveTransportClientSettings(req.flags, remote.remoteBaseUrl, host.env);
  // An attach client owns no daemon, and a private state directory would hold one nobody started.
  const ownedStateDir =
    daemonLifecycle !== 'attach' &&
    shouldUseOwnedReplayStateDir(req, explicitStateDir, remote.rawBaseUrl)
      ? createOwnedReplayStateDir()
      : undefined;
  return {
    host,
    paths:
      ownedStateDir?.paths ??
      resolveDaemonPaths(explicitStateDir, { env: host.env, cwd: host.cwd }),
    daemonLifecycle,
    retireIncompatibleContender: true,
    transportPreference: transport.preference,
    serverMode: transport.serverMode,
    ownedStateDir,
    remoteBaseUrl: remote.remoteBaseUrl,
    remoteAuthToken: remote.authToken,
  };
}

/**
 * The local daemon a request would use, in the terms `ensureDaemon` takes, or `undefined` when the
 * request has no shared local daemon to ensure: a remote connection has none, and a one-shot replay
 * or test with no explicit state directory runs on a private daemon of its own.
 */
export function resolveEnsurableDaemon(
  req: Omit<DaemonWireRequest, 'token'>,
  host: HostEnvironment,
): EnsureDaemonOptions | undefined {
  const stateDir = resolveExplicitStateDir(req, host.env);
  const rawBaseUrl = req.flags?.daemonBaseUrl ?? host.env.AGENT_DEVICE_DAEMON_BASE_URL;
  if (rawBaseUrl || shouldUseOwnedReplayStateDir(req, stateDir, rawBaseUrl)) return undefined;
  return {
    ...(stateDir !== undefined ? { stateDir } : {}),
    ...(req.flags?.daemonTransport !== undefined
      ? { daemonTransport: req.flags.daemonTransport }
      : {}),
    ...(req.flags?.daemonServerMode !== undefined
      ? { daemonServerMode: req.flags.daemonServerMode }
      : {}),
  };
}

/**
 * The settings of a local daemon with no request behind them, for the caller that ensures one. It
 * reads no remote base URL: a remote connection has no local daemon to ensure.
 */
export function resolveLocalDaemonSettings(
  options: EnsureDaemonOptions,
  host: HostEnvironment,
): DaemonClientSettings {
  const transport = resolveTransportClientSettings(options, undefined, host.env);
  return {
    host,
    paths: resolveDaemonPaths(options.stateDir ?? host.env.AGENT_DEVICE_STATE_DIR, {
      env: host.env,
      cwd: host.cwd,
    }),
    daemonLifecycle: 'managed',
    retireIncompatibleContender: false,
    transportPreference: transport.preference,
    serverMode: transport.serverMode,
  };
}

function resolveExplicitStateDir(
  req: Omit<DaemonWireRequest, 'token'>,
  env: Readonly<EnvMap>,
): string | undefined {
  return req.flags?.stateDir ?? env.AGENT_DEVICE_STATE_DIR;
}

function resolveRemoteClientSettings(
  req: Omit<DaemonWireRequest, 'token'>,
  suppliedAuthToken: string | undefined,
  env: Readonly<EnvMap>,
): {
  rawBaseUrl: string | undefined;
  remoteBaseUrl?: string;
  authToken?: string;
} {
  const rawBaseUrl = req.flags?.daemonBaseUrl ?? env.AGENT_DEVICE_DAEMON_BASE_URL;
  const remoteBaseUrl = resolveRemoteDaemonBaseUrl(rawBaseUrl);
  const authToken = suppliedAuthToken ?? env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  validateRemoteDaemonTrust(remoteBaseUrl, authToken);
  return { rawBaseUrl, remoteBaseUrl, authToken };
}

function resolveTransportClientSettings(
  flags: Partial<Pick<EnsureDaemonOptions, 'daemonTransport' | 'daemonServerMode'>> | undefined,
  remoteBaseUrl: string | undefined,
  env: Readonly<EnvMap>,
): { preference: DaemonTransportPreference; serverMode: DaemonServerMode } {
  const rawTransport = flags?.daemonTransport ?? env.AGENT_DEVICE_DAEMON_TRANSPORT;
  const preference = resolveDaemonTransportPreference(rawTransport);
  if (remoteBaseUrl && preference === 'socket') {
    throw new AppError(
      'INVALID_ARGS',
      'Remote daemon base URL only supports HTTP transport. Remove --daemon-transport socket.',
      { daemonBaseUrl: remoteBaseUrl },
    );
  }
  const rawServerMode =
    flags?.daemonServerMode ??
    env.AGENT_DEVICE_DAEMON_SERVER_MODE ??
    (rawTransport === 'dual' ? 'dual' : undefined);
  return {
    preference,
    serverMode: resolveDaemonServerMode(rawServerMode),
  };
}

function shouldUseOwnedReplayStateDir(
  req: Omit<DaemonWireRequest, 'token'>,
  explicitStateDir: string | undefined,
  rawRemoteBaseUrl: string | undefined,
): boolean {
  return isOneShotReplayCommand(req.command) && !explicitStateDir && !rawRemoteBaseUrl;
}

export async function ensureManagedDaemon(settings: DaemonClientSettings): Promise<EnsuredDaemon> {
  if (settings.remoteBaseUrl) {
    return await ensureRemoteDaemon(settings);
  }

  const ensured = await ensureLocalDaemon(settings);
  // Checked on both branches: a startup can resolve to a daemon another caller raced in.
  await assertDaemonPolicyMatches(ensured.info, settings.paths.baseDir, settings.host);
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
  req: Omit<DaemonWireRequest, 'token'>,
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
  req: Omit<DaemonWireRequest, 'token'>,
  response: DaemonResponse | undefined,
): boolean {
  if (req.command !== PUBLIC_COMMANDS.replay) return false;
  if (!response || !response.ok) return false;
  return response.data?.sessionActive === true;
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
  req: Omit<DaemonWireRequest, 'token'>,
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
