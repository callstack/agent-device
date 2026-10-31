// The published Node client surface.
//
// The VOCABULARY it is stated in terms of — connection config, the device/session views, and every
// per-command Options/Result shape — lives in the contracts/client-*.ts family files, one file per
// command/domain family. Both this module and the command layer are stated in terms of that
// vocabulary, so a shape both surfaces need sits below both.
//
// The `AgentDeviceClient` facade and `AgentDeviceCommandClient` are declared ONCE, in
// `@agent-device/command-surface`: the command definitions invoke that port, and the published SDK
// re-exports exactly those two names here (ADR 0008).
//
// The published surface is assembled in `src/sdk/index.ts`, which re-exports this module, so no
// name became unreachable from the package entrypoint. The factory lives in `@agent-device/client`.

export type { AgentDeviceClient, AgentDeviceCommandClient } from '@agent-device/command-surface';

// The relocated vocabulary keeps its published import path through this module — a wildcard per
// family rather than 84 named re-exports, so no name is published twice under two spellings.
export type * from '@agent-device/contracts/client';

// The Metro command vocabulary answers its question in the contracts/metro.ts domain file; named
// rather than wildcarded so the daemon-side Metro shapes there stay out of the published surface.
export type {
  MetroPrepareOptions,
  MetroPrepareResult,
  MetroReloadOptions,
  MetroReloadResult,
} from '@agent-device/contracts/remote';

// Contracts/kernel types re-exported into the PUBLISHED surface: `agent-device-client.ts` picks
// these up via `export type *`, and that is their only job — every internal consumer imports
// them from the declaring module instead. Deleting one would remove a name from the package's
// public types.
export type { TargetShutdownResult } from '@agent-device/contracts/device';
export type { MetroBridgeScope } from '@agent-device/contracts/remote';
export type { AppsFilter } from '@agent-device/contracts/device';
export type { AlertAction } from '@agent-device/contracts/alert-contract';
export type { AppleOS } from '@agent-device/kernel/device';
export type { JsonObject } from '@agent-device/contracts/client';
export type { BatchRunResult } from '@agent-device/command-registry/batch';

export type { DiffSnapshotCommandResult } from '@agent-device/contracts/capture';
export type { PrepareCommandResult, PushCommandResult } from '@agent-device/contracts/command';
export type { TriggerAppEventCommandResult } from '@agent-device/contracts/device';
export type { WaitCommandResult } from '@agent-device/contracts/wait';
export type {
  DebugSymbolsOptions,
  DebugSymbolsResult,
  DoctorCommandResult,
} from '@agent-device/contracts/observability';
export type { RecordingCommandResult, TraceCommandResult } from '@agent-device/contracts/recording';
export type { ReplayCommandResult, ReplaySuiteResult } from '@agent-device/contracts/replay';
