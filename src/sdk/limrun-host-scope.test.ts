import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { withCommandHost } from '@agent-device/host-kit/command';
import { createLimrunRuntimeDependencies } from './limrun-runtime-dependencies.ts';

test.skipIf(process.platform === 'win32')(
  'Limrun ADB callbacks retain their owning host outside and across concurrent foreign scopes',
  async () => {
    const root = mkdtempForTestSync('agent-device-limrun-host-');
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const adb = path.join(bin, 'adb');
    writeFileSync(
      adb,
      `#!${process.execPath}\n` +
        `process.stdout.write(JSON.stringify({args:process.argv.slice(2),host:process.env.LIMRUN_OWNER}));\n`,
    );
    chmodSync(adb, 0o755);
    const owner = (name: string) =>
      createLimrunRuntimeDependencies({
        env: { ...process.env, PATH: bin, LIMRUN_OWNER: name },
        cwd: root,
      });
    const first = owner('first');
    const second = owner('second');
    const invocation = {
      target: { selector: { kind: 'unspecified' as const }, server: { kind: 'ambient' as const } },
      command: ['devices'],
    };
    const previous = { PATH: process.env.PATH, LIMRUN_OWNER: process.env.LIMRUN_OWNER };
    process.env.PATH = bin;
    process.env.LIMRUN_OWNER = 'ambient';
    try {
      const standalone = await first.host.runAdb(invocation);
      const [left, right] = await withCommandHost(
        {
          host: { env: { ...process.env, PATH: bin, LIMRUN_OWNER: 'foreign' }, cwd: root },
          requestEnv: { LIMRUN_OWNER: 'foreign-request' },
        },
        () => Promise.all([first.host.runAdb(invocation), second.host.runAdb(invocation)]),
      );
      for (const [result, host] of [
        [standalone, 'first'],
        [left, 'first'],
        [right, 'second'],
      ] as const) {
        assert.deepEqual(JSON.parse(result.stdout), { args: ['devices'], host });
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'Limrun bundle inference resolves plist tooling from its supplied host without an outer scope',
  async () => {
    const root = mkdtempForTestSync('agent-device-limrun-plist-');
    const plutil = path.join(root, 'plutil');
    writeFileSync(
      plutil,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({CFBundleDisplayName:'Scoped App'}));\n`,
    );
    chmodSync(plutil, 0o755);
    const dependencies = createLimrunRuntimeDependencies({
      env: { ...process.env, PATH: root },
      cwd: root,
    });
    assert.equal(
      await dependencies.ios.readBundleAppName(path.join(root, 'Example.app')),
      'Scoped App',
    );
  },
);
