import type {
  DetachedCommandExit,
  DetachedCommandLaunch,
} from '@agent-device/contracts/platform-runtime-host';
import type { ExecOptions, ExecResult } from './exec.ts';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';

/**
 * The host-command funnel's own vocabulary: what a detached run reports, and the two scopes a
 * caller can wrap a spawn in. Types only: `exec.ts` re-exports the public ones, and nothing
 * imports this module at runtime, so it adds no module to any import closure. A background run's
 * shape, which names the child handle, stays in `exec.ts`.
 */
export type ExecDetachedExit = DetachedCommandExit;

/**
 * The child's side of the Node IPC channel, present only when `stdio` includes `'ipc'`. It is
 * unref'd at spawn, so neither the child handle nor the channel keeps this process alive.
 */
export type ExecDetachedChannel = Readonly<{
  /** Subscribes to the messages the child sends over its IPC channel. */
  onMessage(listener: (message: unknown) => void): void;
}>;

export type ExecDetachedProcess = DetachedCommandLaunch & {
  channel?: ExecDetachedChannel;
};

/** A command wrapper that answers for one spawn instead of running it, or declines to. */
export type CommandExecutorOverride = (
  cmd: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult> | undefined;

/** The host a command runs as, plus the request's env on top of it. */
export type CommandHostScope = Readonly<{
  host: HostEnvironment;
  requestEnv: EnvMap | undefined;
}>;
