import { defineParameterlessCommandFacet } from '../family/types.ts';

const SHAKE_COMMAND_NAME = 'shake';

const shakeCommandDescription =
  "Shake an iOS simulator or an Android emulator once. iOS posts the shake notification that Device > Shake in the Simulator app posts, which UIKit delivers to the app as a motion-shake event; it injects no accelerometer data, so an app that detects shakes through CoreMotion does not see it. Android swings the emulator's accelerometer about 2 g in alternating directions for about a second through the emulator console, then restores the reading it found, so an app that counts direction changes above a force threshold sees a shake. The shake is sent without activating the session app and nothing is re-observed afterwards, so take a snapshot to see what the app did with it. Physical devices, Android TV, remote provider devices, and every other platform refuse this command.";

export const shakeCommandFacet = defineParameterlessCommandFacet({
  name: SHAKE_COMMAND_NAME,
  effect: 'write',
  description: shakeCommandDescription,
  text: {
    summary: 'Shake an iOS simulator or Android emulator',
    searchHint: 'jiggle rattle wobble',
    cliDetail:
      'iPhone and iPad simulators and Android emulators on the daemon host only. Snapshot afterwards to see what the app did with it.',
  },
  run: (client, input) => client.command.shake(input),
});
