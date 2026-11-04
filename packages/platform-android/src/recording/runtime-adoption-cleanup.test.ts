import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { adoptStartedScreenRecording } from '@agent-device/capture-kit/screen-recording-session-resource';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

test.each(['forced-still-alive', 'artifact-still-present', 'writer-unconfirmed'] as const)(
  'failed adoption retains native and durable evidence when %s',
  async (failure) => {
    vi.useFakeTimers();
    const root = mkdtempForTestSync('android-adoption-proof-');
    const oldClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
    const claimsDir = path.join(root, 'claims');
    mkdirSync(claimsDir);
    const sentinel = path.join(claimsDir, 'sentinel');
    writeFileSync(sentinel, 'untouched');
    process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
    const sessionDir = path.join(root, 'session');
    mkdirSync(sessionDir);
    let nativeMarker = '';
    let alive = true;
    let forced = false;
    let removed = false;
    try {
      const runtime = await bindAndroidScreenRecordingRuntime({
        host: recordingHost({
          readManifest: async (path: string) =>
            path.includes('recording-v2-') && nativeMarker
              ? { status: 'read' as const, contents: nativeMarker }
              : { status: 'missing' as const },
          writeManifest: async ({ contents }: { contents: string }) => {
            nativeMarker = contents;
          },
          removeManifest: async () => {
            nativeMarker = '';
            return true;
          },
          stop: async (_identity: unknown, options?: { force?: boolean }) => {
            if (options?.force) forced = true;
            if (failure !== 'forced-still-alive') alive = false;
            return 'stopped' as const;
          },
          inspect: async () => (alive ? ('owned-alive' as const) : ('missing' as const)),
          findRunning: async () =>
            failure === 'writer-unconfirmed' ? { writers: [], conclusive: false } : [],
          exists: async () => failure === 'artifact-still-present' || !removed,
          remove: async () => {
            removed = true;
            return true;
          },
        }),
        device: androidRecordingDevice,
        owner: localRuntimeOwner('android'),
        signal: new AbortController().signal,
      });
      const input = recordingInput();
      const started = await runtime.screenRecordingStart(input);
      const before = nativeMarker;
      let rollbackReported = false;
      const binding = {
        address: input.sessionId,
        sessionDir,
        read: () => undefined,
        assertAdoptable: () => {},
        canPersist: () => true,
        adopt: () => {},
        clear: () => 'cleared' as const,
      };
      const adoption = adoptStartedScreenRecording({
        admissionLedger: createScreenRecordingAdmissionLedger(),
        binding,
        device: androidRecordingDevice,
        owner: localRuntimeOwner('android'),
        fence: input.fence,
        ...started,
        reportConfirmedStartRollback: () => {
          rollbackReported = true;
        },
        throwIfCanceled: () => {
          throw new Error('adoption canceled');
        },
      });
      const rejected = expect(adoption).rejects.toThrow('adoption canceled');
      await vi.advanceTimersByTimeAsync(21_000);
      await rejected;
      expect(rollbackReported).toBe(false);
      expect(nativeMarker).toBe(before);
      if (failure === 'forced-still-alive') {
        expect(forced).toBe(true);
        expect(removed).toBe(false);
      }
      if (failure === 'writer-unconfirmed') expect(removed).toBe(false);
      const stored = screenRecordingResourceStore.read(
        screenRecordingResourceStore.resolvePath(sessionDir),
      );
      expect(stored).toMatchObject({
        status: 'decoded',
        envelope: { lifecycle: 'open', metadata: { phase: 'cleanup-pending' } },
      });
      expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
    } finally {
      vi.useRealTimers();
      if (oldClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
      else process.env.AGENT_DEVICE_CLAIMS_DIR = oldClaimsDir;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
