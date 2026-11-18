import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { readCaptureGrantId } from '@agent-device/kernel/contracts';
import { makeRecordRuntimeHarness, recordingResourcePath } from './record-runtime.fixtures.ts';

const GRANT_ID = '6f1c2a4e-0b7d-4c1e-9a55-3d2f8e7b6a10';

function readEnvelopeMetadata(harness: ReturnType<typeof makeRecordRuntimeHarness>) {
  const record = screenRecordingResourceStore.read(
    recordingResourcePath(harness.sessionStore, harness.sessionName),
  );
  return record.status === 'decoded' ? record.envelope.metadata : undefined;
}

test('an accepted record start binds the client grant ID into the capture record and the stop echoes it from that capture', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-grant-bind-');
  const outPath = path.join(mkdtempForTestSync('record-runtime-grant-'), 'capture.mp4');

  const started = await harness.run(['start', outPath], {
    cwd: '/client/project',
    clientArtifactPaths: { outPath: '/client/project/capture.mp4' },
    captureGrantId: GRANT_ID,
  });
  expect(started.ok).toBe(true);

  // The binding lives in the capture's own producer lifecycle metadata; the fence never appears.
  const metadata = readEnvelopeMetadata(harness);
  expect(readCaptureGrantId(metadata?.captureGrantId)).toBe(GRANT_ID);
  expect(JSON.stringify(metadata)).not.toContain('fence');

  const stopped = await harness.run(['stop']);
  if (!stopped.ok) throw new Error(JSON.stringify(stopped.error));
  expect(readCaptureGrantId(stopped.data?.captureGrantId)).toBe(GRANT_ID);
  const artifacts = (stopped.data?.artifacts ?? []) as Array<Record<string, unknown>>;
  expect(artifacts.length).toBeGreaterThan(0);
  for (const artifact of artifacts) {
    expect(readCaptureGrantId(artifact.captureGrantId)).toBe(GRANT_ID);
  }
});

test('a malformed or absent grant ID is not bound and the stop echoes none', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-grant-absent-');
  const outPath = path.join(mkdtempForTestSync('record-runtime-grant-'), 'capture.mp4');

  const started = await harness.run(['start', outPath], { captureGrantId: '../escape' });
  expect(started.ok).toBe(true);
  expect(readEnvelopeMetadata(harness)?.captureGrantId).toBeUndefined();

  const stopped = await harness.run(['stop']);
  if (!stopped.ok) throw new Error(JSON.stringify(stopped.error));
  expect(stopped.data?.captureGrantId).toBeUndefined();
  const artifacts = (stopped.data?.artifacts ?? []) as Array<Record<string, unknown>>;
  for (const artifact of artifacts) {
    expect(artifact.captureGrantId).toBeUndefined();
  }
});

test('a start without a grant ID leaves the record without one, and the stop echoes none', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-grant-none-');
  const outPath = path.join(mkdtempForTestSync('record-runtime-grant-'), 'capture.mp4');

  const started = await harness.run(['start', outPath]);
  expect(started.ok).toBe(true);
  expect(readEnvelopeMetadata(harness)?.captureGrantId).toBeUndefined();

  const stopped = await harness.run(['stop']);
  if (!stopped.ok) throw new Error(JSON.stringify(stopped.error));
  expect(stopped.data?.captureGrantId).toBeUndefined();
});
