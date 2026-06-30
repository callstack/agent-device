#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DERIVED_ROOT = path.join(os.homedir(), '.agent-device', 'ios-runner', 'derived');
const ROOT_TRANSIENT_ENTRY_NAMES = new Set([
  '.agent-device-runner-cache.json',
  'Build',
  'BuildCache.noindex',
  'Index.noindex',
  'Logs',
  'ModuleCache.noindex',
  'SDKStatCaches.noindex',
  'SourcePackages',
  'TextBasedInstallAPI',
  'info.plist',
]);
const platforms = process.argv.slice(2);
const requested = platforms.length > 0 ? platforms : ['ios', 'macos', 'tvos', 'visionos'];
const supported = new Set(['ios', 'macos', 'tvos', 'visionos']);
const DERIVED_PATHS = new Map([
  ['ios', DERIVED_ROOT],
  ['macos', path.join(DERIVED_ROOT, 'macos')],
  ['tvos', path.join(DERIVED_ROOT, 'tvos')],
  ['visionos', path.join(DERIVED_ROOT, 'visionos')],
]);

for (const platform of requested) {
  if (!supported.has(platform)) {
    console.error(`Unsupported XCTest cache platform: ${platform}`);
    console.error('Supported platforms: ios, macos, tvos, visionos');
    process.exitCode = 1;
    continue;
  }
  const targetPath = resolveDerivedPath(platform);
  cleanDerivedPath(platform, targetPath);
  console.log(`Removed ${targetPath}`);
}

// fallow-ignore-next-line complexity
function cleanDerivedPath(platform, targetPath) {
  if (platform !== 'ios') {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return;
  }
  if (!fs.existsSync(targetPath)) {
    return;
  }
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (!ROOT_TRANSIENT_ENTRY_NAMES.has(entry.name)) continue;
    fs.rmSync(path.join(targetPath, entry.name), { recursive: true, force: true });
  }
}

function resolveDerivedPath(platform) {
  const targetPath = DERIVED_PATHS.get(platform);
  if (targetPath) return targetPath;
  throw new Error(`Unsupported platform: ${platform}`);
}
