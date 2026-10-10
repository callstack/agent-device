import net from 'node:net';
import { isIosFamily } from '@agent-device/kernel/device';
import { emitDiagnostic } from './host.ts';
import {
  isRunnerMainThreadOccupied,
  type RunnerSession,
  type RunnerListenerWatch,
  type RunnerRetention,
} from './runner-session-types.ts';

const LISTENER_CONNECT_TIMEOUT_MS = 500;
const RETAINED_IDLE_STOP_DEFAULT_MS = 5 * 60_000;

type StopRetainedRunner = (
  retention: RunnerRetention,
  reason: 'idle_timeout' | 'listener_lost',
) => Promise<void>;

/** Observes one serving generation; a lost connection is never attached to a replacement. */
export function observeRunnerListener(
  session: RunnerSession,
  onLost: () => Promise<void> | undefined,
): void {
  if (session.state !== 'ready' || !needsListenerWatch(session) || session.listenerWatch) return;
  const socket = net.connect(session.port, '127.0.0.1');
  socket.unref();
  let settle!: (connected: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const connectTimer = setTimeout(() => socket.destroy(), LISTENER_CONNECT_TIMEOUT_MS);
  connectTimer.unref();
  const watch: RunnerListenerWatch = {
    lost: false,
    ready,
    close() {
      clearTimeout(connectTimer);
      watch.lost = true;
      settle(false);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
    },
  };
  session.listenerWatch = watch;
  socket.on('connect', () => {
    clearTimeout(connectTimer);
    settle(true);
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    clearTimeout(connectTimer);
    watch.lost = true;
    settle(false);
    void onLost()?.catch((error: unknown) => {
      emitDiagnostic({
        level: 'warn',
        phase: 'ios_runner_warm_stop_failed',
        data: { deviceId: session.deviceId, sessionId: session.sessionId, error: String(error) },
      });
    });
  });
}

/** Retains a ready generation already observed by its listener connection, with one idle timer. */
export async function retainRunnerSession(
  session: RunnerSession,
  stop: StopRetainedRunner,
): Promise<boolean> {
  if (
    session.state !== 'ready' ||
    isRunnerMainThreadOccupied(session) ||
    session.commandCharges.hasOutstandingCharges
  )
    return false;
  if (needsListenerWatch(session)) {
    const watch = session.listenerWatch;
    if (!watch || !(await watch.ready) || watch.lost) return false;
  }
  if (
    session.state !== 'ready' ||
    isRunnerMainThreadOccupied(session) ||
    session.commandCharges.hasOutstandingCharges
  )
    return false;
  session.retention?.cancel();
  let timer: NodeJS.Timeout | undefined;
  const retention: RunnerRetention = {
    cancel() {
      clearTimeout(timer);
      if (session.retention === retention) session.retention = undefined;
    },
  };
  session.retention = retention;
  const idleMs = resolveRunnerIdleStopMs();
  if (idleMs > 0) {
    timer = setTimeout(() => {
      void stop(retention, 'idle_timeout').catch((error: unknown) => {
        emitDiagnostic({
          level: 'warn',
          phase: 'ios_runner_idle_stop_failed',
          data: { deviceId: session.deviceId, sessionId: session.sessionId, error: String(error) },
        });
      });
    }, idleMs);
    timer.unref();
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_idle_stop_scheduled',
      data: { deviceId: session.deviceId, sessionId: session.sessionId, idleMs },
    });
  }
  return true;
}

function needsListenerWatch(session: RunnerSession): boolean {
  return session.device.kind === 'simulator' && isIosFamily(session.device);
}

function resolveRunnerIdleStopMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(Math.floor(parsed), 2 ** 31 - 1);
  }
  return RETAINED_IDLE_STOP_DEFAULT_MS;
}
