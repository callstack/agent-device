import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { computeDaemonCodeSignature } from '@agent-device/host-kit/code-signature';
import {
  resolveDaemonLaunchSpec,
  resolveDaemonTakeoverReason,
  resolveLocalDaemonCodeIdentity,
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

/** This tree's fingerprint, or `undefined` when the tree is an installed package. */
function ownCheckoutCodeSignature(): Promise<string | undefined> {
  return resolveLocalDaemonCodeIdentity().then((identity) =>
    identity.origin === 'checkout' ? identity.codeSignature : undefined,
  );
}

// A source checkout re-reads the launch entry and its code signature on every
// command. The entry is fixed for the process; the signature is not, so it stays
// live and leans on the stat-validated cache instead. An installed package reports
// an origin and no signature at all: its version pins its bytes (`#2458`).

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

test('the local code identity re-reads the filesystem on every call', async () => {
  resetAllProcessMemosForTests();

  const first = await ownCheckoutCodeSignature();
  assert.ok(first);
  const statSpy = vi.spyOn(fs, 'statSync');
  const second = await ownCheckoutCodeSignature();

  assert.equal(second, first);
  // Not memoized in either mode: a long-lived client (the MCP server) has to
  // notice a daemon rebuilt underneath it. What the source mode avoids is the
  // content reads, not the question (`code-signature-cache.ts`).
  assert.ok(statSpy.mock.calls.length > 0);
});

test('the local signature agrees with the uncached walk over the launch entry', async () => {
  resetAllProcessMemosForTests();
  const spec = resolveDaemonLaunchSpec();
  const entryPath = spec.useSrc ? spec.srcPath : spec.distPath;

  assert.equal(await ownCheckoutCodeSignature(), computeDaemonCodeSignature(entryPath, spec.root));
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
    assert.equal(await ownCheckoutCodeSignature(), expected);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    assert.equal(await ownCheckoutCodeSignature(), expected);
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
 * in; these cases flip the two inputs that separate the trees — which tree this client
 * runs from, and which tree the running daemon says it was started from (#2458).
 */
function useClientTree(sourceCheckout: boolean): void {
  vi.mocked(isSourceCheckoutProjectRoot).mockReturnValue(sourceCheckout);
}

function runningDaemon(info: {
  version?: string;
  codeOrigin?: 'installed' | 'checkout';
  codeSignature?: string;
}) {
  return {
    token: 'local-secret',
    pid: 999_999,
    httpPort: 41_234,
    transport: 'http' as const,
    version: info.version ?? readVersion(),
    codeOrigin: info.codeOrigin,
    codeSignature: info.codeSignature,
  };
}

test('an installed client reports an origin and no signature, because its version pins its bytes (#2458)', async () => {
  // Two installs of one published version stamp identical bytes with different
  // mtimes, so a signature can only ever say "different" about the same code.
  resetAllProcessMemosForTests();
  useClientTree(false);
  const statSpy = vi.spyOn(fs, 'statSync');

  assert.deepEqual(await resolveLocalDaemonCodeIdentity(), { origin: 'installed' });
  assert.equal(statSpy.mock.calls.length, 0);
});

test('an installed client keeps an installed daemon whose code signature differs (#2458)', async () => {
  // Both sides are installs of the version they report, so that version is the
  // whole of the identity either can offer, and the session on the daemon stands.
  useClientTree(false);

  assert.equal(
    await resolveDaemonTakeoverReason(
      runningDaemon({ codeOrigin: 'installed', codeSignature: 'some-other-install' }),
      true,
    ),
    undefined,
  );
});

test('an installed client replaces a daemon that reports a source checkout (#2458)', async () => {
  // The bypass is pairwise. A checkout beside a shared `--state-dir` can publish any
  // code it likes under the published version string, and an installed client has no
  // fingerprint of its own to notice.
  useClientTree(false);

  assert.equal(
    await resolveDaemonTakeoverReason(
      runningDaemon({ codeOrigin: 'checkout', codeSignature: 'edited-checkout' }),
      true,
    ),
    'code origin mismatch (daemon checkout, client installed)',
  );
});

test('an installed client replaces a daemon that predates the code origin field (#2458)', async () => {
  useClientTree(false);

  assert.equal(
    await resolveDaemonTakeoverReason(runningDaemon({ codeSignature: 'any' }), true),
    'code origin mismatch (daemon unreported, client installed)',
  );
});

test('a source checkout keeps a daemon that reports the same code signature', async () => {
  useClientTree(true);
  const ownCodeSignature = await ownCheckoutCodeSignature();
  assert.ok(ownCodeSignature);

  assert.equal(
    await resolveDaemonTakeoverReason(
      runningDaemon({ codeOrigin: 'checkout', codeSignature: ownCodeSignature }),
      true,
    ),
    undefined,
  );
});

test('a source checkout replaces a daemon whose code signature differs', async () => {
  // A rebuild leaves the version alone, so the signature is the only thing that can
  // notice a daemon serving code its client no longer has.
  useClientTree(true);

  assert.equal(
    await resolveDaemonTakeoverReason(
      runningDaemon({ codeOrigin: 'checkout', codeSignature: 'an-older-build' }),
      true,
    ),
    'code-signature mismatch',
  );
});

test('a source checkout replaces a daemon that reports an installed package', async () => {
  // The pair #2458 lets through is two installs; a checkout can still neither prove
  // nor disprove what an install holds, and must not run it on faith.
  useClientTree(true);

  assert.equal(
    await resolveDaemonTakeoverReason(
      runningDaemon({ codeOrigin: 'installed', codeSignature: 'the-published-artifact' }),
      true,
    ),
    'code origin mismatch (daemon installed, client checkout)',
  );
});

test('a source checkout judges a daemon that predates the code origin field by its signature', async () => {
  // Every daemon published before the field answered with a signature, which is the
  // comparison they were reused under until now.
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
        runningDaemon({ version: '0.0.0-mismatch', codeOrigin: 'installed', codeSignature: 'any' }),
        true,
      ),
      expected,
    );
  }
});

test('a reachable daemon of a matching identity survives, an unreachable one does not', async () => {
  useClientTree(false);

  assert.equal(
    await resolveDaemonTakeoverReason(runningDaemon({ codeOrigin: 'installed' }), true),
    undefined,
  );
  assert.equal(
    await resolveDaemonTakeoverReason(runningDaemon({ codeOrigin: 'installed' }), false),
    'unreachable',
  );
});

test('the tree shape is asked per call, not memoized with the signature', async () => {
  // A long-lived client (the MCP server) must notice a daemon rebuilt underneath it,
  // so nothing about this answer is cached — including which tree it came from.
  useClientTree(false);
  assert.deepEqual(await resolveLocalDaemonCodeIdentity(), { origin: 'installed' });

  useClientTree(true);
  assert.ok(await ownCheckoutCodeSignature());
});
