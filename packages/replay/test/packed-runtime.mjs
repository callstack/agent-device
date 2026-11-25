import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [core, plugin, scratch] = process.argv.slice(2);
const { startAgentDevice } = await import('../../../src/host.ts');
const { default: replayPlugin } = await import(
  pathToFileURL(path.join(plugin, 'dist/agent-device.mjs'))
);
const script = path.join(scratch, 'empty.ad');
fs.writeFileSync(script, '# native replay entrypoint and suite transport\n');
const host = {
  cwd: scratch,
  env: {
    AGENT_DEVICE_HOME: path.join(scratch, 'conflicting-home'),
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
  },
};
fs.mkdirSync(host.env.AGENT_DEVICE_HOME, { recursive: true });
fs.writeFileSync(
  path.join(host.env.AGENT_DEVICE_HOME, 'config.json'),
  JSON.stringify({
    plugins: { '@agent-device/replay': { installation: 'invalid-conflicting-store' } },
  }),
);
async function embedded(label, plugins) {
  return await startAgentDevice({ host, plugins, stateDir: path.join(scratch, label) });
}
const absent = await embedded('absent', []);
try {
  for (const run of [
    () => absent.client.replay.run({ path: script }),
    () => absent.client.replay.test({ paths: [script] }),
  ])
    await assert.rejects(run(), (error) => {
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.details.reason, 'plugin-not-installed');
      assert.equal(error.details.package, '@agent-device/replay');
      const coreVersion = JSON.parse(
        fs.readFileSync(path.join(core, 'package.json'), 'utf8'),
      ).version;
      const sourceBuild = coreVersion.endsWith('-dev');
      assert.equal(
        error.details.installCommand,
        sourceBuild
          ? 'agent-device plugins add @agent-device/replay@nightly-0.22'
          : 'agent-device plugins add @agent-device/replay',
      );
      assert.equal(error.details.requiredVersion, sourceBuild ? undefined : coreVersion);
      return true;
    });
} finally {
  await absent.close();
}
const withContribution = (overrides) => ({
  ...replayPlugin(),
  contributes: [{ ...replayPlugin().contributes[0], ...overrides }],
});
for (const [label, plugin, reason] of [
  ['incompatible', { ...replayPlugin(), apiVersion: 99 }, 'incompatible-plugin-api'],
  ['invalid', withContribution({ setup: () => ({ execution: {} }) }), 'invalid_plugin'],
  [
    'setup',
    withContribution({
      setup: () => {
        throw new Error('selected setup failed');
      },
    }),
    'plugin_setup_failed',
  ],
]) {
  const runtime = await embedded(label, [plugin]);
  try {
    await assert.rejects(runtime.client.replay.run({ path: script }), (error) => {
      assert.equal(error.details.reason, reason);
      return true;
    });
  } finally {
    await runtime.close();
  }
}
const installed = await embedded('installed', [replayPlugin()]);
try {
  const replay = await installed.client.replay.run({ path: script });
  assert.equal(replay.replayed, 0);
  assert.equal(replay.sessionActive, false);
  assert.deepEqual(replay.artifactPaths, []);
  const suite = await installed.client.replay.test({
    paths: [script],
    artifactsDir: path.join(scratch, 'artifacts'),
  });
  assert.equal(suite.passed, 1);
  assert.equal(suite.failed, 0);
  assert.equal(suite.tests[0].status, 'passed');
  assert.ok(fs.existsSync(suite.artifactsDir));
  const malformed = path.join(scratch, 'legacy.ad');
  fs.writeFileSync(malformed, '[{"command":"open"}]');
  await assert.rejects(installed.client.replay.run({ path: malformed }), (error) => {
    assert.equal(error.code, 'INVALID_ARGS');
    assert.match(error.message, /JSON replay payloads are no longer supported/);
    return true;
  });
} finally {
  await installed.close();
}
process.stdout.write(
  'Packed native replay, suites, failure isolation and embedded scopes passed.\n',
);
