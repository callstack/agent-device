import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import type {
  AlertCommandOptions,
  CaptureScreenshotOptions,
  WaitCommandOptions,
} from '../../client-types.ts';
import type { AlertAction } from '../../alert-contract.ts';
import { ALERT_ACTIONS } from '../../alert-contract.ts';
import { parseWaitPositionals } from '../../core/wait-positionals.ts';
import { SESSION_SURFACES } from '../../core/session-surface.ts';
import {
  SCREENSHOT_COMMAND_FLAG_KEYS,
  screenshotFlagsFromOptions,
  screenshotOptionsFromFlags,
} from '../../contracts/screenshot.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { SELECTOR_SNAPSHOT_FLAGS, SNAPSHOT_FLAGS, type CliFlags } from '../../utils/cli-flags.ts';
import { AppError } from '../../utils/errors.ts';
import { tryParseSelectorChain } from '../../utils/selectors-parse.ts';
import {
  booleanField,
  compactRecord,
  enumField,
  integerField,
  jsonSchemaField,
  optionalEnum,
  requiredField,
  stringField,
} from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { WAIT_KIND_VALUES } from './wait-command-contract.ts';
import {
  commonInputFromFlags,
  direct,
  optionalNumber,
  optionalString,
  readFiniteNumber,
  request,
  requiredDaemonString,
  selectionOptionsFromFlags,
  selectorSnapshotOptionsFromFlags,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import {
  SETTINGS_COMMAND_NAME,
  settingsCliReader as settingsCliReaderImpl,
  settingsCliSchema,
  settingsCommandDefinition,
  settingsCommandMetadata,
  settingsDaemonWriter as settingsDaemonWriterImpl,
} from './settings.ts';

const SNAPSHOT_COMMAND_NAME = 'snapshot';
const SCREENSHOT_COMMAND_NAME = 'screenshot';
const DIFF_COMMAND_NAME = 'diff';
const WAIT_COMMAND_NAME = 'wait';
const ALERT_COMMAND_NAME = 'alert';

const snapshotCommandDescription = 'Capture an accessibility snapshot.';
const screenshotCommandDescription = 'Capture a screenshot.';
const diffCommandDescription = 'Diff accessibility snapshots.';
const waitCommandDescription = 'Wait for duration, text, ref, or selector.';
const alertCommandDescription = 'Inspect or handle platform alerts.';

const snapshotCommandMetadata = defineFieldCommandMetadata(
  SNAPSHOT_COMMAND_NAME,
  snapshotCommandDescription,
  {
    interactiveOnly: booleanField(),
    depth: integerField(),
    scope: stringField(),
    raw: booleanField(),
    forceFull: booleanField(),
    timeoutMs: integerField('Maximum wall-clock time for the snapshot command.'),
  },
);

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

const diffCommandMetadata = defineFieldCommandMetadata(DIFF_COMMAND_NAME, diffCommandDescription, {
  kind: requiredField(jsonSchemaField<'snapshot'>({ type: 'string', const: 'snapshot' })),
  out: stringField(),
  interactiveOnly: booleanField(),
  depth: integerField(),
  scope: stringField(),
  raw: booleanField(),
});

const waitCommandMetadata = defineFieldCommandMetadata(WAIT_COMMAND_NAME, waitCommandDescription, {
  kind: enumField(WAIT_KIND_VALUES),
  durationMs: integerField(),
  text: stringField(),
  ref: stringField(),
  selector: stringField(),
  timeoutMs: integerField(),
  depth: integerField(),
  scope: stringField(),
  raw: booleanField(),
});

const alertCommandMetadata = defineFieldCommandMetadata(
  ALERT_COMMAND_NAME,
  alertCommandDescription,
  {
    action: enumField(ALERT_ACTIONS),
    timeoutMs: integerField(),
  },
);

export const captureCommandMetadata = [
  snapshotCommandMetadata,
  screenshotCommandMetadata,
  diffCommandMetadata,
  waitCommandMetadata,
  alertCommandMetadata,
  settingsCommandMetadata,
] as const;

const snapshotCommandDefinition = defineExecutableCommand(
  snapshotCommandMetadata,
  (client, input) => client.capture.snapshot(input),
);

const screenshotCommandDefinition = defineExecutableCommand(
  screenshotCommandMetadata,
  (client, input) => client.capture.screenshot(input),
);

const diffCommandDefinition = defineExecutableCommand(diffCommandMetadata, (client, input) =>
  client.capture.diff(input),
);

const waitCommandDefinition = defineExecutableCommand(waitCommandMetadata, (client, input) =>
  client.command.wait(waitInputToOptions(input)),
);

const alertCommandDefinition = defineExecutableCommand(alertCommandMetadata, (client, input) =>
  client.command.alert(input),
);

export const captureCommandDefinitions = [
  snapshotCommandDefinition,
  screenshotCommandDefinition,
  diffCommandDefinition,
  waitCommandDefinition,
  alertCommandDefinition,
  settingsCommandDefinition,
] as const;

const snapshotCliSchema = {
  usageOverride:
    'snapshot [--diff] [-i] [-d <depth>] [-s <scope>] [--raw] [--force-full] [--timeout <ms>]',
  helpDescription:
    'Capture accessibility tree or diff against the previous session baseline. For iOS raw-coordinate fallback after a no-op ref press, inspect rects with snapshot -i --json, press the rect center, then verify with diff snapshot -i or snapshot --diff.',
  summary: 'Capture accessibility tree or diff against the previous session baseline',
  allowedFlags: ['snapshotDiff', ...SNAPSHOT_FLAGS, 'snapshotForceFull', 'timeoutMs'],
} as const satisfies CommandSchemaOverride;

const diffCliSchema = {
  usageOverride:
    'diff snapshot | diff screenshot --baseline <path> [current.png] [--out <diff.png>] [--threshold <0-1>] [--overlay-refs]',
  helpDescription: 'Diff accessibility snapshot or compare screenshots pixel-by-pixel',
  summary: 'Diff snapshot or screenshot',
  positionalArgs: ['kind', 'current?'],
  allowedFlags: [...SNAPSHOT_FLAGS, 'baseline', 'threshold', 'out', 'overlayRefs'],
} as const satisfies CommandSchemaOverride;

const screenshotCliSchema = {
  helpDescription:
    'Capture screenshot (macOS app sessions default to the app window; use --fullscreen for full desktop, --max-size to downscale, --overlay-refs to annotate current refs, or --no-stabilize for low-latency Android capture loops)',
  summary: 'Capture screenshot with optional desktop, downscale, or ref overlay modes',
  positionalArgs: ['path?'],
  allowedFlags: SCREENSHOT_COMMAND_FLAG_KEYS,
} as const satisfies CommandSchemaOverride;

const waitCliSchema = {
  usageOverride: 'wait <ms>|text <text>|@ref|<selector> [timeoutMs]',
  positionalArgs: ['durationOrSelector', 'timeoutMs?'],
  allowsExtraPositionals: true,
  allowedFlags: [...SELECTOR_SNAPSHOT_FLAGS],
} as const satisfies CommandSchemaOverride;

const alertCliSchema = {
  usageOverride: 'alert [get|accept|dismiss|wait] [timeout]',
  positionalArgs: ['action?', 'timeout?'],
} as const satisfies CommandSchemaOverride;

export const captureCliSchemas = {
  [SNAPSHOT_COMMAND_NAME]: snapshotCliSchema,
  [SCREENSHOT_COMMAND_NAME]: screenshotCliSchema,
  [DIFF_COMMAND_NAME]: diffCliSchema,
  [WAIT_COMMAND_NAME]: waitCliSchema,
  [ALERT_COMMAND_NAME]: alertCliSchema,
  [SETTINGS_COMMAND_NAME]: settingsCliSchema,
} as const satisfies Record<string, CommandSchemaOverride>;

function waitInputToOptions(input: Record<string, unknown>): WaitCommandOptions {
  optionalEnum(input, 'kind', WAIT_KIND_VALUES);
  const options = { ...input };
  delete options.kind;
  return options as WaitCommandOptions & { kind?: never };
}

export const captureCliReaders = {
  snapshot: (_positionals, flags) => ({
    ...commonInputFromFlags(flags),
    interactiveOnly: flags.snapshotInteractiveOnly,
    depth: flags.snapshotDepth,
    scope: flags.snapshotScope,
    raw: flags.snapshotRaw,
    forceFull: flags.snapshotForceFull,
    timeoutMs: flags.timeoutMs,
  }),
  screenshot: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    path: positionals[0] ?? flags.out,
    ...screenshotOptionsFromFlags(flags),
  }),
  diff: (positionals, flags) => {
    if (positionals[0] !== 'snapshot') {
      throw new AppError('INVALID_ARGS', 'Only diff snapshot is available through this parser.');
    }
    return {
      ...commonInputFromFlags(flags),
      kind: 'snapshot',
      out: flags.out,
      interactiveOnly: flags.snapshotInteractiveOnly,
      depth: flags.snapshotDepth,
      scope: flags.snapshotScope,
      raw: flags.snapshotRaw,
    };
  },
  wait: (positionals, flags) => readWaitOptionsFromPositionals(positionals, flags),
  alert: (positionals, flags) => ({
    ...commonInputFromFlags(flags),
    ...readAlertInput(positionals),
  }),
  settings: settingsCliReaderImpl,
} satisfies Record<string, CliReader>;

export const snapshotCliReader = captureCliReaders.snapshot;
export const screenshotCliReader = captureCliReaders.screenshot;
export const diffCliReader = captureCliReaders.diff;
export const waitCliReader = captureCliReaders.wait;
export const alertCliReader = captureCliReaders.alert;
export const settingsCliReader = captureCliReaders.settings;

export const captureDaemonWriters = {
  snapshot: direct(PUBLIC_COMMANDS.snapshot),
  screenshot: (input) =>
    request(PUBLIC_COMMANDS.screenshot, optionalString(input.path), {
      ...input,
      ...screenshotFlagsFromOptions(input as CaptureScreenshotOptions),
    }),
  diff: direct(PUBLIC_COMMANDS.diff, (input) => [
    requiredDaemonString(input.kind, 'diff requires kind'),
  ]),
  wait: direct(PUBLIC_COMMANDS.wait, (input) => waitPositionals(input as WaitCommandOptions)),
  alert: direct(PUBLIC_COMMANDS.alert, (input) => alertPositionals(input as AlertCommandOptions)),
  settings: settingsDaemonWriterImpl,
} satisfies Record<string, DaemonWriter>;

export const screenshotDaemonWriter = captureDaemonWriters.screenshot;
export const waitDaemonWriter = captureDaemonWriters.wait;
export const alertDaemonWriter = captureDaemonWriters.alert;
export const settingsDaemonWriter = captureDaemonWriters.settings;

function readWaitOptionsFromPositionals(
  positionals: string[],
  flags: CliFlags,
): WaitCommandOptions {
  const parsed = parseWaitPositionals(positionals);
  if (!parsed) {
    throw new AppError(
      'INVALID_ARGS',
      'wait requires <ms>, text <text>, @ref, or <selector> [timeoutMs].',
    );
  }
  const base = {
    ...selectionOptionsFromFlags(flags),
    ...selectorSnapshotOptionsFromFlags(flags),
  };
  if (parsed.kind === 'sleep') return { ...base, durationMs: parsed.durationMs };
  if (parsed.kind === 'text') {
    if (!parsed.text) throw new AppError('INVALID_ARGS', 'wait requires text.');
    return { ...base, text: parsed.text, ...readTimeoutOption(parsed.timeoutMs) };
  }
  if (parsed.kind === 'ref') {
    return { ...base, ref: parsed.rawRef, ...readTimeoutOption(parsed.timeoutMs) };
  }
  return {
    ...base,
    selector: parsed.selectorExpression,
    ...readTimeoutOption(parsed.timeoutMs),
  };
}

// fallow-ignore-next-line complexity
function waitPositionals(options: WaitCommandOptions): string[] {
  const targets = [
    options.durationMs !== undefined ? 'durationMs' : undefined,
    options.text !== undefined ? 'text' : undefined,
    options.ref !== undefined ? 'ref' : undefined,
    options.selector !== undefined ? 'selector' : undefined,
  ].filter(Boolean);
  if (targets.length !== 1) {
    throw new AppError(
      'INVALID_ARGS',
      'wait command requires exactly one of durationMs, text, ref, or selector.',
    );
  }
  if (options.durationMs !== undefined) return [String(options.durationMs)];
  const timeout = optionalNumber(options.timeoutMs);
  if (options.text !== undefined) return ['text', options.text, ...timeout];
  if (options.ref !== undefined) return [options.ref, ...timeout];
  const selector = options.selector!;
  if (!tryParseSelectorChain(selector)) {
    throw new AppError('INVALID_ARGS', `Invalid wait selector: ${selector}`);
  }
  return [selector, ...timeout];
}

function alertPositionals(input: AlertCommandOptions): string[] {
  return [input.action ?? 'get', ...optionalNumber(input.timeoutMs)];
}

function readAlertInput(positionals: string[]): Record<string, unknown> {
  if (positionals.length > 2) {
    throw new AppError('INVALID_ARGS', 'alert accepts at most action and timeout arguments.');
  }
  const action = readAlertAction(positionals[0]);
  const timeoutMs = readFiniteNumber(positionals[1], 'alert timeout');
  return compactRecord({ action, timeoutMs });
}

function readAlertAction(value: string | undefined): AlertAction | undefined {
  const action = value?.toLowerCase();
  if (
    action === undefined ||
    action === 'get' ||
    action === 'accept' ||
    action === 'dismiss' ||
    action === 'wait'
  ) {
    return action;
  }
  throw new AppError('INVALID_ARGS', 'alert action must be get, accept, dismiss, or wait.');
}

function readTimeoutOption(timeoutMs: number | null): { timeoutMs?: number } {
  return timeoutMs === null ? {} : { timeoutMs };
}
