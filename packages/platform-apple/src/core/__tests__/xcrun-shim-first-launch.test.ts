import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { ExecResult } from '@agent-device/host-kit/command';
import {
  createLocalAppleToolProvider,
  withAppleToolProvider,
  XCRUN_TOOL_NAMES,
  type AppleToolCommandExecutor,
} from '../tool-provider.ts';
import { probeXcrunShimFirstLaunchHooks } from '../xcrun-shim-first-launch.ts';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

async function tempRoot(): Promise<string> {
  return await mkdtempForTest('xcrun-shim-first-launch-');
}

function writeFile(root: string, name: string, text: string | Buffer): string {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, text);
  return filePath;
}

function hookedShim(expectedVersion: string, infoPlistPath: string): string {
  return [
    '#!/bin/bash',
    `EXPECTED_VERSION="${expectedVersion}"`,
    `CURRENT_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "${infoPlistPath}" 2>&1)"`,
    'if [[ "${EXPECTED_VERSION}" != "${CURRENT_VERSION}" ]]; then',
    '    "${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2',
    'fi',
    '',
  ].join('\n');
}

async function withFakeXcrun<T>(
  runCommand: AppleToolCommandExecutor,
  plistVersions: Record<string, string>,
  task: () => Promise<T>,
): Promise<T> {
  const provider = createLocalAppleToolProvider({
    runCommand,
    plist: {
      readJson: async (plistPath) =>
        plistPath in plistVersions ? { CFBundleVersion: plistVersions[plistPath] } : null,
    },
  });
  return await withAppleToolProvider(provider, task);
}

function xcrunFind(found: Partial<Record<string, string>>): {
  runCommand: AppleToolCommandExecutor;
  calls: Array<[string, string[]]>;
} {
  const calls: Array<[string, string[]]> = [];
  const runCommand: AppleToolCommandExecutor = async (cmd, args): Promise<ExecResult> => {
    calls.push([cmd, args]);
    const tool = args[1] ?? '';
    const shimPath = found[tool];
    return shimPath
      ? { exitCode: 0, stdout: `${shimPath}\n`, stderr: '' }
      : { exitCode: 1, stdout: '', stderr: `xcrun: error: unable to find utility "${tool}"` };
  };
  return { runCommand, calls };
}

test('the probe locates every declared xcrun tool through xcrun --find', async () => {
  const { runCommand, calls } = xcrunFind({});

  const shims = await withFakeXcrun(runCommand, {}, () => probeXcrunShimFirstLaunchHooks());

  assert.deepEqual(
    calls.map(([cmd, args]) => [cmd, ...args]),
    XCRUN_TOOL_NAMES.map((tool) => ['xcrun', '--find', tool]),
  );
  assert.deepEqual(
    shims.map((shim) => shim.tool),
    [...XCRUN_TOOL_NAMES],
  );
  for (const shim of shims) {
    assert.equal(shim.hook, 'armed', `${shim.tool} was not found, so it cannot be called safe`);
    assert.equal(shim.shimPath, null);
  }
});

test('a hooked shim found by xcrun --find is read against the plist its own text names', async () => {
  const root = await tempRoot();
  const otherPlist = path.join(root, 'Other.framework', 'Info.plist');
  const simctl = writeFile(root, 'simctl', hookedShim('1051.17.7', otherPlist));
  const machO = Buffer.concat([
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    Buffer.from(' -runFirstLaunch'),
  ]);
  const binary = writeFile(root, 'xctrace', machO);
  const readJson = vi.fn(async (plistPath: string) =>
    plistPath === otherPlist ? { CFBundleVersion: '1155.4' } : null,
  );
  const { runCommand } = xcrunFind({
    simctl,
    devicectl: binary,
    xcdevice: binary,
    xctrace: binary,
  });

  const shims = await withAppleToolProvider(
    createLocalAppleToolProvider({ runCommand, plist: { readJson } }),
    () => probeXcrunShimFirstLaunchHooks(),
  );

  assert.deepEqual(
    readJson.mock.calls.map(([plistPath]) => plistPath),
    [otherPlist],
  );
  assert.deepEqual(shims[0], {
    tool: 'simctl',
    shimPath: simctl,
    hook: 'armed',
    expectedVersion: '1051.17.7',
    frameworkInfoPlistPath: otherPlist,
    installedVersion: '1155.4',
  });
  for (const shim of shims.slice(1)) {
    assert.deepEqual(shim, { tool: shim.tool, shimPath: binary, hook: 'none' });
  }
});

test('equal versions disarm a hooked shim', async () => {
  const root = await tempRoot();
  const plist = path.join(root, 'CoreDevice.framework', 'Info.plist');
  const devicectl = writeFile(root, 'devicectl', hookedShim('629.3', plist));
  const shimPaths = Object.fromEntries(XCRUN_TOOL_NAMES.map((tool) => [tool, devicectl]));

  const shims = await withFakeXcrun(xcrunFind({}).runCommand, { [plist]: '629.3' }, () =>
    probeXcrunShimFirstLaunchHooks({ xcrunShimPaths: shimPaths }),
  );

  for (const shim of shims) {
    assert.deepEqual(shim, {
      tool: shim.tool,
      shimPath: devicectl,
      hook: 'disarmed',
      expectedVersion: '629.3',
      frameworkInfoPlistPath: plist,
      installedVersion: '629.3',
    });
  }
});

test('a probe that outlives its budget reads every unanswered shim as armed', async () => {
  const budget = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(budget.signal);
  const pending = new Promise<ExecResult>(() => {});
  let started = 0;
  const runCommand: AppleToolCommandExecutor = async () => {
    started += 1;
    if (started === XCRUN_TOOL_NAMES.length) budget.abort();
    return await pending;
  };

  const shims = await withFakeXcrun(runCommand, {}, () => probeXcrunShimFirstLaunchHooks());

  assert.deepEqual(
    shims.map((shim) => [shim.tool, shim.hook, shim.shimPath]),
    XCRUN_TOOL_NAMES.map((tool) => [tool, 'armed', null]),
  );
});
