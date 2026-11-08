import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import type { SessionState } from '../../../core/session-state.ts';
import { makeRecordRuntimeHarness, recordingResourcePath } from './record-runtime.fixtures.ts';

// A record-only start selects the harness device.
vi.mock('@agent-device/device-selection/dispatch-resolve', () => ({
  resolveTargetDevice: async () => ({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
  }),
}));

// Two sessions share one device, so the second start meets the first one's record.
function startOnSecondSession(harness: ReturnType<typeof makeRecordRuntimeHarness>) {
  const second: SessionState = { ...harness.session, name: 'second' };
  harness.sessionStore.publish('second', second);
  const outPath = path.join(mkdtempForTestSync('record-runtime-orphan-output-'), 'second.mp4');
  return harness.run(['start', outPath], undefined, undefined, undefined, 'second');
}

function recordLifecycle(
  harness: ReturnType<typeof makeRecordRuntimeHarness>,
  sessionName = harness.sessionName,
): string {
  const record = screenRecordingResourceStore.read(
    recordingResourcePath(harness.sessionStore, sessionName),
  );
  if (record.status !== 'decoded') throw new Error('Expected a decoded recording record');
  return record.envelope.lifecycle;
}

// An open record that a recording on another device left under `sessionId`.
function writeRecordOnOtherDevice(
  harness: ReturnType<typeof makeRecordRuntimeHarness>,
  sessionId: string,
) {
  const resourcePath = recordingResourcePath(harness.sessionStore, sessionId);
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  screenRecordingResourceStore.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId,
      device: deviceIdentity({ platform: 'android', id: 'emulator-5556', kind: 'emulator' }),
      owner: localRuntimeOwner('android'),
      fence: { token: sessionId, generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { recordingId: sessionId } },
    }),
  );
}

async function leaveOrphanedRecord(harness: ReturnType<typeof makeRecordRuntimeHarness>) {
  const outPath = path.join(mkdtempForTestSync('record-runtime-orphan-first-'), 'first.mp4');
  await harness.run(['start', outPath]);
  // The daemon forgets the session while its record stays open: the recorder died with its device
  // and no claim, startup recovery or stop is left to settle it.
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the live recording session');
  harness.sessionStore.retire(ref);
  expect(recordLifecycle(harness)).toBe('open');
}

// The start does what the record's own stop would: a recording that can still export is finished.
test('record start finishes an orphaned recording record on its device instead of refusing', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-orphan-finish-', {
    runtime: { reattachActive: true },
  });
  await leaveOrphanedRecord(harness);

  const response = await startOnSecondSession(harness);

  expect(response).toMatchObject({ ok: true, data: { recording: 'started' } });
  expect(recordLifecycle(harness)).toBe('completed');
  expect(harness.runtime.finish).toHaveBeenCalledOnce();
  expect(harness.runtime.forceCleanup).not.toHaveBeenCalled();
});

test('record start cleans an orphaned recording record that cannot finish', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-orphan-settle-', {
    runtime: { reattachActive: true, finishError: new Error('artifact is not stable') },
  });
  await leaveOrphanedRecord(harness);

  const response = await startOnSecondSession(harness);

  expect(response).toMatchObject({ ok: true, data: { recording: 'started' } });
  expect(recordLifecycle(harness)).toBe('completed');
  expect(harness.runtime.forceCleanup).toHaveBeenCalledOnce();
});

test('record start completes an orphaned record whose recording is gone from its device', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-orphan-missing-');
  await leaveOrphanedRecord(harness);

  const response = await startOnSecondSession(harness);

  expect(response).toMatchObject({ ok: true, data: { recording: 'started' } });
  expect(recordLifecycle(harness)).toBe('completed');
});

test('record start leaves an orphaned record on another device open', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-orphan-elsewhere-', {
    runtime: { reattachActive: true },
  });
  writeRecordOnOtherDevice(harness, 'elsewhere');
  const outPath = path.join(mkdtempForTestSync('record-runtime-orphan-elsewhere-out-'), 'a.mp4');

  const response = await harness.run(['start', outPath]);

  expect(response).toMatchObject({ ok: true, data: { recording: 'started' } });
  expect(recordLifecycle(harness, 'elsewhere')).toBe('open');
  expect(harness.runtime.reattach).not.toHaveBeenCalled();
});

test('record start refuses on a record of its own session that another device left open', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-orphan-same-path-', {
    runtime: { reattachActive: true },
  });
  const ref = harness.sessionStore.lookup(harness.sessionName);
  if (!ref) throw new Error('Expected the harness session');
  harness.sessionStore.retire(ref);
  writeRecordOnOtherDevice(harness, harness.sessionName);
  const outPath = path.join(mkdtempForTestSync('record-runtime-orphan-same-path-out-'), 'a.mp4');

  const response = await harness.run(['start', outPath], undefined, {
    recordingScope: 'device',
    serial: 'emulator-5554',
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      hint: expect.stringContaining('"emulator-5556"'),
      details: { reason: 'cleanup-unconfirmed', session: harness.sessionName },
    },
  });
  expect(recordLifecycle(harness)).toBe('open');
  expect(harness.runtime.reattach).not.toHaveBeenCalled();
});

test('record start still refuses when the orphaned record cannot be confirmed cleaned', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-orphan-pending-', {
    runtime: {
      reattachActive: true,
      finishError: new Error('artifact is not stable'),
      cleanup: { status: 'cleanup-pending', reason: 'transport-failed' },
    },
  });
  await leaveOrphanedRecord(harness);

  const response = await startOnSecondSession(harness);

  expect(response).toMatchObject({
    ok: false,
    error: { details: { reason: 'cleanup-unconfirmed' } },
  });
  expect(recordLifecycle(harness)).toBe('open');
  expect(harness.runtime.start).toHaveBeenCalledOnce();
});

// A held session's record belongs to its own stop or close: with its live recording, and after a
// record stop that could not produce its export kept the record open for a retry.
test.for([
  { held: 'the live recording', dropBinding: false },
  { held: 'the session after its recording binding is gone', dropBinding: true },
])('record start leaves a record alone while its session holds $held', async ({ dropBinding }) => {
  const harness = makeRecordRuntimeHarness('record-runtime-orphan-held-', {
    runtime: { reattachActive: true },
  });
  const firstOut = path.join(mkdtempForTestSync('record-runtime-orphan-held-first-'), 'first.mp4');
  await harness.run(['start', firstOut]);
  if (dropBinding) {
    const ref = harness.sessionStore.lookup(harness.sessionName);
    if (!ref) throw new Error('Expected the recording session');
    harness.sessionStore.update(ref, { screenRecording: undefined });
  }

  const response = await startOnSecondSession(harness);

  // The refusal names the session whose stop or close owns the record.
  expect(response).toMatchObject({
    ok: false,
    error: { details: { reason: 'cleanup-unconfirmed', session: harness.sessionName } },
  });
  expect(recordLifecycle(harness)).toBe('open');
  expect(harness.runtime.reattach).not.toHaveBeenCalled();
  expect(harness.runtime.forceCleanup).not.toHaveBeenCalled();
});
