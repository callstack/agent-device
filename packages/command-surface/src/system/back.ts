import { type BackMode, BACK_MODES } from '@agent-device/contracts/back-mode';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { commonInputFromFlags, request } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { enumField } from '../command-input.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import {
  postActionObservationCliFlags,
  postActionObservationFields,
} from '../post-action-observation-grammar.ts';

const BACK_COMMAND_NAME = 'back';

const backCommandDescription =
  "Navigate back in the app or through system navigation. The in-app mode targets the app navigation stack; system targets platform back behavior. iOS has no system back: both modes only pop the navigation stack and never close a modal or sheet, whose own Close or Cancel control does; Android's system back also closes dialogs and modal screens. On iOS, back presses the navigation bar system back button (identifier BackButton) only when exactly one hittable one is found in a readable accessibility tree, and succeeds only when the bar count, the back button count, or a back button title then changes; a back button with no title, such as the iPhone Duo's floating one, is confirmed by its bar's title instead, which must hold still before the tap, and a bar that retitles itself can be misread as a pop. Otherwise it swipes from the left edge (on an iPad whose app window cannot be resolved, only while the app fills the screen) and succeeds only when the app screen changes. Reason back_swipe_no_change: the swipe was sent and the screen did not change; details.dismissControls then lists the top-band Back, Close, Cancel, or xmark buttons (never Done or Save) as { selector, label, identifier? }, and the hint names a lone one. Press one by its selector; back returns no refs, because it expires them. Reason back_swipe_unverified: the button was pressed but the bar state did not change after the tap, or the swipe may or may not have navigated because the screen kept changing before it or could not be sampled after it. Reason back_swipe_not_dispatched, or a screen that cannot be sampled before the swipe, means nothing was sent. An app with a left-edge drawer may open the drawer instead.";

const backCommandMetadata = defineFieldCommandMetadata(BACK_COMMAND_NAME, backCommandDescription, {
  mode: enumField(BACK_MODES),
  ...postActionObservationFields(BACK_COMMAND_NAME),
});

const backCliSchema = {
  usageOverride: 'back [--in-app|--system] [--settle]',
  usageFlags: [],
  allowedFlags: ['backMode', ...postActionObservationCliFlags(BACK_COMMAND_NAME)],
} as const satisfies CommandSchemaOverride;

export const backCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  mode: flags.backMode,
});

export const backDaemonWriter: DaemonWriter = (input) =>
  request(BACK_COMMAND_NAME, [], {
    ...input,
    backMode: readBackMode(input.mode),
  });

export const backCommandFacet = defineCommandFacet({
  name: BACK_COMMAND_NAME,
  effect: 'write',
  text: {
    summary: 'Navigate back in the app or system',
    searchHint: 'previous return dismiss',
  },
  metadata: backCommandMetadata,
  run: (client, input) => client.command.back(input),
  cliSchema: backCliSchema,
  cliReader: backCliReader,
  daemonWriter: backDaemonWriter,
});

function readBackMode(value: unknown): BackMode | undefined {
  return value === 'in-app' || value === 'system' ? value : undefined;
}
