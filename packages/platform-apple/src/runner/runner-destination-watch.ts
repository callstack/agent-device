import net from 'node:net';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitDiagnostic } from './host.ts';

/**
 * What the watcher records when it stops a retained runner: the moment the loss was seen. Read
 * once by the next `open`.
 */
export type RunnerWarmLossNotice = Readonly<{ atMs: number }>;

/**
 * A push watcher for a runner retained after `close` (#3321).
 *
 * A retained `xcodebuild test-without-building` owns its Simulator destination: when something
 * outside agent-device shuts that Simulator down, the runner app dies and Xcode silently reboots
 * the device to keep its own session alive, with nobody asking agent-device. The device then stays
 * powered on for as long as the runner process lives. Stopping the runner is what powers it back
 * off, and stopping a runner whose device was not rebooted only costs its warm reuse.
 *
 * The watcher holds one idle TCP connection to the runner's loopback listener for the retention
 * window and writes nothing on it. The listener never closes an idle connection on its own, so a
 * connection that closes after it was established means the runner app ended, and the retained
 * runner is stopped. Nothing samples a quiet runner. A refused attach is retried on a flat cadence
 * inside a bounded budget, because the listener can refuse for a few seconds right after `close`;
 * a port that stays refused is a runner that cannot answer, and is stopped the same way.
 */

const ATTACH_RETRY_DELAY_MS = 1_000;
const ATTACH_RETRY_ATTEMPTS = 15;

export type RunnerDestinationWatchParams = {
  device: DeviceInfo;
  sessionId: string;
  port: number;
  /** Re-read at every decision: false once any path has left the idle-retention window. */
  isArmed: () => boolean;
  /** Stops the retained runner and releases its lease. */
  onStop: () => Promise<void>;
  /** Attach attempts left for a refused port; a fresh retention window starts a fresh budget. */
  attemptsLeft?: number;
};

type DestinationWatch = { socket: net.Socket; retryTimer?: NodeJS.Timeout };

const destinationWatches = new Map<string, DestinationWatch>();
const pendingWarmLossNotices = new Map<string, RunnerWarmLossNotice>();

/**
 * Attaches the watcher for one retention window. A device has one watch: a fresh window replaces
 * the existing one. `isArmed` is consulted again at every decision, so an attach that lands after
 * its retention window already ended arms nothing that can act.
 */
export function attachRunnerDestinationWatch(params: RunnerDestinationWatchParams): void {
  const deviceId = params.device.id;
  closeRunnerDestinationWatch(deviceId);
  const watch: DestinationWatch = { socket: net.connect(params.port, '127.0.0.1') };
  let connected = false;
  watch.socket.unref();
  watch.socket.on('connect', () => {
    connected = true;
  });
  // `close` always follows an `error`; the decision is made once, there.
  watch.socket.on('error', () => {});
  watch.socket.on('close', () => {
    if (destinationWatches.get(deviceId) !== watch) return;
    if (!params.isArmed()) {
      closeRunnerDestinationWatch(deviceId);
    } else if (connected) {
      stopRetainedRunner(params);
    } else {
      retryRefusedAttach(watch, params);
    }
  });
  destinationWatches.set(deviceId, watch);
}

/**
 * Ends the watch without acting. Every path that leaves the idle-retention window calls it; even a
 * missed call is inert, because `isArmed` re-reads the retention state at each decision.
 */
export function closeRunnerDestinationWatch(deviceId: string): void {
  const watch = destinationWatches.get(deviceId);
  if (!watch) return;
  destinationWatches.delete(deviceId);
  clearTimeout(watch.retryTimer);
  watch.socket.removeAllListeners();
  watch.socket.on('error', () => {});
  watch.socket.destroy();
}

function retryRefusedAttach(watch: DestinationWatch, params: RunnerDestinationWatchParams): void {
  const attemptsLeft = params.attemptsLeft ?? ATTACH_RETRY_ATTEMPTS;
  if (attemptsLeft <= 0) {
    stopRetainedRunner(params);
    return;
  }
  watch.retryTimer = setTimeout(() => {
    if (params.isArmed())
      attachRunnerDestinationWatch({ ...params, attemptsLeft: attemptsLeft - 1 });
    else closeRunnerDestinationWatch(params.device.id);
  }, ATTACH_RETRY_DELAY_MS);
  watch.retryTimer.unref();
}

/** Stops the retained runner, recording the notice before the stop so an `open` cannot miss it. */
function stopRetainedRunner(params: RunnerDestinationWatchParams): void {
  const deviceId = params.device.id;
  closeRunnerDestinationWatch(deviceId);
  pendingWarmLossNotices.set(deviceId, { atMs: Date.now() });
  emitDiagnostic({
    level: 'warn',
    phase: 'ios_runner_warm_stop',
    data: { deviceId, sessionId: params.sessionId },
  });
  void params.onStop().catch((error: unknown) => {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_warm_stop_failed',
      data: { deviceId, error: error instanceof Error ? error.message : String(error) },
    });
  });
}

/** Takes the loss notice recorded for this device, once. */
export function takeRunnerWarmLossNotice(deviceId: string): RunnerWarmLossNotice | undefined {
  const notice = pendingWarmLossNotices.get(deviceId);
  pendingWarmLossNotices.delete(deviceId);
  return notice;
}
