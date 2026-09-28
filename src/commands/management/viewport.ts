import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { ViewportCommandOptions } from '@agent-device/contracts/client';
import { readViewportDimensions } from '@agent-device/contracts/capture';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import type { CommandResultMap } from '@agent-device/command-registry/command-result';
import {
  integerField,
  numberSchema,
  objectSchema,
  requiredField,
  stringSchema,
} from '../command-input.ts';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import type { JsonSchema } from '../command-contract.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

/**
 * This family's advertised MCP `outputSchema`, keyed by daemon command name and projected into
 * the command map by `src/mcp/command-output-schemas.ts`. Non-strict like every other entry: no
 * `additionalProperties: false`, so additive response fields keep validating. `viewport` does not
 * carry the post-action observation trait (#1652): it reports a viewport resize, not an
 * interaction, so no settle-graft copy applies here.
 */
export const VIEWPORT_COMMAND_OUTPUT_SCHEMAS = {
  // packages/contracts/src/viewport.ts
  viewport: objectSchema(
    { width: numberSchema(), height: numberSchema(), message: stringSchema() },
    ['width', 'height', 'message'],
  ),
} satisfies Pick<Record<keyof CommandResultMap, JsonSchema>, 'viewport'>;

const viewportCommandMetadata = defineFieldCommandMetadata(
  'viewport',
  'Resize the active web viewport before taking snapshots or screenshots. Useful for fixed-layout or 100vh apps where changing the viewport reveals different content.',
  {
    width: requiredField(integerField('Viewport width in CSS pixels.', { min: 1 })),
    height: requiredField(integerField('Viewport height in CSS pixels.', { min: 1 })),
  },
);

const viewportCliSchema = {
  positionalArgs: ['width', 'height'],
} as const satisfies CommandSchemaOverride;

const viewportCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readViewportDimensions(positionals),
});

const viewportDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.viewport, (input) => {
  const { width, height } = input as ViewportCommandOptions;
  return [String(width), String(height)];
});

export const viewportCommandFacet = defineCommandFacet({
  name: 'viewport',
  text: {
    summary: 'Resize the active web viewport for the current session',
  },
  metadata: viewportCommandMetadata,
  run: (client, input) => client.command.viewport(input),
  cliSchema: viewportCliSchema,
  cliReader: viewportCliReader,
  daemonWriter: viewportDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.viewport,
});
