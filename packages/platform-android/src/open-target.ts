export type AndroidAppTargetKind = 'package' | 'binary' | 'other';

const ANDROID_BINARY_TARGET_EXTENSION = /\.(?:apk|aab)$/i;
const ANDROID_PACKAGE_NAME_PATTERN = /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)+$/;

export function classifyAndroidAppTarget(target: string): AndroidAppTargetKind {
  const trimmed = target.trim();
  if (trimmed.length === 0) return 'other';
  if (!ANDROID_BINARY_TARGET_EXTENSION.test(trimmed)) {
    return looksLikeAndroidPackageName(trimmed) ? 'package' : 'other';
  }

  const looksLikePath =
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.startsWith('.') ||
    trimmed.startsWith('~');
  if (looksLikePath || !looksLikeAndroidPackageName(trimmed)) {
    return 'binary';
  }
  return 'package';
}

function looksLikeAndroidPackageName(value: string): boolean {
  return ANDROID_PACKAGE_NAME_PATTERN.test(value);
}

export function formatAndroidInstalledPackageRequiredMessage(target: string): string {
  return `Android runtime hints require an installed package name, not "${target}". Install or reinstall the app first, then relaunch by package.`;
}
