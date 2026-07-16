import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { SNAPSHOT_FLAGS } from '../cli-grammar/flag-groups.ts';
import { booleanField, integerField, stringField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  commonInputFromFlags,
  direct,
  recordControlInputFromFlags,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { captureCliOutputFormatters } from './output.ts';

const SNAPSHOT_COMMAND_NAME = 'snapshot';

const snapshotCommandDescription = 'Capture an accessibility snapshot.';

const snapshotCommandMetadata = defineFieldCommandMetadata(
  SNAPSHOT_COMMAND_NAME,
  snapshotCommandDescription,
  {
    interactiveOnly: booleanField(),
    depth: integerField(),
    scope: stringField(),
    raw: booleanField(),
    forceFull: booleanField(),
    timeoutMs: integerField('Maximum wall-clock time for the snapshot command.'),
  },
);

const snapshotCommandDefinition = defineExecutableCommand(
  snapshotCommandMetadata,
  (client, input) => client.capture.snapshot(input),
);

const snapshotCliSchema = {
  usageOverride:
    'snapshot [--diff] [-i] [-d <depth>] [-s <scope>] [--raw] [--force-full] [--timeout <ms>]',
  helpDescription:
    'Capture accessibility tree or diff against the previous session baseline. For iOS raw-coordinate fallback after a no-op ref press, inspect rects with snapshot -i --json, press the rect center, then verify with diff snapshot -i or snapshot --diff.',
  summary: 'Capture accessibility tree or diff against the previous session baseline',
  allowedFlags: ['snapshotDiff', ...SNAPSHOT_FLAGS, 'snapshotForceFull', 'timeoutMs'],
} as const;

export const snapshotCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...recordControlInputFromFlags(flags),
  interactiveOnly: flags.snapshotInteractiveOnly,
  depth: flags.snapshotDepth,
  scope: flags.snapshotScope,
  raw: flags.snapshotRaw,
  forceFull: flags.snapshotForceFull,
  timeoutMs: flags.timeoutMs,
});

const snapshotDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.snapshot);

export const snapshotCommandFacet = defineCommandFacet({
  name: SNAPSHOT_COMMAND_NAME,
  metadata: snapshotCommandMetadata,
  definition: snapshotCommandDefinition,
  cliSchema: snapshotCliSchema,
  cliReader: snapshotCliReader,
  daemonWriter: snapshotDaemonWriter,
  cliOutputFormatter: captureCliOutputFormatters.snapshot,
});
