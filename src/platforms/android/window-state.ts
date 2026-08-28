import type { AppStateRuntimeResult } from '@agent-device/contracts/app-state-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidAdb } from './adb.ts';
import {
  ANDROID_FOCUSED_WINDOW_MARKER,
  ANDROID_FOCUS_MARKERS,
  readAndroidBlockingDialogFocus,
  type AndroidBlockingDialogFocus,
} from './app-parsers.ts';

/**
 * What is on the Android screen right now: which app owns the foreground, and whether a blocking
 * system dialog owns the focus. Both answers come out of the same `dumpsys` text, so the dump
 * sequence is owned here once instead of being repeated per question.
 */

// What WMS says owns the focus. Ranked ahead of the activity dumps because that is what the user
// is actually looking at: an escaped press leaves the app resumed while another package owns the
// focused window (#592).
const ANDROID_WINDOW_FOCUS_DUMPS = [
  ['shell', 'dumpsys', 'window', 'windows'],
  ['shell', 'dumpsys', 'window'],
] as const;
// What AMS says is resumed. The fallback for a foreground question no window dump answered — a
// system window (the notification shade, say) owns the focus but not the foreground app.
const ANDROID_RESUMED_ACTIVITY_DUMPS = [
  ['shell', 'dumpsys', 'activity', 'activities'],
  ['shell', 'dumpsys', 'activity'],
] as const;

type AndroidWindowDumpTier = readonly (readonly string[])[];

/**
 * One question the daemon asks of a window dump: which dump variants can answer it, and which
 * section of a dump counts as an answer.
 *
 * `tiers` is ordered, and so is each tier. Every variant WITHIN a tier answers from the same
 * source, so which one answers cannot change the answer; ACROSS tiers it can, which is why the
 * ordering below only ever reorders inside a tier.
 */
type AndroidWindowQuestion = {
  readonly tiers: readonly AndroidWindowDumpTier[];
  readonly section: RegExp;
};

const ANDROID_WINDOW_QUESTIONS = {
  // Which app is in the foreground: any focus marker names a component to read it from.
  foreground: {
    tiers: [ANDROID_WINDOW_FOCUS_DUMPS, ANDROID_RESUMED_ACTIVITY_DUMPS],
    section: markerSectionPattern(ANDROID_FOCUS_MARKERS),
  },
  // Whether a blocking dialog owns the focus: only the focused-window line can carry that title,
  // and only the window dumps print it.
  blockingDialog: {
    tiers: [ANDROID_WINDOW_FOCUS_DUMPS],
    section: markerSectionPattern([ANDROID_FOCUSED_WINDOW_MARKER]),
  },
} as const satisfies Record<string, AndroidWindowQuestion>;

type AndroidWindowQuestionName = keyof typeof ANDROID_WINDOW_QUESTIONS;

// Two questions about the same markers: which component the focus line names (text order, the
// legacy foreground parse), and whether the dump prints a focus section at all.
const ANDROID_FOCUS_LINE = new RegExp(
  `(?:${ANDROID_FOCUS_MARKERS.map(escapeRegExp).join('|')})(.*)$`,
  'gm',
);

/**
 * Per serial and per question, whether each dump variant has EVER been seen to print the section
 * that answers it. On Android 16 `dumpsys window windows` has no `mCurrentFocus`: that section
 * moved into the display dump plain `dumpsys window` prints. Asking the silent variant first
 * therefore costs a ~50 KB transfer that structurally cannot answer, on every readiness check.
 *
 * Per QUESTION, not per dump, because the two questions read different sections: a dump that names
 * the focused app token answers "which app is foreground" and can never answer "is a dialog
 * blocking us".
 *
 * "Ever answered" rather than "answered last time" is the load-bearing part. A variant that
 * normally answers still prints nothing during a window transition, and one such sample must not
 * demote it — only a variant this device has never once answered from is demoted, which is the
 * structural property (the OS build's dump layout) the ordering is trying to exploit.
 *
 * It is a demotion, never a removal, and never across a tier: a demoted variant moves to the back
 * of its own tier and is still asked when nothing ahead of it answers, so a wrong record costs
 * ordering, never an answer.
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

/**
 * What one look at the device says about a blocking system dialog. `unknown` is the case the
 * daemon must not confuse with `clear`: no variant printed the focused window, so this look is
 * evidence about nothing.
 */
export type AndroidBlockingDialogObservation =
  | { status: 'dialog'; focus: AndroidBlockingDialogFocus }
  | { status: 'clear' }
  | { status: 'unknown' };

export function createAndroidWindowDumpReader(device: DeviceInfo): AndroidWindowDumpReader {
  const dumps = new Map<string, Promise<string>>();
  return (args) => {
    const key = args.join(' ');
    const pending =
      dumps.get(key) ??
      runAndroidAdb(device, [...args], { allowFailure: true }).then((result) => {
        const stdout = result.stdout ?? '';
        recordAndroidWindowDumpSections(device, key, stdout);
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
  for (const args of orderAndroidWindowDumps(device, 'foreground')) {
    const state = parseLegacyAndroidForegroundApp(await read(args));
    if (state) return state;
  }
  return {};
}

/**
 * A dump that shows the focused window has answered the blocking-dialog question, whether or not
 * the answer is a dialog. The remaining variants exist for devices whose earlier one says nothing
 * about the focused window, so they fire on that miss only — not on every clear screen.
 */
export async function getAndroidBlockingDialogObservation(
  device: DeviceInfo,
  read: AndroidWindowDumpReader = createAndroidWindowDumpReader(device),
): Promise<AndroidBlockingDialogObservation> {
  for (const args of orderAndroidWindowDumps(device, 'blockingDialog')) {
    const { focusObserved, focus } = readAndroidBlockingDialogFocus(await read(args));
    if (focus) return { status: 'dialog', focus };
    if (focusObserved) return { status: 'clear' };
  }
  return { status: 'unknown' };
}

/**
 * @internal Test isolation hook: the focus-section record is per-serial and per-process, and test
 * fixtures share serials.
 */
export function resetAndroidWindowDumpFocusMemoForTests(): void {
  androidWindowDumpEverAnswered.clear();
}

function recordAndroidWindowDumpSections(device: DeviceInfo, key: string, stdout: string): void {
  // An empty dump is a failed or refused command, not evidence about the variant's shape.
  if (stdout.length === 0) return;
  const everAnswered = androidWindowDumpEverAnswered.get(device.id) ?? new Map<string, boolean>();
  for (const [name, question] of Object.entries(ANDROID_WINDOW_QUESTIONS)) {
    const memoKey = androidWindowDumpMemoKey(name as AndroidWindowQuestionName, key);
    if (everAnswered.get(memoKey) === true) continue;
    everAnswered.set(memoKey, question.section.test(stdout));
  }
  androidWindowDumpEverAnswered.set(device.id, everAnswered);
}

function orderAndroidWindowDumps(
  device: DeviceInfo,
  name: AndroidWindowQuestionName,
): readonly (readonly string[])[] {
  const everAnswered = androidWindowDumpEverAnswered.get(device.id);
  return ANDROID_WINDOW_QUESTIONS[name].tiers.flatMap((tier) =>
    orderAndroidWindowDumpTier(tier, name, everAnswered),
  );
}

function orderAndroidWindowDumpTier(
  tier: AndroidWindowDumpTier,
  name: AndroidWindowQuestionName,
  everAnswered: Map<string, boolean> | undefined,
): AndroidWindowDumpTier {
  if (!everAnswered) return tier;
  const demoted = (args: readonly string[]) =>
    everAnswered.get(androidWindowDumpMemoKey(name, args.join(' '))) === false;
  const promoted = tier.filter((args) => !demoted(args));
  // Nothing to gain, and a whole tier of demoted variants must keep its place rather than let the
  // next tier — which answers with lower authority — take the question first.
  if (promoted.length === tier.length || promoted.length === 0) return tier;
  return [...promoted, ...tier.filter(demoted)];
}

function androidWindowDumpMemoKey(name: AndroidWindowQuestionName, command: string): string {
  return `${name} ${command}`;
}

function markerSectionPattern(markers: readonly string[]): RegExp {
  return new RegExp(markers.map(escapeRegExp).join('|'));
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
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
