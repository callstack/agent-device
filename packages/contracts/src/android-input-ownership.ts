export type AndroidInputOwner = 'app' | 'ime' | 'unknown';

const KNOWN_ANDROID_IME_PACKAGES = new Set([
  'com.google.android.inputmethod.latin',
  'com.samsung.android.honeyboard',
  'com.touchtype.swiftkey',
  'com.microsoft.swiftkey',
]);

export type AndroidInputOwnershipSource =
  | 'active-input-method'
  | 'active-input-method-resource'
  | 'known-ime-package'
  | 'known-ime-resource'
  | 'app';

export type AndroidInputOwnership = {
  inputMethodOwned: boolean;
  source: AndroidInputOwnershipSource;
};

export function classifyAndroidInputOwnership(options: {
  packageName: string | null | undefined;
  resourceId?: string | null | undefined;
  activeInputMethodPackage?: string | null | undefined;
}): AndroidInputOwnership {
  const packageName = normalizeAndroidPackageName(options.packageName);
  const resourceId = (options.resourceId ?? '').toLowerCase();
  const activeInputMethodPackage = normalizeAndroidPackageName(options.activeInputMethodPackage);

  if (packageName && activeInputMethodPackage && packageName === activeInputMethodPackage) {
    return { inputMethodOwned: true, source: 'active-input-method' };
  }
  if (activeInputMethodPackage && resourceId.startsWith(`${activeInputMethodPackage}:id/`)) {
    return { inputMethodOwned: true, source: 'active-input-method-resource' };
  }

  if (packageName && KNOWN_ANDROID_IME_PACKAGES.has(packageName)) {
    return { inputMethodOwned: true, source: 'known-ime-package' };
  }

  for (const knownPackageName of KNOWN_ANDROID_IME_PACKAGES) {
    if (resourceId.startsWith(`${knownPackageName}:id/`)) {
      return { inputMethodOwned: true, source: 'known-ime-resource' };
    }
  }

  return { inputMethodOwned: false, source: 'app' };
}

function isAndroidInputMethodOwned(
  packageName: string | null | undefined,
  resourceId?: string | null | undefined,
  activeInputMethodPackage?: string | null | undefined,
): boolean {
  return classifyAndroidInputOwnership({
    packageName,
    resourceId,
    activeInputMethodPackage,
  }).inputMethodOwned;
}

export function isAndroidInputMethodOwnedNode(options: {
  packageName: string | null | undefined;
  resourceId?: string | null | undefined;
  activeInputMethodPackage?: string | null | undefined;
}): boolean {
  return classifyAndroidInputOwnership(options).inputMethodOwned;
}

export function isFallbackAndroidInputMethodPackage(
  packageName: string | null | undefined,
): boolean {
  const normalizedPackageName = normalizeAndroidPackageName(packageName);
  return Boolean(normalizedPackageName && KNOWN_ANDROID_IME_PACKAGES.has(normalizedPackageName));
}

export function isFallbackAndroidInputMethodResource(
  resourceId: string | null | undefined,
): boolean {
  const normalizedResourceId = (resourceId ?? '').toLowerCase();
  for (const packageName of KNOWN_ANDROID_IME_PACKAGES) {
    if (normalizedResourceId.startsWith(`${packageName}:id/`)) return true;
  }
  return false;
}

export function classifyAndroidInputOwner(
  packageName: string | null | undefined,
  resourceId?: string | null,
  activeInputMethodPackage?: string | null,
): AndroidInputOwner {
  if (!packageName && !resourceId) return 'unknown';
  return isAndroidInputMethodOwned(packageName, resourceId, activeInputMethodPackage)
    ? 'ime'
    : 'app';
}

export function readAndroidActiveInputMethodPackage(stdout: string): string | undefined {
  for (const pattern of [
    /\bmCurMethodId=([^\s]+)/i,
    /\bmCurId=([^\s]+)/i,
    /\bmCurrentInputMethodId=([^\s]+)/i,
    /\bcurMethodId=([^\s]+)/i,
  ]) {
    const match = stdout.match(pattern);
    const packageName = parseAndroidInputMethodPackage(match?.[1]);
    if (packageName) return packageName;
  }
  return undefined;
}

export function parseAndroidInputMethodPackage(
  value: string | null | undefined,
): string | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  const packageSegment = trimmed.split('/')[0] ?? '';
  const match = packageSegment.match(/[a-zA-Z0-9_.]+/);
  return normalizeAndroidPackageName(match?.[0]);
}

function normalizeAndroidPackageName(value: string | null | undefined): string | undefined {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized || undefined;
}
