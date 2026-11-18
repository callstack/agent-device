import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { mkdtempForTestSync } from '@agent-device/test-kit';

import type { CliJsonResult } from '../cli-json.ts';
import { createLiveDeviceContext, type LiveRunCli } from '../live-device-e2e/runtime.ts';
import type { AndroidEmulatorBehaviorId } from './behavior-coverage.ts';
import { createAndroidLiveAssertions, filesDiffer } from './live-assertions.ts';
import { createAndroidLiveHarness, type LiveContext } from './live-harness.ts';
import { createHomeAndRecentsRestorationScenario } from './live-automation-scenario.ts';

const APP_ID = 'com.callstack.agentdevicelab';
const LAUNCHER = 'com.google.android.apps.nexuslauncher';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FOREGROUND = Buffer.concat([PNG_SIGNATURE, Buffer.from('fixture-foreground')]);
const HOME = Buffer.concat([PNG_SIGNATURE, Buffer.from('launcher-home')]);
const RECENTS = Buffer.concat([PNG_SIGNATURE, Buffer.from('recents-surface')]);

/**
 * A scripted device behind the harness-owned `runCli` injection. `screenshot` behaves like a CLI
 * runner under a step timeout: the capture would finish after `workMs`, but a forwarded
 * `options.timeoutMs` kills it first and returns a failure without writing the image. The
 * forwarded timeout of every screenshot call is recorded in `timeouts`.
 */
function scriptedDevice(options: { script: Record<string, Buffer[]>; workMs: number }): {
  runCli: LiveRunCli;
  timeouts: Record<string, (number | undefined)[]>;
} {
  const attempts = new Map<string, number>();
  const timeouts: Record<string, (number | undefined)[]> = {};
  let foregroundPackage = APP_ID;
  const runCli: LiveRunCli = (args, _env, cliOptions): Promise<CliJsonResult> => {
    const command = args[0];
    if (command === 'home') {
      foregroundPackage = LAUNCHER;
      return Promise.resolve({
        status: 0,
        stdout: '',
        stderr: '',
        json: { success: true, data: {} },
      });
    }
    if (command === 'open') {
      foregroundPackage = APP_ID;
      return Promise.resolve({
        status: 0,
        stdout: '',
        stderr: '',
        json: { success: true, data: {} },
      });
    }
    if (command === 'appstate') {
      return Promise.resolve({
        status: 0,
        stdout: '',
        stderr: '',
        json: { success: true, data: { package: foregroundPackage } },
      });
    }
    if (command === 'screenshot') {
      const output = args[1]!;
      const base = path.basename(output);
      const timeoutMs = cliOptions?.timeoutMs;
      (timeouts[base] ??= []).push(timeoutMs);
      return new Promise<CliJsonResult>((resolve) => {
        let done = false;
        const finish = setTimeout(() => {
          if (done) return;
          done = true;
          const attempt = (attempts.get(base) ?? 0) + 1;
          attempts.set(base, attempt);
          const images = options.script[base] ?? [FOREGROUND];
          fs.writeFileSync(output, images[Math.min(attempt - 1, images.length - 1)]!);
          resolve({ status: 0, stdout: '', stderr: '', json: { success: true, data: {} } });
        }, options.workMs);
        if (timeoutMs !== undefined) {
          setTimeout(() => {
            if (done) return;
            done = true;
            clearTimeout(finish);
            resolve({
              status: 1,
              stdout: '',
              stderr: `screenshot killed after ${timeoutMs}ms`,
              json: { success: false, error: { code: 'timeout' } },
            });
          }, timeoutMs);
        }
      });
    }
    return Promise.resolve({
      status: 0,
      stdout: '',
      stderr: '',
      json: { success: true, data: {} },
    });
  };
  return { runCli, timeouts };
}

function makeContext(): LiveContext {
  return {
    ...createLiveDeviceContext<AndroidEmulatorBehaviorId>({
      artifactRoot: mkdtempForTestSync('home-recents-scenario-'),
      session: 'scenario-test',
    }),
    appId: APP_ID,
    appPath: '/tmp/fixture.apk',
    serial: 'emulator-5554',
    tier: 'smoke',
  };
}

/** Runs the Home/Recents restoration scenario through the harness entry with a scripted device. */
function runScenarioWithDevice(device: { runCli: LiveRunCli }) {
  const harness = createAndroidLiveHarness({ runCli: device.runCli });
  const assertions = createAndroidLiveAssertions(harness);
  const context = makeContext();
  const scenario = createHomeAndRecentsRestorationScenario({
    ...assertions,
    runStep: harness.runStep,
    verifyBehavior: harness.verifyBehavior,
    verifyCommand: harness.verifyCommand,
  });
  return { context, promise: harness.runScenario(context, scenario) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const settled = Promise.allSettled([promise]).then(([result]) => result);
  await vi.runAllTimersAsync();
  return settled;
}

test('Home and Recents pass through the harness scenario entry after delayed captures, with forwarded capture timeouts', async () => {
  // Quick captures; the first Home capture still shows the fixture and the first Recents capture
  // still shows Home, so a single-capture route fails both pixel comparisons here.
  const device = scriptedDevice({
    script: {
      'foreground.png': [FOREGROUND],
      'home.png': [FOREGROUND, HOME],
      'recents.png': [HOME, RECENTS],
    },
    workMs: 100,
  });
  const { context, promise } = runScenarioWithDevice(device);
  const result = await settle(promise);

  expect(result.status).toBe('fulfilled');
  const screenshotSteps = context.stepHistory
    .filter((record) => record.commandName === 'screenshot')
    .map((record) => record.step);
  expect(screenshotSteps).toContain('capture Android Home surface (attempt 2)');
  expect(screenshotSteps).toContain('capture Android Recents surface (attempt 2)');
  // The default capture forwarded a bounded timeout to the CLI runner on every wait attempt.
  for (const base of ['home.png', 'recents.png']) {
    const attemptTimeouts = device.timeouts[base] ?? [];
    expect(attemptTimeouts.length).toBe(2);
    for (const timeoutMs of attemptTimeouts) {
      expect(typeof timeoutMs).toBe('number');
      expect(timeoutMs).toBeLessThanOrEqual(5_000);
      expect(timeoutMs).toBeGreaterThan(0);
    }
  }
  expect(
    filesDiffer(
      path.join(context.artifactDir, 'foreground.png'),
      path.join(context.artifactDir, 'home.png'),
    ),
  ).toBe(true);
  expect(
    filesDiffer(
      path.join(context.artifactDir, 'home.png'),
      path.join(context.artifactDir, 'recents.png'),
    ),
  ).toBe(true);
  expect(context.behaviorEvidence['home-recents-restoration']?.length).toBeGreaterThan(0);
  expect(context.completedScenarios).toContain('smoke:home-recents-restoration');
});

test('a wedged capture is cut at the forwarded remaining timeout and the scenario fails at the wait deadline', async () => {
  // Every capture would finish after 60s; only the forwarded step timeout can cut it, and the
  // wait must still fail at its own 10s deadline with the capture failures as the last observation.
  const device = scriptedDevice({
    script: { 'foreground.png': [FOREGROUND], 'home.png': [FOREGROUND], 'recents.png': [RECENTS] },
    workMs: 60_000,
  });
  const { context, promise } = runScenarioWithDevice(device);
  const result = await settle(promise);

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /Android Home never replaced the fixture pixels within 10000ms.*capture \d+ failed/s,
      ),
    },
  });
  // The remaining deadline (not a constant) was forwarded to the wedged captures: timeouts are
  // set, bounded by the per-attempt cap, and shrink as the wait's deadline approaches.
  const homeTimeouts = device.timeouts['home.png'] ?? [];
  expect(homeTimeouts.length).toBeGreaterThan(1);
  for (const timeoutMs of homeTimeouts) expect(typeof timeoutMs).toBe('number');
  expect(Math.max(...homeTimeouts.map((t) => t!))).toBeLessThanOrEqual(5_000);
  expect(Math.min(...homeTimeouts.map((t) => t!))).toBeLessThan(5_000);
  expect(
    context.stepHistory.filter((record) => record.commandName === 'screenshot').length,
  ).toBeGreaterThanOrEqual(homeTimeouts.length);
});

test('the scenario fails when Recents never differs from the Home surface', async () => {
  const device = scriptedDevice({
    script: { 'foreground.png': [FOREGROUND], 'home.png': [HOME], 'recents.png': [HOME] },
    workMs: 100,
  });
  const { promise } = runScenarioWithDevice(device);
  const result = await settle(promise);

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /Android Recents never differed from the Home pixels within 10000ms/s,
      ),
    },
  });
});
