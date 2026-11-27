import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { auditDependencyClosure } from '../lib/shipped-imports.ts';

test('the packed Limrun plugin includes its SDK, declares the external runtime, and preserves its User-Agent', async (t) => {
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

    // Resolve only published runtime dependencies from the extracted package.
    for (const dependency of Object.keys(manifest.dependencies)) {
      const link = path.join(packed, 'node_modules', dependency);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.join(cwd, 'node_modules', dependency), link, 'junction');
    }

    const previousBaseUrl = process.env.LIMRUN_BASE_URL;
    process.env.LIMRUN_BASE_URL = 'https://api.limrun.com';
    t.after(() => {
      if (previousBaseUrl === undefined) delete process.env.LIMRUN_BASE_URL;
      else process.env.LIMRUN_BASE_URL = previousBaseUrl;
    });
    const userAgents: Array<string | null> = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (input: URL | Request | string, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        assert.equal(url.origin, 'https://api.limrun.com');
        assert.equal(url.pathname, '/v1/android_instances');
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        userAgents.push(headers.get('user-agent'));
        return Response.json([]);
      },
    );
    const entry = manifest.exports['./agent-device'].import;
    const { default: limrun } = await import(pathToFileURL(path.join(packed, entry)).href);
    const [provider] = limrun().contributes;
    await provider.connection.verify({
      flags: { platform: 'android' },
      env: { LIMRUN_API_KEY: 'lim_fixture_key' },
      host: { clientVersion: '1.2.3' },
    });
    assert.equal(userAgents.length, 1);
    assert.match(userAgents[0] ?? '', /^agent-device-cli\/1\.2\.3 Limrun\/JS /);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
