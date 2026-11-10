import type { BoundOf, RuntimeCommand } from '../../runtime-types.ts';
import {
  contactSheetCommand,
  type RecordingContactSheetCommandOptions,
  type RecordingContactSheetCommandResult,
} from './contact-sheet.ts';

export type RecordingCommands = {
  contactSheet: RuntimeCommand<
    RecordingContactSheetCommandOptions,
    RecordingContactSheetCommandResult
  >;
};

export type BoundRecordingCommands = BoundOf<RecordingCommands>;

export const recordingCommands: RecordingCommands = {
  contactSheet: contactSheetCommand,
};
