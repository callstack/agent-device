import { defineParameterlessCommandFacet } from '../family/types.ts';

const HOME_COMMAND_NAME = 'home';

const homeCommandDescription =
  'Send the selected device to its home screen. This leaves the app session open but moves the foreground away from the app. On watchOS, home presses the Digital Crown: from an app it shows the watch face, and from the watch face it opens the app grid.';

export const homeCommandFacet = defineParameterlessCommandFacet({
  name: HOME_COMMAND_NAME,
  effect: 'write',
  description: homeCommandDescription,
  text: {
    summary: 'Go to the device home screen',
    searchHint: 'springboard launcher',
  },
  run: (client, input) => client.command.home(input),
});
