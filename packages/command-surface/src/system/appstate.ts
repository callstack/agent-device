import { defineParameterlessCommandFacet } from '../family/types.ts';

const APPSTATE_COMMAND_NAME = 'appstate';

const appStateCommandDescription =
  'Show foreground app/activity (Android and HarmonyOS; iOS and macOS answer per session)';

export const appStateCommandFacet = defineParameterlessCommandFacet({
  name: APPSTATE_COMMAND_NAME,
  effect: 'write',
  description: appStateCommandDescription,
  text: {
    summary: 'Show the foreground app and activity',
    searchHint: 'current state',
  },
  run: (client, input) => client.command.appState(input),
});
