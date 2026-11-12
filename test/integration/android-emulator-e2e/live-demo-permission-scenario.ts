import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCmd } from '@agent-device/host-kit/command';
import { deviceShellArgv } from '@agent-device/kernel/device-shell';
import { assertPngFile } from '../provider-scenarios/assertions.ts';

const DEMO_PERMISSION = 'sysui_demo_allowed';
const DEMO_PERMISSION_PREFIX = `${DEMO_PERMISSION}=`;

type PermissionCase = {
  state: string;
  before: string | null;
  after?: string | null;
  path: string;
};

export async function assertScreenshotDemoPermissionRestoration(options: {
  serial: string;
  artifactDir: string;
  captureScreenshot: (filePath: string) => Promise<void>;
}): Promise<void> {
  const shell = async (words: string[]) => {
    const result = await runCmd(
      'adb',
      deviceShellArgv('adb', 'shell', words, ['-s', options.serial]),
      { timeoutMs: 5_000 },
    );
    return result.stdout;
  };
  const readPermission = async () => {
    const rows = (await shell(['settings', 'list', 'global']))
      .split(/\r?\n/)
      .filter((row) => row.startsWith(DEMO_PERMISSION_PREFIX));
    assert.ok(rows.length <= 1, 'the global permission must have at most one row');
    return rows[0] ?? null;
  };
  const writePermission = async (value: string | undefined) => {
    await shell(
      value === undefined
        ? ['settings', 'delete', 'global', DEMO_PERMISSION]
        : ['settings', 'put', 'global', DEMO_PERMISSION, value],
    );
  };
  const apiLevel = Number((await shell(['getprop', 'ro.build.version.sdk'])).trim());
  assert.ok(Number.isInteger(apiLevel) && apiLevel > 0, 'Android must report its API level');
  const initial = await readPermission();
  const cases: PermissionCase[] = [];
  fs.mkdirSync(options.artifactDir, { recursive: true });
  try {
    for (const value of [undefined, '0', '1']) {
      await writePermission(value);
      const before = await readPermission();
      assert.equal(before, value === undefined ? null : `${DEMO_PERMISSION_PREFIX}${value}`);
      const item: PermissionCase = {
        state: value ?? 'absent',
        before,
        path: path.join(options.artifactDir, `demo-permission-${value ?? 'absent'}.png`),
      };
      cases.push(item);
      await options.captureScreenshot(item.path);
      assertPngFile(item.path);
      assert.ok(fs.statSync(item.path).size > 8, 'the capture must contain PNG image data');
      item.after = await readPermission();
      assert.equal(item.after, before, `normalized capture changed the ${item.state} permission`);
    }
  } finally {
    await writePermission(
      initial === null ? undefined : initial.slice(DEMO_PERMISSION_PREFIX.length),
    );
    const restored = await readPermission();
    fs.writeFileSync(
      path.join(options.artifactDir, 'demo-permission-evidence.json'),
      `${JSON.stringify({ serial: options.serial, apiLevel, initial, restored, cases }, null, 2)}\n`,
    );
    assert.equal(restored, initial, 'the native test must restore its initial global setting');
  }
}
