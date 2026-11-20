import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { isRecord } from '@agent-device/kernel/record';
import { redactDiagnosticText } from '@agent-device/kernel/redaction';
import type { DaemonRequest, DaemonResponseData } from '@agent-device/kernel/contracts';

const EVENT_LIST_PREVIEW_LIMIT = 5;
const EVENT_LIST_SUMMARY_LIMIT = 3;
const EVENT_LABEL_MAX_LENGTH = 120;
const EVENT_NOTE_MAX_LENGTH = 300;
const EVENT_NOTE_REDACTION_INPUT_MAX_LENGTH = 4 * EVENT_NOTE_MAX_LENGTH;
const WHITESPACE_RE = /\s/u;
const DEVICE_IDENTIFIER_KEYS = [
  'id',
  'deviceId',
  'device_id',
  'serial',
  'udid',
  'device_udid',
  'identifier',
] as const;
const DEVICE_PLATFORM_LABELS: Readonly<Record<string, string>> = {
  ios: 'iOS',
  ipados: 'iPadOS',
  tvos: 'tvOS',
  watchos: 'watchOS',
  visionos: 'visionOS',
  macos: 'macOS',
  apple: 'Apple',
  android: 'Android',
  linux: 'Linux',
  web: 'Web',
};

type RequestSuccessEventPresentation = {
  summary?: string;
  details?: Record<string, unknown>;
};

// Session events are durable and may be rendered outside the CLI. Project only
// command-owned fields here; never copy an arbitrary daemon response into the log.
export function buildRequestSuccessEventPresentation(
  req: DaemonRequest,
  data: DaemonResponseData | undefined,
): RequestSuccessEventPresentation {
  const result = data ?? {};
  switch (req.command) {
    case PUBLIC_COMMANDS.devices:
      return buildDevicesPresentation(result.devices);
    case PUBLIC_COMMANDS.apps:
      return buildAppsPresentation(result.apps, req.flags?.appsFilter);
    case PUBLIC_COMMANDS.boot:
      return buildDeviceLifecyclePresentation('Booted', result, true);
    case PUBLIC_COMMANDS.shutdown:
      return buildDeviceLifecyclePresentation('Shut down', result, false);
    case PUBLIC_COMMANDS.install:
      return buildInstallPresentation('Installed', result);
    case PUBLIC_COMMANDS.reinstall:
      return buildInstallPresentation('Reinstalled', result);
    case PUBLIC_COMMANDS.screenshot:
      return buildScreenshotPresentation(req, result);
    default:
      return {};
  }
}

function buildDevicesPresentation(value: unknown): RequestSuccessEventPresentation {
  if (!Array.isArray(value)) return {};
  const devices = value.flatMap((entry) => {
    const device = buildDevicePreview(entry);
    return device ? [device] : [];
  });
  const preview = devices.slice(0, EVENT_LIST_PREVIEW_LIMIT);
  const omittedDeviceCount = Math.max(0, devices.length - preview.length);
  const summaryPreview = devices.slice(0, EVENT_LIST_SUMMARY_LIMIT);
  return {
    summary: formatListSummary(
      `Found ${devices.length} ${pluralize('device', devices.length)}`,
      summaryPreview.map((device) => formatDevicePreview(device, true)),
      Math.max(0, devices.length - summaryPreview.length),
    ),
    details: {
      deviceCount: devices.length,
      devices: preview,
      ...(omittedDeviceCount > 0 ? { omittedDeviceCount } : {}),
    },
  };
}

function buildAppsPresentation(value: unknown, filter: unknown): RequestSuccessEventPresentation {
  if (!Array.isArray(value)) return {};
  const apps = value.flatMap((entry) => {
    const app = readBoundedString(entry);
    return app ? [app] : [];
  });
  const preview = apps.slice(0, EVENT_LIST_PREVIEW_LIMIT);
  const omittedAppCount = Math.max(0, apps.length - preview.length);
  const summaryPreview = apps.slice(0, EVENT_LIST_SUMMARY_LIMIT);
  return {
    summary: formatListSummary(
      `Found ${apps.length} ${pluralize('app', apps.length)}`,
      summaryPreview,
      Math.max(0, apps.length - summaryPreview.length),
    ),
    details: {
      appCount: apps.length,
      apps: preview,
      ...(omittedAppCount > 0 ? { omittedAppCount } : {}),
      ...(filter === 'all' || filter === 'user-installed' ? { filter } : {}),
    },
  };
}

function buildDeviceLifecyclePresentation(
  verb: 'Booted' | 'Shut down',
  data: Record<string, unknown>,
  booted: boolean,
): RequestSuccessEventPresentation {
  const device = readDeviceEventLabel(data);
  if (!device) return {};
  const details = {
    device,
    ...readDeviceTraits(data),
    booted,
  };
  return {
    summary: `${verb} ${formatDevicePreview(details, false)}`,
    details,
  };
}

function buildInstallPresentation(
  verb: 'Installed' | 'Reinstalled',
  data: Record<string, unknown>,
): RequestSuccessEventPresentation {
  const appName = readBoundedString(data.appName);
  const bundleId = readBoundedString(data.bundleId);
  const packageName = readFirstBoundedString(data, ['packageName', 'package']);
  const platform = readBoundedString(data.platform);
  const launchTarget = readBoundedString(data.launchTarget);
  const appId = readFirstBoundedString(data, [
    'bundleId',
    'packageName',
    'package',
    'appId',
    'launchTarget',
  ]);
  const label = formatAppLabel(appName, appId);
  if (!label) return {};
  const details: Record<string, unknown> = {};
  writeString(details, 'appName', appName);
  writeString(details, 'bundleId', bundleId);
  writeString(details, 'packageName', packageName);
  writeString(details, 'platform', platform);
  if (launchTarget !== appId) writeString(details, 'launchTarget', launchTarget);
  return {
    summary: `${verb} ${label}`,
    details,
  };
}

function buildScreenshotPresentation(
  req: DaemonRequest,
  data: Record<string, unknown>,
): RequestSuccessEventPresentation {
  const requestedFileName = readRequestedScreenshotFileName(req, data);
  return requestedFileName ? { details: { requestedFileName } } : {};
}

export function readRequestedScreenshotFileName(
  req: Pick<DaemonRequest, 'meta'>,
  data: Record<string, unknown>,
): string | undefined {
  // Remote transport replaces the output path with a daemon-local temp file, while
  // clientArtifactPaths retains the caller's original destination.
  const requestedPath = readSessionEventString(req.meta?.clientArtifactPaths?.path);
  const outputPath = requestedPath ?? readSessionEventString(data.path);
  if (!outputPath) return undefined;
  return readSessionEventFileName(outputPath);
}

function buildDevicePreview(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const name = readDeviceEventLabel(value);
  if (!name) return undefined;
  return {
    name,
    ...readDeviceTraits(value),
  };
}

function readDeviceEventLabel(value: Record<string, unknown>): string | undefined {
  const name = readFirstBoundedString(value, ['name', 'deviceName', 'device']);
  if (!name || !matchesDeviceIdentifier(value, name)) return name;
  return buildAnonymousDeviceLabel(value);
}

function matchesDeviceIdentifier(value: Record<string, unknown>, name: string): boolean {
  const normalizedName = normalizeDeviceIdentifier(name);
  return DEVICE_IDENTIFIER_KEYS.some((key) => {
    const identifier = readBoundedString(value[key]);
    return identifier !== undefined && normalizeDeviceIdentifier(identifier) === normalizedName;
  });
}

function normalizeDeviceIdentifier(value: string): string {
  return value.toLowerCase();
}

function buildAnonymousDeviceLabel(value: Record<string, unknown>): string {
  const appleOs = readBoundedString(value.appleOs);
  const platform = readBoundedString(value.platform);
  const kind = readBoundedString(value.kind);
  const platformLabel = readDevicePlatformLabel(appleOs, platform);
  if (platformLabel && (kind === 'simulator' || kind === 'emulator')) {
    return `${platformLabel} ${kind}`;
  }
  if (platformLabel) return `${platformLabel} device`;
  if (kind === 'simulator') return 'Simulator';
  if (kind === 'emulator') return 'Emulator';
  return 'Unnamed device';
}

function readDevicePlatformLabel(
  appleOs: string | undefined,
  platform: string | undefined,
): string | undefined {
  const key = appleOs ?? platform;
  if (!key || !Object.hasOwn(DEVICE_PLATFORM_LABELS, key)) return undefined;
  return DEVICE_PLATFORM_LABELS[key];
}

function readDeviceTraits(value: Record<string, unknown>): Record<string, unknown> {
  const platform = readBoundedString(value.platform);
  const appleOs = readBoundedString(value.appleOs);
  const kind = readBoundedString(value.kind);
  const target = readBoundedString(value.target);
  return {
    ...(platform ? { platform } : {}),
    ...(appleOs ? { appleOs } : {}),
    ...(kind ? { kind } : {}),
    ...(target ? { target } : {}),
    ...(typeof value.booted === 'boolean' ? { booted: value.booted } : {}),
  };
}

function formatDevicePreview(device: Record<string, unknown>, includeBootState: boolean): string {
  const name = readBoundedString(device.name) ?? readBoundedString(device.device) ?? 'device';
  const platform = readBoundedString(device.platform);
  const appleOs = readBoundedString(device.appleOs);
  const traits = [
    platform,
    appleOs !== platform ? appleOs : undefined,
    readBoundedString(device.kind),
    readBoundedString(device.target),
    includeBootState && typeof device.booted === 'boolean'
      ? device.booted
        ? 'booted'
        : 'stopped'
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return traits.length > 0 ? `${name} (${traits.join(', ')})` : name;
}

function formatAppLabel(
  appName: string | undefined,
  appId: string | undefined,
): string | undefined {
  if (appName && appId && appName !== appId) return `${appName} (${appId})`;
  return appName ?? appId;
}

function readFirstBoundedString(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const text = readBoundedString(value[key]);
    if (text) return text;
  }
  return undefined;
}

function writeString(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (value) target[key] = value;
}

function formatListSummary(base: string, preview: string[], omittedCount: number): string {
  const entries = [...preview, ...(omittedCount > 0 ? [`+${omittedCount} more`] : [])];
  return entries.length > 0 ? `${base}: ${entries.join(', ')}` : base;
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function readBoundedString(
  value: unknown,
  maxLength: number = EVENT_LABEL_MAX_LENGTH,
  truncated = false,
): string | undefined {
  const rawText = readSessionEventString(value);
  if (!rawText) return undefined;
  const text = rawText.trim();
  const characters = Array.from(text);
  if (!truncated && characters.length <= maxLength) return text;
  return `${characters.slice(0, maxLength - 1).join('')}…`;
}

export function readBoundedSessionEventString(value: unknown): string | undefined {
  return readBoundedString(value);
}

/**
 * The stored form of a client-written request note, or `undefined` when nothing is left to store.
 * The note keeps the diagnostic credential and URL redaction. Redaction reads only a fixed
 * code-point prefix of the note, so its cost does not grow with the request body. The 300
 * code-point bound applies last, in place of the redactor's code-unit cap, so a cut never splits
 * a character. A note cut at either step ends with `…` within the 300, even when redaction
 * shortened the kept text below the bound.
 */
export function prepareRequestNoteForStorage(note: string): string | undefined {
  const { text, truncated } = boundNoteForRedaction(note);
  return readBoundedString(redactDiagnosticText(text), EVENT_NOTE_MAX_LENGTH, truncated);
}

/**
 * The trimmed note cut to its first 1,200 code points: the most client text that redaction reads.
 * Redaction time grows faster than its input, and the daemon accepts much larger request bodies.
 * `truncated` says the cut dropped text, so the stored note can show that it is incomplete.
 *
 * A cut inside a whitespace-delimited token drops that whole token. Its fragment, such as a URL
 * cut inside its userinfo, may no longer match the redaction pattern for the full token.
 */
function boundNoteForRedaction(note: string): {
  text: string;
  truncated: boolean;
} {
  const characters: string[] = [];
  let lastTokenStart = 0;
  for (const character of note.trim()) {
    if (characters.length === EVENT_NOTE_REDACTION_INPUT_MAX_LENGTH) {
      const kept = WHITESPACE_RE.test(character) ? characters : characters.slice(0, lastTokenStart);
      return { text: kept.join(''), truncated: true };
    }
    characters.push(character);
    if (WHITESPACE_RE.test(character)) lastTokenStart = characters.length;
  }
  return { text: characters.join(''), truncated: false };
}

export function readSessionEventBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function readSessionEventEnum<const Value extends string>(
  value: unknown,
  values: readonly Value[],
): Value | undefined {
  const text = readBoundedSessionEventString(value);
  return text && values.includes(text as Value) ? (text as Value) : undefined;
}

export function compactSessionEventDetails(
  value: Record<string, unknown | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function readSessionEventFileName(value: unknown): string | undefined {
  const filePath = readSessionEventString(value);
  return filePath ? readBoundedString(filePath.split(/[\\/]/).at(-1)) : undefined;
}

export function readSessionEventString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().length > 0 ? value : undefined;
}

export function readSessionEventNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
