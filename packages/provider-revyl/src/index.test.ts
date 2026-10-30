import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { ProviderPluginHost } from 'agent-device/plugins';
import type { CliFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import revyl from './index.ts';
import { startRevylFixtureBackend, type RevylFixtureBackend } from './revyl-backend.fixtures.ts';
import { REVYL_DEFAULT_BACKEND_URL } from './revyl-client.ts';
import { resolveRevylRuntimeInstance } from './runtime-instance.ts';

const openBackends: RevylFixtureBackend[] = [];

async function backend() {
  const started = await startRevylFixtureBackend();
  openBackends.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((fixture) => fixture.close()));
});

function host(env: Readonly<Record<string, string | undefined>>): ProviderPluginHost {
  return {
    env,
    cwd: '/tmp',
    clientVersion: '0.0.0-test',
    createError: (code: string, message: string) => new Error(`${code}: ${message}`),
  } as unknown as ProviderPluginHost;
}

const PROFILE_FLAGS = {
  platform: 'ios',
  providerApp: 'https://apps.test/app.zip',
} as CliFlags;

/** Runs one plugin configuration's `verify`, which authenticates against the backend it resolves. */
async function verifyWith(
  options: Parameters<typeof revyl>[0],
  env: Readonly<Record<string, string | undefined>>,
) {
  const connection = revyl(options).connection;
  if (!connection?.verify) throw new Error('Revyl declares a verify callback');
  return await connection.verify({ flags: PROFILE_FLAGS, host: host(env) } as never);
}

test('the plugin declares only the variables it still reads from the environment', () => {
  assert.deepEqual(revyl().credentials?.variables, ['REVYL_API_KEY', 'REVYL_API_URL']);
  // A variable an option carries is no longer one the daemon compares against the shell, so a
  // host-provided key is not reported as a rotated credential.
  assert.deepEqual(revyl({ apiKey: 'k' }).credentials?.variables, ['REVYL_API_URL']);
  assert.deepEqual(revyl({ apiUrl: 'https://backend.test' }).credentials?.variables, [
    'REVYL_API_KEY',
  ]);
  assert.deepEqual(
    revyl({ apiKey: 'k', apiUrl: 'https://backend.test' }).credentials?.variables,
    [],
  );
});

test('the plugin declares what a Revyl lease is and is not', () => {
  const capabilities = revyl().connection?.capabilities;
  assert.deepEqual(capabilities, {
    leaseKind: 'direct-device-provider',
    requiresAppAttachment: false,
    requiresRemoteDaemon: false,
    // Revyl keeps no artifacts after a session ends, and installs the app at start rather than
    // attaching one to a device that is already up.
    supportsArtifacts: false,
    supportsDeferredAppSelection: false,
    supportsDirectPortReverse: false,
    usesCloudWebDriverLease: false,
  });
});

test('each credential option replaces only its own variable', async () => {
  const fixture = await backend();

  // `apiUrl` alone: the option names the backend, the key still comes from the environment.
  await verifyWith({ apiUrl: fixture.backendUrl }, { REVYL_API_KEY: 'env-key' });
  assert.equal(fixture.requests.at(-1)?.authorization, 'Bearer env-key');

  // `apiKey` alone: the option names the key, the URL still comes from the environment.
  const urlOnly = revyl({ apiKey: 'option-key' }).connection;
  if (!urlOnly?.verify) throw new Error('Revyl declares a verify callback');
  await urlOnly.verify({
    flags: PROFILE_FLAGS,
    host: host({ REVYL_API_KEY: 'env-key', REVYL_API_URL: fixture.backendUrl }),
  } as never);
  assert.equal(fixture.requests.at(-1)?.authorization, 'Bearer option-key');

  // Neither option: the environment answers both, which is the path a CLI or MCP session takes.
  await verifyWith({}, { REVYL_API_KEY: 'env-key', REVYL_API_URL: fixture.backendUrl });
  assert.equal(fixture.requests.at(-1)?.authorization, 'Bearer env-key');
});

test('a plugin with no key in either place refuses before it reaches the backend', async () => {
  const fixture = await backend();
  await assert.rejects(
    async () => await verifyWith({ apiUrl: fixture.backendUrl }, {}),
    (error: unknown) =>
      error instanceof AppError &&
      error.message.includes('requires a Revyl API key') &&
      JSON.stringify(error.details?.variables) === JSON.stringify(['REVYL_API_KEY']),
  );
  assert.deepEqual(fixture.paths(), []);
});

test('setup builds the runtime and owner from the credential options, not the environment', async () => {
  const fixture = await backend();
  // The environment holds neither variable, so only the options can reach the runtime it builds.
  const plugin = revyl({ apiKey: 'option-key', apiUrl: fixture.backendUrl });
  const setup = await plugin.setup(host({}));
  if (!('runtime' in setup)) throw new Error('Revyl sets up a runtime, not a WebDriver descriptor');

  // The owner identity hashes the key and the origin together, so this equality says both came from
  // the options. A runtime built from another credential would be a second owner for one account,
  // and the two would race over the same sessions.
  assert.equal(
    setup.platformModule.owner.instance,
    resolveRevylRuntimeInstance({ apiKey: 'option-key', backendUrl: fixture.backendUrl }),
  );
  assert.equal(setup.runtime.provider, 'revyl');
  await setup.runtime.shutdown();
});

test('one account and origin is one runtime identity whatever the URL spelling', () => {
  const base = resolveRevylRuntimeInstance({ apiKey: 'k', backendUrl: REVYL_DEFAULT_BACKEND_URL });
  // Trailing slash, and the default spelled out, are one account against one origin. Two identities
  // would let two runtimes each claim an owner and race over the same sessions.
  assert.equal(
    resolveRevylRuntimeInstance({ apiKey: 'k', backendUrl: 'https://backend.revyl.ai/' }),
    base,
  );
  assert.equal(resolveRevylRuntimeInstance({ apiKey: 'k' }), base);
  assert.notEqual(resolveRevylRuntimeInstance({ apiKey: 'other' }), base);
  assert.notEqual(
    resolveRevylRuntimeInstance({ apiKey: 'k', backendUrl: 'https://staging.revyl.test' }),
    base,
  );
  // The identity is a hash, never the key: it travels into diagnostics.
  assert.match(base, /^principal-[0-9a-f]{32}$/);
});
