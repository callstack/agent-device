import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, vi } from 'vitest';
import {
  isProcessAlive,
  readHostProcessIdentityObservations,
} from '@agent-device/host-kit/process';
import { cleanupDaemonTestState } from './daemon-test-cleanup.ts';
import { resolveDaemonPaths } from '../../../src/daemon-resolution.ts';
import { stopDaemonProcess } from '../../../src/daemon-process.ts';
import { mkdtempForTestSync } from '../../../src/__tests__/test-utils/tmp-dir.ts';
import {
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
  finishRegisteredDaemonFixture,
} from '../../../src/__tests__/test-utils/registered-daemon-fixture.ts';

const fields = {
  httpPort: 4210,
  token: 'fixture',
  version: 'test',
  codeOrigin: 'checkout' as const,
  codeSignature: 'fixture',
};

test.each(['string', 'out-of-range'])(
  'malformed %s registration retains the directory and live daemon',
  async (kind) => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-test-invalid-registration-'));
    const child = spawnRegisteredDaemonFixture(paths, fields, undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const info = await waitForRegisteredDaemonFixture(paths, child);
      const malformed = JSON.stringify({
        ...info,
        pid: kind === 'string' ? String(info.pid) : 2_147_483_648,
      });
      fs.writeFileSync(paths.infoPath, malformed);
      await cleanupDaemonTestState(paths.baseDir, null);
      assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), malformed);
      assert.equal(isProcessAlive(child.pid), true);
      assert.equal(warnings.mock.calls.length, 1);
    } finally {
      warnings.mockRestore();
      await finishRegisteredDaemonFixture(paths.baseDir);
    }
  },
);

test.each([false, true])(
  'cleanup joins a registered successor when the old observation lacks birth proof: %s',
  async (missingBirth) => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-test-replaced-registration-'));
    const original = spawnRegisteredDaemonFixture(paths, fields, undefined);
    try {
      const observed = await waitForRegisteredDaemonFixture(paths, original);
      const stopped = await stopDaemonProcess(
        { pid: original.pid, startTime: observed.processStartTime ?? null },
        { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 1_000 },
      );
      assert.equal(stopped.status, 'exited');
      await original.exited;
      const replacement = spawnRegisteredDaemonFixture(paths, fields, undefined);
      await waitForRegisteredDaemonFixture(paths, replacement);
      await cleanupDaemonTestState(paths.baseDir, {
        ...observed,
        processStartTime: missingBirth ? undefined : observed.processStartTime,
      });
      assert.ok(
        !isProcessAlive(replacement.pid) ||
          readHostProcessIdentityObservations([replacement.pid])
            .get(replacement.pid)
            ?.state.startsWith('Z'),
        'the registered replacement must be dead before cleanup returns',
      );
      await replacement.exited;
      assert.equal(isProcessAlive(replacement.pid), false);
      assert.equal(fs.existsSync(paths.baseDir), false);
    } finally {
      await finishRegisteredDaemonFixture(paths.baseDir);
    }
  },
);

test.each(['invalid-json', 'ownerless'])(
  'cleanup joins its observed child and retains %s metadata',
  async (kind) => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-test-corrupt-observed-'));
    const child = spawnRegisteredDaemonFixture(paths, fields, undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const observed = await waitForRegisteredDaemonFixture(paths, child);
      const corrupt = kind === 'invalid-json' ? '{invalid' : '{"pid": "unknown"}';
      fs.writeFileSync(paths.infoPath, corrupt);
      await cleanupDaemonTestState(paths.baseDir, observed);
      assert.ok(
        !isProcessAlive(child.pid) ||
          readHostProcessIdentityObservations([child.pid]).get(child.pid)?.state.startsWith('Z'),
        'the observed child must be terminated before cleanup returns',
      );
      await child.exited;
      assert.equal(isProcessAlive(child.pid), false);
      assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), corrupt);
      assert.equal(warnings.mock.calls.length, 1);
    } finally {
      warnings.mockRestore();
      await finishRegisteredDaemonFixture(paths.baseDir);
    }
  },
);

test('cleanup retains an unpublished successor holding the registration lock', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-test-unpublished-successor-'));
  const original = spawnRegisteredDaemonFixture(paths, fields, undefined);
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const observed = await waitForRegisteredDaemonFixture(paths, original);
    assert.equal(
      (
        await stopDaemonProcess(
          { pid: original.pid, startTime: observed.processStartTime ?? null },
          { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 1_000 },
        )
      ).status,
      'exited',
    );
    await original.exited;
    fs.rmSync(paths.infoPath);
    fs.rmSync(paths.baseDir + '/registration-held');
    fs.writeFileSync(paths.baseDir + '/defer-publication', 'wait');
    const successor = spawnRegisteredDaemonFixture(paths, fields, undefined);
    await vi.waitFor(
      () => assert.equal(fs.existsSync(paths.baseDir + '/registration-held'), true),
      { timeout: 4_000, interval: 10 },
    );
    await cleanupDaemonTestState(paths.baseDir, observed);
    assert.equal(fs.existsSync(paths.baseDir), true);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.equal(isProcessAlive(successor.pid), true);
    assert.equal(warnings.mock.calls.length, 1);
  } finally {
    warnings.mockRestore();
    await finishRegisteredDaemonFixture(paths.baseDir);
  }
});
