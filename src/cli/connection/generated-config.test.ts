import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { writeGeneratedRemoteConfig } from './generated-config.ts';

test('a rewritten generated remote config replaces the file, so a reader never sees a partial profile', () => {
  const stateDir = mkdtempForTestSync('agent-device-generated-replace-');
  const options = {
    stateDir,
    provider: 'proxy',
    profile: { daemonBaseUrl: 'http://proxy.example.test/agent-device', leaseProvider: 'proxy' },
  };
  try {
    const configPath = writeGeneratedRemoteConfig(options);
    const published = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, '{');
    const openedBeforeRewrite = fs.openSync(configPath, 'r');
    try {
      assert.equal(writeGeneratedRemoteConfig(options), configPath);
      assert.equal(fs.readFileSync(openedBeforeRewrite, 'utf8'), '{');
    } finally {
      fs.closeSync(openedBeforeRewrite);
    }
    assert.equal(fs.readFileSync(configPath, 'utf8'), published);
    assert.deepEqual(fs.readdirSync(path.dirname(configPath)), [path.basename(configPath)]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
