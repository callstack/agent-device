import { AppError } from '../../kernel/errors.ts';
import type { AndroidAdbExecutor } from './adb-executor.ts';
import { isAmStartError, parseAndroidLaunchComponent } from './app-lifecycle.ts';

const ANDROID_LAUNCHER_CATEGORY = 'android.intent.category.LAUNCHER';
const ANDROID_DEFAULT_CATEGORY = 'android.intent.category.DEFAULT';

export type AndroidOpenAppWithAdbOptions = {
  activity?: string;
  category?: string;
};

export async function forceStopAndroidAppWithAdb(
  adb: AndroidAdbExecutor,
  packageName: string,
): Promise<void> {
  await adb(['shell', 'am', 'force-stop', packageName]);
}

async function resolveAndroidLaunchComponentWithAdb(
  adb: AndroidAdbExecutor,
  packageName: string,
  categories: string[] = [ANDROID_LAUNCHER_CATEGORY],
): Promise<string | null> {
  for (const category of categories) {
    const result = await adb(
      [
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-a',
        'android.intent.action.MAIN',
        '-c',
        category,
        packageName,
      ],
      { allowFailure: true },
    );
    if (result.exitCode !== 0) continue;
    const component = parseAndroidLaunchComponent(result.stdout);
    if (component) return component;
  }
  return null;
}

export async function openAndroidAppWithAdb(
  adb: AndroidAdbExecutor,
  packageName: string,
  options: AndroidOpenAppWithAdbOptions = {},
): Promise<void> {
  const category = options.category ?? ANDROID_LAUNCHER_CATEGORY;
  if (options.activity) {
    await adb([
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      ANDROID_DEFAULT_CATEGORY,
      '-c',
      category,
      '-n',
      normalizeAndroidComponent(packageName, options.activity),
    ]);
    return;
  }

  const primary = await adb(
    [
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      ANDROID_DEFAULT_CATEGORY,
      '-c',
      category,
      '-p',
      packageName,
    ],
    { allowFailure: true },
  );
  if (primary.exitCode === 0 && !isAmStartError(primary.stdout, primary.stderr)) {
    return;
  }

  const component = await resolveAndroidLaunchComponentWithAdb(adb, packageName, [category]);
  if (!component) {
    // exec-guard-allow: reachable at exit 0 (am start "succeeds" with an error
    // in its output); the trio is the primary attempt's context, not an exit wrap.
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to resolve Android launch component for ${packageName}`,
      {
        stdout: primary.stdout,
        stderr: primary.stderr,
        exitCode: primary.exitCode,
      },
    );
  }
  await adb([
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    ANDROID_DEFAULT_CATEGORY,
    '-c',
    category,
    '-n',
    component,
  ]);
}

function normalizeAndroidComponent(packageName: string, activity: string): string {
  if (activity.includes('/')) return activity;
  return `${packageName}/${activity.startsWith('.') ? activity : `.${activity}`}`;
}
