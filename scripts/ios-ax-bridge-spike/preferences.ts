import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { PlistDiff, PlistKeyChange, PreferenceEvidence } from './types.ts';

const PREFERENCE_VALUES = {
  'com.apple.Accessibility.plist': {
    AccessibilityEnabled: true,
    ApplicationAccessibilityEnabled: true,
    AutomationEnabled: true,
    IgnoreAXServerEntitlements: true,
  },
  'com.apple.UIAutomation.plist': {
    UIAutomationEnabled: true,
  },
} as const;

const UUID_PATTERN = /^[0-9A-Fa-f-]{36}$/u;
const EMPTY_PLIST = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict></dict></plist>\n`;

class PreferenceSafetyError extends Error {
  readonly code: 'invalid-udid' | 'simulator-not-shutdown' | 'simulator-state-unknown';

  constructor(code: PreferenceSafetyError['code'], message: string) {
    super(message);
    this.name = 'PreferenceSafetyError';
    this.code = code;
  }
}

export type PlistSnapshot = Readonly<{
  path: string;
  existedBefore: boolean;
  beforeBytes: Buffer | null;
  beforeValues: Record<string, unknown>;
}>;

export function simulatorPreferencePaths(udid: string): string[] {
  validateUdid(udid);
  const directory = path.join(
    os.homedir(),
    'Library',
    'Developer',
    'CoreSimulator',
    'Devices',
    udid,
    'data',
    'Library',
    'Preferences',
  );
  return Object.keys(PREFERENCE_VALUES).map((name) => path.join(directory, name));
}

export function diffPlistValues(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
): PlistKeyChange[] {
  return keys.flatMap((key) => {
    const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
    if (hasBefore && hasAfter && Object.is(before[key], after[key])) return [];
    return [
      {
        key,
        ...(hasBefore ? { before: before[key] } : {}),
        ...(hasAfter ? { after: after[key] } : {}),
      },
    ];
  });
}

export function readSimulatorState(udid: string): string {
  validateUdid(udid);
  const result = spawnSync('xcrun', ['simctl', 'list', 'devices', '-j'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    throw new PreferenceSafetyError('simulator-state-unknown', `Unable to read state for ${udid}.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new PreferenceSafetyError(
      'simulator-state-unknown',
      `Simulator state was not JSON for ${udid}.`,
    );
  }
  const state = findDeviceState(payload, udid);
  if (!state) {
    throw new PreferenceSafetyError('simulator-state-unknown', `Simulator ${udid} was not found.`);
  }
  return state;
}

export function applyPrebootPreferences(udid: string): {
  evidence: PreferenceEvidence;
  snapshots: readonly PlistSnapshot[];
} {
  const simulatorStateBefore = readSimulatorState(udid);
  if (simulatorStateBefore !== 'Shutdown') {
    throw new PreferenceSafetyError(
      'simulator-not-shutdown',
      `Preference experiment requires a shutdown Simulator; ${udid} is ${simulatorStateBefore}.`,
    );
  }
  const snapshots = simulatorPreferencePaths(udid).map(snapshotPlist);
  try {
    for (const snapshot of snapshots) applyPlistValues(snapshot.path);
  } catch (error) {
    restoreSnapshotBytes(snapshots);
    throw error;
  }
  const diffs = snapshots.map((snapshot) => {
    const afterBytes = readBytes(snapshot.path);
    const afterValues = readPlist(snapshot.path);
    return {
      path: snapshot.path,
      existedBefore: snapshot.existedBefore,
      beforeSha256: hashBytes(snapshot.beforeBytes),
      afterSha256: hashBytes(afterBytes),
      changes: diffPlistValues(snapshot.beforeValues, afterValues, changedKeys(snapshot.path)),
    } satisfies PlistDiff;
  });
  return {
    snapshots,
    evidence: {
      applied: diffs.some((diff) => diff.changes.length > 0),
      restored: false,
      simulatorStateBefore,
      diffs,
    },
  };
}

export function restorePrebootPreferences(
  udid: string,
  snapshots: readonly PlistSnapshot[],
): PreferenceEvidence['restored'] {
  const state = readSimulatorState(udid);
  if (state !== 'Shutdown') {
    throw new PreferenceSafetyError(
      'simulator-not-shutdown',
      `Preference restore requires a shutdown Simulator; ${udid} is ${state}.`,
    );
  }
  restoreSnapshotBytes(snapshots);
  return true;
}

function restoreSnapshotBytes(snapshots: readonly PlistSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.beforeBytes === null) {
      fs.rmSync(snapshot.path, { force: true });
      continue;
    }
    fs.writeFileSync(snapshot.path, snapshot.beforeBytes);
  }
}

function snapshotPlist(filePath: string): PlistSnapshot {
  const beforeBytes = readBytes(filePath);
  return {
    path: filePath,
    existedBefore: beforeBytes !== null,
    beforeBytes,
    beforeValues: beforeBytes === null ? {} : readPlist(filePath),
  };
}

function applyPlistValues(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, EMPTY_PLIST);
  for (const key of changedKeys(filePath)) {
    const value = true;
    const replaced = spawnSync(
      '/usr/bin/plutil',
      ['-replace', key, '-bool', String(value), filePath],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    if (replaced.status === 0) continue;
    const inserted = spawnSync(
      '/usr/bin/plutil',
      ['-insert', key, '-bool', String(value), filePath],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    if (inserted.status !== 0) {
      throw new PreferenceSafetyError('simulator-state-unknown', `Unable to update ${filePath}.`);
    }
  }
}

function readPlist(filePath: string): Record<string, unknown> {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', filePath], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return {};
  try {
    const value: unknown = JSON.parse(result.stdout);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function readBytes(filePath: string): Buffer | null {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function hashBytes(value: Buffer | null): string | null {
  return value === null ? null : crypto.createHash('sha256').update(value).digest('hex');
}

function changedKeys(filePath: string): string[] {
  const name = path.basename(filePath) as keyof typeof PREFERENCE_VALUES;
  return name in PREFERENCE_VALUES ? Object.keys(PREFERENCE_VALUES[name]) : [];
}

function findDeviceState(payload: unknown, udid: string): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.devices)) return undefined;
  for (const runtimeDevices of Object.values(payload.devices)) {
    if (!Array.isArray(runtimeDevices)) continue;
    const device = runtimeDevices.find(
      (candidate) => isRecord(candidate) && candidate.udid === udid,
    );
    if (isRecord(device) && typeof device.state === 'string') return device.state;
  }
  return undefined;
}

function validateUdid(udid: string): void {
  if (!UUID_PATTERN.test(udid)) {
    throw new PreferenceSafetyError('invalid-udid', `Invalid Simulator UDID: ${udid}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
