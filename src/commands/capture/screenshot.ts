import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { CaptureScreenshotOptions } from '../../client-types.ts';
import { SESSION_SURFACES } from '../../core/session-surface.ts';
import {
  SCREENSHOT_COMMAND_FLAG_KEYS,
  screenshotFlagsFromOptions,
  screenshotOptionsFromFlags,
} from '../../contracts/screenshot.ts';
import { booleanField, enumField, integerField, stringField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags, optionalString, request } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const SCREENSHOT_COMMAND_NAME = 'screenshot';

const screenshotCommandDescription = 'Capture a screenshot.';

const screenshotCommandMetadata = defineFieldCommandMetadata(
  SCREENSHOT_COMMAND_NAME,
  screenshotCommandDescription,
  {
    path: stringField('Output path.'),
    overlayRefs: booleanField(),
    fullscreen: booleanField(),
    maxSize: integerField(),
    stabilize: booleanField(),
    surface: enumField(SESSION_SURFACES),
  },
);

const screenshotCommandDefinition = defineExecutableCommand(
  screenshotCommandMetadata,
  (client, input) => client.capture.screenshot(input),
);

const screenshotCliSchema = {
  helpDescription:
    'Capture screenshot (macOS app sessions default to the app window; use --fullscreen for full desktop, --max-size to downscale, --overlay-refs to annotate current refs, or --no-stabilize for low-latency Android capture loops)',
  summary: 'Capture screenshot with optional desktop, downscale, or ref overlay modes',
  positionalArgs: ['path?'],
  allowedFlags: SCREENSHOT_COMMAND_FLAG_KEYS,
} as const;

export const screenshotCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  path: positionals[0] ?? flags.out,
  ...screenshotOptionsFromFlags(flags),
});

export const screenshotDaemonWriter: DaemonWriter = (input) =>
  request(PUBLIC_COMMANDS.screenshot, optionalString(input.path), {
    ...input,
    ...screenshotFlagsFromOptions(input as CaptureScreenshotOptions),
  });

export const screenshotCommandFacet = defineCommandFacet({
  name: SCREENSHOT_COMMAND_NAME,
  metadata: screenshotCommandMetadata,
  definition: screenshotCommandDefinition,
  cliSchema: screenshotCliSchema,
  cliReader: screenshotCliReader,
  daemonWriter: screenshotDaemonWriter,
});
