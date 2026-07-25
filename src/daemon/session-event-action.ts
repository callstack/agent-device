import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../command-catalog.ts';
import { BACK_MODES } from '../contracts/back-mode.ts';
import { RECORDING_SCOPE_VALUES } from '../contracts/recording-scope.ts';
import { SESSION_SURFACES } from '../contracts/session-surface.ts';
import { SWIPE_PATTERNS } from '../contracts/scroll-gesture.ts';
import { CLICK_BUTTONS } from '../contracts/click-button.ts';
import { DEVICE_TARGETS, PLATFORM_SELECTORS, PUBLIC_PLATFORMS } from '../kernel/device.ts';
import type { SessionAction } from './types.ts';
import {
  buildInstallActionSummary,
  buildStructuredActionDetails,
  buildStructuredActionSummary,
} from './session-event-action-presentation.ts';
import {
  compactSessionEventDetails as compactDetails,
  readBoundedSessionEventString as readString,
  readSessionEventBoolean as readBoolean,
  readSessionEventEnum as readEnum,
  readSessionEventNumber as readNumber,
} from './session-event-request.ts';

export function buildActionSummary(action: SessionAction): string {
  switch (action.command) {
    case PUBLIC_COMMANDS.open:
      return `Opened ${readActionTargetLabel(action) ?? 'session'}`;
    case PUBLIC_COMMANDS.close:
      return `Closed ${readString(action.result?.session) ?? 'session'}`;
    case PUBLIC_COMMANDS.click:
    case PUBLIC_COMMANDS.press:
      return `Tapped ${readActionTargetLabel(action) ?? 'target'}`;
    case PUBLIC_COMMANDS.longPress:
      return `Long pressed ${readActionTargetLabel(action) ?? 'target'}`;
    case PUBLIC_COMMANDS.fill:
      return `Filled ${readActionTargetLabel(action) ?? 'target'}`;
    case PUBLIC_COMMANDS.type:
      return 'Typed text';
    case PUBLIC_COMMANDS.install:
    case PUBLIC_COMMANDS.reinstall:
    case INTERNAL_COMMANDS.installSource:
      return buildInstallActionSummary(action);
    default:
      return buildStructuredActionSummary(action) ?? `Ran ${action.command}`;
  }
}

export function buildActionDetails(action: SessionAction): Record<string, unknown> {
  return compactDetails({
    command: action.command,
    positionals: buildDisplayPositionals(action),
    flags: buildSafeActionFlags(action),
    ...buildTargetActionDetails(action),
    ...buildIdentityActionDetails(action),
    ...buildObservationActionDetails(action),
    ...buildStructuredActionDetails(action),
  });
}

function buildTargetActionDetails(action: SessionAction): Record<string, unknown> {
  if (!isTargetActionCommand(action.command)) return {};
  const result = action.result ?? {};
  return compactDetails({
    ref: readActionRef(result),
    targetLabel: readActionTargetLabel(action),
    selectorChainLength: readStringArray(result.selectorChain)?.length,
    x: readNumber(result.x),
    y: readNumber(result.y),
    x2: readNumber(result.x2),
    y2: readNumber(result.y2),
    durationMs: readNumber(result.durationMs),
  });
}

function buildIdentityActionDetails(action: SessionAction): Record<string, unknown> {
  if (!isIdentityActionCommand(action.command)) return {};
  const result = action.result ?? {};
  return compactDetails({
    platform: readEnum(result.platform, PUBLIC_PLATFORMS),
    target: readEnum(result.target, DEVICE_TARGETS),
    appName: readString(result.appName),
    appBundleId: readString(result.appBundleId),
    bundleId: readString(result.bundleId),
    packageName: readString(result.packageName),
    launchTarget: readString(result.launchTarget),
  });
}

function buildObservationActionDetails(action: SessionAction): Record<string, unknown> {
  const result = action.result ?? {};
  if (action.command === PUBLIC_COMMANDS.snapshot) {
    return {
      ...(Array.isArray(result.nodes) ? { nodeCount: result.nodes.length } : {}),
    };
  }
  if (
    action.command !== PUBLIC_COMMANDS.wait &&
    action.command !== PUBLIC_COMMANDS.find &&
    action.command !== PUBLIC_COMMANDS.get &&
    action.command !== PUBLIC_COMMANDS.is
  ) {
    return {};
  }
  return compactDetails({
    waitedMs: readNumber(result.waitedMs),
    found: readBoolean(result.found),
  });
}

function isTargetActionCommand(command: string): boolean {
  return (
    command === PUBLIC_COMMANDS.click ||
    command === PUBLIC_COMMANDS.press ||
    command === PUBLIC_COMMANDS.longPress ||
    command === PUBLIC_COMMANDS.focus ||
    command === PUBLIC_COMMANDS.fill
  );
}

function isIdentityActionCommand(command: string): boolean {
  return (
    command === PUBLIC_COMMANDS.open ||
    command === PUBLIC_COMMANDS.install ||
    command === PUBLIC_COMMANDS.reinstall ||
    command === INTERNAL_COMMANDS.installSource
  );
}

function readActionTargetLabel(action: SessionAction): string | undefined {
  const result = action.result ?? {};
  return (
    readElementTargetLabel(result) ??
    readPointTargetLabel(result) ??
    readAppTargetLabel(result) ??
    readSafeDisplayPositional(action.positionals[0])
  );
}

function readElementTargetLabel(result: Record<string, unknown>): string | undefined {
  const ref = readActionRef(result);
  if (ref) return ref.startsWith('@') ? ref : `@${ref}`;
  return undefined;
}

function readPointTargetLabel(result: Record<string, unknown>): string | undefined {
  const x = readNumber(result.x);
  const y = readNumber(result.y);
  if (x !== undefined && y !== undefined) return `(${x}, ${y})`;
  return undefined;
}

function readAppTargetLabel(result: Record<string, unknown>): string | undefined {
  return (
    readString(result.appName) ??
    readString(result.appBundleId) ??
    readString(result.bundleId) ??
    readString(result.packageName)
  );
}

export function buildDisplayPositionals(action: SessionAction): string[] | undefined {
  if (action.positionals.length === 0) return undefined;
  if (action.command === PUBLIC_COMMANDS.type) {
    return [hiddenValue('text')];
  }
  if (action.command === PUBLIC_COMMANDS.fill) {
    return buildFillDisplayPositionals(action);
  }
  if (action.command === PUBLIC_COMMANDS.find) {
    return buildFindDisplayPositionals(action);
  }
  if (action.command === PUBLIC_COMMANDS.clipboard) {
    return buildClipboardDisplayPositionals(action);
  }
  if (action.command === PUBLIC_COMMANDS.push) {
    return buildPayloadDisplayPositionals(action, 'app', 'payload');
  }
  if (action.command === PUBLIC_COMMANDS.triggerAppEvent) {
    return buildPayloadDisplayPositionals(action, 'event', 'payload');
  }
  return action.positionals.map(redactDisplayPositional);
}

function buildFillDisplayPositionals(action: SessionAction): string[] {
  const textPlaceholder = hiddenValue('text');
  const result = action.result ?? {};
  const ref = readActionRef(result);
  if (ref) return [`@${ref}`, textPlaceholder];
  const selector = readString(result.selector);
  if (selector) return [hiddenValue('target'), textPlaceholder];
  const x = readNumber(result.x);
  const y = readNumber(result.y);
  if (x !== undefined && y !== undefined) return [String(x), String(y), textPlaceholder];
  return [textPlaceholder];
}

function buildFindDisplayPositionals(action: SessionAction): string[] | undefined {
  const queryIndex = isFindLocator(action.positionals[0]) ? 1 : 0;
  const query = action.positionals[queryIndex];
  if (query === undefined) return undefined;
  const actionIndex = queryIndex + 1;
  const prefix = [
    ...(queryIndex === 1 ? [String(action.positionals[0])] : []),
    hiddenValue('query'),
  ];
  const findAction = action.positionals[actionIndex];
  if (!findAction) return prefix;
  if (findAction === 'fill' || findAction === 'type') {
    return [...prefix, findAction, hiddenValue('text')];
  }
  return [...prefix, ...action.positionals.slice(actionIndex).map(redactFindActionPositional)];
}

function buildClipboardDisplayPositionals(action: SessionAction): string[] {
  const clipboardAction = action.positionals[0]?.toLowerCase();
  if (clipboardAction === 'read') return ['read'];
  if (clipboardAction === 'write') {
    return ['write', hiddenValue('text')];
  }
  return action.positionals.map(redactDisplayPositional);
}

function buildPayloadDisplayPositionals(
  action: SessionAction,
  targetLabel: string,
  payloadLabel: string,
): string[] {
  const [target, payload, ...extra] = action.positionals;
  return [
    ...(target ? [hiddenValue(targetLabel)] : []),
    ...(payload ? [hiddenValue(payloadLabel)] : []),
    ...extra.map(redactDisplayPositional),
  ];
}

function redactFindActionPositional(value: string): string {
  if (
    value === 'click' ||
    value === 'focus' ||
    value === 'exists' ||
    value === 'get' ||
    value === 'text' ||
    value === 'attrs' ||
    value === 'wait'
  ) {
    return value;
  }
  return redactDisplayPositional(value);
}

function redactDisplayPositional(value: string): string {
  return readSafeDisplayPositional(value) ?? hiddenValue('arg');
}

function readSafeDisplayPositional(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^@[a-zA-Z0-9:_-]+$/.test(trimmed)) return trimmed;
  return undefined;
}

function hiddenValue(label: string): string {
  return `<${label}>`;
}

function isFindLocator(value: string | undefined): boolean {
  return (
    value === 'text' || value === 'label' || value === 'value' || value === 'role' || value === 'id'
  );
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

type FlagField = { source: string; output?: string };
type EnumFlagField = FlagField & { values: readonly string[] };
type SafeFlagSpec = {
  booleans?: readonly FlagField[];
  numbers?: readonly FlagField[];
  enums?: readonly EnumFlagField[];
};

const COMMON_SAFE_FLAG_SPEC = {
  enums: [
    { source: 'platform', values: PLATFORM_SELECTORS },
    { source: 'target', values: DEVICE_TARGETS },
  ],
} as const satisfies SafeFlagSpec;

const SAFE_ACTION_FLAG_SPECS: Record<string, SafeFlagSpec> = {
  [PUBLIC_COMMANDS.open]: {
    booleans: [{ source: 'relaunch' }, { source: 'testIme' }],
    enums: [{ source: 'surface', values: SESSION_SURFACES }],
  },
  [PUBLIC_COMMANDS.click]: touchSafeFlagSpec(),
  [PUBLIC_COMMANDS.press]: touchSafeFlagSpec(),
  [PUBLIC_COMMANDS.longPress]: touchSafeFlagSpec(),
  [PUBLIC_COMMANDS.fill]: textEntrySafeFlagSpec(),
  [PUBLIC_COMMANDS.type]: textEntrySafeFlagSpec(),
  [PUBLIC_COMMANDS.scroll]: {
    numbers: [{ source: 'pixels' }, { source: 'durationMs' }],
  },
  [PUBLIC_COMMANDS.gesture]: gestureSafeFlagSpec(),
  [PUBLIC_COMMANDS.swipe]: gestureSafeFlagSpec(),
  [PUBLIC_COMMANDS.screenshot]: {
    booleans: [
      { source: 'overlayRefs' },
      { source: 'screenshotFullscreen', output: 'fullscreen' },
      { source: 'screenshotNoStabilize', output: 'noStabilize' },
      { source: 'screenshotNormalizeStatusBar', output: 'normalizeStatusBar' },
    ],
    numbers: [
      { source: 'screenshotPixelDensity', output: 'pixelDensity' },
      { source: 'screenshotMaxSize', output: 'maxSize' },
    ],
  },
  [PUBLIC_COMMANDS.snapshot]: {
    booleans: [
      { source: 'snapshotInteractiveOnly', output: 'interactiveOnly' },
      { source: 'snapshotDiff', output: 'diff' },
      { source: 'snapshotRaw', output: 'raw' },
      { source: 'snapshotForceFull', output: 'forceFull' },
    ],
    numbers: [{ source: 'snapshotDepth', output: 'depth' }],
  },
  [PUBLIC_COMMANDS.back]: {
    enums: [{ source: 'backMode', output: 'mode', values: BACK_MODES }],
  },
  [PUBLIC_COMMANDS.record]: {
    booleans: [{ source: 'hideTouches' }],
    numbers: [{ source: 'fps' }, { source: 'screenshotMaxSize', output: 'maxSize' }],
    enums: [{ source: 'recordingScope', output: 'scope', values: RECORDING_SCOPE_VALUES }],
  },
  [PUBLIC_COMMANDS.apps]: {
    enums: [{ source: 'appsFilter', output: 'filter', values: ['user-installed', 'all'] }],
  },
  [PUBLIC_COMMANDS.boot]: {
    booleans: [{ source: 'headless' }],
  },
  [PUBLIC_COMMANDS.close]: {
    booleans: [{ source: 'shutdown' }],
  },
};

function buildSafeActionFlags(action: SessionAction): Record<string, unknown> | undefined {
  const flags = (action.flags ?? {}) as Record<string, unknown>;
  const safeFlags: Record<string, unknown> = {};
  const commandFlagSpec = Object.hasOwn(SAFE_ACTION_FLAG_SPECS, action.command)
    ? SAFE_ACTION_FLAG_SPECS[action.command]
    : undefined;
  projectSafeFlags(safeFlags, flags, COMMON_SAFE_FLAG_SPEC);
  projectSafeFlags(safeFlags, flags, commandFlagSpec);
  return Object.keys(safeFlags).length > 0 ? safeFlags : undefined;
}

function touchSafeFlagSpec(): SafeFlagSpec {
  return {
    booleans: [{ source: 'doubleTap' }, { source: 'settle' }],
    numbers: [
      { source: 'count' },
      { source: 'intervalMs' },
      { source: 'holdMs' },
      { source: 'jitterPx' },
      { source: 'settleQuietMs' },
    ],
    enums: [{ source: 'clickButton', values: CLICK_BUTTONS }],
  };
}

function textEntrySafeFlagSpec(): SafeFlagSpec {
  return {
    booleans: [{ source: 'settle' }],
    numbers: [{ source: 'delayMs' }, { source: 'settleQuietMs' }],
  };
}

function gestureSafeFlagSpec(): SafeFlagSpec {
  return {
    numbers: [{ source: 'pointerCount' }, { source: 'count' }, { source: 'pauseMs' }],
    enums: [{ source: 'pattern', values: SWIPE_PATTERNS }],
  };
}

function projectSafeFlags(
  output: Record<string, unknown>,
  flags: Record<string, unknown>,
  spec: SafeFlagSpec | undefined,
): void {
  if (!spec) return;
  projectBooleanFlags(output, flags, spec.booleans ?? []);
  projectNumberFlags(output, flags, spec.numbers ?? []);
  projectEnumFlags(output, flags, spec.enums ?? []);
}

function projectBooleanFlags(
  output: Record<string, unknown>,
  flags: Record<string, unknown>,
  fields: readonly FlagField[],
): void {
  for (const field of fields) {
    writeBoolean(output, field.output ?? field.source, flags[field.source]);
  }
}

function projectNumberFlags(
  output: Record<string, unknown>,
  flags: Record<string, unknown>,
  fields: readonly FlagField[],
): void {
  for (const field of fields) {
    writeNumber(output, field.output ?? field.source, flags[field.source]);
  }
}

function projectEnumFlags(
  output: Record<string, unknown>,
  flags: Record<string, unknown>,
  fields: readonly EnumFlagField[],
): void {
  for (const field of fields) {
    writeEnum(output, field.output ?? field.source, flags[field.source], field.values);
  }
}

function readActionRef(result: Record<string, unknown>): string | undefined {
  const ref = readString(result.ref);
  if (!ref) return undefined;
  const normalized = ref.startsWith('@') ? ref.slice(1) : ref;
  return /^[a-zA-Z0-9:_-]+$/.test(normalized) ? normalized : undefined;
}

function writeBoolean(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'boolean') target[key] = value;
}

function writeNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  const number = readNumber(value);
  if (number !== undefined) target[key] = number;
}

function writeEnum<const Value extends string>(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  values: readonly Value[],
): void {
  const entry = readEnum(value, values);
  if (entry !== undefined) target[key] = entry;
}
