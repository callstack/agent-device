import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { discoverReplayTestEntries } from '../session-test-discovery.ts';

test('discoverReplayTestEntries discovers nested .ad suites through native DFS traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-'));
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, '02-second.ad'), 'context platform=android\nopen "Second"\n');
  fs.writeFileSync(path.join(root, '01-first.ad'), 'context platform=ios\nopen "First"\n');

  const entries = discoverReplayTestEntries({ inputs: [root], cwd: root });

  assert.deepEqual(
    new Set(entries.map((entry) => entry.path)),
    new Set([path.join(nested, '02-second.ad'), path.join(root, '01-first.ad')]),
  );
});

test('discoverReplayTestEntries skips untyped scripts when platform filter is set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-filter-'));
  fs.writeFileSync(path.join(root, '01-untyped.ad'), 'open "Demo"\n');
  fs.writeFileSync(path.join(root, '02-android.ad'), 'context platform=android\nopen "Demo"\n');

  const entries = discoverReplayTestEntries({
    inputs: [root],
    cwd: root,
    platformFilter: 'android',
  });

  const untyped = entries.find((entry) => path.basename(entry.path) === '01-untyped.ad');
  const android = entries.find((entry) => path.basename(entry.path) === '02-android.ad');
  assert.equal(untyped?.kind, 'skip');
  assert.equal(android?.kind, 'run');
  if (untyped?.kind === 'skip') {
    assert.match(untyped.message, /missing platform metadata for --platform android/);
  }
});

test('discoverReplayTestEntries rejects empty post-filter suites', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-empty-'));
  fs.writeFileSync(path.join(root, '01-ios.ad'), 'context platform=ios\nopen "Settings"\n');

  assert.throws(
    () => discoverReplayTestEntries({ inputs: [root], cwd: root, platformFilter: 'android' }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'No replay tests matched for --platform android.',
  );
});

test('discoverReplayTestEntries includes Maestro yaml flows for Maestro test suites', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-maestro-'));
  fs.writeFileSync(
    path.join(root, '01-flow.yaml'),
    'appId: demo\nname: Bottom Tabs - Dynamic\n---\n- launchApp\n',
  );
  fs.writeFileSync(path.join(root, '02-flow.yml'), 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(root, '03-flow.ad'), 'open "Demo"\n');

  const entries = discoverReplayTestEntries({
    inputs: [root],
    cwd: root,
    platformFilter: 'android',
    replayBackend: 'maestro',
  });

  assert.deepEqual(
    new Set(entries.map((entry) => path.basename(entry.path))),
    new Set(['01-flow.yaml', '02-flow.yml', '03-flow.ad']),
  );
  assert.equal(entries.find((entry) => path.basename(entry.path) === '01-flow.yaml')?.kind, 'run');
  assert.equal(entries.find((entry) => path.basename(entry.path) === '02-flow.yml')?.kind, 'run');
  assert.equal(entries.find((entry) => path.basename(entry.path) === '03-flow.ad')?.kind, 'skip');
  const namedFlow = entries.find((entry) => path.basename(entry.path) === '01-flow.yaml');
  assert.equal(namedFlow?.kind, 'run');
  if (namedFlow?.kind === 'run') {
    assert.equal(namedFlow.title, 'Bottom Tabs - Dynamic');
  }
});

test('discoverReplayTestEntries preserves Maestro directory filesystem order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-maestro-sort-'));
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
    const entries = discoverReplayTestEntries({
      inputs: [root],
      cwd: root,
      replayBackend: 'maestro',
    });

    assert.deepEqual(
      entries.map((entry) => path.basename(entry.path)),
      ['10-legacy.ad', '30-zeta.yaml', '05-compat.ad', '20-beta.yml'],
    );
  } finally {
    opendirSync.mockRestore();
  }
});

test('discoverReplayTestEntries preserves Maestro nested directory DFS order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-maestro-dfs-'));
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
    const entries = discoverReplayTestEntries({
      inputs: [root],
      cwd: root,
      replayBackend: 'maestro',
    });

    assert.deepEqual(
      entries.map((entry) => path.relative(root, entry.path)),
      ['30-root-a.yaml', path.join('nested', '10-child.yml'), '20-root-c.ad'],
    );
  } finally {
    opendirSync.mockRestore();
  }
});

test('discoverReplayTestEntries preserves explicit Maestro file order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-maestro-order-'));
  const second = path.join(root, '02-second.yaml');
  const first = path.join(root, '01-first.yaml');
  fs.writeFileSync(first, 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(second, 'appId: demo\n---\n- launchApp\n');

  const entries = discoverReplayTestEntries({
    inputs: [second, first],
    cwd: root,
    replayBackend: 'maestro',
  });

  assert.deepEqual(
    entries.map((entry) => path.basename(entry.path)),
    ['02-second.yaml', '01-first.yaml'],
  );
});

test('discoverReplayTestEntries orders Maestro file inputs before expanded flows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-maestro-files-'));
  const suite = path.join(root, 'suite');
  const globSuite = path.join(root, 'glob-suite');
  fs.mkdirSync(suite);
  fs.mkdirSync(globSuite);
  const explicit = path.join(root, '99-explicit.yaml');
  fs.writeFileSync(explicit, 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(suite, '01-directory.yaml'), 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(globSuite, '02-glob.yaml'), 'appId: demo\n---\n- launchApp\n');

  const entries = discoverReplayTestEntries({
    inputs: [suite, path.join(globSuite, '*.yaml'), explicit],
    cwd: root,
    replayBackend: 'maestro',
  });

  assert.deepEqual(
    entries.map((entry) => path.basename(entry.path)),
    ['99-explicit.yaml', '01-directory.yaml', '02-glob.yaml'],
  );
});

test('discoverReplayTestEntries de-duplicates overlapping Maestro file and glob inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-overlap-'));
  const explicit = path.join(root, '02-explicit.yaml');
  fs.writeFileSync(explicit, 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(root, '01-expanded.yaml'), 'appId: demo\n---\n- launchApp\n');

  const entries = discoverReplayTestEntries({
    inputs: [explicit, path.join(root, '*.yaml')],
    cwd: root,
    replayBackend: 'maestro',
  });

  assert.deepEqual(
    entries.map((entry) => path.basename(entry.path)),
    ['02-explicit.yaml', '01-expanded.yaml'],
  );
});

test('discoverReplayTestEntries sorts mixed Maestro glob matches by YAML-first compatibility order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-mixed-glob-'));
  fs.writeFileSync(path.join(root, '20-zeta.yaml'), 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(root, '10-alpha.yml'), 'appId: demo\n---\n- launchApp\n');
  fs.writeFileSync(path.join(root, '00-native.ad'), 'open "Demo"\n');
  fs.writeFileSync(path.join(root, '30-native.ad'), 'open "Demo"\n');

  const entries = discoverReplayTestEntries({
    inputs: [path.join(root, '*.{yaml,yml,ad}')],
    cwd: root,
    replayBackend: 'maestro',
  });

  assert.deepEqual(
    entries.map((entry) => path.basename(entry.path)),
    ['10-alpha.yml', '20-zeta.yaml', '00-native.ad', '30-native.ad'],
  );
});

test('discoverReplayTestEntries rejects YAML without explicit Maestro routing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-discovery-yaml-route-'));
  const flowPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(flowPath, 'appId: demo\n---\n- launchApp\n');

  assert.throws(
    () => discoverReplayTestEntries({ inputs: [flowPath], cwd: root }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message ===
        `Maestro YAML requires explicit --maestro routing: test ${flowPath} --maestro`,
  );
});
