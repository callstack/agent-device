import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type {
  DaemonBinding,
  DaemonLifecycle,
  EnsureDaemonOptions,
} from '@agent-device/contracts/client';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
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
  isLoopbackHostname,
  resolveDaemonPaths,
  resolveDaemonServerMode,
  resolveDaemonTransportPreference,
  DAEMON_RETIREMENT_REASONS,
  type DaemonPaths,
  type DaemonServerMode,
  type DaemonTransportPreference,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { DaemonRpcMode } from '@agent-device/contracts/remote';
import {
  DAEMON_CLIENT_CONFIG_REASONS,
  REMOTE_DAEMON_UNREACHABLE_HINT,
} from './daemon-lifecycle-errors.ts';

import type { findUnrecoveredRepairCommitFailure } from '@agent-device/daemon-contracts/session-repair-tombstone';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { attachActiveSessionAddressHint } from './daemon-client-address-hints.ts';
import { isRemoteDaemon, observedDaemonIdentityOf } from './daemon-client-metadata.ts';
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
  /** Told when this client retires an incompatible daemon to start its own; stderr gets a notice otherwise. */
  onTakeover?: (notice: DaemonTakeoverNotice) => void;
  transportPreference: DaemonTransportPreference;
  serverMode: DaemonServerMode;
  ownedStateDir?: OwnedReplayStateDir;
  remoteBaseUrl?: string;
  remoteAuthToken?: string;
  /**
   * The request goes on the checked RPC route without a `/health` probe: its connection sets
   * `daemonRpc: checked`, and the request has no remote side effect before its command RPC.
   */
  remoteCheckedRpc?: true;
  /** See {@link DaemonBinding}. Present on a client that is pinned to one daemon instance. */
  daemonBinding?: DaemonBinding;
};

/** A daemon this client is about to retire so it can start its own, in structured fields for the caller to render. */
export type DaemonTakeoverNotice = {
  stateDir: string;
  previous: { pid: number; version?: string };
  reason: string;
};

export type EnsuredDaemon = {
  info: DaemonInfo;
  startedByClient: boolean;
};

/**
 * Whether a timed-out request may retire the daemon it was waiting on. An attach client never may: the
 * daemon is not its to kill, and `ensureDaemon` reuses a compatible daemon that accepts a connection
 * without asking it anything, so that one is ended only by a deliberate stop. Every other caller asks the retirement, which judges the record's owner before it signals anything.
 */
export function resolveTimeoutRecovery(
  settings: DaemonClientSettings,
): 'retire-unresponsive' | 'none' {
  if (settings.daemonLifecycle === 'attach') return 'none';
  return 'retire-unresponsive';
}

export function resolveClientSettings(
  req: Omit<DaemonWireRequest, 'token'>,
  suppliedAuthToken: string | undefined,
  host: HostEnvironment,
  daemonLifecycle: DaemonLifecycle = 'managed',
  daemonBinding: DaemonBinding | undefined = undefined,
): DaemonClientSettings {
  const explicitStateDir = resolveExplicitStateDir(req, host.env);
  const remote = resolveRemoteClientSettings(req, suppliedAuthToken, host.env);
  // A pin names one local daemon instance: its token, pid and start time are read from a state
  // directory's record. A base URL sends requests somewhere else entirely, so a client that sets both
  // has stated two different answers to "which daemon". Refusing here beats picking one silently.
  if (daemonBinding && remote.remoteBaseUrl) {
    throw new AppError(
      'INVALID_ARGS',
      'daemonBinding names a local daemon instance and cannot be combined with a daemon base URL.',
      {
        reason: DAEMON_CLIENT_CONFIG_REASONS.bindingWithBaseUrl.reason,
        daemonBaseUrl: remote.remoteBaseUrl,
        hint: 'Drop the base URL to reach the pinned daemon on its own state dir, or drop the pin to reach a remote daemon.',
      },
    );
  }
  if (daemonBinding) daemonLifecycle = 'attach';
  const transport = resolveTransportClientSettings(req.flags, remote.remoteBaseUrl, host.env);
  // An attach client owns no daemon, and a private state directory would hold one nobody started. A
  // pinned client owns one neither: it uses the instance it was given and starts nothing.
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
    ...(remote.remoteBaseUrl && remote.daemonRpc === 'checked' && isStandaloneRemoteRequest(req)
      ? { remoteCheckedRpc: true as const }
      : {}),
    ...(daemonBinding ? { daemonBinding } : {}),
  };
}

/**
 * Whether a remote request reaches the daemon with nothing before its command RPC. An install may
 * upload an artifact, under lease beats, before its RPC, so it keeps the `/health` probe and the
 * instance headers that pin that RPC to the daemon holding the upload.
 */
function isStandaloneRemoteRequest(req: Omit<DaemonWireRequest, 'token'>): boolean {
  return (
    req.command !== PUBLIC_COMMANDS.install &&
    req.command !== PUBLIC_COMMANDS.reinstall &&
    req.command !== INTERNAL_COMMANDS.installSource
  );
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
  daemonRpc: DaemonRpcMode;
} {
  const rawBaseUrl = req.flags?.daemonBaseUrl ?? env.AGENT_DEVICE_DAEMON_BASE_URL;
  const remoteBaseUrl = resolveRemoteDaemonBaseUrl(rawBaseUrl);
  const authToken = suppliedAuthToken ?? env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  validateRemoteDaemonTrust(remoteBaseUrl, authToken);
  const daemonRpc = resolveDaemonRpcMode(req.flags?.daemonRpc ?? env.AGENT_DEVICE_DAEMON_RPC);
  return { rawBaseUrl, remoteBaseUrl, authToken, daemonRpc };
}

function resolveDaemonRpcMode(raw: string | undefined): DaemonRpcMode {
  if (raw === undefined || raw === '') return 'health';
  if (raw === 'health' || raw === 'checked') return raw;
  throw new AppError('INVALID_ARGS', 'daemonRpc must be health or checked', { daemonRpc: raw });
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
    defaultServerModeForRequestedTransport(rawTransport);
  return { preference, serverMode: resolveDaemonServerMode(rawServerMode) };
}

/**
 * The server mode that answers the transport a client named, used when that client named no server
 * mode: the daemon a managed client starts has to serve the endpoint that client will call. `auto`
 * and `socket` ask for nothing — the socket-only default answers both. A client that starts no
 * daemon never reads this setting, so it decides nothing for one.
 */
function defaultServerModeForRequestedTransport(
  rawTransport: string | undefined,
): DaemonServerMode | undefined {
  const normalized = (rawTransport ?? '').trim().toLowerCase();
  if (normalized === 'dual') return 'dual';
  if (normalized === 'http') return 'http';
  return undefined;
}

function shouldUseOwnedReplayStateDir(
  req: Omit<DaemonWireRequest, 'token'>,
  explicitStateDir: string | undefined,
  rawRemoteBaseUrl: string | undefined,
): boolean {
  return isOneShotReplayCommand(req.command) && !explicitStateDir && !rawRemoteBaseUrl;
}

/**
 * How long the remote `/health` gate may re-probe a daemon that is there but not ready: the budget
 * of the command waiting behind it. Without one, the first failed probe refuses.
 */
export type RemoteHealthRecovery = {
  budgetMs: number;
  signal: AbortSignal | undefined;
};

export async function ensureManagedDaemon(
  settings: DaemonClientSettings,
  healthRecovery?: RemoteHealthRecovery,
): Promise<EnsuredDaemon> {
  if (settings.remoteBaseUrl) {
    return await ensureRemoteDaemon(settings, healthRecovery);
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

async function ensureRemoteDaemon(
  settings: DaemonClientSettings,
  healthRecovery: RemoteHealthRecovery | undefined,
): Promise<EnsuredDaemon> {
  const remoteInfo: DaemonInfo = {
    transport: 'http',
    // Remote mode reuses the auth token as the daemon token so the existing JSON-RPC contract still works.
    token: settings.remoteAuthToken ?? '',
    pid: 0,
    baseUrl: settings.remoteBaseUrl,
  };
  // The checked route makes the server refuse what `/health` would have: no probe goes first.
  if (settings.remoteCheckedRpc)
    return { info: { ...remoteInfo, checkedRpc: true }, startedByClient: false };
  // The command's budget starts with the first probe, which already runs under it and its signal.
  const deadline = performance.now() + (healthRecovery?.budgetMs ?? 0);
  let health = await cachedRemoteDaemonHealth(
    remoteInfo,
    healthRecovery?.budgetMs,
    healthRecovery?.signal,
  );
  if (!health.reachable) {
    // Loaded on the refusal: this module is not part of what every CLI start pays for.
    const { recoverRemoteDaemonHealth } = await import('./daemon-client-remote-health-recovery.ts');
    health = await recoverRemoteDaemonHealth({
      info: remoteInfo,
      failedProbe: health,
      recovery: healthRecovery,
      deadline,
      hint: REMOTE_DAEMON_UNREACHABLE_HINT,
    });
  }
  remoteInfo.capabilities = (health.upstream ?? health).capabilities;
  remoteInfo.remoteInstanceId = health.instanceId;
  remoteInfo.remoteUpstreamInstanceId = health.upstream?.instanceId;
  return { info: remoteInfo, startedByClient: false };
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
    observed: observedDaemonIdentityOf(daemon.info),
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
            reason: DAEMON_RETIREMENT_REASONS.retirementUnconfirmed.reason,
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
