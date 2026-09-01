import type {
  AndroidBlockingDialogFocus,
  AndroidBlockingDialogObservation,
  AndroidObservationAdapter,
  AndroidObservationHost,
} from '@agent-device/contracts/android-observation';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

const FOCUSED_WINDOW_MARKER = 'mCurrentFocus=Window{';
const FOCUS_MARKERS = [
  FOCUSED_WINDOW_MARKER,
  'mFocusedApp=AppWindowToken{',
  'mResumedActivity:',
  'ResumedActivity:',
] as const;
const WINDOW_DUMPS = [
  ['shell', 'dumpsys', 'window', 'windows'],
  ['shell', 'dumpsys', 'window'],
] as const;
const ACTIVITY_DUMPS = [
  ['shell', 'dumpsys', 'activity', 'activities'],
  ['shell', 'dumpsys', 'activity'],
] as const;
const FOCUS_LINE = new RegExp(`(?:${FOCUS_MARKERS.map(escapeRegExp).join('|')})(.*)$`, 'gm');
const ANR_TITLE = /\bApplication Not Responding:\s*([A-Za-z0-9_.]+)/i;
const PACKAGE_NAME = /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\b/;
const PERMISSION_PACKAGES = new Set([
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.android.packageinstaller',
  'com.google.android.packageinstaller',
]);

type Question = 'foreground' | 'blockingDialog';
type DumpReader = (args: readonly string[]) => Promise<string>;
const everAnswered = new Map<string, Map<string, boolean>>();

export function createAndroidObservationAdapter(
  host: AndroidObservationHost,
): AndroidObservationAdapter {
  return Object.freeze({
    readAppState: async (device) => await readAppState(host, device),
    readBlockingDialog: async (device) => await readBlockingDialog(host, device),
    async readAppFocus(device, appBundleId, options = {}) {
      const read = createDumpReader(host, device);
      if (options.requireNoBlockingDialog) {
        const observation = await readBlockingDialog(host, device, read);
        if (observation.status === 'dialog') return false;
      }
      return (await readAppState(host, device, read)).package === appBundleId;
    },
    readSnapshotNodes: async (device) => await host.readSnapshotNodes(device),
    async tap(device, x, y) {
      return await host.runAdb(
        device,
        ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))],
        { allowFailure: true },
      );
    },
    openApp: async (device, appBundleId) => await host.openApp(device, appBundleId),
    async readScreenSize(device) {
      const result = await host.runAdb(device, ['shell', 'wm', 'size']);
      const match = result.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
      if (!match) throw new AppError('COMMAND_FAILED', 'Unable to read screen size');
      return { width: Number(match[1]), height: Number(match[2]) };
    },
    async isPermissionPackage(packageName) {
      return PERMISSION_PACKAGES.has(packageName);
    },
  });
}

function createDumpReader(host: AndroidObservationHost, device: DeviceInfo): DumpReader {
  const dumps = new Map<string, Promise<string>>();
  return (args) => {
    const key = args.join(' ');
    const pending =
      dumps.get(key) ??
      host.runAdb(device, args, { allowFailure: true }).then((result) => {
        recordSections(device, key, result.stdout);
        return result.stdout;
      });
    dumps.set(key, pending);
    return pending;
  };
}

async function readAppState(
  host: AndroidObservationHost,
  device: DeviceInfo,
  read: DumpReader = createDumpReader(host, device),
): Promise<AppStateRuntimeResult> {
  for (const args of orderedDumps(device, 'foreground')) {
    const state = parseForeground(await read(args));
    if (state) return state;
  }
  return {};
}

async function readBlockingDialog(
  host: AndroidObservationHost,
  device: DeviceInfo,
  read: DumpReader = createDumpReader(host, device),
): Promise<AndroidBlockingDialogObservation> {
  for (const args of orderedDumps(device, 'blockingDialog')) {
    const parsed = parseBlockingDialog(await read(args));
    if (parsed.focus) return { status: 'dialog', focus: parsed.focus };
    if (parsed.focusObserved) return { status: 'clear' };
  }
  return { status: 'unknown' };
}

function orderedDumps(device: DeviceInfo, question: Question): readonly (readonly string[])[] {
  const tiers = question === 'foreground' ? [WINDOW_DUMPS, ACTIVITY_DUMPS] : [WINDOW_DUMPS];
  const memo = everAnswered.get(device.id);
  return tiers.flatMap((tier) => {
    if (!memo) return tier;
    const demoted = (args: readonly string[]) =>
      memo.get(`${question} ${args.join(' ')}`) === false;
    const promoted = tier.filter((args) => !demoted(args));
    return promoted.length === 0 || promoted.length === tier.length
      ? tier
      : [...promoted, ...tier.filter(demoted)];
  });
}

function recordSections(device: DeviceInfo, key: string, text: string): void {
  if (!text) return;
  const memo = everAnswered.get(device.id) ?? new Map<string, boolean>();
  preservePositiveMemo(memo, `foreground ${key}`, markerPattern(FOCUS_MARKERS).test(text));
  preservePositiveMemo(
    memo,
    `blockingDialog ${key}`,
    markerPattern([FOCUSED_WINDOW_MARKER]).test(text),
  );
  everAnswered.set(device.id, memo);
}

function preservePositiveMemo(memo: Map<string, boolean>, key: string, answered: boolean): void {
  if (memo.get(key) !== true) memo.set(key, answered);
}

function parseForeground(text: string): AppStateRuntimeResult | null {
  for (const match of text.matchAll(FOCUS_LINE)) {
    const component = match[1]?.match(
      /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/,
    );
    if (component?.[1] && component[2]) return { package: component[1], activity: component[2] };
  }
  return null;
}

function parseBlockingDialog(text: string): {
  focusObserved: boolean;
  focus: AndroidBlockingDialogFocus | null;
} {
  let focusObserved = false;
  const lines = text.split('\n');
  for (const marker of FOCUS_MARKERS) {
    for (const line of lines) {
      const index = line.indexOf(marker);
      if (index === -1) continue;
      if (marker === FOCUSED_WINDOW_MARKER) focusObserved = true;
      const raw = line.trim();
      const segment =
        line
          .slice(index + marker.length)
          .split('}')[0]
          ?.trim() ?? '';
      const focus = parseDialogFocus(segment, raw);
      if (focus) return { focusObserved, focus };
    }
  }
  return { focusObserved, focus: null };
}

function parseDialogFocus(segment: string, raw: string): AndroidBlockingDialogFocus | null {
  const anrPackage = ANR_TITLE.exec(segment)?.[1];
  if (anrPackage) {
    return {
      package: anrPackage,
      focusedWindow: `Application Not Responding: ${anrPackage}`,
      raw,
    };
  }
  const normalizedSegment = segment.toLowerCase();
  if (
    !normalizedSegment.includes("isn't responding") &&
    !normalizedSegment.includes('is not responding')
  ) {
    return null;
  }
  const responding = segment.trim().replaceAll(/\s+/g, ' ');
  const packageName = PACKAGE_NAME.exec(responding)?.[1];
  return {
    ...(packageName ? { package: packageName } : {}),
    focusedWindow: responding,
    raw,
  };
}

function markerPattern(markers: readonly string[]): RegExp {
  return new RegExp(markers.map(escapeRegExp).join('|'));
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
