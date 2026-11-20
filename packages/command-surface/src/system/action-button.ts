import { defineParameterlessCommandFacet } from '../family/types.ts';

const ACTION_BUTTON_COMMAND_NAME = 'action-button';

const actionButtonCommandDescription =
  'Press the iPhone, iPad, or Apple Watch Ultra Action Button once. The press is dispatched without activating the session app and nothing is re-observed afterwards, so the app keeps the state the press found. What the system does with the press is not observed by this command: Simulators run no Shortcuts or App Intents, so delivery to an assigned Shortcut is verifiable only on a physical iPhone. A model with no Action Button refuses with UNSUPPORTED_OPERATION, error.details.reason hardware_control_unavailable and dispatched: no.';

export const actionButtonCommandFacet = defineParameterlessCommandFacet({
  name: ACTION_BUTTON_COMMAND_NAME,
  effect: 'destructive',
  description: actionButtonCommandDescription,
  text: {
    summary: 'Press the iPhone, iPad, or Apple Watch Ultra Action Button',
    searchHint: 'side switch',
    cliDetail:
      'iPhone, iPad, and Apple Watch Ultra simulators. The runner asks the device for the button and reports unsupported when that model has none.',
  },
  run: (client, input) => client.command.actionButton(input),
});
