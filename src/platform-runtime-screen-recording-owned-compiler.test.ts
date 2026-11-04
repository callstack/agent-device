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
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { createVideoValidatorPreparation } from '@agent-device/capture-kit/recording-video';
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
      if (!daemon.pid) throw new Error('fixture daemon did not start');
      const daemonIdentity = {
        pid: daemon.pid,
        startTime: (await readProcessIdentityFacts(daemon.pid)).startTime,
      };
      expect(daemonIdentity.startTime).toBeTruthy();
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
      const { frontend: recordedFrontend, written } = JSON.parse(checkpoint) as {
        frontend: { pid: number; startTime: string };
        written: string;
      };
      frontend = recordedFrontend;
      expect(frontend?.startTime).toBeTruthy();
      expect(written.startsWith(path.join(root, 'cache', 'attempts') + path.sep)).toBe(true);
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
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      let published = '';
      try {
        await withCommandExecutorOverride(
          (cmd, args) => {
            if (cmd !== 'xcrun') return undefined;
            const output = args[args.indexOf('-o') + 1]!;
            fs.writeFileSync(output, 'successor validator', { mode: 0o755 });
            return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
          },
          async () => {
            const preparation = createVideoValidatorPreparation(host);
            const result = await preparation.prepare();
            if (result.kind !== 'avfoundation') throw new Error('expected validator');
            published = result.executablePath;
            await preparation.close();
          },
        );
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
      expect(fs.readFileSync(published, 'utf8')).toBe('successor validator');
      console.log('crashed compiler fixture', {
        root,
        cache: path.join(root, 'cache'),
        written,
        published,
        daemonIdentity,
        frontend,
      });
      const work = written.split(`${path.sep}alias${path.sep}work${path.sep}`)[0]!;
      await vi.waitFor(() =>
        expect(fs.lstatSync(path.join(work, 'alias', 'work')).isFile()).toBe(true),
      );
      fs.writeFileSync(path.join(root, 'frontend-trigger'), 'continue');
      await vi.waitFor(() => expect(fs.existsSync(path.join(root, 'frontend-done'))).toBe(true));
      expect(['ENOTDIR', 'EEXIST']).toContain(
        fs.readFileSync(path.join(root, 'frontend-done'), 'utf8'),
      );
      expect(fs.existsSync(written)).toBe(false);
      expect(fs.readFileSync(published, 'utf8')).toBe('successor validator');
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
          await vi.waitFor(
            () => expect(fs.existsSync(path.join(root, 'frontend-done'))).toBe(true),
            { timeout: 2000 },
          );
      }
      if (frontend)
        await vi.waitFor(async () => {
          const facts = await readProcessIdentityFacts(frontend!.pid);
          expect(facts.startTime !== frontend!.startTime || facts.zombie).toBe(true);
        });
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
