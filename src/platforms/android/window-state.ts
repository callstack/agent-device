import type { AppStateRuntimeResult } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidAdb } from './adb.ts';
import { readAndroidBlockingDialogFocus, type AndroidBlockingDialogFocus } from './app-parsers.ts';

/**
 * What is on the Android screen right now: which app owns the foreground, and whether a blocking
 * system dialog owns the focus. Both answers come out of the same `dumpsys` text, so the dump
 * sequence is owned here once instead of being repeated per question.
 */

const ANDROID_FOREGROUND_COMMANDS = [
  ['shell', 'dumpsys', 'window', 'windows'],
  ['shell', 'dumpsys', 'window'],
  ['shell', 'dumpsys', 'activity', 'activities'],
  ['shell', 'dumpsys', 'activity'],
] as const;
// A blocking dialog is a window title, so only the window dumps can carry one. Sliced from the
// foreground sequence rather than restated so the two orders cannot drift apart.
const ANDROID_BLOCKING_DIALOG_COMMANDS = ANDROID_FOREGROUND_COMMANDS.slice(0, 2);
const ANDROID_FOCUS_LINE =
  /(?:(mCurrentFocus=Window\{)|(mFocusedApp=AppWindowToken\{)|(mResumedActivity:)|(ResumedActivity:))(.*)$/gm;

/**
 * Reads one `dumpsys` variant. A reader is bound to a single observation instant: it runs each
 * distinct command at most once and replays that text to every later question, so two questions
 * about the same instant cost one spawn and cannot disagree about what was on screen.
 *
 * Deliberately scope-bound rather than time-bound. A reader that outlived its caller would answer
 * the recovery poll loops in `android-system-dialog.ts` with text they have already seen, and
 * those loops would never observe the state change they are waiting for.
 */
export type AndroidWindowDumpReader = (args: readonly string[]) => Promise<string>;

export function createAndroidWindowDumpReader(device: DeviceInfo): AndroidWindowDumpReader {
  const dumps = new Map<string, Promise<string>>();
  return (args) => {
    const key = args.join(' ');
    const pending =
      dumps.get(key) ??
      runAndroidAdb(device, [...args], { allowFailure: true }).then(
        (result) => result.stdout ?? '',
      );
    dumps.set(key, pending);
    return pending;
  };
}

export async function getAndroidAppState(
  device: DeviceInfo,
  read: AndroidWindowDumpReader = createAndroidWindowDumpReader(device),
): Promise<AppStateRuntimeResult> {
  for (const args of ANDROID_FOREGROUND_COMMANDS) {
    const state = parseLegacyAndroidForegroundApp(await read(args));
    if (state) return state;
  }
  return {};
}

/**
 * A dump that shows the focused window has answered the blocking-dialog question, whether or not
 * the answer is a dialog. The second variant exists for devices whose `dumpsys window windows`
 * says nothing about focus, so it fires on that miss only — not on every clear screen.
 */
export async function getAndroidBlockingDialogFocus(
  device: DeviceInfo,
  read: AndroidWindowDumpReader = createAndroidWindowDumpReader(device),
): Promise<AndroidBlockingDialogFocus | null> {
  for (const args of ANDROID_BLOCKING_DIALOG_COMMANDS) {
    const { focusObserved, focus } = readAndroidBlockingDialogFocus(await read(args));
    if (focus) return focus;
    if (focusObserved) return null;
  }
  return null;
}

function parseLegacyAndroidForegroundApp(text: string): AppStateRuntimeResult | null {
  for (const match of text.matchAll(ANDROID_FOCUS_LINE)) {
    const segment = match[5];
    const component = segment?.match(
      /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/,
    );
    if (component?.[1] && component[2]) {
      return { package: component[1], activity: component[2] };
    }
  }
  return null;
}
