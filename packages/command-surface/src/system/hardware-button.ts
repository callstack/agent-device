import {
  // The hardware-button vocabulary arrives through the same eager device-vocabulary façade the
  // orientation and fold readers use (#3848, eager-closure budgets).
  HARDWARE_BUTTON_NAMES,
  HARDWARE_BUTTON_NAME_LABELS,
  HARDWARE_BUTTON_USAGE,
  parseHardwareButtonPositionals,
} from '@agent-device/contracts/device';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { commonInputFromFlags, direct, requiredDaemonString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { enumField, requiredField } from '../command-input.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const HARDWARE_BUTTON_COMMAND_NAME = 'hardware-button';

const hardwareButtonCommandDescription =
  'Press a phone hardware button once: volume-up, volume-down, power, mute, sleep, wake, media-play-pause, media-next, media-previous, media-rewind, or media-fast-forward. The press is dispatched without activating the session app and nothing is re-observed afterwards, so the OS decides what the key does — which audio stream a volume press moves, which media session a media key reaches, and whether the HUD shows, is device behavior this command does not claim. Power toggles the Android screen; sleep and wake are the explicit Android events that turn it off or on without toggling, and after a press that turns it off, later commands may hit a locked screen. Android (ADB-backed and Appium) presses all eleven on phones and tablets; a physical iPhone or iPad presses volume only through the local runner or Appium, never power, mute, sleep, wake, or media. iOS Simulators, Android TV and tvOS targets refuse this command.';

const hardwareButtonCommandMetadata = defineFieldCommandMetadata(
  HARDWARE_BUTTON_COMMAND_NAME,
  hardwareButtonCommandDescription,
  {
    button: requiredField(
      enumField(
        HARDWARE_BUTTON_NAMES,
        'One press each. volume-up and volume-down move the system volume stream the OS selects; power toggles the screen on Android; sleep and wake are the explicit Android events that turn the screen off or on without toggling; mute, media-play-pause, media-next, media-previous, media-rewind, and media-fast-forward are Android keys the OS routes to its own streams and media sessions. All of these except volume are refused on every Apple leaf.',
      ),
    ),
  },
);

const hardwareButtonCliSchema = {
  usageOverride: `hardware-button ${HARDWARE_BUTTON_USAGE}`,
  positionalArgs: ['button'],
} as const satisfies CommandSchemaOverride;

export const hardwareButtonCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readHardwareButtonInput(positionals),
});

export const hardwareButtonDaemonWriter: DaemonWriter = direct(
  HARDWARE_BUTTON_COMMAND_NAME,
  (input) => [requiredDaemonString(input.button, 'hardware-button requires button')],
);

export const hardwareButtonCommandFacet = defineCommandFacet({
  name: HARDWARE_BUTTON_COMMAND_NAME,
  effect: 'write',
  text: {
    summary: 'Press a phone hardware button once',
    searchHint: 'lock',
    cliDetail:
      'Single press; no hold. Android presses all eleven named keys on phones and tablets: volume-up, volume-down, power, mute, sleep, wake, and the five media keys. A physical iPhone or iPad presses volume only; the other keys are never supported on Apple targets. iOS Simulators, Android TV, and tvOS refuse — use tv-remote on TV targets.',
  },
  metadata: hardwareButtonCommandMetadata,
  run: (client, input) => client.command.hardwareButton(input),
  cliSchema: hardwareButtonCliSchema,
  cliReader: hardwareButtonCliReader,
  daemonWriter: hardwareButtonDaemonWriter,
});

function readHardwareButtonInput(positionals: string[]): Record<string, unknown> {
  // One shared helper answers arity and parse for the CLI reader and the daemon resolver alike.
  return { button: HARDWARE_BUTTON_NAME_LABELS[parseHardwareButtonPositionals(positionals)] };
}
