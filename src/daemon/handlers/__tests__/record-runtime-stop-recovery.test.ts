import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { screenRecordingResourceStore } from '../../screen-recording-resource-store.ts';
import {
  expectDecodedCompletedRecording,
  makeRecordRuntimeHarness,
  recordingResourcePath,
} from './record-runtime.fixtures.ts';

test('record stop with a live handle binds no runtime and terminalizes the durable record', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-live-stop-');
  const outPath = path.join(mkdtempForTestSync('record-runtime-live-stop-output-'), 'capture.mp4');
  await harness.run(['start', outPath]);

  const stopped = await harness.run(['stop']);

  expect(stopped).toMatchObject({
    ok: true,
    data: { recording: 'stopped', outPath, recordingBackend: 'adb screenrecord' },
  });
  expect(harness.runtime.finish).toHaveBeenCalledOnce();
  expect(harness.runtime.bindExactDeviceCalls).not.toHaveBeenCalled();
  expect(harness.sessionStore.get(harness.sessionName)?.screenRecording).toBeUndefined();
});

test('record stop preserves a finish failure after confirmed compensating cleanup', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-failed-live-stop-', {
    runtime: { finishError: new Error('final copy failed') },
  });
  await harness.run(['start', 'failed-copy.mp4']);

  const stopped = await harness.run(['stop']);

  expect(stopped).toMatchObject({
    ok: false,
    error: { code: 'UNKNOWN', message: 'final copy failed' },
  });
  expect(harness.runtime.finish).toHaveBeenCalledOnce();
  expect(harness.runtime.forceCleanup).toHaveBeenCalledOnce();
  expect(harness.sessionStore.get(harness.sessionName)?.screenRecording).toBeUndefined();
  expectDecodedCompletedRecording(harness.sessionStore, harness.sessionName);

  await expect(harness.run(['start', 'replacement.mp4'])).resolves.toMatchObject({
    ok: true,
    data: { recording: 'started' },
  });
});

test('record stop after daemon-state loss reattaches only through the persisted exact owner', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-recovered-stop-', {
    runtime: { reattachActive: true },
  });
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-recovered-stop-output-'),
    'capture.mp4',
  );
  await harness.run(['start', outPath]);
  const adopted = harness.sessionStore.get(harness.sessionName);
  if (!adopted) throw new Error('Expected adopted recording session');
  harness.sessionStore.set(harness.sessionName, { ...adopted, screenRecording: undefined });

  const stopped = await harness.run(['stop']);

  expect(stopped).toMatchObject({ ok: true, data: { recording: 'stopped', outPath } });
  expect(harness.runtime.bindExactDeviceCalls).toHaveBeenCalledOnce();
  expect(harness.runtime.reattach).toHaveBeenCalledOnce();
  expect(harness.runtime.finish).toHaveBeenCalledOnce();
});

test('record stop terminalizes cleanup-only exact recovery without starting a replacement', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-cleanup-only-stop-', {
    recordOnlySession: true,
    runtime: { reattachUnreattachable: true },
  });
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-cleanup-only-output-'),
    'capture.mp4',
  );
  await harness.run(['start', outPath]);
  const adopted = harness.sessionStore.get(harness.sessionName);
  if (!adopted) throw new Error('Expected adopted recording session');
  harness.sessionStore.set(harness.sessionName, { ...adopted, screenRecording: undefined });

  const stopped = await harness.run(['stop']);

  expect(stopped).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'transport-not-reattachable' } },
  });
  expect(harness.runtime.cleanup).toHaveBeenCalledOnce();
  expectDecodedCompletedRecording(harness.sessionStore, harness.sessionName);
  expect(harness.sessionStore.get(harness.sessionName)).toBeUndefined();
  expect(harness.runtime.start).toHaveBeenCalledOnce();
});

test('record stop rejects a cross-session recovery manifest before exact-owner binding', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-cross-session-', {
    sessionName: 'recording-a',
    runtime: { reattachActive: true },
  });
  const outPath = path.join(
    mkdtempForTestSync('record-runtime-cross-session-output-'),
    'capture.mp4',
  );
  await harness.run(['start', outPath]);
  const resourcePath = recordingResourcePath(harness.sessionStore, harness.sessionName);
  const record = screenRecordingResourceStore.read(resourcePath);
  if (record.status !== 'decoded') throw new Error('Expected decoded recording manifest');
  screenRecordingResourceStore.write(resourcePath, {
    ...record.envelope,
    sessionId: 'recording-b',
  });
  const adopted = harness.sessionStore.get(harness.sessionName);
  if (!adopted) throw new Error('Expected adopted recording session');
  harness.sessionStore.set(harness.sessionName, { ...adopted, screenRecording: undefined });

  const stopped = await harness.run(['stop']);

  expect(stopped).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'runtime-contract-invalid' } },
  });
  expect(harness.runtime.bindExactDeviceCalls).not.toHaveBeenCalled();
});

test('record stop returns the export whose response never reached the caller', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-replayed-stop-');
  const outPath = writeRecording('record-runtime-replayed-stop-output-');
  await harness.run(['start', outPath]);
  await harness.run(['stop']);

  const recovered = await harness.run(['stop']);

  expect(recovered).toMatchObject({
    ok: true,
    data: { recording: 'stopped', outPath, recordingBackend: 'adb screenrecord' },
  });
  expect(harness.runtime.finish).toHaveBeenCalledOnce();
  expect(harness.runtime.bindExactDeviceCalls).not.toHaveBeenCalled();
});

test('a recovered stop keeps the caller-side output path that makes it downloadable', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-replayed-remote-stop-');
  const cwd = mkdtempForTestSync('record-runtime-replayed-remote-stop-output-');
  const outPath = path.join(cwd, 'capture.mp4');
  fs.writeFileSync(outPath, 'mp4');
  await harness.run(['start', outPath], {
    cwd,
    clientArtifactPaths: { outPath: '/client/capture.mp4' },
  });
  await harness.run(['stop'], { cwd });

  const recovered = await harness.run(['stop'], { cwd });

  expect(recovered).toMatchObject({
    ok: true,
    data: {
      recording: 'stopped',
      outPath,
      artifacts: [{ field: 'outPath', path: outPath, localPath: '/client/capture.mp4' }],
    },
  });
});

test('a recovered stop does not record a second session stop action', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-replayed-stop-action-');
  const outPath = writeRecording('record-runtime-replayed-stop-action-output-');
  await harness.run(['start', outPath]);
  await harness.run(['stop']);

  await harness.run(['stop']);

  const actions = harness.sessionStore.get(harness.sessionName)?.actions ?? [];
  expect(actions.filter((action) => action.positionals[0] === 'stop')).toHaveLength(1);
});

test('record stop refuses a completed export owned by another session', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-replayed-stop-cross-session-');
  const outPath = writeRecording('record-runtime-replayed-stop-cross-session-output-');
  await harness.run(['start', outPath]);
  await harness.run(['stop']);
  const resourcePath = recordingResourcePath(harness.sessionStore, harness.sessionName);
  const record = screenRecordingResourceStore.read(resourcePath);
  if (record.status !== 'decoded') throw new Error('Expected decoded recording manifest');
  screenRecordingResourceStore.write(resourcePath, {
    ...record.envelope,
    sessionId: 'recording-b',
  });

  const recovered = await harness.run(['stop']);

  expect(recovered).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'runtime-contract-invalid' } },
  });
  expect(harness.runtime.bindExactDeviceCalls).not.toHaveBeenCalled();
});

test('record stop reports no active recording once a completed export is gone', async () => {
  const harness = makeRecordRuntimeHarness('record-runtime-deleted-stop-');
  const outPath = writeRecording('record-runtime-deleted-stop-output-');
  await harness.run(['start', outPath]);
  await harness.run(['stop']);
  fs.rmSync(outPath);

  const recovered = await harness.run(['stop']);

  expect(recovered).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', message: 'no active recording' },
  });
  expect(harness.runtime.bindExactDeviceCalls).not.toHaveBeenCalled();
});

function writeRecording(prefix: string): string {
  const outPath = path.join(mkdtempForTestSync(prefix), 'capture.mp4');
  fs.writeFileSync(outPath, 'mp4');
  return outPath;
}
