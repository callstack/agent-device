import { resolveAppsFilter, type AppsFilter } from '@agent-device/contracts/device';
import { androidAdbResultError, runAdbShell, type AndroidAdbExecutor } from './adb-executor.ts';
import {
  parseAndroidLaunchablePackages,
  parseAndroidUserInstalledPackages,
} from './app-parsers.ts';
import { inferAndroidAppName } from './app-deployment-resolution.ts';
import { androidLauncherCategories } from './launcher-categories.ts';

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

async function listAndroidLaunchablePackagesWithAdb(
  adb: AndroidAdbExecutor,
  target: AndroidAppListTarget,
): Promise<Set<string>> {
  const discoveredPackages = (
    await Promise.all(
      androidLauncherCategories(target, { includeFallbackCategories: true }).map(
        async (category) => {
          const result = await runAdbShell(adb, buildAndroidQueryActivitiesArgs(category), {
            allowFailure: true,
          });
          return result.exitCode === 0 ? parseAndroidLaunchablePackageOutput(result.stdout) : [];
        },
      ),
    )
  ).flat();
  return new Set(discoveredPackages);
}

function buildAndroidQueryActivitiesArgs(category: string): string[] {
  return [
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
  const result = await runAdbShell(adb, ['pm', 'list', 'packages', '-3'], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw androidAdbResultError('Failed to list Android user-installed apps', result);
  }
  return parseAndroidUserInstalledPackages(result.stdout);
}
