import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { mkdtempForTestSync } from '@agent-device/test-kit';

import type { CliJsonResult } from '../cli-json.ts';
import type { AndroidLiveHarness, LiveContext } from './live-harness.ts';
import {
  type ForegroundRead,
  type SurfaceCapture,
  waitForForegroundLeaves,
  waitForSurfaceChange,
} from './live-surface-transition.ts';

const CONTEXT = {} as LiveContext;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FIXTURE_SURFACE = Buffer.concat([PNG_SIGNATURE, Buffer.from('fixture-foreground')]);
const HOME_SURFACE = Buffer.concat([PNG_SIGNATURE, Buffer.from('home-surface')]);

let artifactDir: string;
let baselinePath: string;
let outputPath: string;

beforeEach(() => {
  vi.useFakeTimers();
  artifactDir = mkdtempForTestSync('surface-transition-');
  baselinePath = path.join(artifactDir, 'baseline.png');
  outputPath = path.join(artifactDir, 'observed.png');
  fs.writeFileSync(baselinePath, FIXTURE_SURFACE);
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const settled = Promise.allSettled([promise]).then(([result]) => result);
  await vi.runAllTimersAsync();
  return settled;
}

/** A capture script: entry `attempt - 1` is written, the last entry repeats; an Error is thrown. */
function scriptedCapture(script: (Buffer | Error)[]): {
  capture: SurfaceCapture;
  attempts: () => number;
} {
  let attempts = 0;
  const capture: SurfaceCapture = async (output, attempt) => {
    attempts = attempt;
    const image = script[Math.min(attempt - 1, script.length - 1)]!;
    if (image instanceof Error) throw image;
    fs.writeFileSync(output, image);
  };
  return { attempts: () => attempts, capture };
}

test('a delayed transition satisfies the wait only after a capture differs, keeping that final image', async () => {
  const { attempts, capture } = scriptedCapture([FIXTURE_SURFACE, FIXTURE_SURFACE, HOME_SURFACE]);
  const result = await settle(
    waitForSurfaceChange(
      CONTEXT,
      baselinePath,
      outputPath,
      'capture surface',
      'surface never changed',
      { capture },
    ),
  );

  expect(result.status).toBe('fulfilled');
  expect(attempts()).toBe(3);
  expect(fs.readFileSync(outputPath).equals(HOME_SURFACE)).toBe(true);
});

test('a capture that fails transiently is retried until the surface changes', async () => {
  const { attempts, capture } = scriptedCapture([
    new Error('screenshot: device offline'),
    FIXTURE_SURFACE,
    HOME_SURFACE,
  ]);
  const result = await settle(
    waitForSurfaceChange(
      CONTEXT,
      baselinePath,
      outputPath,
      'capture surface',
      'surface never changed',
      { capture },
    ),
  );

  expect(result.status).toBe('fulfilled');
  expect(attempts()).toBe(3);
  expect(fs.readFileSync(outputPath).equals(HOME_SURFACE)).toBe(true);
});

test('a surface that never changes fails at the deadline and keeps the last observed image', async () => {
  const { attempts, capture } = scriptedCapture([FIXTURE_SURFACE]);
  const result = await settle(
    waitForSurfaceChange(
      CONTEXT,
      baselinePath,
      outputPath,
      'capture surface',
      'surface never changed',
      { capture },
    ),
  );

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /surface never changed within 30000ms.*capture \d+ still matched/s,
      ),
    },
  });
  expect(attempts()).toBe(120);
  expect(fs.readFileSync(outputPath).equals(FIXTURE_SURFACE)).toBe(true);
});

test('a wait whose captures keep failing reports the last capture error at the deadline', async () => {
  const { capture } = scriptedCapture([new Error('screenshot: device offline')]);
  const result = await settle(
    waitForSurfaceChange(
      CONTEXT,
      baselinePath,
      outputPath,
      'capture surface',
      'surface never changed',
      { capture },
    ),
  );

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(/surface never changed within 30000ms.*device offline/s),
    },
  });
});

test('no capture outlives the remaining deadline', async () => {
  const start = Date.now();
  let failedAt = 0;
  const result = await settle(
    waitForSurfaceChange(
      CONTEXT,
      baselinePath,
      outputPath,
      'capture surface',
      'surface never changed',
      {
        capture: (_output, _attempt, remainingMs) =>
          new Promise((_resolve, reject) =>
            setTimeout(() => {
              failedAt = Date.now();
              reject(new Error('capture timed out'));
            }, remainingMs),
          ),
      },
    ),
  );

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(/surface never changed within 30000ms.*capture timed out/s),
    },
  });
  expect(failedAt - start).toBeLessThanOrEqual(30_000);
});

test('a capture that resolves after the deadline is rejected as a late observation', async () => {
  const result = await settle(
    waitForSurfaceChange(
      CONTEXT,
      baselinePath,
      outputPath,
      'capture surface',
      'surface never changed',
      {
        capture: async (output, _attempt, remainingMs) => {
          await new Promise((resolve) => setTimeout(resolve, remainingMs + 500));
          fs.writeFileSync(output, HOME_SURFACE);
        },
      },
    ),
  );

  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /surface never changed within 30000ms.*resolved after the deadline/s,
      ),
    },
  });
  // The final observed image is still kept, even when it arrives late.
  expect(fs.readFileSync(outputPath).equals(HOME_SURFACE)).toBe(true);
});

const FIXTURE_PACKAGE = 'com.callstack.agentdevicelab';
const LAUNCHER_PACKAGE = 'com.google.android.apps.nexuslauncher';

type ForegroundStep = { step: string; args: string[]; timeoutMs: number | undefined };

/** A scripted `runStep` answering `appstate` with one package per attempt; an Error is thrown. */
function scriptedForegroundRun(script: (string | Error | undefined)[]): {
  runStep: AndroidLiveHarness['runStep'];
  steps: ForegroundStep[];
} {
  const steps: ForegroundStep[] = [];
  const runStep = (
    _context: LiveContext,
    step: string,
    args: string[],
    options: { timeoutMs?: number } = {},
  ) => {
    steps.push({ step, args, timeoutMs: options.timeoutMs });
    const answer = script[Math.min(steps.length - 1, script.length - 1)]!;
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      status: 0,
      stdout: '',
      stderr: '',
      json: { success: true, data: answer === undefined ? {} : { package: answer } },
    });
  };
  return { runStep, steps };
}

test('the foreground wait reports the first package that left the expected one', async () => {
  const { runStep, steps } = scriptedForegroundRun([
    FIXTURE_PACKAGE,
    FIXTURE_PACKAGE,
    LAUNCHER_PACKAGE,
  ]);
  const settled = await settle(
    waitForForegroundLeaves(
      CONTEXT,
      runStep,
      FIXTURE_PACKAGE,
      'read foreground state',
      'foreground never left the fixture',
    ),
  );

  expect(settled.status).toBe('fulfilled');
  if (settled.status === 'fulfilled') expect(settled.value).toBe(LAUNCHER_PACKAGE);
  expect(steps.map((record) => record.step)).toEqual([
    'read foreground state (attempt 1)',
    'read foreground state (attempt 2)',
    'read foreground state (attempt 3)',
  ]);
  // Each read asks for the foreground package through one bounded appstate step.
  for (const record of steps) {
    expect(record.args).toEqual(['appstate']);
    expect(typeof record.timeoutMs).toBe('number');
    expect(record.timeoutMs).toBeGreaterThan(0);
    expect(record.timeoutMs).toBeLessThanOrEqual(5_000);
  }
});

test('the foreground wait fails at the deadline when the package never changes', async () => {
  const { runStep, steps } = scriptedForegroundRun([FIXTURE_PACKAGE]);
  const settled = await settle(
    waitForForegroundLeaves(
      CONTEXT,
      runStep,
      FIXTURE_PACKAGE,
      'read foreground state',
      'foreground never left the fixture',
    ),
  );

  expect(settled).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /foreground never left the fixture within 30000ms.*foreground read \d+ still reported com\.callstack\.agentdevicelab/s,
      ),
    },
  });
  // Reads run to the deadline, and the last one is still bounded by the time it has left.
  expect(steps.length).toBeGreaterThan(1);
  expect(Math.min(...steps.map((record) => record.timeoutMs!))).toBeLessThan(5_000);
});

/** A `runStep` for a wait driven by an injected `read`; any call to it is reported as a failure. */
function unusedRunStep(): { runStep: AndroidLiveHarness['runStep']; calls: string[] } {
  const calls: string[] = [];
  const runStep = (_context: LiveContext, step: string): Promise<CliJsonResult> => {
    calls.push(step);
    return Promise.reject(new Error(`runStep should not run: ${step}`));
  };
  return { runStep: runStep as AndroidLiveHarness['runStep'], calls };
}

test('the foreground wait retries a failed read and reports it at the deadline', async () => {
  const unused = unusedRunStep();
  const read: ForegroundRead = () => Promise.reject(new Error('appstate: device offline'));
  const settled = await settle(
    waitForForegroundLeaves(
      CONTEXT,
      unused.runStep,
      FIXTURE_PACKAGE,
      'read foreground state',
      'foreground never left the fixture',
      { read },
    ),
  );

  expect(settled).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /foreground never left the fixture within 30000ms.*device offline/s,
      ),
    },
  });
  expect(unused.calls).toEqual([]);
});

test('a read that answers no package is retried and reported at the deadline', async () => {
  const { runStep } = scriptedForegroundRun([undefined]);
  const settled = await settle(
    waitForForegroundLeaves(
      CONTEXT,
      runStep,
      FIXTURE_PACKAGE,
      'read foreground state',
      'foreground never left the fixture',
    ),
  );

  expect(settled).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /foreground never left the fixture within 30000ms.*foreground read \d+ reported no package/s,
      ),
    },
  });
});

test('a read that resolves after the deadline is a late observation', async () => {
  const unused = unusedRunStep();
  const read: ForegroundRead = async (_attempt, remainingMs) => {
    await new Promise((resolve) => setTimeout(resolve, remainingMs + 500));
    return LAUNCHER_PACKAGE;
  };
  const settled = await settle(
    waitForForegroundLeaves(
      CONTEXT,
      unused.runStep,
      FIXTURE_PACKAGE,
      'read foreground state',
      'foreground never left the fixture',
      { read },
    ),
  );

  expect(settled).toMatchObject({
    status: 'rejected',
    reason: {
      message: expect.stringMatching(
        /foreground never left the fixture within 30000ms.*resolved after the deadline/s,
      ),
    },
  });
});
