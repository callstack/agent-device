import { AppError } from '../../kernel/errors.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { enumField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags } from '../cli-grammar/common.ts';
import type { CliReader } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { managementCliOutputFormatters } from './output.ts';

const sessionCommandMetadata = defineFieldCommandMetadata(
  'session',
  'List active sessions or print daemon state directory.',
  {
    action: enumField(
      ['list', 'state-dir'],
      'list shows active sessions; state-dir prints the resolved daemon state directory without contacting the daemon.',
    ),
  },
);

const sessionCommandDefinition = defineExecutableCommand(
  sessionCommandMetadata,
  async (client, { action, ...input }) =>
    action === 'state-dir'
      ? { stateDir: await client.sessions.stateDir(input) }
      : { sessions: await client.sessions.list(input) },
);

const sessionCliSchema = {
  usageOverride: 'session list | session state-dir',
  listUsageOverride: 'session',
  helpDescription: 'List active sessions or print the effective daemon state directory',
  positionalArgs: ['list|state-dir?'],
} as const satisfies CommandSchemaOverride;

const sessionCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readSessionAction(positionals[0]),
});

export const sessionCommandFacet = defineCommandFacet({
  name: 'session',
  metadata: sessionCommandMetadata,
  definition: sessionCommandDefinition,
  cliSchema: sessionCliSchema,
  cliReader: sessionCliReader,
  cliOutputFormatter: managementCliOutputFormatters.session,
});

function readSessionAction(value: string | undefined): 'list' | 'state-dir' {
  const action = value ?? 'list';
  if (action === 'list') return action;
  if (action === 'state-dir') return action;
  throw new AppError('INVALID_ARGS', 'session only supports list or state-dir');
}
