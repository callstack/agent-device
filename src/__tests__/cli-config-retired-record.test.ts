import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCliCapture } from './cli-capture.ts';
import { makeTempWorkspace } from './cli-config-fixtures.ts';

/**
 * The retired `record` config surface (`src/commands/schema/cli-config.ts`):
 * the config key `record` and AGENT_DEVICE_RECORD were released as command
 * defaults, but the repair-segment recording opt-in they feed needs
 * per-invocation provenance a config default cannot carry. They fail closed
 * with migration guidance instead of silently doing nothing.
 */

test('retired record config key is refused with migration guidance on every config surface', async () => {
  const { root, home, project } = makeTempWorkspace();
  fs.mkdirSync(path.join(home, '.agent-device'), { recursive: true });
  fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify({ record: true }));
  fs.writeFileSync(path.join(home, '.agent-device', 'config.json'), JSON.stringify({}));

  const result = await runCliCapture(['snapshot'], {
    cwd: project,
    env: { HOME: home },
    defaultResponse: { ok: true, data: {} },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /"record" in project config file .* was removed/);
  assert.match(result.stderr, /--record is per-invocation only/);

  fs.rmSync(path.join(project, 'agent-device.json'));
  fs.writeFileSync(
    path.join(home, '.agent-device', 'config.json'),
    JSON.stringify({ record: true }),
  );
  const fromUserConfig = await runCliCapture(['snapshot'], {
    cwd: project,
    env: { HOME: home },
    defaultResponse: { ok: true, data: {} },
  });
  assert.equal(fromUserConfig.code, 1);
  assert.match(fromUserConfig.stderr, /"record" in config file .* was removed/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('retired record config key is refused in an explicit --config file', async () => {
  const { root, home, project } = makeTempWorkspace();
  const configPath = path.join(root, 'chosen.json');
  fs.writeFileSync(configPath, JSON.stringify({ record: true }));

  const result = await runCliCapture(['snapshot', '--config', configPath], {
    cwd: project,
    env: { HOME: home },
    defaultResponse: { ok: true, data: {} },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /"record" in config file .*chosen\.json was removed/);
  assert.match(result.stderr, /--record is per-invocation only/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('retired record config key is refused in an AGENT_DEVICE_CONFIG file', async () => {
  const { root, home, project } = makeTempWorkspace();
  const configPath = path.join(root, 'from-env.json');
  fs.writeFileSync(configPath, JSON.stringify({ record: true }));

  const result = await runCliCapture(['snapshot'], {
    cwd: project,
    env: { HOME: home, AGENT_DEVICE_CONFIG: configPath },
    defaultResponse: { ok: true, data: {} },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /"record" in config file .*from-env\.json was removed/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('retired AGENT_DEVICE_RECORD fails closed only for commands that accept --record', async () => {
  const { root, home, project } = makeTempWorkspace();
  const env = { HOME: home, AGENT_DEVICE_RECORD: 'true' };

  const snapshot = await runCliCapture(['snapshot'], {
    cwd: project,
    env,
    defaultResponse: { ok: true, data: {} },
  });
  assert.equal(snapshot.code, 1);
  assert.match(snapshot.stderr, /AGENT_DEVICE_RECORD was removed/);
  assert.match(snapshot.stderr, /--record is per-invocation only/);

  const unaffected = await runCliCapture(['devices', '--json'], {
    cwd: project,
    env,
    defaultResponse: { ok: true, data: { devices: [] } },
  });
  assert.equal(unaffected.code, null);

  fs.rmSync(root, { recursive: true, force: true });
});
