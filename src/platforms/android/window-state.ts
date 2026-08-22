import type { AppStateRuntimeResult } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidAdb } from './adb.ts';
import {
  ANDROID_FOCUS_MARKERS,
  readAndroidBlockingDialogFocus,
  type AndroidBlockingDialogFocus,
} from './app-parsers.ts';

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
const ANDROID_FOCUS_MARKER_ALTERNATION = ANDROID_FOCUS_MARKERS.map((marker) =>
  marker.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`),
).join('|');
// Two questions about the same markers: which component the focus line names (text order, the
// legacy foreground parse), and whether the dump prints a focus section at all.
const ANDROID_FOCUS_LINE = new RegExp(`(?:${ANDROID_FOCUS_MARKER_ALTERNATION})(.*)$`, 'gm');
const ANDROID_FOCUS_SECTION = new RegExp(ANDROID_FOCUS_MARKER_ALTERNATION);

/**
 * Per serial, whether each dump variant has EVER been seen to print a focus section. On Android 16
 * `dumpsys window windows` has no `mCurrentFocus`: that section moved into the display dump plain
 * `dumpsys window` prints. Asking the silent variant first therefore costs a ~50 KB transfer that
 * structurally cannot answer, on every single readiness check.
 *
 * "Ever answered" rather than "answered last time" is the load-bearing part. A variant that
 * normally answers still prints nothing during a window transition, and one such sample must not
 * demote it — only a variant this device has never once answered from is demoted, which is the
 * structural property (the OS build's dump layout) the ordering is trying to exploit.
 *
 * It is a demotion, never a removal: a demoted variant moves to the back of the sequence and is
 * still asked when nothing ahead of it answers, so a wrong record costs ordering, never an answer.
 */
const androidWindowDumpEverAnswered = new Map<string, Map<string, boolean>>();

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
      runAndroidAdb(device, [...args], { allowFailure: true }).then((result) => {
        const stdout = result.stdout ?? '';
        recordAndroidWindowDumpFocusSection(device, key, stdout);
        return stdout;
      });
    dumps.set(key, pending);
    return pending;
  };
}

export async function getAndroidAppState(
  device: DeviceInfo,
  read: AndroidWindowDumpReader = createAndroidWindowDumpReader(device),
): Promise<AppStateRuntimeResult> {
  for (const args of orderAndroidWindowDumps(device, ANDROID_FOREGROUND_COMMANDS)) {
    const state = parseLegacyAndroidForegroundApp(await read(args));
    if (state) return state;
  }
  return {};
}

/**
 * A dump that shows the focused window has answered the blocking-dialog question, whether or not
 * the answer is a dialog. The remaining variants exist for devices whose earlier one says nothing
 * about focus, so they fire on that miss only — not on every clear screen.
 */
export async function getAndroidBlockingDialogFocus(
  device: DeviceInfo,
  read: AndroidWindowDumpReader = createAndroidWindowDumpReader(device),
): Promise<AndroidBlockingDialogFocus | null> {
  for (const args of orderAndroidWindowDumps(device, ANDROID_BLOCKING_DIALOG_COMMANDS)) {
    const { focusObserved, focus } = readAndroidBlockingDialogFocus(await read(args));
    if (focus) return focus;
    if (focusObserved) return null;
  }
  return null;
}

/**
 * @internal Test isolation hook: the focus-section record is per-serial and per-process, and test
 * fixtures share serials.
 */
export function resetAndroidWindowDumpFocusMemoForTests(): void {
  androidWindowDumpEverAnswered.clear();
}

function recordAndroidWindowDumpFocusSection(
  device: DeviceInfo,
  key: string,
  stdout: string,
): void {
  // An empty dump is a failed or refused command, not evidence about the variant's shape.
  if (stdout.length === 0) return;
  const everAnswered = androidWindowDumpEverAnswered.get(device.id) ?? new Map<string, boolean>();
  if (everAnswered.get(key) === true) return;
  everAnswered.set(key, ANDROID_FOCUS_SECTION.test(stdout));
  androidWindowDumpEverAnswered.set(device.id, everAnswered);
}

function orderAndroidWindowDumps(
  device: DeviceInfo,
  commands: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  const everAnswered = androidWindowDumpEverAnswered.get(device.id);
  if (!everAnswered) return commands;
  const demoted = (args: readonly string[]) => everAnswered.get(args.join(' ')) === false;
  const promoted = commands.filter((args) => !demoted(args));
  if (promoted.length === commands.length || promoted.length === 0) return commands;
  return [...promoted, ...commands.filter(demoted)];
}

function parseLegacyAndroidForegroundApp(text: string): AppStateRuntimeResult | null {
  for (const match of text.matchAll(ANDROID_FOCUS_LINE)) {
    const segment = match[1];
    const component = segment?.match(
      /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/,
    );
    if (component?.[1] && component[2]) {
      return { package: component[1], activity: component[2] };
    }
  }
  return null;
}
