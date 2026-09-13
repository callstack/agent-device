import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { isSourceCheckoutProjectRoot, resolveAgentDeviceProjectRoot } from './project-root.ts';

/**
 * The shape that separates a tree whose code can be rebuilt under its own version
 * from an installed copy of a published one (`daemon-launch-spec.ts` stops asking a
 * running daemon for its fingerprint on the installed side of that line).
 */
test('an installed package root is not a source checkout', () => {
  const root = mkdtempForTestSync('agent-device-installed-root-');
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"agent-device"}\n', 'utf8');
    fs.mkdirSync(path.join(root, 'dist', 'src', 'internal'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'src', 'internal', 'daemon.js'), '', 'utf8');

    assert.equal(isSourceCheckoutProjectRoot(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a checkout carrying the daemon source is a source checkout', () => {
  const root = mkdtempForTestSync('agent-device-source-root-');
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"agent-device"}\n', 'utf8');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'daemon.ts'), 'export {};\n', 'utf8');

    assert.equal(isSourceCheckoutProjectRoot(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a root with neither a manifest nor a daemon source is neither', () => {
  const root = mkdtempForTestSync('agent-device-bare-root-');
  try {
    assert.equal(isSourceCheckoutProjectRoot(root), false);

    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'daemon.ts'), 'export {};\n', 'utf8');
    assert.equal(
      isSourceCheckoutProjectRoot(root),
      false,
      'a daemon source alone does not make a checkout',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('this checkout is the source checkout its resolver reports', () => {
  assert.equal(isSourceCheckoutProjectRoot(resolveAgentDeviceProjectRoot(process.cwd())), true);
});
