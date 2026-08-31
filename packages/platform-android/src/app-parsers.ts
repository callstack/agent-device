export type AndroidBlockingDialogFocus = {
  package?: string;
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

/** The line prefixes a `dumpsys` dump uses to name the focused window or resumed activity. */
export const ANDROID_FOCUS_MARKERS = [
  ANDROID_FOCUSED_WINDOW_MARKER,
  'mFocusedApp=AppWindowToken{',
  'mResumedActivity:',
  'ResumedActivity:',
] as const;
const ANDROID_ANR_TITLE_PATTERN = /\bApplication Not Responding:\s*([A-Za-z0-9_.]+)/i;
const ANDROID_PACKAGE_PATTERN = /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\b/;

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
 */
export type AndroidBlockingDialogRead = {
  focusObserved: boolean;
  focus: AndroidBlockingDialogFocus | null;
};

export function readAndroidBlockingDialogFocus(text: string): AndroidBlockingDialogRead {
  let focusObserved = false;
  const focus = parseAndroidFocusSegment(text, (segment, raw, marker) => {
    if (marker === ANDROID_FOCUSED_WINDOW_MARKER) focusObserved = true;
    return parseAndroidBlockingDialogFromSegment(segment, raw);
  });
  return { focusObserved, focus };
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

function parseAndroidBlockingDialogFromSegment(
  segment: string,
  raw: string,
): AndroidBlockingDialogFocus | null {
  const windowText = segment.split('}')[0]?.trim() ?? segment.trim();
  const anrMatch = ANDROID_ANR_TITLE_PATTERN.exec(windowText);
  if (anrMatch) {
    const packageName = anrMatch[1];
    return {
      package: packageName,
      focusedWindow: `Application Not Responding: ${packageName}`,
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
  const packageName = ANDROID_PACKAGE_PATTERN.exec(focusedWindow)?.[1];
  return {
    ...(packageName ? { package: packageName } : {}),
    focusedWindow,
    raw,
  };
}
