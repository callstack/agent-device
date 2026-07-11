import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { stringField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags, direct } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

const artifactsCommandMetadata = defineFieldCommandMetadata(
  'artifacts',
  'List daemon or cloud provider artifacts for an active or completed session.',
  {
    provider: stringField('Cloud provider name, for example browserstack or aws-device-farm.'),
    providerSessionId: stringField('Cloud provider session id or ARN.'),
  },
);

const artifactsCommandDefinition = defineExecutableCommand(
  artifactsCommandMetadata,
  (client, input) => client.sessions.artifacts(input),
);

const artifactsCliSchema = {
  summary: 'List daemon or cloud provider session artifacts',
  usageOverride: 'artifacts [provider-session-id] [--provider <name>]',
  positionalArgs: ['provider-session-id?'],
  allowedFlags: ['provider', 'providerSessionId'],
} as const satisfies CommandSchemaOverride;

const artifactsCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  provider: flags.provider,
  providerSessionId: positionals[0] ?? flags.providerSessionId,
});

const artifactsDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.artifacts);

export const artifactsCommandFacet = defineCommandFacet({
  name: 'artifacts',
  metadata: artifactsCommandMetadata,
  definition: artifactsCommandDefinition,
  cliSchema: artifactsCliSchema,
  cliReader: artifactsCliReader,
  daemonWriter: artifactsDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.artifacts,
});
