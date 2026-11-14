import {
  ALERT_ACTIONS,
  parseAlertAction,
  type AlertAction,
} from '@agent-device/contracts/alert-contract';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { AlertCommandOptions } from '@agent-device/contracts/client';
import { enumField, integerField } from '../command-input.ts';
import { compactRecord } from '../input-readers.ts';
import {
  commonInputFromFlags,
  direct,
  optionalNumber,
  readFiniteNumber,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { AppError } from '@agent-device/kernel/errors';

const ALERT_COMMAND_NAME = 'alert';

const alertCommandDescription =
  "Inspect, wait for, accept, or dismiss a platform alert. The get action reads alert content; accept and dismiss change the active alert state. Each iOS XCTest execution activates once, then only observes. Apple XCTest and Limrun iOS choose recognized English labels by preference (Allow While Using App before Allow Once); on iOS simulators, including Limrun, the runner also recognizes the device's preferred languages' wording of those labels from the OS permission-prompt strings, on any alert; equal-ranked choices and unknown labels refuse, including a lone unknown button. Open, Done, and Confirm… accept; Keep Browsing, Deny, and Skip dismiss. On the Apple XCUITest runner, dismiss taps only a recognized decline label (Cancel, Don't Allow, Ask App Not to Track, and similar) or the close element of a popover whose accessibility marker reads exactly \"dismiss popup\"; when no button fits the action, accept and dismiss answer ALERT_BUTTON_NOT_FOUND having tapped nothing. The get action exposes labels for explicit button targeting. On the Apple XCUITest runner, get takes the timeout argument as the runner's budget (10 s by default, at least 1.5 s, at most 25 s). A get the runner's watchdog (the same budget) cuts off answers runner_main_thread_timeout with dispatched: unknown, which does not mean no alert; the next get waits out RUNNER_BUSY while abandoned work drains, and still answers RUNNER_BUSY (dispatched: no) if that outlasts the bounded resends. A get result with status none reports no alert. An alert-not-found refusal means no alert was found and no button was pressed. An alert-wait-timeout means no actionable alert resolved within the wait window. A refusal with dispatched: no means no button was activated. After a press, an unconfirmed outcome leaves the resulting alert state unknown.";

const alertCommandMetadata = defineFieldCommandMetadata(
  ALERT_COMMAND_NAME,
  alertCommandDescription,
  {
    action: enumField(ALERT_ACTIONS),
    timeoutMs: integerField(),
  },
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
  effect: 'destructive',
  text: {
    summary: 'Inspect, accept, or dismiss a platform alert',
    searchHint: 'dialog system',
  },
  metadata: alertCommandMetadata,
  run: (client, input) => client.command.alert(input),
  cliSchema: alertCliSchema,
  cliReader: alertCliReader,
  daemonWriter: alertDaemonWriter,
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
  if (value === undefined) return undefined;
  const action = parseAlertAction(value);
  if (action) return action;
  throw new AppError('INVALID_ARGS', 'alert action must be get, accept, dismiss, or wait.');
}
