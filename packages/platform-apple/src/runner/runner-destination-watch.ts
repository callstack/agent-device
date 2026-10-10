import net from 'node:net';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  emitDiagnostic,
  isProcessAlive,
  observeSimulatorBootTimeMs,
  observeSimulatorState,
} from './host.ts';

/**
 * Why a runner retained after `close` was stopped before the session asked for it again.
 * Keyed behavior: consumers branch on these values, never on prose.
 */
export type RunnerWarmLossReason = 'runner_destination_lost' | 'runner_unreachable';

/**
 * What a retained runner's owner records when the watcher stops it: the typed reason, the session
 * the runner served, and the moment the loss was proven. Read once by the next `open`.
 */
export type RunnerWarmLossNotice = Readonly<{
  reason: RunnerWarmLossReason;
  deviceId: string;
  sessionId: string;
  atMs: number;
}>;

/**
 * A push watcher for a runner retained after `close` (#3321).
 *
 * A retained `xcodebuild test-without-building` owns its Simulator destination: when something
 * outside agent-device shuts that Simulator down, the runner app dies (`ipc/mig server died`) and
 * Xcode's destination machinery silently reboots the device to keep its own session alive, with
 * nobody asking agent-device. The device stays powered on for as long as that runner process
 * lives — potentially the whole idle-retention window. Killing the runner is what powers a
 * rebooted device back off (measured: within ~2s of the kill on a device Xcode had rebooted),
 * while killing a runner whose device was NOT rebooted leaves the device powered on — so stopping
 * on loss cannot harm a healthy warm runner.
 *
 * The watcher holds ONE idle TCP connection to the runner's listener for the length of the
 * retention window and writes nothing on it. The runner's listener serves many connections and
 * never closes an idle one on its own (measured: alive past 180s while commands answered in
 * single-digit milliseconds beside it), so a connection that closes AFTER it was established is
 * the push signal that the runner's app generation ended — arriving within ~1s of an external
 * shutdown. No timer samples a quiet runner: every read below happens once, at an event.
 *
 * "A connected socket closed" cannot by itself tell a reboot from a crash, because Xcode restarts
 * the runner app onto the same port after rebooting the destination. The classification therefore
 * reads device identity, not port liveness: a boot that began after the watch was armed, or no
 * boot observable while the runner is still there to serve one, means the destination was replaced
 * under the session and the retained runner must go.
 *
 * An attach that never connected (ECONNREFUSED) carries no information about WHY nothing was
 * listening — the restart after a reboot lands on the same port within seconds — so it is retried
 * on a bounded backoff instead of being classified; only an established connection that later
 * closes is evidence of a runner-generation change.
 */

/** How long an attach keeps retrying a refused port before the runner is called unreachable. */
const ATTACH_RETRY_BUDGET_DEFAULT_MS = 15_000;
const ATTACH_RETRY_BASE_DELAY_MS = 1_000;

/** How long a connected-socket close waits before the boot identity is read (see below). */
const DESTINATION_CONFIRM_DEFAULT_MS = 2_500;
const DESTINATION_RECHECK_DEFAULT_MS = 1_000;

/** `simctl list` name of a powered-on Simulator. */
const SIMULATOR_BOOTED_STATE = 'Booted';

type LossAction = 'stop' | 'rearm';

type LossVerdict = Readonly<{
  action: LossAction;
  /** Present only when the loss is worth telling the next `open` about. */
  noticeReason?: RunnerWarmLossReason;
}>;

const DESTINATION_LOST: LossVerdict = { action: 'stop', noticeReason: 'runner_destination_lost' };

/**
 * The listing timed out or was unreadable, so nothing proves the device changed. Stopping is still
 * the safe side, but the notice must not claim a shutdown nobody observed.
 */
const STATE_UNVERIFIABLE: LossVerdict = { action: 'stop', noticeReason: 'runner_unreachable' };

type DestinationWatch = {
  device: DeviceInfo;
  sessionId: string;
  port: number;
  runnerPid: number | undefined;
  /** When this retention window began; a boot starting later belongs to a replacement device state. */
  armedAtMs: number;
  /** Re-read at every decision: false once any path has left the idle-retention window. */
  isArmed: () => boolean;
  /** Stops the retained runner and releases its lease. */
  onStop: () => Promise<void>;
  socket: net.Socket;
  /** True once this connection was established: only then can its close mean runner death. */
  connected: boolean;
  /**
   * True when this attach follows a refusal or a same-boot re-arm, so what answers may be a new
   * runner generation started after the device changed under the session.
   */
  replacement: boolean;
  /** The in-flight loss decision, which a notice reader waits for while the window is still open. */
  deciding: Promise<void> | undefined;
  detached: boolean;
};

const destinationWatches = new Map<string, DestinationWatch>();
const pendingWarmLossNotices = new Map<string, RunnerWarmLossNotice>();

/**
 * How long a loss event waits before reading the device's boot identity. A shutdown is not over
 * when the runner app dies: the old `launchd_sim` may still be visible for a moment, and Xcode's
 * reboot starts within ~1s of the shutdown returning. One bounded re-read per event (never a
 * sample of a quiet runner) lets that churn settle so a mid-shutdown read cannot misclassify a
 * crash. A stop that lands after the reboot has finished still powers the device back off.
 *
 * The confirm delay, the recheck delay and the attach-retry budget have production defaults; a
 * non-negative millisecond value in `AGENT_DEVICE_IOS_RUNNER_DESTINATION_CONFIRM_MS`,
 * `..._RECHECK_MS` or `..._ATTACH_RETRY_MS` replaces one. Only tests set them, to avoid waiting
 * production time.
 */
function resolveConfirmDelayMs(): number {
  return readDurationEnvMs(
    'AGENT_DEVICE_IOS_RUNNER_DESTINATION_CONFIRM_MS',
    DESTINATION_CONFIRM_DEFAULT_MS,
  );
}

function resolveRecheckDelayMs(): number {
  return readDurationEnvMs(
    'AGENT_DEVICE_IOS_RUNNER_DESTINATION_RECHECK_MS',
    DESTINATION_RECHECK_DEFAULT_MS,
  );
}

function resolveAttachRetryBudgetMs(): number {
  return readDurationEnvMs(
    'AGENT_DEVICE_IOS_RUNNER_DESTINATION_ATTACH_RETRY_MS',
    ATTACH_RETRY_BUDGET_DEFAULT_MS,
  );
}

/** A non-negative millisecond override, fractions floored; anything else keeps the default. */
function readDurationEnvMs(key: string, fallbackMs: number): number {
  const raw = process.env[key]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallbackMs;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export type RunnerDestinationWatchParams = {
  device: DeviceInfo;
  sessionId: string;
  port: number;
  runnerPid: number | undefined;
  isArmed: () => boolean;
  onStop: () => Promise<void>;
  /**
   * Remaining attach-retry budget for a refused port, carried across the re-attaches of one loss
   * event so a runner that never answers is bounded; a fresh retention window starts a fresh
   * budget.
   */
  attachRetryBudgetMs?: number;
  /** When the retention window began; re-attaches within one window carry it forward unchanged. */
  armedAtMs?: number;
  /** Set by re-attaches within one window: the listener that answers may be a new generation. */
  replacement?: boolean;
};

/**
 * Attaches the watcher for one retention window. A device has one watch: a fresh window replaces
 * the existing one rather than stacking another. `isArmed` is consulted again at every
 * decision, so an attach that lands after its retention window already ended arms nothing that
 * can act.
 */
export function attachRunnerDestinationWatch(params: RunnerDestinationWatchParams): void {
  // One watch per device, and a new attach replaces rather than amends: nothing carries over
  // from a window another path already ended, so no caller has to have detached first.
  const existing = destinationWatches.get(params.device.id);
  if (existing) detachWatch(existing);
  const watch: DestinationWatch = {
    device: params.device,
    sessionId: params.sessionId,
    port: params.port,
    runnerPid: params.runnerPid,
    armedAtMs: params.armedAtMs ?? Date.now(),
    isArmed: params.isArmed,
    onStop: params.onStop,
    socket: net.connect(params.port, '127.0.0.1'),
    connected: false,
    replacement: params.replacement ?? false,
    deciding: undefined,
    detached: false,
  };
  watch.socket.unref();
  watch.socket.on('connect', () => {
    watch.connected = true;
    if (watch.replacement) void decide(watch, () => confirmReplacementGeneration(watch));
  });
  watch.socket.on('close', () => {
    void handleSocketClosed(watch, params.attachRetryBudgetMs);
  });
  // `close` always follows an `error`; classification happens once, there.
  watch.socket.on('error', () => {});
  destinationWatches.set(params.device.id, watch);
}

/**
 * Ends the watch without acting. Every path that leaves the idle-retention window calls it; even
 * a missed call is inert, because `isArmed` re-reads the retention state at each decision.
 */
export function closeRunnerDestinationWatch(deviceId: string): void {
  const watch = destinationWatches.get(deviceId);
  if (watch) detachWatch(watch);
}

function detachWatch(watch: DestinationWatch): void {
  watch.detached = true;
  // A handler resuming after an await may belong to a watch a newer window has replaced.
  if (destinationWatches.get(watch.device.id) === watch) destinationWatches.delete(watch.device.id);
  watch.socket.removeAllListeners('connect');
  watch.socket.removeAllListeners('close');
  watch.socket.removeAllListeners('error');
  watch.socket.destroy();
}

async function handleSocketClosed(
  watch: DestinationWatch,
  attachRetryBudgetMs: number | undefined,
): Promise<void> {
  if (watch.detached) return;
  if (!watch.isArmed()) {
    detachWatch(watch);
    return;
  }
  if (!watch.connected) {
    await handleRefusedAttach(watch, attachRetryBudgetMs);
    return;
  }
  await decide(watch, async () => {
    await delay(resolveConfirmDelayMs());
    if (watch.detached || !watch.isArmed()) {
      detachWatch(watch);
      return;
    }
    const verdict = await classifyConnectedLoss(watch);
    if (watch.detached || !watch.isArmed()) {
      detachWatch(watch);
      return;
    }
    if (verdict.action === 'rearm') {
      rearmOnSameBoot(watch);
      return;
    }
    stopRetainedRunner(watch, verdict.noticeReason);
  });
}

/**
 * A listener answered after the device may have been replaced: the refused attaches that preceded
 * it span exactly the gap in which Xcode reboots a shut-down destination and restarts the runner
 * app onto the same port, and a connection that reaches that new generation never closes on its
 * own. One classification at the connect decides whether the window's boot is still the device's.
 * A same-boot answer keeps this connection as the watch.
 */
async function confirmReplacementGeneration(watch: DestinationWatch): Promise<void> {
  const verdict = await classifyConnectedLoss(watch);
  if (watch.detached || !watch.isArmed()) {
    detachWatch(watch);
    return;
  }
  if (verdict.action === 'stop') stopRetainedRunner(watch, verdict.noticeReason);
}

/** Runs one loss decision and publishes it, so {@link takeRunnerWarmLossNotice} can wait for it. */
async function decide(watch: DestinationWatch, run: () => Promise<void>): Promise<void> {
  const deciding = run();
  watch.deciding = deciding;
  try {
    await deciding;
  } finally {
    if (watch.deciding === deciding) watch.deciding = undefined;
  }
}

/**
 * The attach never reached a listener. A rebooting destination is usually unreachable for a
 * couple of seconds while Xcode restarts the app onto the same port, so retry at a flat one-second
 * cadence inside a bounded budget; a retry that connects classifies the replacement generation. Only when the budget runs out is the retained runner called
 * what it has proven to be: unable to answer anything. By then the destination process's own
 * liveness decides whether this was a crash (Xcode gave up with it, the device lost its boot
 * owner) or a listener that died while Xcode kept the device — the latter is exactly the silent
 * power-on #3321 is about, so the runner goes with a notice.
 */
async function handleRefusedAttach(
  watch: DestinationWatch,
  attachRetryBudgetMs: number | undefined,
): Promise<void> {
  const budgetMs = attachRetryBudgetMs ?? resolveAttachRetryBudgetMs();
  if (budgetMs > 0) {
    const nextDelayMs = Math.min(ATTACH_RETRY_BASE_DELAY_MS, budgetMs);
    await delay(nextDelayMs);
    if (watch.detached || !watch.isArmed()) {
      detachWatch(watch);
      return;
    }
    detachWatch(watch);
    attachRunnerDestinationWatch({
      device: watch.device,
      sessionId: watch.sessionId,
      port: watch.port,
      runnerPid: watch.runnerPid,
      isArmed: watch.isArmed,
      onStop: watch.onStop,
      attachRetryBudgetMs: budgetMs - nextDelayMs,
      armedAtMs: watch.armedAtMs,
      replacement: true,
    });
    return;
  }
  if (watch.runnerPid !== undefined && !isProcessAlive(watch.runnerPid)) {
    // Xcode itself gave up on this runner generation: the retention is over, the lease is stale,
    // and nothing agent-device owns is powering the device any more. Plain cleanup, no notice.
    stopRetainedRunner(watch, undefined);
    return;
  }
  stopRetainedRunner(watch, 'runner_unreachable');
}

/**
 * Reads whether the device behind the runner stopped being the device this session was armed on.
 * A dead destination process answers for itself before the probe: Xcode cannot reboot from a dead
 * process, so stopping is plain lease cleanup. Otherwise the device must be listed `Booted` on the
 * boot the window began with, and anything else is destination loss: a shut-down device keeps its
 * old `launchd_sim` listed for ~6s, so the boot witness alone would read the old boot and call it
 * a crash. A listing that timed out or was unreadable is no evidence of a healthy device, so it
 * stops the runner too, but as `runner_unreachable`: it cannot support a claim about the device. A boot newer than the
 * window is Xcode's reboot; a boot unobservable twice is a device that is down with a reboot
 * promise that may already be in flight. Stopping pre-empts that promise in every loss case.
 */
async function classifyConnectedLoss(watch: DestinationWatch): Promise<LossVerdict> {
  if (watch.runnerPid !== undefined && !isProcessAlive(watch.runnerPid)) {
    return { action: 'stop' };
  }
  const state = await observeSimulatorState(watch.device);
  if (state === null) return STATE_UNVERIFIABLE;
  if (state !== SIMULATOR_BOOTED_STATE) return DESTINATION_LOST;
  let boot = await readBootAgainstWindow(watch);
  if (boot === 'unobserved') {
    await delay(resolveRecheckDelayMs());
    boot = await readBootAgainstWindow(watch);
  }
  return boot === 'same-boot' ? { action: 'rearm' } : DESTINATION_LOST;
}

async function readBootAgainstWindow(
  watch: DestinationWatch,
): Promise<'same-boot' | 'newer-boot' | 'unobserved'> {
  const boot = await observeSimulatorBootTimeMs(watch.device);
  if (!boot.observed) return 'unobserved';
  return boot.bootedAtMs <= watch.armedAtMs ? 'same-boot' : 'newer-boot';
}

/**
 * The runner's app generation died while the device kept this session's boot: a crash Xcode may
 * restart onto the same port. Re-arm the push signal on the replacement. Each cycle waits on the
 * new socket's own close event — an established close here is a real runner death, not a sample,
 * and Xcode's restart budget bounds how many there can be; a refused port runs the bounded
 * attach-retry above instead of spinning here.
 */
function rearmOnSameBoot(watch: DestinationWatch): void {
  emitDiagnostic({
    level: 'info',
    phase: 'ios_runner_destination_watch_rearmed',
    data: { deviceId: watch.device.id, sessionId: watch.sessionId },
  });
  const { device, sessionId, port, runnerPid, isArmed, onStop, armedAtMs } = watch;
  detachWatch(watch);
  if (!isArmed()) return;
  attachRunnerDestinationWatch({
    device,
    sessionId,
    port,
    runnerPid,
    isArmed,
    onStop,
    armedAtMs,
    replacement: true,
  });
}

/**
 * Stops the retained runner, recording the notice the next `open` must carry before any notice
 * consumer can race this path. A `undefined` reason is silent lease cleanup for a runner
 * generation Xcode already buried.
 */
function stopRetainedRunner(
  watch: DestinationWatch,
  noticeReason: RunnerWarmLossReason | undefined,
): void {
  detachWatch(watch);
  if (noticeReason) {
    pendingWarmLossNotices.set(watch.device.id, {
      reason: noticeReason,
      deviceId: watch.device.id,
      sessionId: watch.sessionId,
      atMs: Date.now(),
    });
  }
  emitDiagnostic({
    level: 'warn',
    phase: 'ios_runner_warm_stop',
    data: {
      deviceId: watch.device.id,
      sessionId: watch.sessionId,
      reason: noticeReason ?? 'runner_process_gone',
    },
  });
  void watch.onStop().catch((error: unknown) => {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_warm_stop_failed',
      data: {
        deviceId: watch.device.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  });
}

/**
 * Takes the destination-loss notice recorded for this device, once. A notice exists only when a
 * retained runner was stopped because the destination was replaced under it — the state the next
 * `open` must explain rather than leave the caller to infer from a cold start. A decision still in
 * flight for a window that is still open is waited for, so a notice cannot land after the open it
 * belongs to has already read; once any use of the runner has ended the window nothing is waited
 * for, because nothing can be recorded any more.
 */
export async function takeRunnerWarmLossNotice(
  deviceId: string,
): Promise<RunnerWarmLossNotice | undefined> {
  for (let watch = destinationWatches.get(deviceId); watch?.deciding;) {
    if (!watch.isArmed()) break;
    await watch.deciding;
    const next = destinationWatches.get(deviceId);
    watch = next === watch ? undefined : next;
  }
  const notice = pendingWarmLossNotices.get(deviceId);
  if (notice) pendingWarmLossNotices.delete(deviceId);
  return notice;
}
