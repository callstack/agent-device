import { actionButtonCommandFacet } from './action-button.ts';
import { appStateCommandFacet } from './appstate.ts';
import { appSwitcherCommandFacet } from './app-switcher.ts';
import { backCommandFacet } from './back.ts';
import { clipboardCommandFacet } from './clipboard.ts';
import { foldCommandFacet } from './fold.ts';
import { hardwareButtonCommandFacet } from './hardware-button.ts';
import { homeCommandFacet } from './home.ts';
import { keyboardCommandFacet } from './keyboard.ts';
import { orientationCommandFacet } from './orientation.ts';
import { shakeCommandFacet } from './shake.ts';
import { telephonyCommandFacet } from './telephony.ts';
import { tvRemoteCommandFacet } from './tv-remote.ts';
import { defineCommandFamilyFromFacets } from '../family/types.ts';

// One file per command owns its schema, description, metadata, CLI grammar, daemon writer and
// private input readers, and exports the reader and writer its own facet consumes. This module
// composes the family and projects the family's advertised output schemas.
export { SYSTEM_COMMAND_OUTPUT_SCHEMAS } from './output-schemas.ts';

export const systemCommandFamily = defineCommandFamilyFromFacets({
  name: 'system',
  commands: [
    appStateCommandFacet,
    backCommandFacet,
    homeCommandFacet,
    orientationCommandFacet,
    foldCommandFacet,
    appSwitcherCommandFacet,
    actionButtonCommandFacet,
    shakeCommandFacet,
    keyboardCommandFacet,
    clipboardCommandFacet,
    tvRemoteCommandFacet,
    hardwareButtonCommandFacet,
    telephonyCommandFacet,
  ],
});
