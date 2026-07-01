import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import {
  applyXctestRunnerAppIcon,
  applyXctestRunnerAppIconFromDerivedPath,
} from '../runner/runner-icon.ts';

type AppleToolCall = [string, string[]];

const IPHONE_ICON_PLIST = {
  CFBundlePrimaryIcon: {
    CFBundleIconFiles: ['AppIcon60x60'],
    CFBundleIconName: 'AppIcon',
  },
};

const IPAD_ICON_PLIST = {
  CFBundlePrimaryIcon: {
    CFBundleIconFiles: ['AppIcon76x76'],
    CFBundleIconName: 'AppIcon',
  },
};

async function withTempDir<T>(prefix: string, fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function applyPlutilMutation(args: string[]): void {
  const [operation, key, type, rawValue, plistPath] = args;
  assert.match(operation as string, /^-(insert|replace)$/);
  assert.equal(type, '-json');
  const plist = JSON.parse(fs.readFileSync(plistPath as string, 'utf8')) as Record<string, unknown>;
  plist[key as string] = JSON.parse(rawValue as string);
  fs.writeFileSync(plistPath as string, JSON.stringify(plist));
}

function makeProductApps(root: string, configuration: string): [string, string] {
  const productsDir = path.join(root, 'Build', 'Products', configuration);
  const sourceAppPath = path.join(productsDir, 'AgentDeviceRunner.app');
  const runnerAppPath = path.join(productsDir, 'AgentDeviceRunnerUITests-Runner.app');
  fs.mkdirSync(sourceAppPath, { recursive: true });
  fs.mkdirSync(runnerAppPath, { recursive: true });
  return [sourceAppPath, runnerAppPath];
}

function writeJsonPlist(appPath: string, value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(appPath, 'Info.plist'), JSON.stringify(value));
}

function createRecordingProvider(calls: AppleToolCall[], mutatePlist = false) {
  return createLocalAppleToolProvider({
    runCommand: async (cmd, args) => {
      calls.push([cmd, args]);
      if (mutatePlist && cmd === 'plutil') {
        applyPlutilMutation(args);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    plist: {
      readJson: async (plistPath) => JSON.parse(fs.readFileSync(plistPath, 'utf8')),
    },
  });
}

function expectedPlutilIconCalls(runnerAppPath: string): AppleToolCall[] {
  const plistPath = path.join(runnerAppPath, 'Info.plist');
  return [
    ['plutil', ['-insert', 'CFBundleIcons', '-json', JSON.stringify(IPHONE_ICON_PLIST), plistPath]],
    [
      'plutil',
      ['-insert', 'CFBundleIcons~ipad', '-json', JSON.stringify(IPAD_ICON_PLIST), plistPath],
    ],
  ];
}

test('copies app icon artifacts into synthesized simulator XCTest runner app', async () => {
  await withTempDir('agent-device-runner-icon-', async (root) => {
    const [sourceAppPath, runnerAppPath] = makeProductApps(root, 'Debug-iphonesimulator');
    fs.writeFileSync(path.join(sourceAppPath, 'AppIcon60x60@2x.png'), 'icon');
    fs.writeFileSync(path.join(sourceAppPath, 'Assets.car'), 'catalog');
    writeJsonPlist(sourceAppPath, {
      CFBundleIcons: IPHONE_ICON_PLIST,
      'CFBundleIcons~ipad': IPAD_ICON_PLIST,
    });
    writeJsonPlist(runnerAppPath, { CFBundleName: 'XCTRunner' });

    const calls: AppleToolCall[] = [];
    const provider = createRecordingProvider(calls, true);

    await withAppleToolProvider(
      provider,
      async () => await applyXctestRunnerAppIcon([sourceAppPath, runnerAppPath]),
    );

    assert.equal(fs.readFileSync(path.join(runnerAppPath, 'AppIcon60x60@2x.png'), 'utf8'), 'icon');
    assert.equal(fs.readFileSync(path.join(runnerAppPath, 'Assets.car'), 'utf8'), 'catalog');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runnerAppPath, 'Info.plist'), 'utf8')), {
      CFBundleName: 'XCTRunner',
      CFBundleIcons: IPHONE_ICON_PLIST,
      'CFBundleIcons~ipad': IPAD_ICON_PLIST,
    });
    assert.deepEqual(calls.slice(0, 2), expectedPlutilIconCalls(runnerAppPath));
    assert.deepEqual(calls.at(-1), [
      'codesign',
      ['--force', '--sign', '-', '--timestamp=none', '--generate-entitlement-der', runnerAppPath],
    ]);
  });
});

test('skips signing when synthesized simulator XCTest runner app is already patched', async () => {
  await withTempDir('agent-device-runner-icon-', async (root) => {
    const [sourceAppPath, runnerAppPath] = makeProductApps(root, 'Debug-iphonesimulator');
    fs.writeFileSync(path.join(sourceAppPath, 'AppIcon60x60@2x.png'), 'icon');
    fs.writeFileSync(path.join(runnerAppPath, 'AppIcon60x60@2x.png'), 'icon');
    fs.writeFileSync(path.join(sourceAppPath, 'Assets.car'), 'catalog');
    fs.writeFileSync(path.join(runnerAppPath, 'Assets.car'), 'catalog');
    writeJsonPlist(sourceAppPath, { CFBundleIcons: IPHONE_ICON_PLIST });
    writeJsonPlist(runnerAppPath, { CFBundleName: 'XCTRunner', CFBundleIcons: IPHONE_ICON_PLIST });

    const calls: AppleToolCall[] = [];
    const provider = createRecordingProvider(calls);

    await withAppleToolProvider(
      provider,
      async () => await applyXctestRunnerAppIcon([sourceAppPath, runnerAppPath]),
    );

    assert.deepEqual(calls, []);
  });
});

test('finds simulator XCTest runner app from derived data', async () => {
  await withTempDir('agent-device-runner-icon-', async (root) => {
    const [sourceAppPath, runnerAppPath] = makeProductApps(root, 'Debug-iphonesimulator');
    fs.writeFileSync(path.join(sourceAppPath, 'AppIcon60x60@2x.png'), 'icon');
    writeJsonPlist(sourceAppPath, {});
    writeJsonPlist(runnerAppPath, {});

    const provider = createLocalAppleToolProvider({
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      plist: {
        readJson: async (plistPath) => JSON.parse(fs.readFileSync(plistPath, 'utf8')),
      },
    });

    await withAppleToolProvider(
      provider,
      async () => await applyXctestRunnerAppIconFromDerivedPath(root),
    );

    assert.equal(fs.readFileSync(path.join(runnerAppPath, 'AppIcon60x60@2x.png'), 'utf8'), 'icon');
  });
});

test('does not patch device XCTest runner apps', async () => {
  await withTempDir('agent-device-runner-icon-', async (root) => {
    const [sourceAppPath, runnerAppPath] = makeProductApps(root, 'Debug-iphoneos');
    fs.writeFileSync(path.join(sourceAppPath, 'AppIcon60x60@2x.png'), 'icon');

    const calls: AppleToolCall[] = [];
    const provider = createRecordingProvider(calls);

    await withAppleToolProvider(
      provider,
      async () => await applyXctestRunnerAppIcon([sourceAppPath, runnerAppPath]),
    );

    assert.equal(fs.existsSync(path.join(runnerAppPath, 'AppIcon60x60@2x.png')), false);
    assert.deepEqual(calls, []);
  });
});
