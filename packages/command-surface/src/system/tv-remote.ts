import {
  type TvRemoteButton,
  TV_REMOTE_BUTTONS,
  TV_REMOTE_ANDROID_KEYCODE_PATTERN,
  TV_REMOTE_BUTTON_USAGE,
  parseTvRemoteButton,
  tvRemoteDurationMode,
} from '@agent-device/contracts/tv-remote';
import { AppError } from '@agent-device/kernel/errors';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import type { JsonSchema } from '../command-contract.ts';
import { customField, enumSchema, integerField, requiredField } from '../command-input.ts';
import { commonInputFromFlags, direct, requiredDaemonString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { compactRecord } from '../input-readers.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const TV_REMOTE_COMMAND_NAME = 'tv-remote';

const TV_REMOTE_LONGPRESS_PRESET_MS = 500;

export const tvRemoteButtonSchema: JsonSchema = {
  description:
    'TV remote button. Android TV also accepts android-keycode:<n> with n from 1 to 2147483647.',
  oneOf: [
    enumSchema(TV_REMOTE_BUTTONS),
    { type: 'string', pattern: TV_REMOTE_ANDROID_KEYCODE_PATTERN.source },
  ],
};

const tvRemoteCommandDescription =
  'Press or long-press a TV remote button on Android TV, tvOS, or Vega OS. Android TV also supports volume, power, media, channel, guide, captions, input, color keys, and android-keycode:N. tvOS and Vega OS support up, down, left, right, select, menu, home, and back. Phones and WebDriver sessions are unsupported. The aliases ok, center, and enter map to select.';

const tvRemoteCommandMetadata = defineFieldCommandMetadata(
  TV_REMOTE_COMMAND_NAME,
  tvRemoteCommandDescription,
  {
    button: requiredField(
      customField<TvRemoteButton>(tvRemoteButtonSchema, (record, key) =>
        parseTvRemoteButton(typeof record[key] === 'string' ? record[key] : undefined),
      ),
    ),
    durationMs: integerField(
      `Press duration in milliseconds. tvOS and Vega OS use the exact hold duration; Android TV maps any positive value to an ADB longpress (${tvRemoteDurationMode('android')}).`,
      {
        min: 0,
      },
    ),
  },
);

const tvRemoteCliSchema = {
  usageOverride: `tv-remote [press|longpress] ${TV_REMOTE_BUTTON_USAGE}`,
  listUsageOverride: 'tv-remote press|longpress <button> [--duration-ms <ms>]',
  positionalArgs: ['press|longpress?', 'button'],
  allowedFlags: ['durationMs'],
} as const satisfies CommandSchemaOverride;

export const tvRemoteCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readTvRemoteInput(positionals, flags.durationMs),
});

export const tvRemoteDaemonWriter: DaemonWriter = direct(TV_REMOTE_COMMAND_NAME, (input) => [
  requiredDaemonString(input.button, 'tv-remote requires button'),
]);

export const tvRemoteCommandFacet = defineCommandFacet({
  name: TV_REMOTE_COMMAND_NAME,
  effect: 'destructive',
  text: {
    summary: 'Press a TV remote navigation, media, or hardware button',
    searchHint: 'dpad play',
    cliDetail:
      'longpress selects the 500ms preset; --duration-ms overrides it. Android TV uses the system long-press duration.',
  },
  metadata: tvRemoteCommandMetadata,
  run: (client, input) => client.command.tvRemote(input),
  cliSchema: tvRemoteCliSchema,
  cliReader: tvRemoteCliReader,
  daemonWriter: tvRemoteDaemonWriter,
});

function readTvRemoteInput(
  positionals: string[],
  durationMs: number | undefined,
): Record<string, unknown> {
  const subcommand = positionals[0]?.toLowerCase();
  const isNamedAction = subcommand === 'press' || subcommand === 'longpress';
  const args = isNamedAction ? positionals.slice(1) : positionals;
  if (args.length !== 1) {
    throw new AppError(
      'INVALID_ARGS',
      `tv-remote requires exactly one button: ${TV_REMOTE_BUTTONS.join(', ')}, or android-keycode:<n>.`,
    );
  }
  const effectiveDurationMs =
    durationMs ?? (subcommand === 'longpress' ? TV_REMOTE_LONGPRESS_PRESET_MS : undefined);
  return compactRecord({
    button: parseTvRemoteButton(args[0]),
    durationMs: effectiveDurationMs,
  });
}
