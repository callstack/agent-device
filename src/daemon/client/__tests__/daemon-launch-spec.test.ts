import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { computeDaemonCodeSignature } from '../../code-signature.ts';
import { resolveDaemonLaunchSpec, resolveLocalDaemonCodeSignature } from '../daemon-launch-spec.ts';
import { resetAllProcessMemosForTests } from '../../../utils/ttl-memo.ts';

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

test('resolveLocalDaemonCodeSignature re-reads the filesystem on every call', () => {
  resetAllProcessMemosForTests();

  const first = resolveLocalDaemonCodeSignature();
  const statSpy = vi.spyOn(fs, 'statSync');
  const second = resolveLocalDaemonCodeSignature();

  assert.equal(second, first);
  // Not memoized in either mode: a long-lived client (the MCP server) has to
  // notice a daemon rebuilt underneath it. What the source mode avoids is the
  // content reads, not the question (`code-signature-cache.ts`).
  assert.ok(statSpy.mock.calls.length > 0);
});

test('resolveLocalDaemonCodeSignature agrees with the uncached walk over the launch entry', () => {
  resetAllProcessMemosForTests();
  const spec = resolveDaemonLaunchSpec();
  const entryPath = spec.useSrc ? spec.srcPath : spec.distPath;

  assert.equal(resolveLocalDaemonCodeSignature(), computeDaemonCodeSignature(entryPath, spec.root));
});
