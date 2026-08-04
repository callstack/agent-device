import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { resolveDaemonPaths } from '../config.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

test('resolveDaemonPaths keeps explicit state directories authoritative', () => {
  const home = mkdtempForTestSync('agent-device-config-home-');
  try {
    const paths = resolveDaemonPaths('~/custom-daemon', { env: { HOME: home } });
    assert.equal(paths.baseDir, path.join(home, 'custom-daemon'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveDaemonPaths keeps packaged installs on the global daemon state directory', () => {
  const home = mkdtempForTestSync('agent-device-config-home-');
  const packageRoot = mkdtempForTestSync('agent-device-package-root-');
  try {
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"agent-device"}\n');

    const paths = resolveDaemonPaths(undefined, {
      env: { HOME: home },
      projectRoot: packageRoot,
    });

    assert.equal(paths.baseDir, path.join(home, '.agent-device'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('resolveDaemonPaths scopes source checkout defaults by project root', () => {
  const home = mkdtempForTestSync('agent-device-config-home-');
  const firstRoot = mkdtempForTestSync('agent-device-source-a-');
  const secondRoot = mkdtempForTestSync('agent-device-source-b-');
  try {
    for (const root of [firstRoot, secondRoot]) {
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"agent-device"}\n');
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'daemon.ts'), 'export {};\n');
    }

    const firstPaths = resolveDaemonPaths(undefined, {
      env: { HOME: home },
      projectRoot: firstRoot,
    });
    const secondPaths = resolveDaemonPaths(undefined, {
      env: { HOME: home },
      projectRoot: secondRoot,
    });

    assert.match(firstPaths.baseDir, /^.+\/\.agent-device\/dev\/agent-device-source-a-/);
    assert.match(secondPaths.baseDir, /^.+\/\.agent-device\/dev\/agent-device-source-b-/);
    assert.notEqual(firstPaths.baseDir, secondPaths.baseDir);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});
