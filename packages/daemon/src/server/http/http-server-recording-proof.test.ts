import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { stopAndExportScreenRecording } from '@agent-device/capture-kit/recording-stop-sequence';
import { deriveRecordingTelemetryPath } from '@agent-device/capture-kit/recording-telemetry';
import { cleanupDownloadableArtifact } from '../../resources/artifact-tracking.ts';
import { makeRecordRuntimeHarness } from '../../sessions/handlers/__tests__/record-runtime.fixtures.ts';
import { successfulData, withHttp } from './http-output.fixtures.ts';

const RECORD = { command: 'record' };
const START = { ...RECORD, positionals: ['start'] };
const STOP = { ...RECORD, positionals: ['stop'] };
const HEADERS = { authorization: 'Bearer test-token' };

async function withRecording(
  run: (
    harness: ReturnType<typeof makeRecordRuntimeHarness>,
    post: Parameters<Parameters<typeof withHttp>[1]>[0],
    base: string,
    capturePath: string,
  ) => Promise<void>,
) {
  const harness = makeRecordRuntimeHarness('recording-proof-');
  const start = harness.runtime.start.getMockImplementation()!;
  harness.runtime.start.mockImplementation(async (input) => {
    fs.writeFileSync(input.outputPath, 'producer-video');
    return await start(input);
  });
  await withHttp(
    (request) => harness.run(request.positionals, request.meta, request.flags, request.internal),
    async (post, base) => {
      successfulData(await post(START));
      await run(harness, post, base, harness.runtime.start.mock.calls[0]![0].outputPath);
    },
  );
}

test.each(['live stop', 'completed retry', 'successor session'] as const)(
  'a remote recording refuses an unauthorized %s',
  async (operation) => {
    await withRecording(async (harness, post, base) => {
      const namedStop = { ...STOP, meta: { tenantId: 'another-tenant' } };
      const refusal = { reason: 'LEASE_OUTPUT_MISMATCH' };
      if (operation === 'live stop') {
        expect((await post(namedStop)).error?.data?.details).toMatchObject(refusal);
        expect(harness.runtime.finish).not.toHaveBeenCalled();
      }
      const { artifacts } = successfulData(await post(STOP));
      const id = artifacts?.[0]?.artifactId;
      expect(id).toBeTypeOf('string');
      try {
        if (operation === 'completed retry') {
          expect((await post(namedStop)).error?.data?.details).toMatchObject(refusal);
        }
        if (operation === 'successor session') {
          const previous = harness.sessionStore.lookup(harness.sessionName)!;
          harness.sessionStore.retire(previous);
          const successor = harness.sessionStore.publish(harness.sessionName, harness.session);
          expect(successor.lifetime.journalId).not.toBe(previous.lifetime.journalId);
          expect((await post(STOP)).error?.data?.details).toMatchObject(refusal);
        }
        const download = await fetch(`${base}/artifacts/${id}`, { headers: HEADERS });
        expect(download.status).toBe(200);
        expect(await download.text()).toBe('producer-video');
      } finally {
        if (id) cleanupDownloadableArtifact(id);
      }
    });
  },
);

test('a replayed producer completion without proof cannot acquire a remote download ID', async () => {
  await withRecording(async (harness, post, base, capturePath) => {
    const finish = harness.runtime.finish.getMockImplementation()!;
    harness.runtime.finish.mockImplementation(async () => ({
      ...(await finish()),
      alreadyCompleted: true,
    }));
    expect((await post(STOP)).error?.data?.details).toMatchObject({
      reason: 'LEASE_OUTPUT_MISMATCH',
    });
    expect(await (await fetch(`${base}/artifacts`, { headers: HEADERS })).json()).toMatchObject({
      artifacts: [],
    });
    expect(fs.readFileSync(capturePath, 'utf8')).toBe('producer-video');
  });
});

test.each(['terminal write', 'native marker'] as const)(
  'a retry after a failed %s cannot certify replacement bytes',
  async (failedStep) => {
    await withRecording(async (harness, post, base, capturePath) => {
      const finish = harness.runtime.finish.getMockImplementation()!;
      const { sessionName, sessionStore } = harness;
      const manifest = screenRecordingResourceStore.resolvePath(
        sessionStore.resolveSessionDir(sessionName),
      );
      const rename = fs.renameSync;
      const failTerminal = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (
          failedStep === 'terminal write' &&
          to === manifest &&
          fs.readFileSync(from, 'utf8').includes('"lifecycle":"completed"')
        ) {
          throw new Error('Terminal write failed');
        }
        rename(from, to);
      });
      const finalize = vi.fn(async () => ({ nativePathDisposition: 'retired' as const }));
      if (failedStep === 'native marker') {
        harness.runtime.finish.mockImplementation(async (progress) => {
          const { result } = await finish();
          const outcome = await stopAndExportScreenRecording({
            snapshot: { ...result, gestureEvents: [] },
            progress,
            steps: {
              stop: async () => ({ observation: { recorder: 'confirmed' } }),
              collect: async () => {},
              finalize,
              discard: async () => {},
            },
          });
          if (harness.runtime.finish.mock.calls.length === 1)
            throw new Error('Native marker write failed');
          return { ...outcome, result: { ...result, ...outcome.result, scope: 'app' } };
        });
      }
      try {
        expect((await post(STOP)).error).toBeDefined();
      } finally {
        failTerminal.mockRestore();
      }
      fs.writeFileSync(capturePath + '.replacement', 'replacement');
      fs.renameSync(capturePath + '.replacement', capturePath);
      expect((await post(STOP)).error?.data?.details).toMatchObject({ reason: 'RESOURCE_EXPIRED' });
      if (failedStep === 'native marker') expect(finalize).toHaveBeenCalledOnce();
      expect(await (await fetch(`${base}/artifacts`, { headers: HEADERS })).json()).toMatchObject({
        artifacts: [],
      });
      expect(fs.readFileSync(capturePath, 'utf8')).toBe('replacement');
    });
  },
);

test('the first stop validates the whole committed set before publishing any ID', async () => {
  await withRecording(async (harness, post, base, capturePath) => {
    const finish = harness.runtime.finish.getMockImplementation()!;
    const telemetryPath = deriveRecordingTelemetryPath(capturePath);
    harness.runtime.finish.mockImplementation(async () => {
      fs.writeFileSync(telemetryPath, '{}');
      const outcome = await finish();
      return { ...outcome, result: { ...outcome.result, telemetryPath } };
    });
    const manifest = screenRecordingResourceStore.resolvePath(
      harness.sessionStore.resolveSessionDir(harness.sessionName),
    );
    const rename = fs.renameSync;
    const replaceAfterCommit = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      const completed =
        to === manifest && fs.readFileSync(from, 'utf8').includes('"lifecycle":"completed"');
      rename(from, to);
      if (completed) fs.rmSync(telemetryPath);
    });
    try {
      expect((await post(STOP)).error?.data?.details).toMatchObject({ reason: 'RESOURCE_EXPIRED' });
    } finally {
      replaceAfterCommit.mockRestore();
    }
    expect(await (await fetch(`${base}/artifacts`, { headers: HEADERS })).json()).toMatchObject({
      artifacts: [],
    });
    expect(fs.readFileSync(capturePath, 'utf8')).toBe('producer-video');
  });
});

test.each(['missing lookup', 'missing open', 'symlink open'] as const)(
  'a recording download retires a %s with a path-free expiry',
  async (failure) => {
    await withRecording(async (_harness, post, base, capturePath) => {
      const { artifacts } = successfulData(await post(STOP));
      const id = artifacts?.[0]?.artifactId;
      expect(id).toBeTypeOf('string');
      const open = fs.openSync;
      const replacement = path.join(path.dirname(capturePath), 'replacement.mp4');
      const removeCapture = () => {
        fs.unlinkSync(capturePath);
        if (failure === 'symlink open') {
          fs.writeFileSync(replacement, 'replacement');
          fs.symlinkSync(replacement, capturePath);
        }
      };
      if (failure === 'missing lookup') removeCapture();
      const removeBeforeOpen = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
        if (file === capturePath && failure !== 'missing lookup') removeCapture();
        return open(file, flags, mode);
      });
      const download = () => fetch(`${base}/artifacts/${id}`, { headers: HEADERS });
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await download();
          const body = await response.text();
          expect(body).not.toContain(capturePath);
          expect(response.status).toBe(404);
          expect(JSON.parse(body)).toMatchObject({ reason: 'RESOURCE_EXPIRED' });
        }
      } finally {
        removeBeforeOpen.mockRestore();
        if (id) cleanupDownloadableArtifact(id);
      }
      if (failure === 'symlink open') {
        expect(fs.lstatSync(capturePath).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(replacement, 'utf8')).toBe('replacement');
      }
    });
  },
);
