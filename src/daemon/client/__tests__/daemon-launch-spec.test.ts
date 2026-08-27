import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { computeDaemonCodeSignature } from '../../code-signature.ts';
import { resolveDaemonLaunchSpec, resolveLocalDaemonCodeSignature } from '../daemon-launch-spec.ts';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';

afterEach(() => {
  vi.restoreAllMocks();
});

// The daemon-reuse check reads the launch entry and its code signature on
// every command. The entry is fixed for the process; the signature is not, so
// it stays live and leans on the stat-validated cache instead.

test('resolveDaemonLaunchSpec probes the entry candidates once per process', () => {
  resetAllProcessMemosForTests();
  const existsSpy = vi.spyOn(fs, 'existsSync');

  const first = resolveDaemonLaunchSpec();
  const probeCalls = existsSpy.mock.calls.length;
  assert.ok(probeCalls > 0);

  const second = resolveDaemonLaunchSpec();
  assert.equal(second, first);
  assert.equal(existsSpy.mock.calls.length, probeCalls);
});

test('resolveLocalDaemonCodeSignature re-reads the filesystem on every call', async () => {
  resetAllProcessMemosForTests();

  const first = await resolveLocalDaemonCodeSignature();
  const statSpy = vi.spyOn(fs, 'statSync');
  const second = await resolveLocalDaemonCodeSignature();

  assert.equal(second, first);
  // Not memoized in either mode: a long-lived client (the MCP server) has to
  // notice a daemon rebuilt underneath it. What the source mode avoids is the
  // content reads, not the question (`code-signature-cache.ts`).
  assert.ok(statSpy.mock.calls.length > 0);
});

test('resolveLocalDaemonCodeSignature agrees with the uncached walk over the launch entry', async () => {
  resetAllProcessMemosForTests();
  const spec = resolveDaemonLaunchSpec();
  const entryPath = spec.useSrc ? spec.srcPath : spec.distPath;

  assert.equal(
    await resolveLocalDaemonCodeSignature(),
    computeDaemonCodeSignature(entryPath, spec.root),
  );
});

test('a source client fingerprints the source entry through the stat-validated cache', async () => {
  // A built checkout runs Vitest without `--experimental-strip-types`, so
  // every other test in this file routes the DIST branch. This is the branch
  // the cache exists for; stub the mode marker to reach it.
  const execArgv = process.execArgv;
  process.execArgv = [...execArgv, '--experimental-strip-types'];
  resetAllProcessMemosForTests();
  try {
    const spec = resolveDaemonLaunchSpec();
    assert.equal(spec.useSrc, true);
    const expected = computeDaemonCodeSignature(spec.srcPath, spec.root);
    assert.equal(await resolveLocalDaemonCodeSignature(), expected);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    assert.equal(await resolveLocalDaemonCodeSignature(), expected);
    const sourceReads = readSpy.mock.calls
      .map(([target]) => target)
      .filter((target): target is string => typeof target === 'string')
      .filter((target) => target.startsWith(path.join(spec.root, 'src')));
    assert.deepEqual(sourceReads, []);
  } finally {
    process.execArgv = execArgv;
    resetAllProcessMemosForTests();
  }
});
