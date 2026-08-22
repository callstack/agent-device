import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { compactRecord } from '../command-input.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import { commonInputFromFlags, request } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { readGestureInput } from './metadata.ts';
import { gesturePayloadFromPositionals } from '@agent-device/contracts/gesture-normalization';

export const gestureCliReaders = {
  gesture: gestureInputFromCli,
} satisfies Record<string, CliReader>;

export const gestureDaemonWriters = {
  gesture: (input) => {
    const gesture = readGestureInput(input);
    return request(PUBLIC_COMMANDS.gesture, [], input, compactRecord(gesture));
  },
} satisfies Record<string, DaemonWriter>;

function gestureInputFromCli(positionals: string[], flags: CliFlags): Record<string, unknown> {
  return {
    ...commonInputFromFlags(flags),
    ...gesturePayloadFromPositionals(positionals, flags.pointerCount),
  };
}
