import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRemoteConfigProfile } from '../remote/remote-config.ts';
import { resolveRemoteConfigPath } from '../remote/remote-config-core.ts';

test('public remote-config helpers resolve file paths and merged profiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-remote-config-public-'));
  try {
    const configDir = path.join(root, 'profiles');
    const projectRoot = path.join(root, 'project');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    const configPath = path.join(configDir, 'demo.remote.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        platform: 'ios',
        metroProjectRoot: '../project',
        metroKind: 'repack',
        metroPublicBaseUrl: 'https://public.example.test',
      }),
      'utf8',
    );

    const env = {
      AGENT_DEVICE_METRO_PREPARE_PORT: '9090',
    };

    assert.equal(resolveRemoteConfigPath({ configPath, cwd: root, env }), configPath);

    assert.deepEqual(resolveRemoteConfigProfile({ configPath, cwd: root, env }), {
      resolvedPath: configPath,
      profile: {
        platform: 'ios',
        metroProjectRoot: projectRoot,
        metroKind: 'repack',
        metroPublicBaseUrl: 'https://public.example.test',
        metroPreparePort: 9090,
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
