import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import type { CapturedCliRun } from '../../__tests__/cli-capture.ts';
import { parseJsonOutputs } from '../../__tests__/test-utils/cli-json-outputs.ts';
import { resolveCliSessionPath } from '../auth-session.ts';

// A known Limrun provider is refused before this run resolves the options that can carry a
// credential. Registering a value for redaction is the first thing that happens to a resolved
// credential, so a refused route that registers nothing never read one — and a provider the core
// cannot supply is not worth a credential read.
const CLOUD_DAEMON = 'https://bridge.agent-device.dev/api';
const TOKEN = 'adc_live_secret_token_1348';

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>()),
  registerDiagnosticSensitiveValue: vi.fn(),
}));

import { registerDiagnosticSensitiveValue } from '@agent-device/host-kit/diagnostics';

afterEach(() => {
  vi.clearAllMocks();
});

async function connectWithToken(
  argv: string[],
  options: {
    env?: Record<string, string>;
    /** Writes a user config that carries the same token and daemon URL. */
    tokenInUserConfig?: boolean;
    /** Writes a remote config profile and appends `--remote-config <path>` to the command. */
    remoteConfigProfile?: Record<string, unknown>;
  } = {},
): Promise<{ result: CapturedCliRun; registered: unknown[]; stateDir: string }> {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const configDir = path.join(home, '.agent-device');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    options.tokenInUserConfig
      ? JSON.stringify({ daemonAuthToken: TOKEN, daemonBaseUrl: CLOUD_DAEMON })
      : JSON.stringify({}),
  );
  let profilePath: string | undefined;
  if (options.remoteConfigProfile) {
    profilePath = path.join(project, 'remote.json');
    fs.writeFileSync(profilePath, JSON.stringify(options.remoteConfigProfile));
  }
  try {
    const result = await runCliCapture(
      [
        ...argv,
        ...(profilePath ? ['--remote-config', profilePath] : []),
        '--state-dir',
        stateDir,
        '--json',
      ],
      {
        cwd: project,
        env: { HOME: home, LIMRUN_API_KEY: 'lim_test_key', ...(options.env ?? {}) },
      },
    );
    return {
      result,
      registered: vi.mocked(registerDiagnosticSensitiveValue).mock.calls.flat(),
      stateDir,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The one result of a run whose provider plugin the core cannot supply. */
function assertProviderPluginRefusal(result: CapturedCliRun, provider: string): void {
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.equal(result.calls.length, 0);
  const outputs = parseJsonOutputs(result.stdout);
  assert.equal(outputs.length, 1, result.stdout);
  const { error } = outputs[0] as { error: { code: string; details: Record<string, string> } };
  assert.equal(error.code, 'UNSUPPORTED_OPERATION');
  assert.equal(error.details.reason, 'plugin-not-installed');
  assert.equal(error.details.provider, provider);
}

const LIMRUN_COMMAND = ['connect', 'limrun', '--session', 'ci', '--platform', 'android'];

test.each([
  {
    source: 'the environment',
    argv: LIMRUN_COMMAND,
    options: { env: { AGENT_DEVICE_DAEMON_AUTH_TOKEN: TOKEN } },
  },
  {
    source: 'a flag',
    argv: [...LIMRUN_COMMAND, '--daemon-base-url', CLOUD_DAEMON, '--daemon-auth-token', TOKEN],
    options: {},
  },
  {
    source: 'the user config',
    argv: LIMRUN_COMMAND,
    options: { tokenInUserConfig: true },
  },
])(
  'connect limrun with a token from $source refuses the plugin without reading it',
  async ({ argv, options }) => {
    const { result, registered, stateDir } = await connectWithToken(argv, options);

    assertProviderPluginRefusal(result, 'limrun');
    assert.deepEqual(registered, [], 'a refused route must not register a credential value');
    assert.equal(fs.existsSync(resolveCliSessionPath(stateDir)), false);
  },
);

test('connect --remote-config with a Limrun profile refuses the plugin before reading the token', async () => {
  const { result, registered } = await connectWithToken(['connect', '--session', 'ci'], {
    env: { AGENT_DEVICE_DAEMON_AUTH_TOKEN: TOKEN },
    remoteConfigProfile: {
      daemonBaseUrl: CLOUD_DAEMON,
      tenant: 'team-a',
      runId: 'run-a',
      leaseProvider: 'limrun',
      platform: 'android',
    },
  });

  assertProviderPluginRefusal(result, 'limrun');
  assert.deepEqual(registered, [], 'a refused route must not register a credential value');
});

test('connect browserstack resolves and registers this run token before its own admission', async () => {
  // The closest negative: a provider this release admits in its connect handler still resolves and
  // registers the run's credential, as it did before the Limrun admission.
  const { result, registered } = await connectWithToken(
    [
      'connect',
      'browserstack',
      '--session',
      'ci',
      '--platform',
      'android',
      '--daemon-base-url',
      CLOUD_DAEMON,
    ],
    { env: { AGENT_DEVICE_DAEMON_AUTH_TOKEN: TOKEN } },
  );

  assertProviderPluginRefusal(result, 'browserstack');
  assert.ok(registered.includes(TOKEN), result.stdout);
});
