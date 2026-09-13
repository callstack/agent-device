import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { computeDaemonCodeSignature } from '@agent-device/host-kit/code-signature';
import {
  resolveDaemonLaunchSpec,
  resolveDaemonTakeoverReason,
  resolveLocalDaemonCodeSignature,
} from '../daemon-launch-spec.ts';
import { isSourceCheckoutProjectRoot, readVersion } from '@agent-device/host-kit/version';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';

vi.mock('@agent-device/host-kit/version', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agent-device/host-kit/version')>();
  return {
    ...original,
    isSourceCheckoutProjectRoot: vi.fn(original.isSourceCheckoutProjectRoot),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  // Restores the real predicate that `vi.fn` was built with, so no case hands its
  // tree shape to the next one.
  vi.mocked(isSourceCheckoutProjectRoot).mockReset();
});

// A source checkout re-reads the launch entry and its code signature on every
// command. The entry is fixed for the process; the signature is not, so it stays
// live and leans on the stat-validated cache instead. An installed package has no
// signature to re-read: its version pins its bytes (`#2458`).

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

/**
 * Which daemon a command keeps. `daemon-client-lifecycle.test.ts` pins the same
 * decision end to end from a source checkout, which is what this test process runs
 * in; these cases flip the one input that separates a checkout from an installed
 * package of a published version (#2458).
 */
function useClientTree(sourceCheckout: boolean): void {
  vi.mocked(isSourceCheckoutProjectRoot).mockReturnValue(sourceCheckout);
}

function runningDaemon(info: { version?: string; codeSignature?: string }) {
  return {
    token: 'local-secret',
    pid: 999_999,
    httpPort: 41_234,
    transport: 'http' as const,
    version: info.version ?? readVersion(),
    codeSignature: info.codeSignature,
  };
}

test('an installed client fingerprints nothing, because its version pins its bytes (#2458)', async () => {
  // Two installs of one published version stamp identical bytes with different
  // mtimes, so a signature can only ever say "different" about the same code.
  resetAllProcessMemosForTests();
  useClientTree(false);
  const statSpy = vi.spyOn(fs, 'statSync');

  assert.equal(await resolveLocalDaemonCodeSignature(), undefined);
  assert.equal(statSpy.mock.calls.length, 0);
});

test('an installed client keeps a reachable daemon whose code signature differs from its own (#2458)', async () => {
  useClientTree(false);

  assert.equal(
    await resolveDaemonTakeoverReason(runningDaemon({ codeSignature: 'some-other-install' }), true),
    undefined,
  );
});

test('a source checkout keeps a reachable daemon whose code signature matches its own', async () => {
  useClientTree(true);
  const ownCodeSignature = await resolveLocalDaemonCodeSignature();
  assert.ok(ownCodeSignature);

  assert.equal(
    await resolveDaemonTakeoverReason(runningDaemon({ codeSignature: ownCodeSignature }), true),
    undefined,
  );
});

test('a source checkout replaces a reachable daemon whose code signature differs', async () => {
  // A rebuild leaves the version alone, so the signature is the only thing that can
  // notice a daemon serving code its client no longer has.
  useClientTree(true);

  assert.equal(
    await resolveDaemonTakeoverReason(runningDaemon({ codeSignature: 'an-older-build' }), true),
    'code-signature mismatch',
  );
});

test('a source checkout replaces a daemon that reported no code signature at all', async () => {
  useClientTree(true);

  assert.equal(
    await resolveDaemonTakeoverReason(runningDaemon({}), true),
    'code-signature mismatch',
  );
});

test('a mismatched version replaces the daemon whichever tree the client runs from', async () => {
  const expected = `version mismatch (client v${readVersion()})`;
  for (const sourceCheckout of [false, true]) {
    useClientTree(sourceCheckout);

    assert.equal(
      await resolveDaemonTakeoverReason(
        runningDaemon({ version: '0.0.0-mismatch', codeSignature: 'any' }),
        true,
      ),
      expected,
    );
  }
});

test('a reachable daemon of a matching version survives, an unreachable one does not', async () => {
  useClientTree(false);

  assert.equal(await resolveDaemonTakeoverReason(runningDaemon({}), true), undefined);
  assert.equal(await resolveDaemonTakeoverReason(runningDaemon({}), false), 'unreachable');
});

test('the tree shape is asked per call, not memoized with the signature', async () => {
  // A long-lived client (the MCP server) must notice a daemon rebuilt underneath it,
  // so nothing about this answer is cached — including which tree it came from.
  useClientTree(false);
  assert.equal(await resolveLocalDaemonCodeSignature(), undefined);

  useClientTree(true);
  assert.ok(await resolveLocalDaemonCodeSignature());
});
