export type AndroidBlockingDialogFocus = {
  package?: string;
  focusedWindow: string;
  raw: string;
};

const ANDROID_FOCUS_MARKERS = [
  'mCurrentFocus=Window{',
  'mFocusedApp=AppWindowToken{',
  'mResumedActivity:',
  'ResumedActivity:',
] as const;
const ANDROID_ANR_TITLE_PATTERN = /\bApplication Not Responding:\s*([A-Za-z0-9_.]+)/i;
const ANDROID_RESPONDING_TITLE_PATTERN = /([^{}]*\bis(?:n't| not)\s+responding[^{}]*)/i;
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

export function parseAndroidBlockingDialogFocus(text: string): AndroidBlockingDialogFocus | null {
  return parseAndroidFocusSegment(text, (segment, raw) =>
    parseAndroidBlockingDialogFromSegment(segment, raw),
  );
}

function parseAndroidFocusSegment<T>(
  text: string,
  parse: (segment: string, raw: string) => T | null,
): T | null {
  const lines = text.split('\n');
  for (const marker of ANDROID_FOCUS_MARKERS) {
    for (const line of lines) {
      const markerIndex = line.indexOf(marker);
      if (markerIndex === -1) continue;
      const raw = line.trim();
      const parsed = parse(line.slice(markerIndex + marker.length), raw);
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

  const respondingMatch = ANDROID_RESPONDING_TITLE_PATTERN.exec(windowText);
  if (!respondingMatch) return null;

  const focusedWindowTitle = respondingMatch[1];
  if (focusedWindowTitle === undefined) return null;
  const focusedWindow = focusedWindowTitle.trim().replace(/\s+/g, ' ');
  const packageName = ANDROID_PACKAGE_PATTERN.exec(focusedWindow)?.[1];
  return {
    ...(packageName ? { package: packageName } : {}),
    focusedWindow,
    raw,
  };
}
