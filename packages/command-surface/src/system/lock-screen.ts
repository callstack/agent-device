import {
  LOCK_SCREEN_ACTIONS,
  LOCK_SCREEN_USAGE,
  parseLockScreenPositionals,
} from '@agent-device/contracts/device';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { commonInputFromFlags, direct, requiredDaemonString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { enumField, requiredField } from '../command-input.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const LOCK_SCREEN_COMMAND_NAME = 'lock-screen';

const lockScreenCommandDescription =
  'Lock or unlock the device screen, or read its lock state. lock shows the lock screen and leaves a locked screen alone; unlock dismisses it back to the app that was in front. Each returns once the device reports that lock state. status reports the lock state as locked or unlocked and changes nothing: Android reads the keyguard state dumpsys window reports, and iPhone and iPad simulators read the SpringBoard lock state, the same reads lock and unlock verify against. A state the device does not report is an error, never a guess. Android locks with KEYCODE_SLEEP and unlocks with KEYCODE_WAKEUP then wm dismiss-keyguard, verified by the keyguard state dumpsys window reports; a screen lock set to None is refused with lock-screen-disabled, and unlock always sends the wake event, which leaves a screen that is on unchanged. iPhone and iPad simulators lock through the XCUITest lock button, verified by the SpringBoard lock state and a lock screen surface, and unlock with a swipe up from the bottom edge after the lock button wakes a dark screen; unlock also needs the screen on. A PIN, pattern, password, or passcode lock is never unlocked: unlock refuses with reason lock-screen-secure and types nothing. The session app is not activated, so verify with screenshot; an app-scoped command such as snapshot can bring the app back to the front on iOS. Every other target refuses this command, including physical iPhones and iPads and Android TV.';

const lockScreenCommandMetadata = defineFieldCommandMetadata(
  LOCK_SCREEN_COMMAND_NAME,
  lockScreenCommandDescription,
  {
    action: requiredField(
      enumField(
        LOCK_SCREEN_ACTIONS,
        'lock shows the lock screen; unlock dismisses a lock screen that asks for no credential; status reads the lock state and changes nothing.',
      ),
    ),
  },
);

const lockScreenCliSchema = {
  usageOverride: `lock-screen ${LOCK_SCREEN_USAGE}`,
  positionalArgs: ['action'],
} as const satisfies CommandSchemaOverride;

export const lockScreenCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  // One shared helper answers arity and parse for the CLI reader and the daemon resolver alike.
  action: parseLockScreenPositionals(positionals),
});

export const lockScreenDaemonWriter: DaemonWriter = direct(LOCK_SCREEN_COMMAND_NAME, (input) => [
  requiredDaemonString(input.action, 'lock-screen requires action'),
]);

export const lockScreenCommandFacet = defineCommandFacet({
  name: LOCK_SCREEN_COMMAND_NAME,
  effect: 'write',
  text: {
    summary: 'Lock, unlock, or read the lock state of the device screen',
    searchHint: 'lockscreen screenlock islocked',
    cliDetail:
      'Android phones and tablets, and iPhone and iPad simulators. unlock never enters a PIN, pattern, password, or passcode; it refuses such a lock. status reports locked or unlocked and sends nothing.',
  },
  metadata: lockScreenCommandMetadata,
  run: (client, input) => client.command.lockScreen(input),
  cliSchema: lockScreenCliSchema,
  cliReader: lockScreenCliReader,
  daemonWriter: lockScreenDaemonWriter,
});
