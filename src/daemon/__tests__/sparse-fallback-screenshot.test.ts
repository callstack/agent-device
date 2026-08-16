import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import { makeIosSession, mkdtempForTest } from '../../__tests__/test-utils/index.ts';
import { SessionStore } from '../session-store.ts';
import { dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';
import { snapshotRuntimeFixture } from './snapshot-runtime-fixture.ts';

const dispatchCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: dispatchCommandMock,
  };
});

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

/** Snapshot captures answer with the seeded verdict; screenshot captures answer per `screenshot`. */
function seed(
  verdict: SnapshotQualityVerdict,
  screenshot: () => Promise<Record<string, unknown>> = async () => ({ width: 390, height: 844 }),
) {
  dispatchCommandMock.mockReset();
  dispatchCommandMock.mockImplementation(async (_device: unknown, command: string) =>
    command === 'screenshot'
      ? await screenshot()
      : {
          backend: 'xctest',
          truncated: false,
          quality: verdict,
          nodes: [{ index: 0, depth: 0, type: 'Application', label: 'Demo' }],
        },
  );
}

async function dispatch(input: Awaited<ReturnType<typeof scenario>>, internalObservation = false) {
  const runtime = snapshotRuntimeFixture();
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
    ...runtime,
  });
  if (!response.ok) throw new Error('expected ok response');
  return response.data ?? {};
}

function screenshotCalls() {
  return dispatchCommandMock.mock.calls.filter((call) => call[1] === 'screenshot');
}

test('a sparse snapshot captures the screenshot its own remedy asks for and links it', async () => {
  const input = await scenario();
  seed(SPARSE);

  const data = await dispatch(input);
  const warnings = (data.warnings ?? []) as string[];

  expect(screenshotCalls()).toHaveLength(1);
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
  seed({ state: 'healthy', backend: 'tree' });

  const data = await dispatch(input);

  expect(screenshotCalls()).toHaveLength(0);
  expect(data.fallbackScreenshotPath).toBeUndefined();
  expect(data.artifacts).toBeUndefined();
});

test('internal observations stay silent so a polling wait cannot shoot once per poll', async () => {
  const input = await scenario();
  seed(SPARSE);

  const data = await dispatch(input, true);

  expect(screenshotCalls()).toHaveLength(0);
  expect(data.fallbackScreenshotPath).toBeUndefined();
  expect(data.artifacts).toBeUndefined();
});

test('a failed fallback screenshot does not fail the snapshot that was asked for', async () => {
  const input = await scenario();
  seed(SPARSE, async () => {
    throw new Error('screenshot dispatch exploded');
  });

  const data = await dispatch(input);
  const warnings = (data.warnings ?? []) as string[];

  expect(screenshotCalls()).toHaveLength(1);
  expect(data.fallbackScreenshotPath).toBeUndefined();
  expect(data.artifacts).toBeUndefined();
  // The manual remedy is still on the response, so the caller is not left without one.
  expect(warnings.some((line) => line.includes('Use screenshot as visual truth'))).toBe(true);
});
