import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { getReplayExecution } from '@agent-device/replay-port/replay-backend-registry';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
} from '../../__tests__/support/handlers/session-command-harness.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { platformResourceCleanupFixture } from '../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { deriveRecordingTelemetryPath } from '@agent-device/capture-kit/recording-telemetry';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { makeAndroidSession } from '../../__tests__/support/session-factories.ts';
import { makeRecordRuntimeHarness } from './__tests__/record-runtime.fixtures.ts';
import {
  cleanupDownloadableArtifact,
  listDownloadableArtifacts,
} from '../../resources/artifact-tracking.ts';
import { expectOkData } from '../__tests__/replay-suite/session-test-suite.fixtures.ts';

test.each([false, true])(
  'a remote suite preserves the timed-out attempt outcome (missing sidecar: %s)',
  async (missingSidecar) => {
    await getReplayExecution();
    const root = mkdtempForTestSync('suite-recording-cleanup-');
    const script = path.join(root, 'flow.ad');
    fs.writeFileSync(script, 'context platform=android\nopen "Demo"\nclick "Continue"\n');
    const { sessionStore, runtime } = makeRecordRuntimeHarness('suite-recording-provider-');
    const start = runtime.start.getMockImplementation()!;
    let onStart = () => {};
    const started = new Promise<void>((resolve) => {
      onStart = resolve;
    });
    runtime.start.mockImplementation(async (input) => {
      const result = await start(input);
      onStart();
      return result;
    });
    const finish = runtime.finish.getMockImplementation()!;
    runtime.finish
      .mockRejectedValueOnce(new Error('recorder export needs retry'))
      .mockImplementation(async () => {
        const outcome = await finish();
        fs.writeFileSync(outcome.result.outPath, 'video-exported-during-close');
        const telemetryPath = deriveRecordingTelemetryPath(outcome.result.outPath);
        if (!missingSidecar) fs.writeFileSync(telemetryPath, '{}');
        return { ...outcome, result: { ...outcome.result, telemetryPath } };
      });
    const tenantId = 'recording-suite';
    const clientRoot = path.join(root, 'client');
    vi.useFakeTimers();
    try {
      const response = handleSessionCommands({
        host: createTestHostEnvironment({ cwd: root, env: {} }),
        createCommandSurface: fakeCreateCommandSurface,
        platformServices: daemonPlatformServicesFixture(),
        platformResourceCleanup: platformResourceCleanupFixture(),
        req: {
          token: 'fixture',
          session: 'suite',
          command: 'test',
          positionals: [script],
          flags: { platform: 'android', recordVideo: true, timeoutMs: 1_500 },
          meta: { cwd: root, tenantId, clientArtifactPaths: { artifactsDir: clientRoot } },
          internal: { publicNetworkOnly: true },
        },
        sessionName: 'suite',
        logPath: path.join(root, 'daemon.log'),
        sessionStore,
        bindDevice: (device, use) =>
          [...use.required, ...(use.preferred ?? [])].some((operation) =>
            operation.startsWith('screenRecording'),
          )
            ? runtime.bindDevice(device, use)
            : mockBindDeviceRuntime(device, use),
        bindExactDevice: runtime.bindExactDevice,
        screenRecordingAdmissionLedger: createScreenRecordingAdmissionLedger(),
        throwIfCanceled: () => {},
        invoke: async (req) => {
          if (req.command === 'open') {
            const ref = sessionStore.publish(req.session, makeAndroidSession(req.session));
            req.internal?.onLifetimePublished?.(ref.address, ref.lifetime);
            const beforeOpen = await req.internal?.openLifecycle?.beforeDispatch?.();
            if (beforeOpen && !beforeOpen.ok) return beforeOpen;
          }
          if (req.command === 'click') {
            const signal = getRequestSignal(req.meta?.requestId);
            if (signal && !signal.aborted) {
              await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
              );
            }
          }
          return { ok: true, data: { session: req.session } };
        },
      });

      await Promise.race([
        started,
        response.then((result) => {
          if (!runtime.start.mock.calls.length)
            throw new Error(`Recording start was not reached: ${JSON.stringify(result)}`);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(5_000);
      const data = expectOkData(await response);
      expect(data.failed).toBe(1);
      expect(runtime.finish, JSON.stringify(data.failures)).toHaveBeenCalledTimes(2);
      const outputPath = runtime.start.mock.calls[0]![0].outputPath;
      expect(fs.readFileSync(outputPath, 'utf8')).toBe('video-exported-during-close');
      expect(data.artifacts).toEqual([expect.objectContaining({ artifactType: 'test-artifacts' })]);
      const archiveRoot = data.artifacts?.[0]?.path;
      expect(archiveRoot).toBeTypeOf('string');
      expect(outputPath.startsWith(archiveRoot + path.sep)).toBe(false);
      const archiveFiles = fs.readdirSync(archiveRoot!, { recursive: true }).map(String);
      const archiveRecording = archiveFiles.find((file) => path.basename(file) === 'recording.mp4');
      const inventory = await listDownloadableArtifacts({ tenantId }, {});
      try {
        const output = inventory.find((artifact) => artifact.artifactType === 'screen-recording');
        if (missingSidecar) {
          expect(runtime.forceCleanup).toHaveBeenCalledOnce();
          expect(output).toBeUndefined();
          expect(data.recordingArtifacts).toBeUndefined();
          expect(archiveRecording).toBeUndefined();
          expect(data.failures).toMatchObject([{ error: { details: { reason: 'timeout' } } }]);
          expect(
            (data.failures as Array<{ infrastructure?: true }>)[0]!.infrastructure,
          ).toBeUndefined();
        } else {
          expect(runtime.forceCleanup).not.toHaveBeenCalled();
          expect(output?.id).toBeTypeOf('string');
          expect(archiveRecording).toBeTypeOf('string');
          expect(fs.readFileSync(path.join(archiveRoot!, archiveRecording!), 'utf8')).toBe(
            'video-exported-during-close',
          );
          for (const result of [data.tests, data.failures]) {
            expect(result).toMatchObject([
              {
                error: {
                  details: {
                    artifactPaths: expect.arrayContaining([expect.stringContaining(clientRoot)]),
                  },
                },
              },
            ]);
            expect(JSON.stringify(result)).not.toContain(archiveRoot);
            expect(JSON.stringify(result)).not.toContain(outputPath);
          }
          expect(data.recordingArtifacts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                artifactId: output?.id,
                path: expect.stringMatching(/client\/.*\/attempt-1\/recording\.mp4$/),
              }),
            ]),
          );
        }
      } finally {
        for (const artifact of inventory) cleanupDownloadableArtifact(artifact.id);
      }
      expect(fs.existsSync(outputPath)).toBe(missingSidecar);
    } finally {
      vi.useRealTimers();
    }
  },
);
