import type { AndroidBlockingDialogObservation } from '@agent-device/contracts/android-observation';

export type AndroidBlockingDialogFocus = {
  package?: string;
  process?: string;
  focusedWindow: string;
  raw: string;
};

/**
 * The one marker that names the focused WINDOW. A blocking dialog is a window title, so this is the
 * only line that can carry one: `mFocusedApp=AppWindowToken{…}` names the focused app token and
 * `mResumedActivity:` names an activity record, and neither can hold "Application Not Responding:
 * …" (#592).
 */
export const ANDROID_FOCUSED_WINDOW_MARKER = 'mCurrentFocus=Window{';

/** Markers that name the ActivityManager resumed activity in a `dumpsys activity` dump. */
export const ANDROID_RESUMED_ACTIVITY_MARKERS = [
  'mResumedActivity:',
  'ResumedActivity:',
  'topResumedActivity=',
] as const;

/** The line prefixes a `dumpsys` dump uses to name the focused window or resumed activity. */
export const ANDROID_FOCUS_MARKERS = [
  ANDROID_FOCUSED_WINDOW_MARKER,
  'mFocusedApp=AppWindowToken{',
  'mResumedActivity:',
  'ResumedActivity:',
] as const;
/** A process name keeps its `:suffix`: `android:process=":worker"` runs as `<package>:worker`. */
const ANDROID_ANR_TITLE_PATTERN = /\bApplication Not Responding:\s*([A-Za-z0-9_.:]+)/i;
const ANDROID_PROCESS_PATTERN = /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+(?::[A-Za-z0-9_.]+)?)/;
const ANDROID_COMPONENT_PATTERN =
  /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)/;

/**
 * The first `package/Activity` component in a dump segment. Callers choose the segment (a marker's
 * line remainder, or the window text up to `}`) and the marker order.
 */
export function parseAndroidComponent(
  segment: string,
): { package: string; activity: string } | null {
  const match = ANDROID_COMPONENT_PATTERN.exec(segment);
  return match?.[1] && match[2] ? { package: match[1], activity: match[2] } : null;
}

export function parseAndroidLaunchablePackages(stdout: string): string[] {
  const packages = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstToken = trimmed.split(/\s+/)[0] ?? '';
    if (!firstToken.includes('/')) continue;
    const pkg = firstToken.split('/')[0] ?? '';
    if (!pkg.includes('.')) continue;
    if (pkg) packages.add(pkg);
  }
  return Array.from(packages);
}

export function parseAndroidUserInstalledPackages(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line: string) => {
      const trimmed = line.trim();
      return trimmed.startsWith('package:') ? trimmed.slice('package:'.length) : trimmed;
    })
    .filter(Boolean);
}

/**
 * What one window dump can say about a blocking system dialog.
 *
 * `focusObserved` separates "this dump does not show a blocking dialog" from "this dump does not
 * show the focused window at all". Only the second is a miss worth spending another `dumpsys`
 * variant on: a dump that names the focused window and no ANR title has already answered the
 * question.
 *
 * Only {@link ANDROID_FOCUSED_WINDOW_MARKER} sets it, because only that line can carry an ANR
 * title. The other markers are still parsed — the marker order is unchanged (#592) — but a dump
 * that names just the focused app token has NOT answered this question and must not suppress the
 * variant that can.
 *
 * `focusedPackage` is the package of the `package/Activity` component the first focused-window
 * line names. A window without a component (a popup, the keyboard, the notification shade) names
 * no package.
 */
export type AndroidBlockingDialogRead = {
  focusObserved: boolean;
  focus: AndroidBlockingDialogFocus | null;
  focusedPackage?: string;
};

export function readAndroidBlockingDialogFocus(text: string): AndroidBlockingDialogRead {
  let focusObserved = false;
  let focusedPackage: string | undefined;
  const focus = parseAndroidFocusSegment(text, (segment, raw, marker) => {
    if (marker === ANDROID_FOCUSED_WINDOW_MARKER && !focusObserved) {
      focusObserved = true;
      focusedPackage = parseAndroidComponent(segment.split('}')[0] ?? '')?.package;
    }
    return parseAndroidBlockingDialogFromSegment(segment, raw);
  });
  return { focusObserved, focus, ...(focusedPackage ? { focusedPackage } : {}) };
}

/** A clear blocking-dialog observation that names the focused package when the read did. */
export function clearAndroidBlockingDialogObservation(
  focusedPackage: string | undefined,
): Extract<AndroidBlockingDialogObservation, { status: 'clear' }> {
  return focusedPackage ? { status: 'clear', focusedPackage } : { status: 'clear' };
}

export function parseAndroidFocusSegment<T>(
  text: string,
  parse: (segment: string, raw: string, marker: string) => T | null,
): T | null {
  const lines = text.split('\n');
  for (const marker of ANDROID_FOCUS_MARKERS) {
    for (const line of lines) {
      const markerIndex = line.indexOf(marker);
      if (markerIndex === -1) continue;
      const raw = line.trim();
      const parsed = parse(line.slice(markerIndex + marker.length), raw, marker);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * Reads the resumed activity out of an AMS dump (`dumpsys activity …`). Only a
 * resumed-marker line counts: an activity dump lists the whole back stack, so any
 * other `package/Activity` token is not evidence about what is resumed.
 */
export function parseAndroidResumedActivity(
  text: string,
): { package: string; activity: string } | null {
  for (const line of text.split('\n')) {
    for (const marker of ANDROID_RESUMED_ACTIVITY_MARKERS) {
      const markerIndex = line.indexOf(marker);
      // Unanchored match would also hit stale fields such as `mLastResumedActivity:`: a
      // marker only counts at the start of a field, i.e. at line start or after whitespace.
      if (markerIndex === -1 || (markerIndex > 0 && /\S/.test(line[markerIndex - 1] ?? '')))
        continue;
      const component = parseAndroidComponent(line.slice(markerIndex + marker.length));
      if (component) return component;
    }
  }
  return null;
}

function parseAndroidBlockingDialogFromSegment(
  segment: string,
  raw: string,
): AndroidBlockingDialogFocus | null {
  const windowText = segment.split('}')[0]?.trim() ?? segment.trim();
  const anrMatch = ANDROID_ANR_TITLE_PATTERN.exec(windowText);
  if (anrMatch) {
    const processName = anrMatch[1];
    return {
      process: processName,
      focusedWindow: `Application Not Responding: ${processName}`,
      raw,
    };
  }

  const normalizedWindowText = windowText.toLowerCase();
  if (
    !normalizedWindowText.includes("isn't responding") &&
    !normalizedWindowText.includes('is not responding')
  ) {
    return null;
  }
  const focusedWindow = windowText.trim().replaceAll(/\s+/g, ' ');
  const processName = ANDROID_PROCESS_PATTERN.exec(focusedWindow)?.[1];
  return {
    ...(processName ? { process: processName } : {}),
    focusedWindow,
    raw,
  };
}

/** One process record of a `dumpsys activity processes` dump. */
export type AndroidProcessRecord = {
  process: string;
  packages: string[];
  notResponding: boolean;
};

const ANDROID_PROCESS_RECORD_PATTERN =
  /^\s*\*[A-Z]+\*.*\bProcessRecord\{[0-9a-f]+ \d+:([^/\s}]+)\//;
const ANDROID_PACKAGE_LIST_PATTERN = /^\s*packageList=\{([^}]*)\}/;
/** Android 12 and later print `mNotResponding=true`; earlier versions print `notResponding=true`. */
const ANDROID_NOT_RESPONDING_PATTERN = /(?:^|\s)m?notResponding=true\b/i;

/**
 * Reads the process records of a `dumpsys activity processes` dump. A record starts at a
 * `*APP*`-style line, and its `packageList` names the packages that run in that process. Other
 * lines that mention a ProcessRecord (PID mappings, home process) do not start a record.
 */
export function parseAndroidProcessRecords(text: string): AndroidProcessRecord[] {
  const records: AndroidProcessRecord[] = [];
  let current: AndroidProcessRecord | undefined;
  for (const line of text.split('\n')) {
    const recordMatch = ANDROID_PROCESS_RECORD_PATTERN.exec(line);
    if (recordMatch?.[1]) {
      current = { process: recordMatch[1], packages: [], notResponding: false };
      records.push(current);
      continue;
    }
    if (!current) continue;
    const packageList = ANDROID_PACKAGE_LIST_PATTERN.exec(line)?.[1];
    if (packageList !== undefined) {
      current.packages = packageList
        .split(/[,\s]+/)
        .map((name) => name.trim())
        .filter(Boolean);
    }
    if (ANDROID_NOT_RESPONDING_PATTERN.test(line)) current.notResponding = true;
  }
  return records;
}

/**
 * The one package that owns `processName`, or undefined when no record names the process or its
 * records name more than one package. An undefined owner must not be treated as the session app.
 */
export function resolveAndroidProcessOwner(
  records: readonly AndroidProcessRecord[],
  processName: string,
): string | undefined {
  const owners = new Set(
    records.filter((record) => record.process === processName).flatMap((record) => record.packages),
  );
  return owners.size === 1 ? [...owners][0] : undefined;
}
