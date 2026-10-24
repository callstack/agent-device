import type {
  AndroidBlockingDialogObservation,
  AndroidObservationAdapter,
  AndroidObservationHost,
} from '@agent-device/contracts/android-observation';
import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isCommandTimeoutError } from '@agent-device/host-kit/command';
import { Deadline } from '@agent-device/host-kit/retry';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { AppError } from '@agent-device/kernel/errors';
import {
  ANDROID_FOCUS_MARKERS,
  ANDROID_FOCUSED_WINDOW_MARKER,
  readAndroidBlockingDialogFocus,
} from './app-parsers.ts';

const WINDOW_DUMPS: readonly (readonly string[])[] = [
  ['dumpsys', 'window', 'windows'],
  ['dumpsys', 'window'],
];
const ACTIVITY_DUMPS: readonly (readonly string[])[] = [
  ['dumpsys', 'activity', 'activities'],
  ['dumpsys', 'activity'],
];
const FOCUS_LINE = new RegExp(
  `(?:${ANDROID_FOCUS_MARKERS.map(escapeRegExp).join('|')})(.*)$`,
  'gm',
);
const PERMISSION_PACKAGES = new Set([
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.android.packageinstaller',
  'com.google.android.packageinstaller',
]);

const DUMP_OBSERVATION_BUDGET_MS = 10_000;

type Question = 'foreground' | 'blockingDialog';
type DumpReader = (words: readonly string[]) => Promise<string>;
const everAnswered = new Map<string, Map<string, boolean>>();

export function createAndroidObservationAdapter(
  host: AndroidObservationHost,
): AndroidObservationAdapter {
  return Object.freeze({
    readAppState: async (device) => await readAppState(host, device),
    readBlockingDialog: async (device) => await readBlockingDialog(host, device),
    async readAppFocus(device, appBundleId, options = {}) {
      const { runAndroidAutomationHelper } = await import('./automation-helper.ts');
      const focus = await runAndroidAutomationHelper(device, { action: 'focus' });
      if (focus?.focusedPackage === appBundleId && focus.windowType === '1') return true;
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
        deviceShellArgv('adb', 'shell', [
          'input',
          'tap',
          String(Math.round(x)),
          String(Math.round(y)),
        ]),
        { allowFailure: true },
      );
    },
    openApp: async (device, appBundleId) => await host.openApp(device, appBundleId),
    async readScreenSize(device) {
      const result = await host.runAdb(device, deviceShellArgv('adb', 'shell', ['wm', 'size']));
      const match = result.stdout.match(/Physical size:\s*(\d+)x(\d+)/);
      if (!match) throw new AppError('COMMAND_FAILED', 'Unable to read screen size');
      return { width: Number(match[1]), height: Number(match[2]) };
    },
    async isPermissionPackage(packageName) {
      return PERMISSION_PACKAGES.has(packageName);
    },
  });
}

/**
 * Every variant one observation reads shares a single {@link DUMP_OBSERVATION_BUDGET_MS} budget,
 * counted from its first dump read, so an observation costs at most one bound however many
 * variants it walks. A read that times out or finds the budget spent is an unanswered read, like
 * one that printed nothing: the observation reports `unknown` and never refuses the command.
 */
function createDumpReader(host: AndroidObservationHost, device: DeviceInfo): DumpReader {
  const dumps = new Map<string, Promise<string>>();
  let deadline: Deadline | undefined;
  return (words) => {
    const key = words.join(' ');
    const cached = dumps.get(key);
    if (cached) return cached;
    deadline ??= Deadline.fromTimeoutMs(DUMP_OBSERVATION_BUDGET_MS);
    const remainingMs = deadline.remainingMs();
    if (remainingMs <= 0) return Promise.resolve('');
    const pending = host
      .runAdb(device, deviceShellArgv('adb', 'shell', words), {
        allowFailure: true,
        timeoutMs: remainingMs,
      })
      .then(
        (result) => {
          recordSections(device, key, result.stdout);
          return result.stdout;
        },
        (error: unknown) => {
          if (!isCommandTimeoutError(error)) throw error;
          return '';
        },
      );
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
  const { runAndroidAutomationHelper } = await import('./automation-helper.ts');
  const focus = await runAndroidAutomationHelper(device, { action: 'focus' });
  if (focus?.windowType === '1' && focus.focusedPackage && focus.focusedPackage !== 'android') {
    return { status: 'clear' };
  }
  for (const args of orderedDumps(device, 'blockingDialog')) {
    const parsed = readAndroidBlockingDialogFocus(await read(args));
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
  preservePositiveMemo(memo, `foreground ${key}`, markerPattern(ANDROID_FOCUS_MARKERS).test(text));
  preservePositiveMemo(
    memo,
    `blockingDialog ${key}`,
    markerPattern([ANDROID_FOCUSED_WINDOW_MARKER]).test(text),
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

function markerPattern(markers: readonly string[]): RegExp {
  return new RegExp(markers.map(escapeRegExp).join('|'));
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
