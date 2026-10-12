import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeZipFixture } from '@agent-device/host-kit/archive-fixtures';
import { AppError } from '@agent-device/kernel/errors';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import { prepareIosInstallArtifact } from '../install-artifact.ts';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

/**
 * An IPA whose `Payload` holds more than one `.app` is legal on disk and ambiguous for the
 * installer: `appIdentifierHint` is how the caller breaks the tie. The hint matches a bundle by
 * name first and by bundle id only when it is dotted, so these cases run the real extraction over
 * real multi-payload IPAs and pin name/id resolution plus the unmatched-hint and no-hint errors.
 * (Two bundles whose names differ only by case, which would make the hint itself ambiguous, cannot
 * be built on a case-insensitive host filesystem and stay unpinned.)
 */
test('prepareIosInstallArtifact resolves a multi-payload IPA by a bundle-name hint', async () => {
  await withMultiPayloadIpa([{ name: 'Alpha' }, { name: 'Beta' }], async (ipaPath) => {
    const prepared = await prepareIosInstallArtifact(
      { kind: 'path', path: ipaPath },
      { appIdentifierHint: 'beta' },
    );
    try {
      assert.equal(path.basename(prepared.installablePath), 'Beta.app');
      assert.equal(prepared.bundleId, 'com.example.beta');
      assert.equal(prepared.appName, 'Beta');
    } finally {
      await prepared.cleanup();
    }
  });
});

test('prepareIosInstallArtifact resolves a multi-payload IPA by a dotted bundle-id hint', async () => {
  await withMultiPayloadIpa([{ name: 'Alpha' }, { name: 'Beta' }], async (ipaPath) => {
    const prepared = await prepareIosInstallArtifact(
      { kind: 'path', path: ipaPath },
      { appIdentifierHint: 'COM.Example.Alpha' },
    );
    try {
      assert.equal(path.basename(prepared.installablePath), 'Alpha.app');
      assert.equal(prepared.bundleId, 'com.example.alpha');
    } finally {
      await prepared.cleanup();
    }
  });
});

test('prepareIosInstallArtifact lists the available bundles when a dotted hint matches none', async () => {
  // A hint that names neither a payload directory nor a bundle id cannot resolve, and the error
  // has to enumerate what *is* available so the caller can pick one. (The ambiguous-name throw
  // above this branch needs two payloads whose names differ only by case, which a case-insensitive
  // host filesystem cannot hold.)
  await withMultiPayloadIpa([{ name: 'Alpha' }, { name: 'Beta' }], async (ipaPath) => {
    await assert.rejects(
      async () =>
        await prepareIosInstallArtifact(
          { kind: 'path', path: ipaPath },
          { appIdentifierHint: 'com.example.gamma' },
        ),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        /none matched "com\.example\.gamma"/.test(error.message) &&
        error.message.includes('Alpha.app (com.example.alpha)') &&
        error.message.includes('Beta.app (com.example.beta)'),
    );
  });
});

test('prepareIosInstallArtifact lists the available bundles when a hint-free multi-payload IPA fails', async () => {
  await withMultiPayloadIpa([{ name: 'Alpha' }, { name: 'Beta' }], async (ipaPath) => {
    await assert.rejects(
      async () => await prepareIosInstallArtifact({ kind: 'path', path: ipaPath }),
      /Pass an app identifier or bundle name matching one of: Alpha\.app \(com\.example\.alpha\), Beta\.app \(com\.example\.beta\)/,
    );
  });
});

test('prepareIosInstallArtifact keeps a non-dotted hint a name-only match', async () => {
  // The bundle-id rule is reserved for dotted hints, so a plain word never resolves a bundle whose
  // id is an undotted slug; only its directory name can. Otherwise two bundles could silently
  // collide on a fragment of one id.
  await withMultiPayloadIpa(
    [{ name: 'Alpha' }, { name: 'Beta', bundleId: 'beta-app' }],
    async (ipaPath) => {
      await assert.rejects(
        async () =>
          await prepareIosInstallArtifact(
            { kind: 'path', path: ipaPath },
            { appIdentifierHint: 'beta-app' },
          ),
        /none matched "beta-app"/,
      );
    },
  );
});

type PayloadBundleFixture = { name: string; bundleId?: string };

const ZIP_DIR_MODE = 0o040000 | 0o755;
const ZIP_FILE_MODE = 0o100644;

/**
 * Builds a real zip-format IPA carrying the given `Payload/*.app` bundles and runs `run` against
 * it, written through host-kit's own zip fixture so the test needs no `zip` binary on the host.
 * Info.plist reads go through a fake tool provider keyed by the bundle's own directory, so
 * each payload reports an identity of its own without plist tooling on the host.
 */
async function withMultiPayloadIpa(
  bundles: PayloadBundleFixture[],
  run: (ipaPath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtempForTest('agent-device-ios-multi-payload-');
  const ipaPath = path.join(root, 'multi.ipa');
  await writeZipFixture(ipaPath, [
    { name: 'Payload/', mode: ZIP_DIR_MODE },
    ...bundles.map(({ name }) => ({
      name: `Payload/${name}.app/Info.plist`,
      mode: ZIP_FILE_MODE,
      data: '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>',
    })),
  ]);

  const provider = createLocalAppleToolProvider({
    plist: {
      readJson: async (plistPath) => {
        const appName = path.basename(path.dirname(plistPath)).replace(/\.app$/i, '');
        const bundle = bundles.find((candidate) => candidate.name === appName);
        return bundle
          ? {
              CFBundleIdentifier: bundle.bundleId ?? `com.example.${appName.toLowerCase()}`,
              CFBundleDisplayName: appName,
            }
          : null;
      },
    },
  });
  try {
    await withAppleToolProvider(provider, async () => await run(ipaPath));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
