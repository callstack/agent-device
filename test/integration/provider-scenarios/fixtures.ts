import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';

export const PROVIDER_SCENARIO_ANDROID: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 8',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

export const PROVIDER_SCENARIO_IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 15',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

export const PROVIDER_SCENARIO_IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-device-1',
  name: 'QA iPhone',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

export const PROVIDER_SCENARIO_IOS_REINSTALL_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'device-1',
  name: 'iPhone Device',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

export const PROVIDER_SCENARIO_TVOS: DeviceInfo = {
  platform: 'apple',
  appleOs: 'tvos',
  id: 'tv-sim-1',
  name: 'Apple TV',
  kind: 'simulator',
  target: 'tv',
  booted: true,
};

export const PROVIDER_SCENARIO_MACOS: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos',
  name: 'Mac desktop',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export const PROVIDER_SCENARIO_LINUX: DeviceInfo = {
  platform: 'linux',
  id: 'local',
  name: 'Linux desktop',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export const PROVIDER_SCENARIO_WEB: DeviceInfo = {
  platform: 'web',
  id: 'agent-browser-chrome',
  name: 'Agent Browser Chrome',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export function createDemoIosApp(prefix: string): { tempRoot: string; appPath: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appPath = path.join(tempRoot, 'Demo.app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(
    path.join(appPath, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleIdentifier</key><string>com.example.demo</string>',
      '<key>CFBundleName</key><string>Demo</string>',
      '</dict></plist>',
    ].join(''),
    'utf8',
  );
  return { tempRoot, appPath };
}

/**
 * A populated first screen for the reads that settle the first capture after `open`. The post-open
 * wait refuses a tree that holds only the app root and holds a tree of four or fewer nodes for a
 * quiet window, so these reads carry five rows and settle on one quiet pair.
 */
export const FIRST_SCREEN_NODES: readonly Record<string, unknown>[] = [
  {
    index: 0,
    type: 'Application',
    label: 'Example',
    rect: { x: 0, y: 0, width: 400, height: 800 },
  },
  ...Array.from({ length: 5 }, (_, row) => ({
    index: row + 1,
    parentIndex: 0,
    type: 'StaticText',
    label: `Row ${row}`,
    rect: { x: 20, y: 100 + row * 50, width: 300, height: 44 },
  })),
];
