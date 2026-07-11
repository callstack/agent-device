import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { SNAPSHOT_FLAGS } from '../cli-grammar/flag-groups.ts';
import { AppError } from '../../kernel/errors.ts';
import {
  booleanField,
  integerField,
  jsonSchemaField,
  requiredField,
  stringField,
} from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags, direct, requiredDaemonString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const DIFF_COMMAND_NAME = 'diff';

const diffCommandDescription = 'Diff accessibility snapshots.';

const diffCommandMetadata = defineFieldCommandMetadata(DIFF_COMMAND_NAME, diffCommandDescription, {
  kind: requiredField(jsonSchemaField<'snapshot'>({ type: 'string', const: 'snapshot' })),
  out: stringField(),
  interactiveOnly: booleanField(),
  depth: integerField(),
  scope: stringField(),
  raw: booleanField(),
});

const diffCommandDefinition = defineExecutableCommand(diffCommandMetadata, (client, input) =>
  client.capture.diff(input),
);

const diffCliSchema = {
  usageOverride:
    'diff snapshot | diff screenshot --baseline <path> [current.png] [--out <diff.png>] [--threshold <0-1>] [--overlay-refs]',
  helpDescription:
    'Diff accessibility snapshot or compare screenshots pixel-by-pixel. Live iOS simulator screenshot diffs normalize status-bar chrome by default; use screenshot --normalize-status-bar when capturing reusable baselines.',
  summary: 'Diff snapshot or screenshot',
  positionalArgs: ['kind', 'current?'],
  allowedFlags: [...SNAPSHOT_FLAGS, 'baseline', 'threshold', 'out', 'overlayRefs'],
} as const;

export const diffCliReader: CliReader = (positionals, flags) => {
  if (positionals[0] !== 'snapshot') {
    throw new AppError('INVALID_ARGS', 'Only diff snapshot is available through this parser.');
  }
  return {
    ...commonInputFromFlags(flags),
    kind: 'snapshot',
    out: flags.out,
    interactiveOnly: flags.snapshotInteractiveOnly,
    depth: flags.snapshotDepth,
    scope: flags.snapshotScope,
    raw: flags.snapshotRaw,
  };
};

const diffDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.diff, (input) => [
  requiredDaemonString(input.kind, 'diff requires kind'),
]);

export const diffCommandFacet = defineCommandFacet({
  name: DIFF_COMMAND_NAME,
  metadata: diffCommandMetadata,
  definition: diffCommandDefinition,
  cliSchema: diffCliSchema,
  cliReader: diffCliReader,
  daemonWriter: diffDaemonWriter,
});
