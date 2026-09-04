import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type { CaptureScreenshotOptions } from '@agent-device/contracts/client';
import { SESSION_SURFACES } from '@agent-device/contracts/session';
import {
  RETIRED_SCREENSHOT_MAX_SIZE,
  SCREENSHOT_COMMAND_FLAG_KEYS,
  SCREENSHOT_SCALE_LIMITS,
  screenshotFlagsFromPublicOptions,
  screenshotOptionsFromFlags,
  validateNoRetiredScreenshotMaxSize,
  validateScreenshotScale,
} from '@agent-device/contracts/capture';
import {
  booleanField,
  enumField,
  integerField,
  numberField,
  retiredField,
  stringField,
} from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { commonInputFromFlags, optionalString, request } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';

const SCREENSHOT_COMMAND_NAME = 'screenshot';

const screenshotCommandDescription =
  'Capture a screenshot of the active app or web session. Choose the capture scope, density, size, or annotations through the corresponding input fields when needed.';

const screenshotCommandMetadata = defineFieldCommandMetadata(
  SCREENSHOT_COMMAND_NAME,
  screenshotCommandDescription,
  {
    path: stringField('Output path.'),
    cropOn: stringField(
      'Selector expression; the capture is cropped to the frame the selector resolves on the same screen.',
    ),
    overlayRefs: booleanField(),
    pixelDensity: integerField('Output screenshot pixel density in pixels per logical point.', {
      min: 1,
    }),
    fullscreen: booleanField(),
    scale: numberField('Screenshot scale factor.', SCREENSHOT_SCALE_LIMITS),
    maxSize: retiredField(RETIRED_SCREENSHOT_MAX_SIZE.migration.screenshot),
    stabilize: booleanField(),
    normalizeStatusBar: booleanField(),
    surface: enumField(SESSION_SURFACES),
  },
);

const screenshotCommandDefinition = defineExecutableCommand(
  screenshotCommandMetadata,
  (client, input) => client.capture.screenshot(input),
);

const screenshotCliSchema = {
  positionalArgs: ['path?'],
  allowedFlags: SCREENSHOT_COMMAND_FLAG_KEYS,
} as const;

export const screenshotCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  path: positionals[0] ?? flags.out,
  ...screenshotOptionsFromFlags(flags),
});

export const screenshotDaemonWriter: DaemonWriter = (input) => {
  validateNoRetiredScreenshotMaxSize('screenshot', input);
  validateScreenshotScale(input as CaptureScreenshotOptions);
  return request(PUBLIC_COMMANDS.screenshot, optionalString(input.path), {
    ...input,
    ...screenshotFlagsFromPublicOptions(input as CaptureScreenshotOptions),
  });
};

export const screenshotCommandFacet = defineCommandFacet({
  name: SCREENSHOT_COMMAND_NAME,
  text: {
    summary: 'Capture a screenshot',
    cliDetail:
      'Web defaults to the viewport; use --fullscreen, --full, or -f for the entire page. iOS simulators default to 1x logical-point output; use --pixel-density to request a different screenshot density. macOS app sessions default to the app window; use --fullscreen for full desktop, --scale to downscale, --crop-on <selector> to crop the capture to the frame the selector resolves on the same screen (currently iOS simulators and Android emulators), --overlay-refs to annotate current refs, --normalize-status-bar for deterministic iOS simulator chrome, or --no-stabilize for low-latency Android capture loops.',
  },
  metadata: screenshotCommandMetadata,
  definition: screenshotCommandDefinition,
  cliSchema: screenshotCliSchema,
  cliReader: screenshotCliReader,
  daemonWriter: screenshotDaemonWriter,
});
