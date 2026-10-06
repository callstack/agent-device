import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { prepareWorkspacePackage } from '../release-workspace-package.mjs';

const packageName = '@agent-device/release-fixture';

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempForTestSync('workspace-release-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true }));
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  const directory = path.join(root, 'packages', 'fixture');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'build.mjs'),
    `
import fs from 'node:fs';
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/plugin.mjs', 'export default () => ({ provider: "fixture" });');
`,
  );
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: packageName,
      version: '0.1.0',
      private: false,
      type: 'module',
      files: ['dist'],
      exports: { '.': './src/plugin.ts', './test-helper': './src/test-helper.ts' },
      publishConfig: { exports: { '.': { import: './dist/plugin.mjs' } } },
      scripts: { prepack: 'node build.mjs' },
      devDependencies: { '@agent-device/private-fixture': 'workspace:*' },
      ...overrides,
    }),
  );
  const privateDirectory = path.join(root, 'packages', 'private-fixture');
  fs.mkdirSync(privateDirectory);
  fs.writeFileSync(
    path.join(privateDirectory, 'package.json'),
    JSON.stringify({
      name: '@agent-device/private-fixture',
      version: '0.0.0',
      private: true,
    }),
  );
  const scope = path.join(directory, 'node_modules', '@agent-device');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(privateDirectory, path.join(scope, 'private-fixture'), 'dir');
  return { root, directory };
}

function packedManifest(tarball: string) {
  return JSON.parse(
    execFileSync('tar', ['-xOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
    }),
  );
}

test('packs a built plugin with public exports and imports it outside the workspace', async () => {
  const { root, directory } = fixture();
  fs.mkdirSync(path.join(root, 'packages', 'not-a-package'));
  const tarball = prepareWorkspacePackage(root, packageName, '0.1.0');
  const manifest = packedManifest(tarball);
  expect(manifest.exports).toEqual({ '.': { import: './dist/plugin.mjs' } });
  expect(manifest.devDependencies).toEqual({ '@agent-device/private-fixture': '0.0.0' });
  expect(manifest.dependencies).toBeUndefined();
  const consumer = mkdtempForTestSync('workspace-release-consumer-');
  execFileSync('tar', ['-xf', tarball, '-C', consumer]);
  const plugin = await import(
    pathToFileURL(path.join(consumer, 'package', 'dist', 'plugin.mjs')).href
  );
  expect(plugin.default()).toEqual({ provider: 'fixture' });
  expect(fs.existsSync(path.join(consumer, 'package', 'src'))).toBe(false);
  expect(fs.existsSync(path.join(directory, 'dist', 'plugin.mjs'))).toBe(true);
});

test.each([true, undefined])('requires explicit public opt-in (private: %s)', (privateValue) => {
  const { root, directory } = fixture({ private: privateValue });
  expect(() => prepareWorkspacePackage(root, packageName, '0.1.0')).toThrow('private: false');
  expect(fs.existsSync(path.join(directory, 'dist'))).toBe(false);
});

test.each(['agent-device', '@agent-device/unknown', '*', '../fixture'])(
  'rejects selector %s',
  (name) => {
    const { root } = fixture();
    expect(() => prepareWorkspacePackage(root, name, '0.1.0')).toThrow('exactly one');
  },
);

test('rejects a version mismatch before running the pack lifecycle', () => {
  const { root, directory } = fixture();
  expect(() => prepareWorkspacePackage(root, packageName, '0.2.0')).toThrow('version');
  expect(fs.existsSync(path.join(directory, 'dist'))).toBe(false);
});

test('keeps prereleases off latest and allows an explicit next release', () => {
  const { root } = fixture({ version: '0.2.0-beta.1' });
  expect(() => prepareWorkspacePackage(root, packageName, '0.2.0-beta.1')).toThrow('next');
  const tarball = prepareWorkspacePackage(root, packageName, '0.2.0-beta.1', 'next');
  expect(packedManifest(tarball).version).toBe('0.2.0-beta.1');
});

test.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
  'rejects packed private %s',
  (field) => {
    const { root } = fixture({
      [field]: { '@agent-device/private-fixture': 'workspace:*' },
    });
    expect(() => prepareWorkspacePackage(root, packageName, '0.1.0')).toThrow(
      `${field}.@agent-device/private-fixture`,
    );
  },
);

test('rejects local runtime dependencies in the actual published manifest', () => {
  const { root } = fixture({
    dependencies: { 'external-library': 'file:../../local' },
  });
  expect(() => prepareWorkspacePackage(root, packageName, '0.1.0')).toThrow(
    'dependencies.external-library',
  );
});

test('propagates a failed build without producing a release artifact', () => {
  const { root } = fixture({ scripts: { prepack: 'node -e "process.exit(23)"' } });
  expect(() => prepareWorkspacePackage(root, packageName, '0.1.0')).toThrow();
  for (const directory of fs.readdirSync(path.join(root, '.tmp'))) {
    expect(fs.existsSync(path.join(root, '.tmp', directory, 'package.tgz'))).toBe(false);
  }
});

test.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
  'plugins cannot ship a second core through %s',
  (field) => {
    const { root } = fixture({
      agentDevicePlugin: { apiVersion: 1, provider: 'fixture', entry: './dist/plugin.mjs' },
      [field]: { 'agent-device': '^0.21.0' },
    });
    expect(() => prepareWorkspacePackage(root, packageName, '0.1.0')).toThrow(
      `${field}.agent-device`,
    );
  },
);
