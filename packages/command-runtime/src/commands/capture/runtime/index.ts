import type {
  AuditSnapshotCommandResult,
  DiffSnapshotCommandResult,
} from '@agent-device/contracts/capture';
import { bindRuntimeCommands } from '../../runtime-types.ts';
import type {
  AuditSnapshotCommandOptions,
  BoundOf,
  DiffSnapshotCommandOptions,
  RuntimeCommand,
  ScreenshotCommandOptions,
  SnapshotCommandOptions,
} from '../../runtime-types.ts';
import type { AgentDeviceRuntime } from '@agent-device/contracts/runtime-contract';
import {
  diffScreenshotCommand,
  type DiffScreenshotCommandOptions,
  type DiffScreenshotCommandResult,
} from './diff-screenshot.ts';
import { screenshotCommand, type ScreenshotCommandResult } from './screenshot.ts';
import {
  auditSnapshotCommand,
  diffSnapshotCommand,
  snapshotCommand,
  type SnapshotCommandResult,
} from './snapshot.ts';

export type CaptureCommands = {
  screenshot: RuntimeCommand<ScreenshotCommandOptions, ScreenshotCommandResult>;
  diffScreenshot: RuntimeCommand<DiffScreenshotCommandOptions, DiffScreenshotCommandResult>;
  snapshot: RuntimeCommand<SnapshotCommandOptions, SnapshotCommandResult>;
  diffSnapshot: RuntimeCommand<DiffSnapshotCommandOptions, DiffSnapshotCommandResult>;
  auditSnapshot: RuntimeCommand<AuditSnapshotCommandOptions, AuditSnapshotCommandResult>;
};

export type BoundCaptureCommands = BoundOf<CaptureCommands>;

const captureCommands: CaptureCommands = {
  screenshot: screenshotCommand,
  diffScreenshot: diffScreenshotCommand,
  snapshot: snapshotCommand,
  diffSnapshot: diffSnapshotCommand,
  auditSnapshot: auditSnapshotCommand,
};

export function bindCaptureCommands(runtime: AgentDeviceRuntime): BoundCaptureCommands {
  return bindRuntimeCommands(captureCommands, runtime);
}
