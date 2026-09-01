import { execFileSync } from 'node:child_process';
import { screenFixture } from '../ios-snapshot-benchmark/definitions.ts';
import { bootSimulator, shutdownSimulator } from '../ios-snapshot-benchmark/lifecycle.ts';
import type { SpikeConfig } from './config.ts';
import {
  applyPrebootPreferences,
  type PlistSnapshot,
  readSimulatorState,
  restorePrebootPreferences,
} from './preferences.ts';
import type { PreferenceEvidence } from './types.ts';

export function runPreferenceExperiment(config: SpikeConfig): PreferenceEvidence {
  if (!config.applyPreferences) return initialPreferenceEvidence(config.udid);
  shutdownSimulator(config.udid);
  const applied = applyPrebootPreferences(config.udid);
  return exerciseAppliedPreferences(config, applied.evidence, applied.snapshots);
}

function exerciseAppliedPreferences(
  config: SpikeConfig,
  evidence: PreferenceEvidence,
  snapshots: readonly PlistSnapshot[],
): PreferenceEvidence {
  let fixtureLaunchCompatible: boolean;
  try {
    bootSimulator(config.udid);
    fixtureLaunchCompatible = tryPrimeFixtureApp(
      config.udid,
      screenFixture(config.screens[0]!).app,
    );
  } catch {
    fixtureLaunchCompatible = false;
  }
  return {
    ...evidence,
    fixtureLaunchCompatible,
    restored: restorePreferences(config.udid, snapshots),
  };
}

function restorePreferences(udid: string, snapshots: readonly PlistSnapshot[]): boolean {
  try {
    if (readSimulatorState(udid) !== 'Shutdown') shutdownSimulator(udid);
    return restorePrebootPreferences(udid, snapshots);
  } catch {
    return false;
  }
}

export function primeFixtureApps(config: SpikeConfig): void {
  const apps = new Set(config.screens.map((screen) => screenFixture(screen).app));
  for (const app of apps) {
    if (!tryPrimeFixtureApp(config.udid, app))
      throw new Error(`Failed to prime ${app} after booting the restored disposable Simulator.`);
  }
}

function tryPrimeFixtureApp(udid: string, app: string): boolean {
  try {
    execFileSync('xcrun', ['simctl', 'launch', udid, app], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

export function initialPreferenceEvidence(udid: string): PreferenceEvidence {
  let simulatorStateBefore = 'unknown';
  try {
    simulatorStateBefore = readSimulatorState(udid);
  } catch {
    simulatorStateBefore = 'unavailable';
  }
  return {
    applied: false,
    restored: false,
    fixtureLaunchCompatible: null,
    simulatorStateBefore,
    diffs: [],
  };
}
