import type { FileOutputRef } from '../io.ts';
import type { AgentDeviceRuntime, CommandContext } from '../runtime-contract.ts';
import type { SessionSurface } from '../contracts/session-surface.ts';

export type CommandResult = Record<string, unknown>;

export type RuntimeCommand<TOptions = Record<string, unknown>, TResult = CommandResult> = (
  runtime: AgentDeviceRuntime,
  options: TOptions,
) => Promise<TResult>;

export type BoundRuntimeCommand<TOptions = Record<string, unknown>, TResult = CommandResult> = (
  options: TOptions,
) => Promise<TResult>;

export type BoundOf<T> = {
  [K in keyof T]: T[K] extends RuntimeCommand<infer TOptions, infer TResult>
    ? undefined extends TOptions
      ? (options?: TOptions) => Promise<TResult>
      : BoundRuntimeCommand<TOptions, TResult>
    : never;
};

export function bindRuntimeCommands<T extends Record<string, RuntimeCommand<any, any>>>(
  commands: T,
  runtime: AgentDeviceRuntime,
): BoundOf<T> {
  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      (options: unknown) => command(runtime, options),
    ]),
  ) as BoundOf<T>;
}

export function toBackendResult(result: unknown): Record<string, unknown> | undefined {
  return result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
}

export type BackendResultEnvelope = {
  backendResult?: Record<string, unknown>;
  message?: string;
};

export type BackendResultVariant<T extends object> = T & BackendResultEnvelope;

export type ScreenshotCommandOptions = CommandContext & {
  out?: FileOutputRef;
  fullscreen?: boolean;
  overlayRefs?: boolean;
  pixelDensity?: number;
  maxSize?: number;
  stabilize?: boolean;
  normalizeStatusBar?: boolean;
  appId?: string;
  appBundleId?: string;
  surface?: SessionSurface;
};

export type SnapshotCommandOptions = CommandContext & {
  interactiveOnly?: boolean;
  depth?: number;
  scope?: string;
  raw?: boolean;
  forceFull?: boolean;
};

export type DiffSnapshotCommandOptions = SnapshotCommandOptions;
