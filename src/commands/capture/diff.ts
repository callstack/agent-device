import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { SNAPSHOT_FLAGS } from '@agent-device/command-registry/flag-groups';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import { AppError } from '@agent-device/kernel/errors';
import {
  booleanField,
  booleanSchema,
  constSchema,
  enumSchema,
  integerField,
  jsonSchemaField,
  numberSchema,
  objectSchema,
  requiredField,
  stringArraySchema,
  stringField,
  stringSchema,
} from '../command-input.ts';
import { commonInputFromFlags, direct, requiredDaemonString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import type { JsonSchema } from '../command-contract.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const DIFF_COMMAND_NAME = 'diff';

/**
 * This family's advertised MCP `outputSchema`, keyed by daemon command name and projected into
 * the command map by `src/mcp/command-output-schemas.ts`. Non-strict like every other entry: no
 * `additionalProperties: false`, so additive response fields keep validating. `diff` does not
 * carry the post-action observation trait (#1652): it reports a snapshot comparison, not an
 * interaction, so no settle-graft copy applies here.
 */
export const DIFF_COMMAND_OUTPUT_SCHEMAS = {
  // packages/contracts/src/diff.ts — the public Node command accepts snapshot diffs.
  diff: objectSchema(
    {
      mode: constSchema('snapshot'),
      baselineInitialized: booleanSchema(),
      summary: objectSchema(
        {
          additions: numberSchema(),
          removals: numberSchema(),
          unchanged: numberSchema(),
        },
        ['additions', 'removals', 'unchanged'],
      ),
      lines: {
        type: 'array',
        items: objectSchema(
          {
            kind: enumSchema(['added', 'removed', 'unchanged']),
            text: stringSchema(),
            ref: stringSchema(),
          },
          ['kind', 'text'],
        ),
      },
      warnings: stringArraySchema(),
    },
    ['mode', 'baselineInitialized', 'summary', 'lines'],
  ),
} satisfies Pick<Record<keyof CommandResultMap, JsonSchema>, 'diff'>;

const diffCommandDescription =
  'Compare accessibility snapshots or screenshots to identify UI changes. Use snapshot comparisons for semantic tree changes and screenshot comparisons for pixel differences.';

const diffCommandMetadata = defineFieldCommandMetadata(DIFF_COMMAND_NAME, diffCommandDescription, {
  kind: requiredField(jsonSchemaField<'snapshot'>({ type: 'string', const: 'snapshot' })),
  out: stringField(),
  interactiveOnly: booleanField(),
  depth: integerField(),
  scope: stringField(),
  raw: booleanField(),
});

const diffCliSchema = {
  usageOverride:
    'diff snapshot | diff screenshot --baseline <path> [current.png] [--out <diff.png>] [--threshold <0-1>] [--overlay-refs]',
  usageFlags: [],
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
  text: {
    summary: 'Diff snapshot or screenshot',
    cliDetail:
      'Screenshot --threshold is a per-pixel RGB tolerance: 0 requires exact colors and 1 ignores color differences; image dimensions must still match. Both screenshot inputs are decoded from their bytes, so a baseline or current image may be PNG or JPEG, and the diff image is always PNG. JPEG is lossy, so keep --threshold above 0 whenever either input is JPEG. Live iOS simulator screenshot diffs normalize status-bar chrome by default; use screenshot --normalize-status-bar when capturing reusable baselines.',
  },
  metadata: diffCommandMetadata,
  run: (client, input) => client.capture.diff(input),
  cliSchema: diffCliSchema,
  cliReader: diffCliReader,
  daemonWriter: diffDaemonWriter,
});
