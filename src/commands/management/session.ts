import { AppError } from '../../kernel/errors.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { booleanField, enumField, stringField } from '../command-input.ts';
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
      ['list', 'state-dir', 'save-script'],
      'list shows active sessions; state-dir prints the daemon state directory; save-script publishes an armed recording without teardown.',
    ),
    path: stringField('Optional .ad output path for save-script.'),
    force: booleanField('Atomically replace an existing save-script target.'),
  },
);

const sessionCommandDefinition = defineExecutableCommand(
  sessionCommandMetadata,
  async (client, { action, path, force, ...input }) => {
    const effectiveAction = action ?? 'list';
    assertSessionActionOptions(effectiveAction, path, force);
    if (effectiveAction === 'state-dir') {
      return { stateDir: await client.sessions.stateDir(input) };
    }
    if (effectiveAction === 'save-script') {
      return await client.sessions.saveScript({ ...input, path, force });
    }
    return { sessions: await client.sessions.list(input) };
  },
);

const sessionCliSchema = {
  usageOverride: 'session list | session state-dir | session save-script [path] [--force]',
  listUsageOverride: 'session',
  helpDescription:
    'List active sessions, print the effective daemon state directory, or publish an armed open-to-destination script without closing its session',
  positionalArgs: ['list|state-dir|save-script?', 'path?'],
  allowedFlags: ['force'],
} as const satisfies CommandSchemaOverride;

const sessionCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readSessionAction(positionals[0]),
  path: positionals[1],
  force: flags.force,
});

export const sessionCommandFacet = defineCommandFacet({
  name: 'session',
  metadata: sessionCommandMetadata,
  definition: sessionCommandDefinition,
  cliSchema: sessionCliSchema,
  cliReader: sessionCliReader,
  cliOutputFormatter: managementCliOutputFormatters.session,
});

function readSessionAction(value: string | undefined): 'list' | 'state-dir' | 'save-script' {
  const action = value ?? 'list';
  if (action === 'list') return action;
  if (action === 'state-dir') return action;
  if (action === 'save-script') return action;
  throw new AppError('INVALID_ARGS', 'session only supports list, state-dir, or save-script');
}

function assertSessionActionOptions(
  action: 'list' | 'state-dir' | 'save-script',
  path: string | undefined,
  force: boolean | undefined,
): void {
  if (action === 'save-script') return;
  if (path === undefined && force !== true) return;
  throw new AppError(
    'INVALID_ARGS',
    `session ${action} does not accept a path or --force; use session save-script [path] [--force] to publish a recording.`,
  );
}
