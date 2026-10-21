import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  countElements,
  invokeBatchStep,
  invokeCli,
  readBatchStepDurationMs,
  readBatchStepError,
} from './cli.ts';
import type { PerfConfig } from './config.ts';
import { resolveProfile, type ResolvedProfile } from './platform-profiles.ts';
import { buildMeasurement } from './measurement.ts';
import { buildSettingsTour, type ScenarioStep } from './scenario.ts';
import type { CliResult, Measurement, Sample } from './types.ts';

export type IsolationContext = {
  stateDir: string;
  artifactsDir: string;
  baseFlags: string[];
  profile: ResolvedProfile;
};

function log(msg: string): void {
  process.stderr.write(`[perf] ${msg}\n`);
}

export function setupIsolation(cfg: PerfConfig): IsolationContext {
  const profile = resolveProfile(cfg);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-perf-'));
  const artifactsDir = path.join(stateDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const baseFlags = ['--state-dir', stateDir, '--session', 'perf', ...profile.platformFlags];
  log(`state-dir: ${stateDir}`);
  log(`device: ${profile.deviceName} (${profile.serial ?? 'default'})`);
  return { stateDir, artifactsDir, baseFlags, profile };
}

export function teardownIsolation(ctx: IsolationContext, cfg: PerfConfig): void {
  log('teardown: closing session');
  try {
    const args = ['close'];
    if (!cfg.keepArtifacts) args.push('--shutdown');
    invokeCli(args, ctx.baseFlags);
  } catch {
    /* best-effort */
  }
  if (cfg.keepArtifacts) {
    log(`keep-artifacts: leaving ${ctx.stateDir} and device in place`);
    return;
  }
  try {
    fs.rmSync(ctx.stateDir, { recursive: true, force: true });
    log('teardown: removed temp state dir');
  } catch {
    /* best-effort */
  }
}

function sampleError(r: CliResult): Pick<Sample, 'errorCode' | 'errorMessage'> {
  const err = readBatchStepError(r);
  return {
    errorCode: err.code ?? `exit:${r.exitCode}`,
    errorMessage: (err.message ?? r.stderr.trim().split('\n').pop() ?? '').slice(0, 200),
  };
}

// Base sample (timing + ok + error note on failure) shared by every measured invocation.
function toSample(r: CliResult, round: number): Sample {
  const sample: Sample = { round, wallClockMs: r.wallClockMs, ok: r.ok };
  if (!r.ok) Object.assign(sample, sampleError(r));
  return sample;
}

// The first interaction after open/relaunch pays the Android helper startup and a per-relaunch
// first-query settle cost. Run an untimed throwaway interaction so that
// cost is never attributed to a measured command.
function warmRunner(ctx: IsolationContext): void {
  invokeCli(['snapshot', '-i'], ctx.baseFlags);
}

function runStep(step: ScenarioStep, ctx: IsolationContext, round: number): Sample {
  // Untimed reset to root for steps whose precondition is a clean, top-of-list root.
  if (step.freshRoot) {
    invokeCli(['open', ctx.profile.appTarget, '--relaunch'], ctx.baseFlags);
    warmRunner(ctx);
  }
  const r =
    step.execMode === 'standalone'
      ? invokeCli(step.args, ctx.baseFlags)
      : invokeBatchStep(step.step, ctx.baseFlags);
  const sample = toSample(r, round);
  if (step.execMode === 'batch') {
    sample.daemonMs = readBatchStepDurationMs(r);
    if (step.isSnapshot) sample.elementCount = countElements(r);
  }
  return sample;
}

const TOUR_SCENARIO = 'settings-tour';

function tourMeasurement(
  step: Pick<ScenarioStep, 'command' | 'label' | 'execMode'>,
  platform: ResolvedProfile['platform'],
  samples: Sample[],
  warmupDropped: number,
): Measurement {
  return buildMeasurement({
    id: `${TOUR_SCENARIO}/${step.label}`,
    scenario: TOUR_SCENARIO,
    label: step.label,
    command: step.command,
    args: [],
    platform,
    execMode: step.execMode,
    samples,
    warmupDropped,
  });
}

function setupMeasurementFailed(measurement: Measurement): boolean {
  return measurement.samples.some((sample) => !sample.ok);
}

// Boot the device once and time it. Runs WITHOUT --session so no session lock policy
// applies and the device selectors are honored (selectors are rejected on locked sessions).
function bootOnce(ctx: IsolationContext): Measurement {
  log('booting device (no session lock; sampled once)');
  const bootFlags = ['--state-dir', ctx.stateDir, ...ctx.profile.platformFlags];
  const r = invokeCli(['boot', ...ctx.profile.selectorFlags], bootFlags);
  const sample = toSample(r, 0);
  return tourMeasurement(
    { command: 'boot', label: 'boot device', execMode: 'standalone' },
    ctx.profile.platform,
    [sample],
    0,
  );
}

// Establish the session by opening Settings WITH device selectors (open is the only
// interaction command allowed to carry selectors on a fresh session). Locks the session
// to our device so every later call targets it via --session alone.
function establishSession(ctx: IsolationContext): Measurement {
  log('establishing session (open with device selectors)');
  const r = invokeCli(['open', ctx.profile.appTarget, ...ctx.profile.selectorFlags], ctx.baseFlags);
  const sample = toSample(r, 0);
  return tourMeasurement(
    { command: 'open', label: 'open (establish + cold)', execMode: 'standalone' },
    ctx.profile.platform,
    [sample],
    0,
  );
}

export function runScenario(ctx: IsolationContext, cfg: PerfConfig): Measurement[] {
  const steps = buildSettingsTour(ctx.profile, { artifactsDir: ctx.artifactsDir });
  const acc = new Map<string, Sample[]>();
  for (const step of steps) acc.set(step.label, []);

  const boot = bootOnce(ctx);
  const establish = establishSession(ctx);
  if (setupMeasurementFailed(boot) || setupMeasurementFailed(establish)) {
    log('setup failed; skipping timed tour');
    return [boot, establish];
  }
  // Absorb the one-time runner startup before any round so it isn't charged to a measurement.
  warmRunner(ctx);

  // Android accessibility dumps time out while the UI is animating; disable animations
  // up front (untimed) so snapshot/get/is/fill can read an idle hierarchy.
  log('disabling animations');
  invokeCli(['settings', 'animations', 'off'], ctx.baseFlags);

  const totalRounds = cfg.warmup + cfg.rounds;
  for (let round = 0; round < totalRounds; round++) {
    const measured = round >= cfg.warmup;
    log(`round ${round + 1}/${totalRounds}${measured ? '' : ' (warmup, dropped)'}`);
    for (const step of steps) {
      const sample = runStep(step, ctx, round);
      if (measured) acc.get(step.label)!.push(sample);
      // After the round's reset-open relaunch, warm the runner (untimed) so the first measured
      // read (snapshot -i) doesn't pay the post-relaunch first-AX-query cost.
      if (step.command === 'open' && step.execMode === 'standalone') {
        warmRunner(ctx);
      }
    }
  }

  const tourMeasurements = steps.map((step) =>
    tourMeasurement(step, ctx.profile.platform, acc.get(step.label)!, cfg.warmup),
  );
  return [boot, establish, ...tourMeasurements];
}
