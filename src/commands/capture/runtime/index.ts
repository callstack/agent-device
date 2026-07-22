import type {
  BoundOf,
  DiffSnapshotCommandOptions,
  RuntimeCommand,
  ScreenshotCommandOptions,
  SnapshotCommandOptions,
} from '../../runtime-types.ts';
import {
  diffScreenshotCommand,
  type DiffScreenshotCommandOptions,
  type DiffScreenshotCommandResult,
} from './diff-screenshot.ts';
import { screenshotCommand, type ScreenshotCommandResult } from './screenshot.ts';
import {
  diffSnapshotCommand,
  snapshotCommand,
  type DiffSnapshotCommandResult,
  type SnapshotCommandResult,
} from './snapshot.ts';

export type CaptureCommands = {
  screenshot: RuntimeCommand<ScreenshotCommandOptions, ScreenshotCommandResult>;
  diffScreenshot: RuntimeCommand<DiffScreenshotCommandOptions, DiffScreenshotCommandResult>;
  snapshot: RuntimeCommand<SnapshotCommandOptions, SnapshotCommandResult>;
  diffSnapshot: RuntimeCommand<DiffSnapshotCommandOptions, DiffSnapshotCommandResult>;
};

export type BoundCaptureCommands = BoundOf<CaptureCommands>;

export const captureCommands: CaptureCommands = {
  screenshot: screenshotCommand,
  diffScreenshot: diffScreenshotCommand,
  snapshot: snapshotCommand,
  diffSnapshot: diffSnapshotCommand,
};
