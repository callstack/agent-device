/**
 * The daemon startup phase vocabulary and the one typed message that carries it. The launcher opens
 * a Node IPC channel when it spawns the detached child (`stdio: [..., 'ipc']`); the daemon entry
 * reports each phase over it and closes it after `registered`.
 */
const DAEMON_STARTUP_PHASES = Object.freeze([
  'modules-loaded',
  'composition-loaded',
  'lock-acquired',
  'recovery-finished',
  'listening',
  'registered',
] as const);

export type DaemonStartupPhase = (typeof DAEMON_STARTUP_PHASES)[number];

const DAEMON_STARTUP_PHASE_SET: ReadonlySet<string> = new Set<string>(DAEMON_STARTUP_PHASES);

const DAEMON_STARTUP_PROGRESS_MESSAGE_TYPE = 'daemon-startup-phase';

/**
 * One phase report from a daemon child to its launcher. The IPC channel connects exactly one
 * launcher to the child it spawned, so the message needs no sender identity.
 */
export type DaemonStartupProgressMessage = Readonly<{
  type: typeof DAEMON_STARTUP_PROGRESS_MESSAGE_TYPE;
  phase: DaemonStartupPhase;
}>;

export function daemonStartupProgressMessage(
  phase: DaemonStartupPhase,
): DaemonStartupProgressMessage {
  return { type: DAEMON_STARTUP_PROGRESS_MESSAGE_TYPE, phase };
}

/**
 * The phase one channel message reports. Anything unknown or malformed parses to null, so a
 * receiver never fails a startup over a message it does not recognize.
 */
export function parseDaemonStartupProgressMessage(message: unknown): DaemonStartupPhase | null {
  if (typeof message !== 'object' || message === null) return null;
  const { type, phase } = message as Record<string, unknown>;
  if (type !== DAEMON_STARTUP_PROGRESS_MESSAGE_TYPE) return null;
  return typeof phase === 'string' && DAEMON_STARTUP_PHASE_SET.has(phase)
    ? (phase as DaemonStartupPhase)
    : null;
}

/**
 * The launcher sets this on the detached child it spawns. A process that holds an IPC channel for
 * another reason (a forked host, a test worker) has no mark, so its channel is never used.
 */
export const DAEMON_PROGRESS_CHANNEL_ENV = 'AGENT_DEVICE_DAEMON_PROGRESS_CHANNEL';

/**
 * Where a runtime reports its startup phases. The process entry owns the channel behind it; an
 * embedded host passes none. Reporting never fails a startup.
 */
export type DaemonStartupProgress = Readonly<{
  report(phase: DaemonStartupPhase): void;
  /** Ends reporting after `registered`. */
  close(): void;
}>;
