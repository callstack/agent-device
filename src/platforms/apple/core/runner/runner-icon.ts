import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../../kernel/errors.ts';
import { execFailureDetails } from '../../../../utils/exec.ts';
import { readApplePlistJson, runAppleToolCommand } from '../tool-provider.ts';

const ICON_PLIST_KEYS = ['CFBundleIcons', 'CFBundleIcons~ipad'] as const;

type IconPlistChange = {
  key: (typeof ICON_PLIST_KEYS)[number];
  value: unknown;
  shouldInsert: boolean;
};

export async function applyXctestRunnerAppIconFromDerivedPath(derivedPath: string): Promise<void> {
  await applyXctestRunnerAppIcon(findDerivedProductApps(derivedPath));
}

export async function applyXctestRunnerAppIcon(productPaths: readonly string[]): Promise<void> {
  const runnerApps = productPaths.filter(isSimulatorXctestRunnerApp);
  if (runnerApps.length === 0) {
    return;
  }

  const sourceApps = productPaths.filter(
    (productPath) => isAppBundle(productPath) && !isXctestRunnerAppName(productPath),
  );
  for (const runnerAppPath of runnerApps) {
    const sourceAppPath = findCompanionSourceApp(runnerAppPath, sourceApps);
    if (!sourceAppPath) {
      continue;
    }
    await applyCompanionAppIcon(sourceAppPath, runnerAppPath);
  }
}

async function applyCompanionAppIcon(sourceAppPath: string, runnerAppPath: string): Promise<void> {
  const copiedIcon = copyIconArtifactsIfChanged(sourceAppPath, runnerAppPath);
  const updatedPlist = await copyIconPlistEntries(sourceAppPath, runnerAppPath);

  if (copiedIcon || updatedPlist) {
    await codesignRunnerApp(runnerAppPath);
    touchBundleDirectory(runnerAppPath);
  }
}

function copyIconArtifactsIfChanged(sourceAppPath: string, runnerAppPath: string): boolean {
  let copied = false;
  for (const entry of fs.readdirSync(sourceAppPath, { withFileTypes: true })) {
    if (!entry.isFile() || !isIconArtifact(entry.name)) {
      continue;
    }
    const sourcePath = path.join(sourceAppPath, entry.name);
    const destinationPath = path.join(runnerAppPath, entry.name);
    if (copyFileIfChanged(sourcePath, destinationPath)) {
      copied = true;
    }
  }
  return copied;
}

async function copyIconPlistEntries(
  sourceAppPath: string,
  runnerAppPath: string,
): Promise<boolean> {
  const sourcePlistPath = path.join(sourceAppPath, 'Info.plist');
  const runnerPlistPath = path.join(runnerAppPath, 'Info.plist');
  const sourcePlist = await readApplePlistJson(sourcePlistPath);
  const runnerPlist = await readApplePlistJson(runnerPlistPath);

  if (!sourcePlist || !runnerPlist) {
    return false;
  }

  const changes = collectIconPlistChanges(sourcePlist, runnerPlist);
  if (changes.length === 0) {
    return false;
  }
  for (const change of changes) {
    await writeIconPlistValue(runnerPlistPath, change.key, change.value, change.shouldInsert);
  }
  return true;
}

function collectIconPlistChanges(
  sourcePlist: Record<string, unknown>,
  runnerPlist: Record<string, unknown>,
): IconPlistChange[] {
  return ICON_PLIST_KEYS.flatMap((key) => {
    const value = sourcePlist[key];
    if (value === undefined || JSON.stringify(runnerPlist[key]) === JSON.stringify(value)) {
      return [];
    }
    return [{ key, value, shouldInsert: runnerPlist[key] === undefined }];
  });
}

async function writeIconPlistValue(
  plistPath: string,
  key: (typeof ICON_PLIST_KEYS)[number],
  value: unknown,
  shouldInsert: boolean,
): Promise<void> {
  const result = await runAppleToolCommand(
    'plutil',
    [shouldInsert ? '-insert' : '-replace', key, '-json', JSON.stringify(value), plistPath],
    { allowFailure: true },
  );
  if (result.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to update XCTest runner icon plist',
      execFailureDetails(result, { key, plistPath }),
    );
  }
}

async function codesignRunnerApp(runnerAppPath: string): Promise<void> {
  const result = await runAppleToolCommand(
    'codesign',
    ['--force', '--sign', '-', '--timestamp=none', '--generate-entitlement-der', runnerAppPath],
    { allowFailure: true },
  );
  if (result.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to sign XCTest runner app after icon update',
      execFailureDetails(result, { runnerAppPath }),
    );
  }
}

function copyFileIfChanged(sourcePath: string, destinationPath: string): boolean {
  if (fs.existsSync(destinationPath)) {
    const source = fs.readFileSync(sourcePath);
    const destination = fs.readFileSync(destinationPath);
    if (source.equals(destination)) {
      return false;
    }
    fs.copyFileSync(sourcePath, destinationPath);
    return true;
  }
  fs.copyFileSync(sourcePath, destinationPath);
  return true;
}

function isIconArtifact(fileName: string): boolean {
  return /^AppIcon.*\.png$/.test(fileName) || fileName === 'Assets.car';
}

function touchBundleDirectory(bundlePath: string): void {
  const now = new Date();
  fs.utimesSync(bundlePath, now, now);
}

function findCompanionSourceApp(
  runnerAppPath: string,
  sourceApps: readonly string[],
): string | null {
  const runnerParent = path.dirname(runnerAppPath);
  return (
    sourceApps.find(
      (sourceAppPath) =>
        path.dirname(sourceAppPath) === runnerParent &&
        path.basename(sourceAppPath) === 'AgentDeviceRunner.app',
    ) ??
    sourceApps.find(
      (sourceAppPath) =>
        path.dirname(sourceAppPath) === runnerParent && sourceAppPath !== runnerAppPath,
    ) ??
    null
  );
}

function isSimulatorXctestRunnerApp(productPath: string): boolean {
  // Device runner bundles require their original device signing identity; patch simulator products only.
  return (
    isAppBundle(productPath) &&
    isXctestRunnerAppName(productPath) &&
    (productPath.includes('Debug-iphonesimulator') ||
      productPath.includes('Release-iphonesimulator') ||
      productPath.includes('Debug-appletvsimulator') ||
      productPath.includes('Release-appletvsimulator'))
  );
}

function isXctestRunnerAppName(productPath: string): boolean {
  return path.basename(productPath).endsWith('-Runner.app');
}

function isAppBundle(productPath: string): boolean {
  return path.basename(productPath).endsWith('.app');
}

function findDerivedProductApps(derivedPath: string): string[] {
  if (!fs.existsSync(derivedPath)) {
    return [];
  }

  const apps: string[] = [];
  const stack = [derivedPath];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const fullPath = path.join(current, entry.name);
      if (isAppBundle(fullPath)) {
        apps.push(fullPath);
        continue;
      }
      stack.push(fullPath);
    }
  }
  return apps.sort((a, b) => a.localeCompare(b));
}
