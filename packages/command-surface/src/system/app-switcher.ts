import { defineParameterlessCommandFacet } from '../family/types.ts';

const APP_SWITCHER_COMMAND_NAME = 'app-switcher';

const appSwitcherCommandDescription =
  'Open the device app switcher to inspect or change foreground apps. This changes the visible system UI and may move focus away from the current app.';

export const appSwitcherCommandFacet = defineParameterlessCommandFacet({
  name: APP_SWITCHER_COMMAND_NAME,
  effect: 'write',
  description: appSwitcherCommandDescription,
  text: {
    summary: 'Open the device app switcher',
    searchHint: 'recents multitasking',
  },
  run: (client, input) => client.command.appSwitcher(input),
});
