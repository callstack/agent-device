import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { discoverPluginEntry } from './discovery.ts';

type Case = {
  name: string;
  exports: unknown;
  files: string[];
  /** What Node resolves `<package>/agent-device` to, or undefined when Node refuses it. */
  subpathFile?: string;
  /** What the host loads: the subpath's file, the root's file, or a refusal. */
  loads: string | 'refused';
};

const CASES: readonly Case[] = [
  {
    name: 'pattern',
    exports: { './*': './*.js' },
    files: ['agent-device.js'],
    subpathFile: 'agent-device.js',
    loads: 'agent-device.js',
  },
  {
    name: 'pattern-with-trailer',
    exports: { './agent-*': './impl-*.js', '.': './root.js' },
    files: ['impl-device.js', 'root.js'],
    subpathFile: 'impl-device.js',
    loads: 'impl-device.js',
  },
  {
    name: 'condition-set-to-null',
    exports: { './agent-device': { node: null, default: './ok.js' }, '.': './root.js' },
    files: ['ok.js', 'root.js'],
    loads: 'refused',
  },
  {
    name: 'no-matching-condition',
    exports: { './agent-device': { require: './ok.js' }, '.': './root.js' },
    files: ['ok.js', 'root.js'],
    loads: 'refused',
  },
  {
    name: 'subpath-absent',
    exports: { '.': './root.js', './other': './other.js' },
    files: ['root.js', 'other.js'],
    loads: 'root.js',
  },
  {
    name: 'array-skips-an-invalid-target',
    exports: { './agent-device': ['not-a-relative-target', './ok.js'] },
    files: ['ok.js'],
    subpathFile: 'ok.js',
    loads: 'ok.js',
  },
  {
    name: 'conditions-in-package-order',
    exports: { './agent-device': { import: './first.js', default: './second.js' } },
    files: ['first.js', 'second.js'],
    subpathFile: 'first.js',
    loads: 'first.js',
  },
  {
    name: 'root-sugar',
    exports: './root.js',
    files: ['root.js'],
    loads: 'root.js',
  },
];

test('package export resolution agrees with Node for each shape a plugin package may use', () => {
  const root = mkdtempForTestSync('agent-device-exports-');
  for (const entry of CASES) {
    const directory = path.join(root, 'node_modules', entry.name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: entry.name,
        version: '1.0.0',
        type: 'module',
        exports: entry.exports,
      }),
    );
    for (const file of entry.files) fs.writeFileSync(path.join(directory, file), 'export {};');
  }
  const nodeResolutions = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const out = {};
        for (const name of ${JSON.stringify(CASES.map((entry) => entry.name))}) {
          try { out[name] = new URL(import.meta.resolve(name + '/agent-device')).pathname; }
          catch (error) { out[name] = error.code; }
        }
        console.log(JSON.stringify(out));`,
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  ) as Record<string, string>;

  for (const entry of CASES) {
    const directory = fs.realpathSync(path.join(root, 'node_modules', entry.name));
    const node = nodeResolutions[entry.name]!;
    if (entry.subpathFile) {
      assert.equal(fs.realpathSync(node), path.join(directory, entry.subpathFile), entry.name);
    } else {
      assert.equal(node, 'ERR_PACKAGE_PATH_NOT_EXPORTED', entry.name);
    }
    if (entry.loads === 'refused') {
      assert.throws(
        () => discoverPluginEntry(directory),
        (error: unknown) =>
          (error as { details?: { reason?: string } }).details?.reason === 'incompatible_plugin',
        entry.name,
      );
    } else {
      assert.deepEqual(
        discoverPluginEntry(directory),
        { kind: 'v2', file: path.join(directory, entry.loads) },
        entry.name,
      );
    }
  }
});
