import type { BoundOf, RuntimeCommand } from '../../runtime-types.ts';
import {
  contactSheetCommand,
  type RecordingContactSheetCommandOptions,
  type RecordingContactSheetCommandResult,
} from './contact-sheet.ts';
import {
  recordCommand,
  traceCommand,
  type RecordingRecordCommandOptions,
  type RecordingRecordCommandResult,
  type RecordingTraceCommandOptions,
  type RecordingTraceCommandResult,
} from './recording.ts';

export type RecordingCommands = {
  record: RuntimeCommand<RecordingRecordCommandOptions, RecordingRecordCommandResult>;
  trace: RuntimeCommand<RecordingTraceCommandOptions, RecordingTraceCommandResult>;
  contactSheet: RuntimeCommand<
    RecordingContactSheetCommandOptions,
    RecordingContactSheetCommandResult
  >;
};

export type BoundRecordingCommands = BoundOf<RecordingCommands>;

export const recordingCommands: RecordingCommands = {
  record: recordCommand,
  trace: traceCommand,
  contactSheet: contactSheetCommand,
};
