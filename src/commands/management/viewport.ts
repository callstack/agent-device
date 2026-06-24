import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { ViewportCommandOptions } from '../../client-types.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { AppError } from '../../utils/errors.ts';
import { integerField, requiredField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

const viewportCommandMetadata = defineFieldCommandMetadata(
  'viewport',
  'Resize the active web viewport.',
  {
    width: requiredField(integerField('Viewport width in CSS pixels.', { min: 1 })),
    height: requiredField(integerField('Viewport height in CSS pixels.', { min: 1 })),
  },
);

const viewportCommandDefinition = defineExecutableCommand(
  viewportCommandMetadata,
  (client, input) => client.command.viewport(input),
);

const viewportCliSchema = {
  helpDescription:
    'Resize the active web viewport before taking snapshots or screenshots. Useful for fixed-layout or 100vh apps where changing the viewport reveals different content.',
  summary: 'Resize the active web viewport for the current session',
  positionalArgs: ['width', 'height'],
} as const satisfies CommandSchemaOverride;

const viewportCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  width: readViewportDimension(positionals[0], 'width'),
  height: readViewportDimension(positionals[1], 'height'),
});

const viewportDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.viewport, (input) => {
  const { width, height } = input as ViewportCommandOptions;
  return [String(width), String(height)];
});

export const viewportCommandFacet = defineCommandFacet({
  name: 'viewport',
  metadata: viewportCommandMetadata,
  definition: viewportCommandDefinition,
  cliSchema: viewportCliSchema,
  cliReader: viewportCliReader,
  daemonWriter: viewportDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.viewport,
});

function readViewportDimension(value: string | undefined, label: 'width' | 'height'): number {
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError('INVALID_ARGS', `viewport ${label} must be a positive integer`);
  }
  return parsed;
}
