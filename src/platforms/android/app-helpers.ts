import { AppError } from '../../kernel/errors.ts';
import { execFailureDetails } from '../../utils/exec.ts';
import { resolveAppsFilter, type AppsFilter } from '../../contracts/app-inventory.ts';
import type { AndroidAdbExecutor } from './adb-executor.ts';
import {
  parseAndroidForegroundApp,
  parseAndroidLaunchablePackages,
  parseAndroidUserInstalledPackages,
  type AndroidForegroundApp,
} from './app-parsers.ts';
import { inferAndroidAppName } from './app-lifecycle.ts';

const ANDROID_LAUNCHER_CATEGORY = 'android.intent.category.LAUNCHER';
const ANDROID_LEANBACK_CATEGORY = 'android.intent.category.LEANBACK_LAUNCHER';

export type AndroidAppListFilter = AppsFilter;
export type AndroidAppListTarget = 'mobile' | 'tv' | 'auto';

export type AndroidAppListOptions = {
  filter?: AndroidAppListFilter;
  target?: AndroidAppListTarget;
};

export async function listAndroidAppsWithAdb(
  adb: AndroidAdbExecutor,
  options: AndroidAppListOptions = {},
): Promise<Array<{ package: string; name: string }>> {
  const launchable = await listAndroidLaunchablePackagesWithAdb(adb, options.target ?? 'auto');
  const filter = resolveAppsFilter(options.filter);
  const packageIds =
    filter === 'user-installed'
      ? (await listAndroidUserInstalledPackagesWithAdb(adb)).filter((pkg) => launchable.has(pkg))
      : Array.from(launchable);
  return packageIds
    .map((packageName) => ({ package: packageName, name: inferAndroidAppName(packageName) }))
    .sort((a, b) => a.package.localeCompare(b.package));
}

export async function getAndroidAppStateWithAdb(
  adb: AndroidAdbExecutor,
): Promise<AndroidForegroundApp> {
  const windowFocus = await readAndroidFocusWithAdb(adb, [
    ['shell', 'dumpsys', 'window', 'windows'],
    ['shell', 'dumpsys', 'window'],
  ]);
  if (windowFocus) return windowFocus;

  const activityFocus = await readAndroidFocusWithAdb(adb, [
    ['shell', 'dumpsys', 'activity', 'activities'],
    ['shell', 'dumpsys', 'activity'],
  ]);
  if (activityFocus) return activityFocus;
  return {};
}

async function listAndroidLaunchablePackagesWithAdb(
  adb: AndroidAdbExecutor,
  target: AndroidAppListTarget,
): Promise<Set<string>> {
  const discoveredPackages = (
    await Promise.all(
      resolveAndroidLaunchCategoriesForAdb(target).map(async (category) => {
        const result = await adb(buildAndroidQueryActivitiesArgs(category), {
          allowFailure: true,
        });
        return result.exitCode === 0 ? parseAndroidLaunchablePackageOutput(result.stdout) : [];
      }),
    )
  ).flat();
  return new Set(discoveredPackages);
}

function resolveAndroidLaunchCategoriesForAdb(target: AndroidAppListTarget): string[] {
  switch (target) {
    case 'mobile':
      return [ANDROID_LAUNCHER_CATEGORY];
    case 'tv':
      return [ANDROID_LEANBACK_CATEGORY];
    default:
      return [ANDROID_LAUNCHER_CATEGORY, ANDROID_LEANBACK_CATEGORY];
  }
}

function buildAndroidQueryActivitiesArgs(category: string): string[] {
  return [
    'shell',
    'cmd',
    'package',
    'query-activities',
    '--brief',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    category,
  ];
}

function parseAndroidLaunchablePackageOutput(stdout: string): string[] {
  return stdout.trim().length === 0 ? [] : parseAndroidLaunchablePackages(stdout);
}

async function listAndroidUserInstalledPackagesWithAdb(adb: AndroidAdbExecutor): Promise<string[]> {
  const result = await adb(['shell', 'pm', 'list', 'packages', '-3'], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to list Android user-installed apps',
      execFailureDetails(result),
    );
  }
  return parseAndroidUserInstalledPackages(result.stdout);
}

async function readAndroidFocusWithAdb(
  adb: AndroidAdbExecutor,
  commands: string[][],
): Promise<AndroidForegroundApp | null> {
  for (const args of commands) {
    const result = await adb(args, { allowFailure: true });
    const parsed = parseAndroidForegroundApp(result.stdout ?? '');
    if (parsed) return parsed;
  }
  return null;
}
