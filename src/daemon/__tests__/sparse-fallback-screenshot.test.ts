import path from 'node:path';
import { expect, test } from 'vitest';
import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { mkdtempForTest } from '../../__tests__/test-utils/tmp-dir.ts';
import { SessionStore } from '../session-store.ts';
import { dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';
import {
  screenshotRuntimeFixture,
  writeSolidPng,
  type ScreenshotRuntimeFixture,
  type ScreenshotRuntimeFixtureOptions,
} from './screenshot-runtime-fixture.ts';

const SPARSE: SnapshotQualityVerdict = {
  state: 'sparse',
  backend: 'private-ax',
  reason: 'snapshot returned no semantic controls or content',
  reasonCode: 'sparse-tree',
};

async function scenario() {
  const root = await mkdtempForTest('agent-device-sparse-fallback-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  return { sessionStore, sessionName, logPath: path.join(root, 'daemon.log') };
}

/** Both captures answer at the request-bound runtime seam: the snapshot carries the seeded
 * verdict, and the screenshot leg is the fallback under test. */
function seed(
  verdict: SnapshotQualityVerdict,
  onCapture: ScreenshotRuntimeFixtureOptions['onCapture'] = (input) => writeSolidPng(input.outPath),
): ScreenshotRuntimeFixture {
  return screenshotRuntimeFixture({
    onCapture,
    snapshotResult: () =>
      ({
        backend: 'xctest',
        truncated: false,
        quality: verdict,
        nodes: [{ index: 0, depth: 0, type: 'Application', label: 'Demo' }],
      }) as never,
  });
}

async function dispatch(
  input: Awaited<ReturnType<typeof scenario>>,
  runtime: ScreenshotRuntimeFixture,
  internalObservation = false,
) {
  const response = await dispatchSnapshotViaRuntime({
    req: {
      command: 'snapshot',
      positionals: [],
      token: 't',
      session: input.sessionName,
      ...(internalObservation ? { internal: { observationOnly: true } } : {}),
    },
    sessionName: input.sessionName,
    logPath: input.logPath,
    sessionStore: input.sessionStore,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
  });
  if (!response.ok) throw new Error('expected ok response');
  return response.data ?? {};
}

test('a sparse snapshot captures the screenshot its own remedy asks for and links it', async () => {
  const input = await scenario();
  const runtime = seed(SPARSE);

  const data = await dispatch(input, runtime);
  const warnings = (data.warnings ?? []) as string[];

  expect(runtime.captureScreenshot).toHaveBeenCalledTimes(1);
  expect(data.fallbackScreenshotPath).toMatch(/\.png$/);
  expect(data.artifacts).toEqual([
    {
      field: 'fallbackScreenshotPath',
      artifactType: 'screenshot',
      path: data.fallbackScreenshotPath,
      fileName: 'snapshot-fallback.png',
    },
  ]);
  // The verdict's own two lines still stand: the refs are invalid, and a screen that
  // publishes nothing is an app defect worth reporting.
  expect(warnings.some((line) => line.startsWith('No snapshot backend could read'))).toBe(true);
  expect(warnings.some((line) => line.includes('app accessibility bug'))).toBe(true);
});

test('a readable snapshot never pays for a screenshot', async () => {
  const input = await scenario();
  const runtime = seed({ state: 'healthy', backend: 'tree' });

  const data = await dispatch(input, runtime);

  expect(runtime.captureScreenshot).not.toHaveBeenCalled();
  expect(data.fallbackScreenshotPath).toBeUndefined();
  expect(data.artifacts).toBeUndefined();
});

test('internal observations stay silent so a polling wait cannot shoot once per poll', async () => {
  const input = await scenario();
  const runtime = seed(SPARSE);

  const data = await dispatch(input, runtime, true);

  expect(runtime.captureScreenshot).not.toHaveBeenCalled();
  expect(data.fallbackScreenshotPath).toBeUndefined();
  expect(data.artifacts).toBeUndefined();
});

test('a failed fallback screenshot does not fail the snapshot that was asked for', async () => {
  const input = await scenario();
  const runtime = seed(SPARSE, () => {
    throw new Error('screenshot capture exploded');
  });

  const data = await dispatch(input, runtime);
  const warnings = (data.warnings ?? []) as string[];

  expect(runtime.captureScreenshot).toHaveBeenCalledTimes(1);
  expect(data.fallbackScreenshotPath).toBeUndefined();
  expect(data.artifacts).toBeUndefined();
  // The manual remedy is still on the response, so the caller is not left without one.
  expect(warnings.some((line) => line.includes('Use screenshot as visual truth'))).toBe(true);
});
