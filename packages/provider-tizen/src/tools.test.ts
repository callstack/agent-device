import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { test } from 'vitest';

import { locateSdb } from './tools.ts';

function extensionHome() {
  const home = mkdtempForTestSync('tizen-home-');
  const platform = path.join(home, '.tizen-extension-platform');
  const tools = path.join(platform, 'server/sdktools/data/tools');
  mkdirSync(tools, { recursive: true });
  writeFileSync(path.join(tools, 'sdb'), '');
  writeFileSync(path.join(home, '.tizen.path.config'), JSON.stringify({ url: platform }));
  return { home, tools };
}

test('sdb is found in the SDK that ~/.tizen.path.config names', () => {
  const { home, tools } = extensionHome();

  assert.equal(locateSdb(undefined, { HOME: home }), path.join(tools, 'sdb'));
});

test('TIZEN_SDK wins over the extension config, and an explicit path wins over both', () => {
  const extension = extensionHome();
  const sdk = mkdtempForTestSync('tizen-sdk-');
  mkdirSync(path.join(sdk, 'tools'));
  writeFileSync(path.join(sdk, 'tools/sdb'), '');
  const env = { HOME: extension.home, TIZEN_SDK: sdk };

  assert.equal(locateSdb(undefined, env), path.join(sdk, 'tools/sdb'));
  assert.equal(locateSdb('/opt/sdb', env), '/opt/sdb');
});

test('without an SDK, sdb fails as TOOL_MISSING with a hint naming sdbPath', () => {
  const home = mkdtempForTestSync('tizen-empty-');

  assert.throws(
    () => locateSdb(undefined, { HOME: home }),
    (error: { code?: string; details?: { hint?: string } }) => {
      assert.equal(error.code, 'TOOL_MISSING');
      assert.match(error.details?.hint ?? '', /sdbPath/);
      return true;
    },
  );
});
