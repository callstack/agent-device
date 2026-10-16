import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { ANDROID_EMULATOR, mkdtempForTestSync } from '@agent-device/test-kit';
import { withTestDeviceInventory } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  acquireDeviceClaim,
  canonicalLocalDeviceKey,
  clearDeviceClaim,
  inspectDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import { runCmdBackground } from '@agent-device/host-kit/command';
import type { CliFlags } from '@agent-device/contracts/command';
import { runExecCommand } from '../exec.ts';

// #3263: `exec` takes the host-global device claim on its own process identity,
// runs the child, and releases on every exit path. The claim assertions read the
// shared store directly; the device-selection seam is the same inventory context
// the daemon request path installs, so a real wrapper process can be spawned with
// a stubbed inventory.

const deviceKey = canonicalLocalDeviceKey(ANDROID_EMULATOR);
const roots: string[] = [];

afterEach(() => {
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type ExecDirs = Readonly<{ claimsDir: string; stateDir: string }>;

function useDirs(): ExecDirs {
  const root = mkdtempForTestSync('exec-command-');
  roots.push(root);
  const dirs = { claimsDir: path.join(root, 'claims'), stateDir: path.join(root, 'state') };
  fs.mkdirSync(dirs.stateDir, { recursive: true });
  process.env.AGENT_DEVICE_CLAIMS_DIR = dirs.claimsDir;
  return dirs;
}

function execFlags(): CliFlags {
  return {
    json: false,
    help: false,
    version: false,
    platform: 'android',
    serial: ANDROID_EMULATOR.id,
  };
}

type RunningExec = Readonly<{
  promise: Promise<number>;
  /** Resolves once device selection has consulted the test inventory. */
  inventoryReady: () => Promise<void>;
}>;

function runExec(args: readonly string[], dirs: ExecDirs): RunningExec {
  let releaseInventory: () => void = () => {};
  const inventoryReady = new Promise<void>((resolve) => {
    releaseInventory = resolve;
  });
  const promise = withTestDeviceInventory(
    {
      local: async () => {
        releaseInventory();
        return [ANDROID_EMULATOR];
      },
    },
    async () => await runExecCommand(args, { flags: execFlags(), stateDir: dirs.stateDir }),
  );
  return { promise, inventoryReady: () => inventoryReady };
}

function claimFilePath(claimsDir: string): string {
  return path.join(
    claimsDir,
    `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`,
  );
}

function storedClaim(claimsDir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(claimFilePath(claimsDir), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function claimEntry(): ReturnType<typeof inspectDeviceClaims>[number] | undefined {
  return inspectDeviceClaims({ serial: ANDROID_EMULATOR.id })[0];
}

/**
 * A foreign workspace's acquisition of the same device — the acquisition a
 * daemon-side `install` or session `open` performs through this same store.
 */
async function foreignAcquireAttempt(dirs: ExecDirs): Promise<unknown> {
  return await withTestDeviceInventory({ local: async () => [] }, async () =>
    acquireDeviceClaim({
      device: ANDROID_EMULATOR,
      session: 'other-workspace',
      workspace: '/worktrees/other',
      stateDir: path.join(dirs.stateDir, 'other'),
      reconcileOrphanedDeviceClaim: async () => ({ status: 'reconciled' as const }),
    }),
  );
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error('condition not reached within 10s');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Liveness probe by pid; signal 0 sends nothing, ESRCH means the process is gone. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A child that runs until the test releases it: the loop is bounded so a failed
 * assertion ends the child instead of hanging the run, and every release path
 * still reports the gate's removal to the wrapper.
 */
function gatedChildCommand(gate: string): string {
  return `until [ -e ${JSON.stringify(gate)} ]; do i=$((i+1)); [ $i -ge 200 ] && exit 0; sleep 0.05; done`;
}

test('holds the claim with the command label while the child runs and releases it on exit', async () => {
  const dirs = useDirs();
  const observed = path.join(dirs.stateDir, 'child-saw-claim.txt');
  // The child resolves the claim path from its own environment through the same
  // claim root: the wrapper's claim must fence the device for the whole child.
  const exitCode = await runExec(
    [
      'node',
      '-e',
      `const fs=require('fs'),path=require('path'),crypto=require('crypto');
const key='local:android:none:emulator-5554';
const file=path.join(process.env.AGENT_DEVICE_CLAIMS_DIR,crypto.createHash('sha256').update(key).digest('hex')+'.json');
let session='none';
try{session=JSON.parse(fs.readFileSync(file,'utf8')).session}catch{}
fs.writeFileSync(${JSON.stringify(observed)},session)`,
    ],
    dirs,
  ).promise;
  assert.equal(exitCode, 0);
  assert.equal(fs.readFileSync(observed, 'utf8'), 'exec:node');
  assert.equal(storedClaim(dirs.claimsDir), undefined);
});

test('records the wrapper claim with its owner kind under an exec state dir', async () => {
  const dirs = useDirs();
  // The ordinary state dir serves a daemon; the wrapper records its claim under
  // a directory of its own. Planting a registration inside that dir and still
  // classifying the live claim as live pins that the supersession proof — a
  // daemon-only proof — never reads a wrapper claim.
  fs.mkdirSync(path.join(dirs.stateDir, 'exec'), { recursive: true });
  fs.writeFileSync(
    path.join(dirs.stateDir, 'exec', 'daemon.json'),
    '{"pid":4242,"processStartTime":"x"}',
  );
  const gate = path.join(dirs.stateDir, 'release-child.flag');
  const running = runExec(['sh', '-c', gatedChildCommand(gate)], dirs);
  try {
    await running.inventoryReady();
    await waitFor(() => claimEntry()?.claim?.session === 'exec:sh');
    const stored = storedClaim(dirs.claimsDir);
    assert.equal(stored?.ownerKind, 'wrapper');
    assert.equal(stored?.stateDir, path.join(dirs.stateDir, 'exec'));
    assert.equal(claimEntry()?.classification, 'live');
  } finally {
    fs.writeFileSync(gate, '');
  }
  assert.equal(await running.promise, 0);
  assert.equal(storedClaim(dirs.claimsDir), undefined);
});

test('propagates the child exit code', async () => {
  const dirs = useDirs();
  assert.equal(await runExec(['sh', '-c', 'exit 7'], dirs).promise, 7);
  assert.equal(storedClaim(dirs.claimsDir), undefined);
});

test('runs a command named by relative path and reports a missing command as shell code 127', async () => {
  const dirs = useDirs();
  // `./gradlew`-style commands are the common shape; the wrapper resolves them
  // against the cwd the way a shell does.
  const script = path.join(dirs.stateDir, 'build.sh');
  fs.writeFileSync(script, '#!/bin/sh\nexit 3\n');
  fs.chmodSync(script, 0o755);
  const previousCwd = process.cwd();
  const exitCode = await withTestDeviceInventory(
    { local: async () => [ANDROID_EMULATOR] },
    async () => {
      process.chdir(dirs.stateDir);
      try {
        return await runExecCommand(['./build.sh'], {
          flags: execFlags(),
          stateDir: dirs.stateDir,
        });
      } finally {
        process.chdir(previousCwd);
      }
    },
  );
  assert.equal(exitCode, 3);
  assert.equal(storedClaim(dirs.claimsDir), undefined);

  // A command that cannot start reports what a shell would: 127, not a stack.
  assert.equal(await runExec(['definitely-not-a-command-3263'], dirs).promise, 127);
  assert.equal(storedClaim(dirs.claimsDir), undefined);
});

test('reports a child killed by a signal as a signal exit code and releases', async () => {
  const dirs = useDirs();
  const exitCode = await runExec(['sh', '-c', 'kill -TERM $$; wait'], dirs).promise;
  assert.equal(exitCode, 128 + 15);
  assert.equal(storedClaim(dirs.claimsDir), undefined);
});

test('refuses to start while a foreign live claim holds the device, and runs after release', async () => {
  const dirs = useDirs();
  const foreignStateDir = path.join(dirs.stateDir, 'other');
  fs.mkdirSync(foreignStateDir, { recursive: true });
  const foreign = await withTestDeviceInventory({ local: async () => [] }, async () =>
    acquireDeviceClaim({
      device: ANDROID_EMULATOR,
      session: 'other-workspace',
      workspace: '/worktrees/other',
      stateDir: foreignStateDir,
      reconcileOrphanedDeviceClaim: async () => ({
        status: 'retained',
        reason: 'test-no-recovery',
      }),
    }),
  );
  assert.equal(foreign.status, 'acquired');
  if (foreign.status !== 'acquired') return;

  await assert.rejects(runExec(['true'], dirs).promise, (error: unknown) => {
    const appError = error as { code?: string; details?: { reason?: string } };
    return (
      appError.code === 'DEVICE_IN_USE' && appError.details?.reason === 'DEVICE_CLAIM_LIVE_OWNER'
    );
  });
  assert.equal(claimEntry()?.claim?.session, 'other-workspace');

  await clearDeviceClaim(foreign.ownership);
  assert.equal(await runExec(['true'], dirs).promise, 0);
  assert.equal(storedClaim(dirs.claimsDir), undefined);
});

test('a foreign session acquisition is refused while the wrapper holds the device', async () => {
  const dirs = useDirs();
  const gate = path.join(dirs.stateDir, 'release-child.flag');
  const running = runExec(['sh', '-c', gatedChildCommand(gate)], dirs);
  await running.inventoryReady();
  await waitFor(() => claimEntry()?.claim?.session === 'exec:sh');

  // The mirror of the live check: a parallel `install` from another session
  // meets the same conflict the daemon admission seam turns into the typed
  // refusal, on a claim classified live, with no reconciliation.
  const conflicted = (await foreignAcquireAttempt(dirs)) as {
    status?: string;
    conflict?: { classification?: string };
  };
  assert.equal(conflicted.status, 'conflict');
  assert.equal(conflicted.conflict?.classification, 'live');

  fs.writeFileSync(gate, '');
  assert.equal(await running.promise, 0);
  assert.equal(storedClaim(dirs.claimsDir), undefined);
  // And once the wrapper released, the same foreign acquirer gets the device.
  const acquired = (await foreignAcquireAttempt(dirs)) as { status?: string };
  assert.equal(acquired.status, 'acquired');
});

test('forwards SIGTERM to the child and exits with the signal code after releasing', async () => {
  const dirs = useDirs();
  const gotSignal = path.join(dirs.stateDir, 'child-got-term.txt');
  const grandchildGotSignal = path.join(dirs.stateDir, 'grandchild-got-term.txt');
  const childStarted = path.join(dirs.stateDir, 'child-started.txt');
  // An in-place emit reaches every SIGTERM listener in this worker, so pin that
  // the wrapper starts from the worker's own baseline and returns to it.
  const sigtermListenersBefore = process.listenerCount('SIGTERM');
  const running = runExec(
    [
      'sh',
      '-c',
      // Arms the trap before announcing itself, then reports its own receipt of
      // the forwarded signal, so the test only signals a child that can catch it.
      // The background grandchild proves the forward reaches the whole process
      // group: a build's toolchain, not just its driver, must die with the claim.
      // Both loops are bounded so a lost forward ends them instead of leaking.
      `trap 'echo got > ${JSON.stringify(gotSignal)}; exit 0' TERM; echo started > ${JSON.stringify(
        childStarted,
      )}; { trap 'echo got > ${JSON.stringify(grandchildGotSignal)}' TERM; j=0; while [ $j -lt 60 ]; do sleep 0.05; j=$((j+1)); done; } & i=0; while [ $i -lt 60 ]; do sleep 0.05; i=$((i+1)); done`,
    ],
    dirs,
  );
  await running.inventoryReady();
  await waitFor(() => fs.existsSync(childStarted));
  assert.equal(claimEntry()?.claim?.session, 'exec:sh');
  // Same in-place signal pattern as the takeover command's tests. The child
  // exits 0, so only a forwarded SIGTERM can write the receipt, and only the
  // wrapper's own signal bookkeeping can report 143 rather than 0. A swallowed
  // group-kill failure would leave both receipts missing, so their presence
  // also proves the group signal left this worker.
  process.emit('SIGTERM');
  assert.equal(await running.promise, 128 + 15);
  assert.equal(process.listenerCount('SIGTERM'), sigtermListenersBefore);
  assert.equal(fs.readFileSync(gotSignal, 'utf8').trim(), 'got');
  await waitFor(() => fs.existsSync(grandchildGotSignal));
  assert.equal(fs.readFileSync(grandchildGotSignal, 'utf8').trim(), 'got');
  assert.equal(storedClaim(dirs.claimsDir), undefined);
});

test('a real SIGHUP stops the child group and releases the claim before the wrapper exits', async () => {
  const dirs = useDirs();
  // Only a real signal exercises the wrapper's own default disposition, so this
  // runs the wrapper as a real process like the SIGKILL case. Before the
  // SIGHUP handler existed the wrapper died on its default action, leaving the
  // claim pointing at a dead pid while the child kept running — so the release
  // and child-liveness assertions below are the fail-before, not the exit code
  // (a default-action death also reports failure there).
  const hupFixture = path.join(import.meta.dirname, 'exec-hup-fixture.ts');
  const child = runCmdBackground(process.execPath, ['--experimental-strip-types', hupFixture], {
    cwd: process.cwd(),
    env: { ...process.env, EXEC_TEST_DIRS: JSON.stringify(dirs) },
    captureOutput: false,
    stdio: 'ignore',
    allowFailure: true,
  });
  try {
    await waitFor(() => claimEntry()?.claim?.session === 'exec:sh');
    const childPidFile = path.join(dirs.stateDir, 'hup-child.pid');
    await waitFor(() => fs.existsSync(childPidFile));
    const childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 0);

    child.child.kill('SIGHUP');
    const exited = await child.wait;
    // The rule: the wrapper outlives the signal, waits for the child, and the
    // claim is already gone once its exit is observable.
    assert.equal(storedClaim(dirs.claimsDir), undefined);
    await waitFor(() => !processAlive(childPid));
    assert.equal(exited.exitCode, 128 + 1);
  } finally {
    // The wrapper's child leads its own session, so no test-side group kill can
    // reach it; the fixture bounds it with `sleep 8` instead.
    child.child.kill('SIGKILL');
  }
});

test('refuses to run on a Windows host before touching the device or the claim store', async () => {
  const dirs = useDirs();
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    await assert.rejects(runExec(['true'], dirs).promise, (error: unknown) => {
      const appError = error as { code?: string; details?: { reason?: string } };
      return (
        appError.code === 'UNSUPPORTED_PLATFORM' &&
        appError.details?.reason === 'unsupported-host-platform'
      );
    });
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  }
  // The refusal throws before device resolution or claim acquisition: nothing
  // was written to the claim store.
  assert.equal(storedClaim(dirs.claimsDir), undefined);
});

test('forwards a second signal when the child ignored the first, and keeps the first exit code', async () => {
  const dirs = useDirs();
  const gotSignal = path.join(dirs.stateDir, 'child-got-second-term.txt');
  const childStarted = path.join(dirs.stateDir, 'child-started.txt');
  const sigintListenersBefore = process.listenerCount('SIGINT');
  const sigtermListenersBefore = process.listenerCount('SIGTERM');
  const running = runExec(
    [
      'sh',
      '-c',
      // Traps INT without exiting, so the first signal is survivable and only
      // the forwarded second one can end the child.
      `trap '' INT; trap 'echo got > ${JSON.stringify(gotSignal)}; exit 0' TERM; echo started > ${JSON.stringify(
        childStarted,
      )}; i=0; while [ $i -lt 60 ]; do sleep 0.05; i=$((i+1)); done`,
    ],
    dirs,
  );
  await running.inventoryReady();
  await waitFor(() => fs.existsSync(childStarted));
  process.emit('SIGINT');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(gotSignal), false);
  process.emit('SIGTERM');
  // The first signal owns the exit code even though the second ended the child.
  assert.equal(await running.promise, 128 + 2);
  // Both signals were emitted, so both handlers must be gone again.
  assert.equal(process.listenerCount('SIGINT'), sigintListenersBefore);
  assert.equal(process.listenerCount('SIGTERM'), sigtermListenersBefore);
  assert.equal(fs.readFileSync(gotSignal, 'utf8').trim(), 'got');
  assert.equal(storedClaim(dirs.claimsDir), undefined);
});

test('a SIGKILLed wrapper leaves a stale claim the next acquirer reconciles', async () => {
  const dirs = useDirs();
  // Spawn a real wrapper process through the CLI entry with a stubbed
  // inventory, then SIGKILL it: the claim record names a process that exited,
  // and the `sleep 120` descendant that outlives the direct child keeps the
  // device fenced for nobody.
  const cliFixture = path.join(import.meta.dirname, 'exec-cli-fixture.ts');
  // No test-side stdio variant can exercise the wrapper's stdout/pipe cleanup
  // across the real CLI entry and spawn; the claim fence itself is asserted
  // against the same store through a real child of the real spawn.
  const child = runCmdBackground(process.execPath, ['--experimental-strip-types', cliFixture], {
    cwd: process.cwd(),
    env: { ...process.env, EXEC_TEST_DIRS: JSON.stringify(dirs) },
    captureOutput: false,
    stdio: 'ignore',
    allowFailure: true,
  });
  try {
    await waitFor(() => claimEntry()?.claim?.session === 'exec:sh');
    child.child.kill('SIGKILL');
    await child.wait;
    await waitFor(() => claimEntry()?.classification === 'owner-process-dead');

    const acquired = (await foreignAcquireAttempt(dirs)) as { status?: string };
    assert.equal(acquired.status, 'acquired');
    assert.equal(claimEntry()?.claim?.session, 'other-workspace');
  } finally {
    child.child.kill('SIGKILL');
  }
});
