import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { discoverReplaySourcePaths } from '../source-discovery.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

// #1802: path expansion, traversal ordering and file-type routing are CALLER work — `test`
// inputs name files on the machine that typed the command. These pin the traversal itself;
// manifest inspection is pinned beside the daemon capability that does it, and scheduler
// filtering policy is pinned in the replay-test package.
const discover = (inputs: string[], cwd: string, replayBackend?: string) =>
  discoverReplaySourcePaths({ inputs, cwd, replayBackend });

test('replay source discovery discovers nested .ad suites through native DFS traversal', () => {
  const root = mkdtempForTestSync('agent-device-test-discovery-');
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, '02-second.ad'), 'context platform=android\nopen "Second"\n');
  fs.writeFileSync(path.join(root, '01-first.ad'), 'context platform=ios\nopen "First"\n');

  assert.deepEqual(
    new Set(discover([root], root)),
    new Set([path.join(nested, '02-second.ad'), path.join(root, '01-first.ad')]),
  );
});

test('replay source discovery includes Maestro yaml flows for Maestro test suites', () => {
  const root = mkdtempForTestSync('agent-device-test-discovery-maestro-');
  fs.writeFileSync(
    path.join(root, '01-flow.yaml'),
    'appId: demo\nname: Bottom Tabs - Dynamic\n---\n- launchApp\n',
  );
  fs.writeFileSync(path.join(root, '02-flow.yml'), 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(root, '03-flow.ad'), 'open "Demo"\n');

  assert.deepEqual(
    new Set(discover([root], root, 'maestro').map((entry) => path.basename(entry))),
    new Set(['01-flow.yaml', '02-flow.yml', '03-flow.ad']),
  );
});

test('replay source discovery preserves Maestro directory filesystem order', () => {
  const root = mkdtempForTestSync('agent-device-test-discovery-maestro-sort-');
  const flowFiles = ['10-legacy.ad', '30-zeta.yaml', '05-compat.ad', '20-beta.yml'];
  for (const fileName of flowFiles) {
    const body = fileName.endsWith('.ad') ? 'open "Demo"\n' : 'appId: demo\n---\n- launchApp\n';
    fs.writeFileSync(path.join(root, fileName), body);
  }

  const opendirSync = vi.spyOn(fs, 'opendirSync').mockImplementation((directory) => {
    assert.equal(directory, root);
    let index = 0;
    return {
      readSync: () => {
        const name = flowFiles[index++];
        if (!name) return null;
        return {
          name,
          isDirectory: () => false,
          isFile: () => true,
        } as fs.Dirent;
      },
      closeSync: () => {},
    } as fs.Dir;
  });

  try {
    assert.deepEqual(
      discover([root], root, 'maestro').map((entry) => path.basename(entry)),
      ['10-legacy.ad', '30-zeta.yaml', '05-compat.ad', '20-beta.yml'],
    );
  } finally {
    opendirSync.mockRestore();
  }
});

test('replay source discovery preserves Maestro nested directory DFS order', () => {
  const root = mkdtempForTestSync('agent-device-test-discovery-maestro-dfs-');
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, '30-root-a.yaml'), 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(nested, '10-child.yml'), 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(root, '20-root-c.ad'), 'open "Demo"\n');

  type MockDirEntry = { name: string; directory: boolean };
  const opendirSync = vi.spyOn(fs, 'opendirSync').mockImplementation((directory) => {
    let entries: MockDirEntry[] = [];
    if (directory === root) {
      entries = [
        { name: '30-root-a.yaml', directory: false },
        { name: 'nested', directory: true },
        { name: '20-root-c.ad', directory: false },
      ];
    } else if (directory === nested) {
      entries = [{ name: '10-child.yml', directory: false }];
    }
    let index = 0;
    return {
      readSync: () => {
        const entry = entries[index++];
        if (!entry) return null;
        return {
          name: entry.name,
          isDirectory: () => entry.directory,
          isFile: () => !entry.directory,
        } as fs.Dirent;
      },
      closeSync: () => {},
    } as fs.Dir;
  });

  try {
    assert.deepEqual(
      discover([root], root, 'maestro').map((entry) => path.relative(root, entry)),
      ['30-root-a.yaml', path.join('nested', '10-child.yml'), '20-root-c.ad'],
    );
  } finally {
    opendirSync.mockRestore();
  }
});

test('replay source discovery preserves explicit Maestro file order', () => {
  const root = mkdtempForTestSync('agent-device-test-discovery-maestro-order-');
  const second = path.join(root, '02-second.yaml');
  const first = path.join(root, '01-first.yaml');
  fs.writeFileSync(first, 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(second, 'appId: demo\n---\n- launchApp\n');

  assert.deepEqual(
    discover([second, first], root, 'maestro').map((entry) => path.basename(entry)),
    ['02-second.yaml', '01-first.yaml'],
  );
});

test('replay source discovery orders Maestro file inputs before expanded flows', () => {
  const root = mkdtempForTestSync('agent-device-test-discovery-maestro-files-');
  const suite = path.join(root, 'suite');
  const globSuite = path.join(root, 'glob-suite');
  fs.mkdirSync(suite);
  fs.mkdirSync(globSuite);
  const explicit = path.join(root, '99-explicit.yaml');
  fs.writeFileSync(explicit, 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(suite, '01-directory.yaml'), 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(globSuite, '02-glob.yaml'), 'appId: demo\n---\n- launchApp\n');

  assert.deepEqual(
    discover([suite, path.join(globSuite, '*.yaml'), explicit], root, 'maestro').map((entry) =>
      path.basename(entry),
    ),
    ['99-explicit.yaml', '01-directory.yaml', '02-glob.yaml'],
  );
});

test('replay source discovery de-duplicates overlapping Maestro file and glob inputs', () => {
  const root = mkdtempForTestSync('agent-device-test-discovery-overlap-');
  const explicit = path.join(root, '02-explicit.yaml');
  fs.writeFileSync(explicit, 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(root, '01-expanded.yaml'), 'appId: demo\n---\n- launchApp\n');

  assert.deepEqual(
    discover([explicit, path.join(root, '*.yaml')], root, 'maestro').map((entry) =>
      path.basename(entry),
    ),
    ['02-explicit.yaml', '01-expanded.yaml'],
  );
});

test('replay source discovery sorts mixed Maestro glob matches by YAML-first compatibility order', () => {
  const root = mkdtempForTestSync('agent-device-test-discovery-mixed-glob-');
  fs.writeFileSync(path.join(root, '20-zeta.yaml'), 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(root, '10-alpha.yml'), 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(root, '00-native.ad'), 'open "Demo"\n');
  fs.writeFileSync(path.join(root, '30-native.ad'), 'open "Demo"\n');

  assert.deepEqual(
    discover([path.join(root, '*.{yaml,yml,ad}')], root, 'maestro').map((entry) =>
      path.basename(entry),
    ),
    ['10-alpha.yml', '20-zeta.yaml', '00-native.ad', '30-native.ad'],
  );
});

test('replay source discovery rejects YAML without explicit Maestro routing', () => {
  const root = mkdtempForTestSync('agent-device-test-discovery-yaml-route-');
  const flowPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(flowPath, 'appId: demo\n---\n- launchApp\n');

  assert.throws(
    () => discover([flowPath], root),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message ===
        `Maestro YAML requires explicit --maestro routing: test ${flowPath} --maestro`,
  );
});
