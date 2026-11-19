/**
 * The daemon startup phase vocabulary and the one typed message that carries it, shared by the
 * detached daemon child and the launcher's client. The launcher opens a Node IPC channel when it
 * spawns the detached child (`stdio: [..., 'ipc']`); the child reports each phase over that
 * channel and closes it after `registered`. A child started without a channel (embedded mode, a
 * test fixture that spawns the daemon directly, a manual start) reports nothing: sending is a
 * no-op, and a failed send (launcher gone) never affects startup.
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
type DaemonStartupProgressMessage = Readonly<{
  type: typeof DAEMON_STARTUP_PROGRESS_MESSAGE_TYPE;
  phase: DaemonStartupPhase;
}>;

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

let reportedSendFailure = false;

/**
 * The launcher sets this on the detached child it spawns, marking the launch whose progress the
 * channel carries. Embedded hosts, directly spawned fixtures and manual starts never set it, so
 * their reporting is a no-op even when the process happens to hold an IPC channel of its own (a
 * forked host, a test worker) — that channel is not a launch channel.
 */
export const DAEMON_PROGRESS_CHANNEL_ENV = 'AGENT_DEVICE_DAEMON_PROGRESS_CHANNEL';

/**
 * Sends one phase to the launcher over this process's own IPC channel. Without a marked launch
 * channel, or with a launcher that is already gone, this is a no-op; a failed send may write one
 * line to stderr and never affects startup. The channel is unref'd on first use so it cannot keep
 * the daemon alive.
 */
export function reportDaemonStartupPhase(phase: DaemonStartupPhase): void {
  if (process.env[DAEMON_PROGRESS_CHANNEL_ENV] !== '1') return;
  const channel = process.channel;
  if (!channel || typeof process.send !== 'function' || !process.connected) return;
  channel.unref();
  try {
    // The callback form routes a closed-channel error to it instead of throwing asynchronously,
    // which an uncaughtException handler would otherwise turn into a daemon exit.
    const message: DaemonStartupProgressMessage = {
      type: DAEMON_STARTUP_PROGRESS_MESSAGE_TYPE,
      phase,
    };
    process.send(message, (error) => {
      if (error && !reportedSendFailure) {
        reportedSendFailure = true;
        process.stderr.write(`Daemon startup phase report failed: ${error.message}\n`);
      }
    });
  } catch {
    // A synchronously refused send names the same failure; it is ignored like any other.
  }
}

/** Closes the launch channel after `registered`; the daemon serves on without it. */
export function closeDaemonStartupProgressChannel(): void {
  if (process.env[DAEMON_PROGRESS_CHANNEL_ENV] !== '1') return;
  if (!process.channel) return;
  try {
    process.disconnect();
  } catch {
    // An already-closed channel is exactly the state this names.
  }
}
