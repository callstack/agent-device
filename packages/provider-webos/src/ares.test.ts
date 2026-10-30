import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { test } from 'vitest';

import { createAres } from './ares.ts';

function fakeAresBin(outputs: Record<string, string>) {
  const bin = mkdtempForTestSync('ares-');
  for (const [name, output] of Object.entries(outputs)) {
    const script = path.join(bin, name);
    writeFileSync(script, `#!/bin/sh\ncat <<'OUTPUT'\n${output}\nOUTPUT\n`);
    chmodSync(script, 0o755);
  }
  return bin;
}

test('listDevices returns only TV profiles with their IP and default flag', async () => {
  const bin = fakeAresBin({
    'ares-setup-device': JSON.stringify([
      { profile: 'tv', name: 'living-room', default: true, deviceinfo: { ip: '192.0.2.10' } },
      { profile: 'ose', name: 'signage', default: false, deviceinfo: { ip: '192.0.2.20' } },
    ]),
  });

  const devices = await createAres(bin, process.env).listDevices();

  assert.deepEqual(devices, [{ name: 'living-room', isDefault: true }]);
});

test('listApps reads each app id with its title from ares-install --listfull', async () => {
  const bin = fakeAresBin({
    'ares-install': [
      '[Info] Set target device : living-room',
      'id : com.sdk.ares.hostedapp',
      'title : Ares Hosted App',
      'version : 1.1.0',
      '',
      'id : com.example.tvapp',
      'title : Example TV',
      'requiredACG',
      '',
      'id : com.example.untitled',
    ].join('\n'),
  });

  const apps = await createAres(bin, process.env).forDevice('living-room').listApps();

  assert.deepEqual(apps, [
    { id: 'com.sdk.ares.hostedapp', name: 'Ares Hosted App' },
    { id: 'com.example.tvapp', name: 'Example TV' },
    { id: 'com.example.untitled', name: 'com.example.untitled' },
  ]);
});

test('a missing webOS CLI fails as TOOL_MISSING with a hint naming aresBin', async () => {
  const bin = fakeAresBin({});

  const listing = createAres(bin, process.env).listDevices();

  await assert.rejects(listing, (error: { code?: string; details?: { hint?: string } }) => {
    assert.equal(error.code, 'TOOL_MISSING');
    assert.match(error.details?.hint ?? '', /aresBin/);
    return true;
  });
});
