import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { AppCloseOptions, AppOpenOptions } from '@agent-device/contracts/client';
import { SESSION_SURFACES } from '@agent-device/contracts/session';
import type { CommandSchemaOverride } from '@agent-device/command-registry/command-schema';
import { assertResolvedAppsFilter } from './app-inventory-contract.ts';
import {
  booleanField,
  booleanSchema,
  enumField,
  integerField,
  jsonSchemaField,
  optionField,
  stringArrayField,
  stringField,
  stringSchema,
} from '../command-input.ts';
import { commonInputFromFlags, direct, optionalString } from '../cli-grammar/common.ts';
import type { CliReader, CommandInput, DaemonWriter } from '../cli-grammar/types.ts';
import { METRO_RELOAD_FLAGS } from '@agent-device/command-registry/flag-groups';
import { defineCommandFacet } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { withCommandRuntimeHints } from '../runtime-hints.ts';
import { managementCliOutputFormatters } from './output.ts';

const appsCommandMetadata = defineFieldCommandMetadata(
  'apps',
  'List the apps installed on the selected device. Include system or OEM apps only when they are needed as automation targets.',
  {
    appsFilter: enumField(
      ['user-installed', 'all'],
      'Restrict the listing to user-installed apps, or include system and OEM apps.',
    ),
  },
);

const openCommandMetadata = defineFieldCommandMetadata(
  'open',
  'Boot the selected device when needed, then open an app, deep link, or URL in a session. Use the app or URL inputs to choose what becomes the foreground automation target.',
  {
    app: stringField('App name, bundle id, package, or URL.'),
    url: stringField('Optional URL passed with an app shell.'),
    surface: enumField(
      SESSION_SURFACES,
      'macOS presentation surface to open: the app itself, the frontmost app, the desktop, or the menu bar.',
    ),
    activity: stringField('Android activity name.'),
    launchConsole: stringField(
      'File path on the daemon host for the stdout and stderr of the initial app launch. iOS simulator direct app launches only; not for URL opens.',
    ),
    launchArgs: stringArrayField(
      'Launch arguments forwarded verbatim to the platform launch command.',
    ),
    relaunch: booleanField('Force relaunch.'),
    timeoutMs: integerField(
      'Startup budget in milliseconds. Bounds the Simulator boot wait, so a never-booted Simulator can finish its first-boot migration; omit for the default startup behavior.',
      { min: 1 },
    ),
    waitMs: optionField('waitMs'),
    foreground: optionField('foreground'),
    saveScript: jsonSchemaField<boolean | string>({
      oneOf: [booleanSchema(), stringSchema()],
    }),
    force: booleanField(
      'Overwrite an existing --save-script target instead of refusing (alias: --overwrite).',
    ),
    testIme: booleanField(
      'Activate the headless Android test IME for deterministic Unicode text entry (default on for emulators; opt-in on real devices).',
    ),
    noRecord: booleanField('Do not record this action.'),
    metroHost: stringField('Session-scoped Metro/debug host hint applied to the opened app.'),
    metroPort: integerField(
      'Session-scoped Metro/debug port hint applied to the opened app. On an emulator/simulator the host defaults to the loopback alias (Android 10.0.2.2, iOS 127.0.0.1) when --metro-host is omitted; physical devices still require an explicit --metro-host.',
      {
        min: 1,
        max: 65535,
      },
    ),
    bundleUrl: stringField('Session-scoped bundle URL hint applied to the opened app.'),
    launchUrl: stringField(
      'Launch URL for the opened app; does not select the server used by metro reload.',
    ),
  },
);

const closeCommandMetadata = defineFieldCommandMetadata(
  'close',
  'Close the named app, or close the active session app when app is omitted. Use shutdown only when the selected simulator or emulator should also stop. Android ADB close fails with android-app-close-timeout if the app stays foreground, or its process stays running, past its 2s check window.',
  {
    app: stringField('Optional app to close.'),
    shutdown: booleanField('Shutdown the session/device where supported.'),
    saveScript: jsonSchemaField<boolean | string>({
      oneOf: [booleanSchema(), stringSchema()],
    }),
    force: booleanField(
      'Overwrite an existing --save-script target instead of refusing (alias: --overwrite).',
    ),
  },
);

// The flat metro hint flags fold into the `runtime` object open already accepts.
function toAppOpenOptions(
  input: AppOpenOptions & {
    metroHost?: string;
    metroPort?: number;
    bundleUrl?: string;
    launchUrl?: string;
  },
): AppOpenOptions {
  return withCommandRuntimeHints(input);
}

const appsCliSchema = {
  allowedFlags: ['appsFilter'],
} as const satisfies CommandSchemaOverride;

const openCliSchema = {
  positionalArgs: ['appOrUrl?', 'url?'],
  allowedFlags: [
    'activity',
    'launchConsole',
    'launchArgs',
    'testIme',
    'saveScript',
    'force',
    'noRecord',
    'relaunch',
    'foreground',
    'timeoutMs',
    'waitMs',
    'surface',
    ...METRO_RELOAD_FLAGS,
    'launchUrl',
  ],
} as const satisfies CommandSchemaOverride;

const closeCliSchema = {
  positionalArgs: ['app?'],
  allowedFlags: ['saveScript', 'force', 'shutdown'],
} as const satisfies CommandSchemaOverride;

const appsCliReader: CliReader = (_positionals, flags) => ({
  ...commonInputFromFlags(flags),
  appsFilter: assertResolvedAppsFilter(flags.appsFilter),
});

const openCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  app: positionals[0],
  url: positionals[1],
  surface: flags.surface,
  activity: flags.activity,
  launchConsole: flags.launchConsole,
  launchArgs: flags.launchArgs,
  relaunch: flags.relaunch,
  foreground: flags.foreground,
  timeoutMs: flags.timeoutMs,
  waitMs: flags.waitMs,
  saveScript: flags.saveScript,
  force: flags.force,
  testIme: flags.testIme,
  noRecord: flags.noRecord,
  metroHost: flags.metroHost,
  metroPort: flags.metroPort,
  bundleUrl: flags.bundleUrl,
  launchUrl: flags.launchUrl,
});

const closeCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  app: positionals[0],
  shutdown: flags.shutdown,
  saveScript: flags.saveScript,
  force: flags.force,
});

const appsDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.apps);
const openDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.open, openPositionals);
const closeDaemonWriter: DaemonWriter = direct(PUBLIC_COMMANDS.close, (input) =>
  optionalString(input.app),
);

export const appsCommandFacet = defineCommandFacet({
  name: 'apps',
  text: {
    summary: 'List installed apps or deferred provider app assets',
    cliDetail:
      'Before provider allocation, lists uploaded app assets when the selected provider exposes a catalog. On a live device, defaults to user-installed apps; use --all to include system/OEM apps.',
  },
  metadata: appsCommandMetadata,
  run: (client, input) => client.apps.list(input),
  cliSchema: appsCliSchema,
  cliReader: appsCliReader,
  daemonWriter: appsDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.apps,
});

export const openCommandFacet = defineCommandFacet({
  name: 'open',
  text: {
    summary: 'Open an app, deep link or URL, save replays',
    cliDetail:
      'Use --platform to bind URL/deep-link opens to the target platform. For iOS simulator initial stdout/stderr, put --launch-console <path> on this open command, for example agent-device open "Agent Device Tester" --platform ios --launch-console artifacts/launch-console.log. Expo Go/dev-client shells accept host + URL, for example agent-device open "Expo Go" exp://127.0.0.1:8081 --platform ios. macOS also supports --surface app|frontmost-app|desktop|menubar. --metro-host/--metro-port/--bundle-url choose the app\'s Metro server and save that address for later metro reload calls in the same session. A fresh open without Metro hints clears an older same-name binding; close also clears it. --launch-url supplies the app\'s launch URL; it does not select the reload server. On an iOS simulator without --launch-url, open connects a detected Expo development client through its expo-development-client URL. The app must declare a single exp+<slug> scheme that no other installed app owns. If detection is inconclusive, the app opens normally. Bare React Native apps receive their server settings before launch. On an iOS simulator, when --launch-url raises an "Open in <App>?" prompt that keeps open from seeing the app, open accepts it if the URL scheme belongs to the session app (data.launchConfirmation: "accepted"); if the scheme belongs to another installed app, the prompt stays on screen and open fails with details.reason launch_confirmation_foreign_app; if the scheme owner cannot be resolved because no single installed app owns it or the lookup failed, the prompt stays on screen and open returns with data.launchConfirmation: "unanswered", launchConfirmationReason url-owner-unresolved, and a warning; a prompt that is seen but not recognized is reported the same way with launchConfirmationReason alert-unrecognized and its own warning; in both cases inspect the warning and answer with alert get then alert accept; when agent-device cannot read whether a prompt is up at all (the alert read, the accept, or the runner itself failed, including after a re-hand of the URL), open stays green, reports no launchConfirmation plus data.launchConfirmationProbeFailure naming the failed step (alert-read, alert-accept, or runner), and appends a warning that says to check with alert get. The prompt is read whenever open cannot see the app afterwards, including on a slow host where the app\'s target discovery fails on its own deadline. When an accept leaves the app provably not running, open hands the same URL over once more and reads again; still not running, it fails with details.reason launch_confirmation_unanswered. A recognized prompt still visible after a failed accept also fails with this reason, even if the app is running behind it; answer it with alert accept or alert dismiss. A simulator openurl that CoreSimulator never answers fails within 20s with details.reason ios-simulator-openurl-timeout. Only the English prompt title with Cancel and Open buttons is recognized, so on a Simulator set to another language the prompt stays on screen. A prompt that appears after open has already seen the app is not answered; use alert accept. A device another session is holding refuses at once; add --wait <ms> to block up to that budget for it and only then fail with DEVICE_IN_USE naming the owning session.',
    mcpDetail:
      "metroHost, metroPort, and bundleUrl choose the app's Metro server and save its address for later reloads. launchUrl selects the app's launch URL and does not select the reload server. A fresh open without Metro hints clears an older same-name binding; close also clears it.",
  },
  metadata: openCommandMetadata,
  run: (client, input) => client.apps.open(toAppOpenOptions(input)),
  cliSchema: openCliSchema,
  cliReader: openCliReader,
  daemonWriter: openDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.open,
});

export const closeCommandFacet = defineCommandFacet({
  name: 'close',
  text: {
    summary: 'Close an app or end the session',
  },
  metadata: closeCommandMetadata,
  run: (client, input) =>
    input.app ? client.apps.close(input) : client.sessions.close(withoutApp(input)),
  cliSchema: closeCliSchema,
  cliReader: closeCliReader,
  daemonWriter: closeDaemonWriter,
  cliOutputFormatter: managementCliOutputFormatters.close,
});

function withoutApp(input: AppCloseOptions & { shutdown?: boolean }): {
  shutdown?: boolean;
} {
  const { app: _app, ...rest } = input;
  return rest;
}

function openPositionals(input: CommandInput): string[] {
  if (!input.app) return [];
  return input.url ? [input.app, input.url] : [input.app];
}
