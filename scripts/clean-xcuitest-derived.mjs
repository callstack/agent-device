#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DERIVED_ROOT = path.join(os.homedir(), '.agent-device', 'apple-runner', 'derived');
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
const PLATFORM_LABELS = new Map([
  ['ios', 'iOS'],
  ['macos', 'macOS'],
  ['tvos', 'tvOS'],
  ['visionos', 'visionOS'],
]);
const MAX_SUMMARY_ENTRY_NAMES = 3;

for (const platform of requested) {
  if (!supported.has(platform)) {
    console.error(`Unsupported XCTest cache platform: ${platform}`);
    console.error('Supported platforms: ios, macos, tvos, visionos');
    process.exitCode = 1;
    continue;
  }
  const targetPath = resolveDerivedPath(platform);
  try {
    const result = cleanDerivedPath(platform, targetPath);
    console.log(formatCleanupResult(platform, targetPath, result));
  } catch (error) {
    console.error(formatCleanupError(platform, targetPath, error));
    process.exitCode = 1;
  }
}

// fallow-ignore-next-line complexity
function cleanDerivedPath(platform, targetPath) {
  if (!fs.existsSync(targetPath)) {
    return { status: 'skipped', reason: 'not-found' };
  }
  if (platform !== 'ios') {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return { status: 'removed' };
  }
  const removedEntries = [];
  const preservedEntries = [];
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (!ROOT_TRANSIENT_ENTRY_NAMES.has(entry.name)) {
      preservedEntries.push(entry.name);
      continue;
    }
    fs.rmSync(path.join(targetPath, entry.name), { recursive: true, force: true });
    removedEntries.push(entry.name);
  }
  if (removedEntries.length === 0) {
    return {
      status: 'skipped',
      reason: 'no-transient-entries',
      preservedEntries,
    };
  }
  return {
    status: 'removed',
    removedEntries,
    preservedEntries,
  };
}

function formatCleanupResult(platform, targetPath, result) {
  const platformLabel = resolvePlatformLabel(platform);
  if (platform !== 'ios') return formatWholeDerivedCleanupResult(platformLabel, targetPath, result);
  return formatIosCleanupResult(platformLabel, targetPath, result);
}

function formatWholeDerivedCleanupResult(platformLabel, targetPath, result) {
  return result.status === 'removed'
    ? `Removed ${platformLabel} XCTest derived data: ${targetPath}`
    : `Skipped ${platformLabel} XCTest cleanup: ${targetPath} not found`;
}

function formatIosCleanupResult(platformLabel, targetPath, result) {
  if (result.status === 'skipped' && result.reason === 'not-found') {
    return `Skipped ${platformLabel} XCTest cleanup: ${targetPath} not found`;
  }
  const keptSuffix = formatKeptEntriesSuffix(result.preservedEntries);
  if (result.status === 'skipped') {
    return `Skipped ${platformLabel} XCTest cleanup under ${targetPath}: no transient entries found${keptSuffix}`;
  }
  return `Removed ${platformLabel} XCTest transient entries under ${targetPath}: ${summarizeEntryNames(result.removedEntries)}${keptSuffix}`;
}

function formatKeptEntriesSuffix(preservedEntries) {
  return preservedEntries.length > 0 ? `; kept ${summarizeEntryNames(preservedEntries)}` : '';
}

function formatCleanupError(platform, targetPath, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return `Failed to clean ${resolvePlatformLabel(platform)} XCTest derived data under ${targetPath}: ${detail}`;
}

function resolvePlatformLabel(platform) {
  const platformLabel = PLATFORM_LABELS.get(platform);
  if (platformLabel) return platformLabel;
  throw new Error(`Unsupported platform: ${platform}`);
}

function summarizeEntryNames(entryNames) {
  const names = [...entryNames].sort();
  if (names.length <= MAX_SUMMARY_ENTRY_NAMES) {
    return names.join(', ');
  }
  return `${names.slice(0, MAX_SUMMARY_ENTRY_NAMES).join(', ')} (+${names.length - MAX_SUMMARY_ENTRY_NAMES} more)`;
}

function resolveDerivedPath(platform) {
  const targetPath = DERIVED_PATHS.get(platform);
  if (targetPath) return targetPath;
  throw new Error(`Unsupported platform: ${platform}`);
}
