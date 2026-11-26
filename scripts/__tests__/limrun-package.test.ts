import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { auditDependencyClosure } from '../lib/shipped-imports.ts';

test('the packed Limrun plugin includes its bundled SDK and declares the external runtime', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-package-'));
  try {
    const tarball = path.join(directory, 'limrun.tgz');
    const cwd = path.resolve(import.meta.dirname, '../../packages/provider-limrun');
    execFileSync('pnpm', ['pack', '--out', tarball], { cwd, stdio: 'pipe' });
    execFileSync('tar', ['-xf', tarball, '-C', directory]);
    const packed = path.join(directory, 'package');
    const manifest = JSON.parse(fs.readFileSync(path.join(packed, 'package.json'), 'utf8'));
    const imports = auditDependencyClosure(packed, manifest);
    assert.ok(!imports.has('@limrun/api'));
    assert.ok(imports.has('@limrun/xdelta3-wasm'));
    const notices = fs.readFileSync(path.join(packed, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
    assert.match(notices, /@limrun\/api@\S+ \(Apache-2\.0\)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
