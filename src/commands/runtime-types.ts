import type { FileOutputRef } from '../io.ts';
import type { AgentDeviceRuntime, CommandContext } from '../runtime-contract.ts';
import type { SessionSurface } from '../core/session-surface.ts';

export type CommandResult = Record<string, unknown>;

export type RuntimeCommand<TOptions = Record<string, unknown>, TResult = CommandResult> = (
  runtime: AgentDeviceRuntime,
  options: TOptions,
) => Promise<TResult>;

export type BoundRuntimeCommand<TOptions = Record<string, unknown>, TResult = CommandResult> = (
  options: TOptions,
) => Promise<TResult>;

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
  maxSize?: number;
  stabilize?: boolean;
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
