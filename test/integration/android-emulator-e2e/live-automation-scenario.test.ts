import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { mkdtempForTestSync } from '@agent-device/test-kit';

import type { CliJsonResult } from '../cli-json.ts';
import { createLiveDeviceContext, type LiveRunCli } from '../live-device-e2e/runtime.ts';
import type { AndroidEmulatorBehaviorId } from './behavior-coverage.ts';
import { assertHomeAndRecentsRestoration } from './live-automation-scenario.ts';
import { filesDiffer } from './live-assertions.ts';
import type { LiveContext } from './live-harness.ts';

const APP_ID = 'com.callstack.agentdevicelab';
const LAUNCHER = 'com.google.android.apps.nexuslauncher';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FOREGROUND = Buffer.concat([PNG_SIGNATURE, Buffer.from('fixture-foreground')]);
const HOME = Buffer.concat([PNG_SIGNATURE, Buffer.from('launcher-home')]);
const RECENTS = Buffer.concat([PNG_SIGNATURE, Buffer.from('recents-surface')]);

/**
 * A scripted device behind the context's `runCli` override: `screenshot` writes the next scripted
 * image for that artifact (the last entry repeats), `home`/`open` drive the foreground package,
 * and every other command succeeds. The scenario runs through the real harness wiring
 * (commonFlags, step history, command/behavior evidence), not a helper call.
 */
function scriptedDevice(script: Record<string, Buffer[]>) {
  const attempts = new Map<string, number>();
  let foregroundPackage = APP_ID;
  const runCli: LiveRunCli = async (args): Promise<CliJsonResult> => {
    const command = args[0];
    if (command === 'home') {
      foregroundPackage = LAUNCHER;
      return { status: 0, stdout: '', stderr: '', json: { success: true, data: {} } };
    }
    if (command === 'open') {
      foregroundPackage = APP_ID;
      return { status: 0, stdout: '', stderr: '', json: { success: true, data: {} } };
    }
    if (command === 'appstate') {
      return {
        status: 0,
        stdout: '',
        stderr: '',
        json: { success: true, data: { package: foregroundPackage } },
      };
    }
    if (command === 'screenshot') {
      const output = args[1]!;
      const base = path.basename(output);
      const attempt = (attempts.get(base) ?? 0) + 1;
      attempts.set(base, attempt);
      const images = script[base] ?? [FOREGROUND];
      fs.writeFileSync(output, images[Math.min(attempt - 1, images.length - 1)]!);
      return { status: 0, stdout: '', stderr: '', json: { success: true, data: {} } };
    }
    return { status: 0, stdout: '', stderr: '', json: { success: true, data: {} } };
  };
  return { runCli };
}

function makeContext(runCli: LiveRunCli): LiveContext {
  return {
    ...createLiveDeviceContext<AndroidEmulatorBehaviorId>({
      artifactRoot: mkdtempForTestSync('home-recents-scenario-'),
      session: 'scenario-test',
    }),
    appId: APP_ID,
    appPath: '/tmp/fixture.apk',
    serial: 'emulator-5554',
    tier: 'smoke',
    runCli,
  };
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

test('Home and Recents go through the scenario wait and pass only after the delayed captures differ', async () => {
  // The first Home capture still shows the fixture and the first Recents capture still shows
  // Home: a single-capture route would fail both pixel comparisons here.
  const { runCli } = scriptedDevice({
    'foreground.png': [FOREGROUND],
    'home.png': [FOREGROUND, HOME],
    'recents.png': [HOME, RECENTS],
  });
  const context = makeContext(runCli);
  context.currentScenario = 'smoke:automation-system';
  const result = await settle(assertHomeAndRecentsRestoration(context));

  expect(result.status).toBe('fulfilled');
  const screenshotSteps = context.stepHistory
    .filter((record) => record.commandName === 'screenshot')
    .map((record) => record.step);
  expect(screenshotSteps).toContain('capture Android Home surface (attempt 2)');
  expect(screenshotSteps).toContain('capture Android Recents surface (attempt 2)');
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
  const appStates = context.stepHistory.filter((record) => record.commandName === 'appstate');
  expect(appStates.length).toBe(2);
});

test('the scenario fails when Home never replaces the fixture pixels', async () => {
  const { runCli } = scriptedDevice({
    'foreground.png': [FOREGROUND],
    'home.png': [FOREGROUND],
    'recents.png': [RECENTS],
  });
  const context = makeContext(runCli);
  context.currentScenario = 'smoke:automation-system';
  const result = await settle(assertHomeAndRecentsRestoration(context));

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /Android Home never replaced the fixture pixels within 10000ms/s,
      ),
    },
  });
});

test('the scenario fails when Recents never differs from the Home surface', async () => {
  const { runCli } = scriptedDevice({
    'foreground.png': [FOREGROUND],
    'home.png': [HOME],
    'recents.png': [HOME],
  });
  const context = makeContext(runCli);
  context.currentScenario = 'smoke:automation-system';
  const result = await settle(assertHomeAndRecentsRestoration(context));

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /Android Recents never differed from the Home pixels within 10000ms/s,
      ),
    },
  });
});
