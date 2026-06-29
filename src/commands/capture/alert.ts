import { ALERT_ACTIONS, type AlertAction } from '../../alert-contract.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { AlertCommandOptions } from '../../client-types.ts';
import { compactRecord, enumField, integerField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  commonInputFromFlags,
  direct,
  optionalNumber,
  readFiniteNumber,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { messageOutput } from '../output-common.ts';
import { AppError } from '../../kernel/errors.ts';

const ALERT_COMMAND_NAME = 'alert';

const alertCommandDescription = 'Inspect or handle platform alerts.';

const alertCommandMetadata = defineFieldCommandMetadata(
  ALERT_COMMAND_NAME,
  alertCommandDescription,
  {
    action: enumField(ALERT_ACTIONS),
    timeoutMs: integerField(),
  },
);

const alertCommandDefinition = defineExecutableCommand(alertCommandMetadata, (client, input) =>
  client.command.alert(input),
);

const alertCliSchema = {
  usageOverride: 'alert [get|accept|dismiss|wait] [timeout]',
  positionalArgs: ['action?', 'timeout?'],
} as const;

export const alertCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readAlertInput(positionals),
});

export const alertDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.alert, (input) =>
  alertPositionals(input as AlertCommandOptions),
);

export const alertCommandFacet = defineCommandFacet({
  name: ALERT_COMMAND_NAME,
  metadata: alertCommandMetadata,
  definition: alertCommandDefinition,
  cliSchema: alertCliSchema,
  cliReader: alertCliReader,
  daemonWriter: alertDaemonWriter,
  cliOutputFormatter: messageOutput,
});

function alertPositionals(input: AlertCommandOptions): string[] {
  return [input.action ?? 'get', ...optionalNumber(input.timeoutMs)];
}

function readAlertInput(positionals: string[]): Record<string, unknown> {
  if (positionals.length > 2) {
    throw new AppError('INVALID_ARGS', 'alert accepts at most action and timeout arguments.');
  }
  const action = readAlertAction(positionals[0]);
  const timeoutMs = readFiniteNumber(positionals[1], 'alert timeout');
  return compactRecord({ action, timeoutMs });
}

function readAlertAction(value: string | undefined): AlertAction | undefined {
  const action = value?.toLowerCase();
  if (
    action === undefined ||
    action === 'get' ||
    action === 'accept' ||
    action === 'dismiss' ||
    action === 'wait'
  ) {
    return action;
  }
  throw new AppError('INVALID_ARGS', 'alert action must be get, accept, dismiss, or wait.');
}
