import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import {
  IOS_SIMULATOR,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { readProcessIdentityFacts } from '@agent-device/host-kit/process';
import {
  inspectDeviceClaims,
  reconcileOrphanedDeviceClaims,
  retryRecordingClaimCleanup,
} from '@agent-device/daemon-contracts/device-claims';
import {
  createOwnerScopedDeviceClaimReconciler,
  inspectDeviceClaimRecovery,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';

const childScript = fileURLToPath(
  new URL('./__tests__/test-utils/recording-finalizer-owned-child.ts', import.meta.url),
);

test.each(['warmup', 'overlay'] as const)(
  'production finalizer %s leaves an interrupted claim fenced while a separate-group compiler can write',
  async (mode) => {
    const root = mkdtempForTestSync('recording-compiler-owner-');
    const stateDir = path.join(root, 'state');
    const host = createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims'),
        AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache'),
      },
    });
    const daemon = spawn(
      process.execPath,
      ['--experimental-strip-types', childScript, root, mode],
      {
        cwd: process.cwd(),
        env: host.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(daemon, 'exit');
    let stderr = '';
    daemon.stderr.setEncoding('utf8');
    daemon.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    let frontend: { pid: number; startTime: string } | undefined;
    try {
      const checkpoint = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`compiler checkpoint timeout: ${stderr}`)),
          15000,
        );
        daemon.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timer);
          resolve(String(chunk));
        });
        daemon.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`fixture exited early: ${stderr}`));
        });
        daemon.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      frontend = JSON.parse(checkpoint).frontend;
      expect(frontend?.startTime).toBeTruthy();
      const claims = inspectDeviceClaims({}, host.env);
      expect(claims).toHaveLength(1);
      const claimPath = path.join(host.env.AGENT_DEVICE_CLAIMS_DIR!, claims[0]!.fileName);
      const before = fs.readFileSync(claimPath, 'utf8');
      expect(JSON.parse(before)).toMatchObject({
        ownerPid: daemon.pid,
        recordingCleanupPending: true,
      });
      daemon.kill('SIGKILL');
      await exited;
      const resourcePath = screenRecordingDurableResource.store.resolvePath(
        path.join(stateDir, 'sessions', 'recording'),
      );
      await expect(
        retryRecordingClaimCleanup({
          device: IOS_SIMULATOR,
          session: 'recording',
          workspace: host.cwd,
          stateDir,
          resourcePath,
          workspaceMatches: (workspace) => workspace === host.cwd,
          env: host.env,
        }),
      ).rejects.toMatchObject({ details: { reason: 'cleanup-unconfirmed' } });
      const reconcile = createOwnerScopedDeviceClaimReconciler({
        scope: {
          signal: new AbortController().signal,
          diagnostics: { emit: () => {} },
          progress: { report: () => {} },
        },
        beforeGateway: inspectDeviceClaimRecovery,
        composeGateway: () => {
          throw new Error('pending cleanup must not bind');
        },
      });
      expect((await reconcileOrphanedDeviceClaims(reconcile, stateDir, host.env)).retained).toBe(1);
      expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
      fs.writeFileSync(path.join(root, 'frontend-trigger'), 'continue');
      await vi.waitFor(() =>
        expect(fs.readFileSync(path.join(root, 'frontend-done'), 'utf8')).toBe('done'),
      );
      expect(fs.readFileSync(path.join(root, 'cache', 'frontend-late-write'), 'utf8')).toBe(
        'late compiler write',
      );
      expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
      expect(screenRecordingDurableResource.store.read(resourcePath)).toMatchObject({
        status: 'decoded',
        envelope: { lifecycle: 'open' },
      });
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
      await exited;
      if (!fs.existsSync(path.join(root, 'frontend-done'))) {
        fs.writeFileSync(path.join(root, 'frontend-trigger'), 'cleanup');
        if (frontend)
          try {
            await vi.waitFor(
              () => expect(fs.existsSync(path.join(root, 'frontend-done'))).toBe(true),
              { timeout: 2000 },
            );
          } catch {
            const facts = await readProcessIdentityFacts(frontend.pid);
            if (facts.startTime === frontend.startTime) process.kill(frontend.pid, 'SIGKILL');
          }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
