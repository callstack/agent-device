import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMON_INPUT_AUDIENCE,
  commonProperties,
  commonToClientOptions,
  readCommonInput,
} from '../common-input-fields.ts';
import { operatorInputRefusal } from '../input-audience.ts';

// The guidance a refused operator key answers with is rendered from the key's
// declared source, not written per key. These pin the four shapes the
// declarations use, so a change to the template or to `buildPrimaryEnvVarName`
// fails here instead of silently degrading every operator refusal at once.
test('an operator refusal names the environment variable and the config key', () => {
  assert.equal(
    operatorInputRefusal('daemonAuthToken', { operatorConfig: true }),
    'daemonAuthToken is not accepted as a tool argument. Set the AGENT_DEVICE_DAEMON_AUTH_TOKEN environment variable (or daemonAuthToken in ~/.agent-device/config.json) for the process serving these tools.',
  );
});

test('an operator refusal names every environment variable that carries the value', () => {
  assert.equal(
    operatorInputRefusal('bearerToken', { envFlagKeys: ['metroBearerToken', 'daemonAuthToken'] }),
    'bearerToken is not accepted as a tool argument. Set the AGENT_DEVICE_METRO_BEARER_TOKEN or AGENT_DEVICE_DAEMON_AUTH_TOKEN environment variable for the process serving these tools.',
  );
});

test('a key with no environment variable points at the operator config file alone', () => {
  assert.equal(
    operatorInputRefusal('iosSimulatorDeviceSet', { envFlagKeys: [], operatorConfig: true }),
    'iosSimulatorDeviceSet is not accepted as a tool argument. Set iosSimulatorDeviceSet in ~/.agent-device/config.json for the process serving these tools.',
  );
});

test('a key neither env nor config resolves states its own operator path', () => {
  assert.equal(
    operatorInputRefusal('cwd', { operatorPath: 'Start the process elsewhere.' }),
    'cwd is not accepted as a tool argument. Start the process elsewhere.',
  );
});

// `audience` narrows the MODEL-facing surfaces only. The CLI and the Node client
// still accept an operator key as ordinary input -- that is how an operator
// supplies it, and how env/config defaults reach the command route. A
// classification that also narrowed `commonProperties()` would break both
// without failing the MCP tests, which only assert absence.
// (Which keys are operator-owned is pinned at the boundary that enforces it,
// in `mcp/__tests__/command-tools-operator-inputs.test.ts`.)
test('an operator-owned common key stays in the CLI and Node input schema', () => {
  const advertised = commonProperties();
  const operatorKeys = Object.keys(COMMON_INPUT_AUDIENCE);
  assert.ok(operatorKeys.length > 0, 'the table declares operator-owned common keys');
  for (const key of operatorKeys) {
    assert.equal(COMMON_INPUT_AUDIENCE[key]?.kind, 'operator');
    assert.ok(key in advertised, `${key} must stay readable by the CLI and Node client`);
  }
});

// Schema, readers, and projection are three derivations of one table. A row
// that loses its reader or its projection entry drops the key silently at the
// seam nothing else covers, which is the failure `--no-record` hit twice
// (#1304/#1305). Round-tripping every advertised key catches it.
test('every advertised common key is read and projected onto the client options', () => {
  const advertised = Object.keys(commonProperties());
  const record = Object.fromEntries(
    advertised.map((key) => [key, commonInputValueFor(key)]),
  ) as Record<string, unknown>;
  record.noRecord = true;

  const input = readCommonInput(record);
  const options = commonToClientOptions(input) as Record<string, unknown>;

  for (const key of advertised) {
    // `deviceTarget` and its `target` alias are one value under two spellings;
    // the projection emits the client-facing `target`.
    const projected = key === 'deviceTarget' ? 'target' : key;
    assert.ok(projected in options, `${key} is dropped between reader and projection`);
  }
  assert.equal(options.noRecord, true, 'noRecord rides the common seam with no schema of its own');
  assert.equal(options.target, 'mobile');
});

function commonInputValueFor(key: string): unknown {
  if (key === 'platform') return 'ios';
  if (key === 'deviceTarget' || key === 'target') return 'mobile';
  if (key === 'debug') return true;
  return `value-${key}`;
}
