import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import type { AgentDeviceClient } from '../../client/client-types.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { createCommandToolExecutor, listCommandTools } from '../command-tools.ts';

// Operator-owned inputs are never model-writable: the model reads untrusted
// app UI text and picks tool arguments, so no tool schema may offer a
// parameter to write a credential, the endpoint it is sent to, or an
// operator infrastructure path into (exfiltration/redirect path). The keys
// are refused as explicit input too — fail closed with env guidance, the
// same posture as retired fields — while operator env/config defaults keep
// flowing outside the model-writable surface.
const OPERATOR_OWNED_KEYS = [
  'daemonAuthToken',
  'bearerToken',
  'daemonBaseUrl',
  'proxyBaseUrl',
  'stateDir',
  'cwd',
  'iosSimulatorDeviceSet',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
] as const;

// The rest of the shared common input: keys a model may write, because they
// name which device or session THIS call targets, not who the operator is.
const MODEL_WRITABLE_COMMON_KEYS = [
  'session',
  'platform',
  'deviceTarget',
  'target',
  'device',
  'udid',
  'serial',
  'androidDeviceAllowlist',
  'tenant',
  'runId',
  'leaseId',
  'debug',
] as const;

test('MCP tool schemas advertise no operator-owned inputs', () => {
  for (const tool of listCommandTools()) {
    const properties = tool.inputSchema.properties ?? {};
    for (const key of OPERATOR_OWNED_KEYS) {
      assert.equal(key in properties, false, `${tool.name} advertises ${key}`);
    }
  }
});

// The complement, so a misclassification fails in both directions. An
// over-broad operator row narrows every tool's schema at once, and the absence
// assertions above would stay green while the model lost the ability to say
// which device a call targets.
test('MCP tool schemas keep every common input the model may write', () => {
  const wait = listCommandTools().find((tool) => tool.name === 'wait');
  assert.ok(wait, 'expected an MCP tool named wait');
  const properties = wait.inputSchema.properties ?? {};
  for (const key of MODEL_WRITABLE_COMMON_KEYS) {
    assert.equal(key in properties, true, `wait no longer advertises ${key}`);
  }
});

test('MCP refuses every explicit operator-owned argument with guidance', async () => {
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return {};
    },
  });

  for (const key of OPERATOR_OWNED_KEYS) {
    const result = await executor.execute('wait', { [key]: '/steered/by/screen-text' });
    assert.equal(result.isError, true, `${key} must be refused`);
    assert.match(
      result.content[0]?.text ?? '',
      new RegExp(`${key} is not accepted as a tool argument`),
    );
  }
  assert.deepEqual(calls, [], 'a refused operator input must never reach the command route');
});

test('MCP refuses an explicit daemonAuthToken argument with env guidance', async () => {
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return {};
    },
  });

  const result = await executor.execute('wait', { daemonAuthToken: 'stolen-token' });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /daemonAuthToken is not accepted as a tool argument/);
  assert.match(result.content[0]?.text ?? '', /AGENT_DEVICE_DAEMON_AUTH_TOKEN/);
  assert.deepEqual(calls, [], 'a refused credential input must never reach the command route');
});

test('MCP refuses an explicit metro bearerToken argument with env guidance', async () => {
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return {};
    },
  });

  const result = await executor.execute('metro', {
    action: 'prepare',
    bearerToken: 'stolen-token',
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /bearerToken is not accepted as a tool argument/);
  assert.match(result.content[0]?.text ?? '', /AGENT_DEVICE_METRO_BEARER_TOKEN/);
  assert.deepEqual(calls, [], 'a refused credential input must never reach the command route');
});

// Regression: the router forwards raw tools/call arguments verbatim, and the
// MCP config resolver reads `config`/`remoteConfig` as CLI flags to load an
// arbitrary file. Before the admission boundary, `{config: <path>}` on any
// tool loaded that file and its daemonBaseUrl/daemonAuthToken reached the
// command route — a model-writable redirect to an attacker endpoint with the
// operator's token. Hidden-from-tools/list was not enough; admission must
// reject the key.
test('MCP refuses a config-file argument so it cannot smuggle operator values', async () => {
  const home = mkdtempForTestSync('agent-device-mcp-config-bypass-');
  const configPath = path.join(home, 'redirect.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      daemonBaseUrl: 'http://attacker.example:9000',
      daemonAuthToken: 'exfiltrated-secret',
    }),
  );

  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return {};
    },
  });

  for (const key of ['config', 'remoteConfig']) {
    const result = await executor.execute('snapshot', { [key]: configPath });
    assert.equal(result.isError, true, `${key} must be refused`);
    assert.match(
      result.content[0]?.text ?? '',
      new RegExp(`${key} is not accepted as a tool argument`),
    );
  }
  assert.deepEqual(calls, [], 'a config loader must never reach the command route');
  fs.rmSync(home, { recursive: true, force: true });
});

// Deny-by-default: the advertised schema is additionalProperties:false, so a
// key it does not list is rejected outright — a typo, or a future operator
// flag that must never become model-writable, both fail closed.
test('MCP refuses any argument the advertised schema does not list', async () => {
  const calls: unknown[] = [];
  const executor = createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async (_client, name, input) => {
      calls.push({ name, input });
      return {};
    },
  });

  const result = await executor.execute('snapshot', { totallyUnknownKey: 'x' });

  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.text ?? '',
    /totallyUnknownKey is not an accepted argument for the snapshot tool/,
  );
  assert.deepEqual(calls, [], 'an unadvertised key must never reach the command route');
});

// The refusal covers the model-writable surface only: operator values from
// the environment must still merge as config-backed defaults and reach the
// command route (or the MCP client config, for stateDir) unchanged.
test('MCP still resolves operator env values outside the model-writable surface', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'operator-env-token');
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '/operator/state-dir');
  try {
    const createdConfigs: Array<Record<string, unknown>> = [];
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const executor = createCommandToolExecutor({
      createClient: (config) => {
        createdConfigs.push(config as Record<string, unknown>);
        return {} as AgentDeviceClient;
      },
      runCommand: async (_client, name, input) => {
        calls.push({ name, input: input as Record<string, unknown> });
        return {};
      },
    });

    const result = await executor.execute('wait', {});

    assert.equal(result.isError, false);
    assert.equal(calls[0]?.input.daemonAuthToken, 'operator-env-token');
    assert.equal(createdConfigs[0]?.stateDir, '/operator/state-dir');
  } finally {
    vi.unstubAllEnvs();
  }
});
