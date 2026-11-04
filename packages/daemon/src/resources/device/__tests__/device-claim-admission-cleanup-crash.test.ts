import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import * as deviceSelection from '@agent-device/device-selection/dispatch-resolve';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { SCREEN_RECORDING_CLEANUP_SCOPE_METADATA_KEY } from '@agent-device/contracts/screen-recording-runtime';
import { isolatedDeviceClaimStores } from '../../../__tests__/support/device-claim-store.ts';
import { seed } from './device-claim-admission-recording.fixtures.ts';
import { cleanupCrashFixture } from './recording-cleanup-crash.fixtures.ts';

const setup = isolatedDeviceClaimStores('recording-cleanup-crash-');
afterEach(() => vi.restoreAllMocks());
const childScript = fileURLToPath(
  new URL('./recording-cleanup-crash-child.fixtures.ts', import.meta.url),
);

async function crashAt(stateDir: string, claimsDir: string, phase: string) {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', childScript, stateDir, claimsDir, phase],
    {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claimsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`checkpoint timeout: ${stderr}`)), 15000);
      child.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`child exited: ${stderr}`));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}

function fixture() {
  const { stateDir, claimsDir } = setup();
  vi.spyOn(deviceSelection, 'resolveTargetDevice').mockResolvedValue(IOS_SIMULATOR);
  const native = path.join(stateDir, 'native.mp4');
  fs.writeFileSync(native, 'original recording');
  const seeded = seed(stateDir, claimsDir, 'recording', IOS_SIMULATOR, native);
  const record = screenRecordingDurableResource.store.read(seeded.resourcePath);
  if (record.status !== 'decoded') throw new Error('missing fixture manifest');
  screenRecordingDurableResource.store.write(seeded.resourcePath, {
    ...record.envelope,
    metadata: {
      ...record.envelope.metadata,
      [SCREEN_RECORDING_CLEANUP_SCOPE_METADATA_KEY]: 'local-drained',
    },
  });
  return {
    stateDir,
    claimsDir,
    native,
    ...seeded,
    runtime: cleanupCrashFixture(stateDir, claimsDir, false),
  };
}

test.each(['stop-prepared', 'stop-completed-release', 'stop-drained-release'] as const)(
  'a dead stop owner is recovered from its durable %s proof through the record handler',
  async (phase) => {
    const f = fixture();
    await crashAt(f.stateDir, f.claimsDir, phase);
    const claim = JSON.parse(fs.readFileSync(f.claimPath, 'utf8'));
    expect(claim.recordingCleanupProof).toBe(phase);
    expect(claim.ownerToken).toBe('original-token');
    expect(claim.ownerPid).not.toBe(process.pid);
    const beforeEffects = fs.existsSync(f.runtime.events)
      ? fs.readFileSync(f.runtime.events, 'utf8')
      : '';
    if (phase === 'stop-prepared') expect(beforeEffects).toBe('');
    else {
      expect(beforeEffects).toContain('finish\n');
      if (phase === 'stop-drained-release') expect(beforeEffects).toContain('dispose\n');
      else expect(beforeEffects).not.toContain('dispose\n');
      expect(fs.readFileSync(f.runtime.output, 'utf8')).toBe('preserved export');
    }
    const response = await f.runtime.stop();
    if (!response.ok) throw new Error(JSON.stringify(response));
    expect(fs.existsSync(f.claimPath)).toBe(false);
    expect(fs.readFileSync(f.native, 'utf8')).toBe('original recording');
    expect(fs.readFileSync(f.runtime.output, 'utf8')).toBe('preserved export');
    const afterEffects = fs.readFileSync(f.runtime.events, 'utf8');
    if (phase !== 'stop-prepared') expect(afterEffects).toBe(beforeEffects);
    expect(screenRecordingDurableResource.store.read(f.resourcePath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'completed' },
    });
  },
);

test('a completed local stop survives a lost failed-disposal closure', async () => {
  const f = fixture();
  await crashAt(f.stateDir, f.claimsDir, 'failed-disposal');
  expect(JSON.parse(fs.readFileSync(f.claimPath, 'utf8'))).toMatchObject({
    ownerToken: 'original-token',
    recordingCleanupProof: 'stop-completed-release',
  });
  const before = fs.readFileSync(f.runtime.events, 'utf8');
  expect(before).toContain('finish\n');
  expect(before).toContain('dispose\n');
  expect(await f.runtime.stop()).toMatchObject({ ok: true });
  expect(fs.existsSync(f.claimPath)).toBe(false);
  expect(fs.readFileSync(f.runtime.events, 'utf8')).toBe(before);
  expect(fs.readFileSync(f.runtime.output, 'utf8')).toBe('preserved export');
});

test('a completed export cannot substitute for missing binding authority', async () => {
  const f = fixture();
  await crashAt(f.stateDir, f.claimsDir, 'unsupported-binding');
  const claim = fs.readFileSync(f.claimPath, 'utf8');
  expect(JSON.parse(claim)).not.toHaveProperty('recordingCleanupProof');
  const effects = fs.readFileSync(f.runtime.events, 'utf8');
  expect(fs.readFileSync(f.runtime.output, 'utf8')).toBe('preserved export');
  expect(await f.runtime.stop()).toMatchObject({
    ok: false,
    error: { details: { reason: 'cleanup-unconfirmed' } },
  });
  expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(claim);
  expect(fs.readFileSync(f.runtime.events, 'utf8')).toBe(effects);
});

test('completed cleanup retains and promotes the exact claim for other session owners', async () => {
  const f = fixture();
  await crashAt(f.stateDir, f.claimsDir, 'stop-drained-retain');
  const effects = fs.readFileSync(f.runtime.events, 'utf8');
  expect(await f.runtime.stop()).toMatchObject({ ok: true });
  expect(JSON.parse(fs.readFileSync(f.claimPath, 'utf8'))).toMatchObject({
    ownerToken: 'original-token',
    claimOwnerKind: 'open-session',
  });
  expect(JSON.parse(fs.readFileSync(f.claimPath, 'utf8'))).not.toHaveProperty(
    'recordingCleanupPending',
  );
  expect(fs.readFileSync(f.runtime.events, 'utf8')).toBe(effects);
});

test.each(['live', 'replacement', 'unproven', 'remote-origin', 'generation'] as const)(
  'cleanup recovery retains %s authority and performs no recording work',
  async (scenario) => {
    const f = fixture();
    await crashAt(f.stateDir, f.claimsDir, 'stop-prepared');
    const claim = JSON.parse(fs.readFileSync(f.claimPath, 'utf8'));
    if (scenario === 'live') {
      const owner = readCurrentOwnerIdentity();
      claim.ownerPid = owner.pid;
      claim.ownerStartTime = owner.startTime;
    } else if (scenario === 'replacement') claim.ownerToken = 'replacement-token';
    else if (scenario === 'unproven') delete claim.recordingCleanupProof;
    fs.writeFileSync(f.claimPath, JSON.stringify(claim));
    if (scenario === 'remote-origin' || scenario === 'generation') {
      const record = screenRecordingDurableResource.store.read(f.resourcePath);
      if (record.status !== 'decoded') throw new Error('missing fixture manifest');
      const metadata = { ...record.envelope.metadata };
      if (scenario === 'remote-origin')
        delete metadata[SCREEN_RECORDING_CLEANUP_SCOPE_METADATA_KEY];
      screenRecordingDurableResource.store.write(f.resourcePath, {
        ...record.envelope,
        metadata,
        ...(scenario === 'generation'
          ? {
              fence: { ...record.envelope.fence, generation: record.envelope.fence.generation + 1 },
            }
          : {}),
      });
    }
    const beforeClaim = fs.readFileSync(f.claimPath, 'utf8');
    const beforeManifest = fs.readFileSync(f.resourcePath, 'utf8');
    expect(await f.runtime.stop()).toMatchObject({
      ok: false,
      error: { details: { reason: 'cleanup-unconfirmed' } },
    });
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(beforeClaim);
    expect(fs.readFileSync(f.resourcePath, 'utf8')).toBe(beforeManifest);
    expect(fs.readFileSync(f.native, 'utf8')).toBe('original recording');
    expect(fs.existsSync(f.runtime.events)).toBe(false);
  },
);

test('a dispatched stop with an unsettled child remains reserved after its owner exits', async () => {
  const f = fixture();
  await crashAt(f.stateDir, f.claimsDir, 'stop-prepared');
  const claim = JSON.parse(fs.readFileSync(f.claimPath, 'utf8'));
  delete claim.recordingCleanupProof;
  fs.writeFileSync(f.claimPath, JSON.stringify(claim));
  const child = spawn(
    process.execPath,
    [
      '-e',
      String.raw`process.stdout.write('ready\n'); process.stdin.once('data', () => { require('node:fs').appendFileSync(process.argv[1], 'late child\n'); process.exit(0); });`,
      f.runtime.events,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    const beforeClaim = fs.readFileSync(f.claimPath, 'utf8');
    expect(await f.runtime.stop()).toMatchObject({
      ok: false,
      error: { details: { reason: 'cleanup-unconfirmed' } },
    });
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(beforeClaim);
    expect(fs.existsSync(f.runtime.events)).toBe(false);
    child.stdin.write('continue\n');
    await exited;
    expect(fs.readFileSync(f.runtime.events, 'utf8')).toBe('late child\n');
    expect(fs.existsSync(f.claimPath)).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});
