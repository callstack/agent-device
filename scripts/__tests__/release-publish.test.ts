import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';

function runRelease(
  options: { published?: string[]; failures?: Record<string, string>; largeOutput?: boolean } = {},
) {
  const root = mkdtempForTestSync('release-publish-');
  const bin = path.join(root, 'bin');
  const tarballs = path.join(root, 'tarballs');
  const log = path.join(root, 'npm.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(tarballs);
  for (const name of ['alpha', 'beta', 'gamma', 'zeta', 'agent-device']) {
    fs.writeFileSync(path.join(tarballs, `${name}.tgz`), '');
  }
  fs.writeFileSync(
    path.join(bin, 'tar'),
    `#!/usr/bin/env node
const name = require('path').basename(process.argv[3], '.tgz');
console.log(JSON.stringify({ name: name === 'agent-device' ? name : '@agent-device/' + name, version: '1.2.3' }));
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('11.5.1'); process.exit(0); }
if (args.includes('--dry-run')) process.exit(0);
const name = args[0] === 'view' ? args[1].replace(/@1\\.2\\.3$/, '') : path.basename(args[1], '.tgz');
const packageName = name === 'agent-device' || name.startsWith('@') ? name : '@agent-device/' + name;
fs.appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify([args[0], packageName]) + '\\n');
const failure = JSON.parse(process.env.RELEASE_TEST_FAILURES)[args[0] + ':' + packageName];
if (failure === 'SIGNAL') { console.error('npm error code ENOENT'); process.kill(process.pid, 'SIGTERM'); }
if (failure) {
  if (args[0] === 'publish') console.error('npm error code ' + failure);
  else console.log(JSON.stringify({ error: { code: failure } }));
  process.exit(1);
}
if (args[0] === 'view' && !JSON.parse(process.env.RELEASE_TEST_PUBLISHED).includes(packageName)) {
  console.log(JSON.stringify({ error: { code: 'E404' } })); process.exit(1);
}
if (args[0] === 'publish' && process.env.RELEASE_TEST_LARGE_OUTPUT === '1') process.stdout.write('x'.repeat(2 * 1024 * 1024));
console.log(JSON.stringify('1.2.3'));
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    ['scripts/release-publish.mjs', tarballs, '1.2.3', 'next'],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        RELEASE_TEST_LOG: log,
        RELEASE_TEST_LARGE_OUTPUT: options.largeOutput ? '1' : '0',
        RELEASE_TEST_FAILURES: JSON.stringify(options.failures ?? {}),
        RELEASE_TEST_PUBLISHED: JSON.stringify(options.published ?? []),
      },
    },
  );
  const calls: string[][] = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return { result, calls };
}

test('continues after plugin failures and reports all failures without publishing core', () => {
  const { result, calls } = runRelease({
    failures: { 'publish:@agent-device/beta': 'ENEEDAUTH', 'view:@agent-device/gamma': 'E503' },
  });
  assert.notEqual(result.status, 0);
  assert.ok(calls.some(([action, name]) => action === 'publish' && name === '@agent-device/zeta'));
  assert.ok(!calls.some(([, name]) => name === 'agent-device'));
  assert.match(result.stderr, /@agent-device\/beta.*ENEEDAUTH/);
  assert.match(result.stderr, /@agent-device\/gamma.*E503/);
});

test('publishes core after every plugin', () => {
  const { result, calls } = runRelease();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls.filter(([action]) => action === 'publish').map(([, name]) => name),
    [
      '@agent-device/alpha',
      '@agent-device/beta',
      '@agent-device/gamma',
      '@agent-device/zeta',
      'agent-device',
    ],
  );
});

test('skips published versions and publishes core after the remaining plugins', () => {
  const { result, calls } = runRelease({ published: ['@agent-device/beta', '@agent-device/zeta'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls.filter(([action]) => action === 'publish').map(([, name]) => name),
    ['@agent-device/alpha', '@agent-device/gamma', 'agent-device'],
  );
});

test('publishes core successfully when publish output exceeds the default buffer', () => {
  const { result, calls } = runRelease({ largeOutput: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.some(([action, name]) => action === 'publish' && name === 'agent-device'));
});

test('reports signal-terminated publish as unknown with its signal', () => {
  const { result, calls } = runRelease({ failures: { 'publish:@agent-device/beta': 'SIGNAL' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /@agent-device\/beta: UNKNOWN.*SIGTERM/);
  assert.ok(calls.some(([action, name]) => action === 'publish' && name === '@agent-device/zeta'));
  assert.ok(!calls.some(([, name]) => name === 'agent-device'));
});
