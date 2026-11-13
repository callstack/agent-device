import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { materializeRemoteArtifacts } from '../daemon-artifacts.ts';

test.each([
  { force: false, existing: false, broken: false, success: true },
  { force: false, existing: true, broken: false, success: false },
  { force: true, existing: true, broken: false, success: true },
  { force: true, existing: true, broken: true, success: false },
])(
  'atomic script transfer $force/$existing/$broken',
  async ({ force, existing, broken, success }) => {
    const root = mkdtempForTestSync('script-download-');
    const destination = path.join(root, 'caller.ad');
    if (existing) fs.writeFileSync(destination, 'original');
    const text = 'context platform=ios\nopen Demo\n';
    const server = http.createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer test');
      expect(req.headers['x-agent-device-tenant']).toBe('tenant');
      expect(req.headers['x-agent-device-lease-id']).toBe('lease');
      res.writeHead(200, { 'content-length': Buffer.byteLength(text) });
      if (broken) {
        res.flushHeaders();
        res.write(text.slice(0, 4));
        setImmediate(() => res.destroy());
      } else res.end(text);
    });
    try {
      const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
      const response = materializeRemoteArtifacts(
        { baseUrl, token: 'test' },
        {
          token: 'test',
          session: 'owned',
          command: 'session_save_script',
          positionals: [],
          meta: { cwd: root, tenantId: 'tenant', leaseId: 'lease' },
        },
        {
          ok: true,
          data: {
            savedScript: '/daemon/script.ad',
            artifacts: [
              {
                field: 'savedScript',
                artifactType: 'session-script',
                artifactId: 'script-id',
                localPath: destination,
                force,
              },
            ],
          },
        },
        createTestHostEnvironment(),
      );
      if (success) {
        await expect(response).resolves.toMatchObject({
          ok: true,
          data: { savedScript: destination },
        });
        expect(fs.readFileSync(destination, 'utf8')).toBe(text);
      } else {
        await expect(response).rejects.toMatchObject({
          code: 'COMMAND_FAILED',
          details: { artifactId: 'script-id' },
        });
        expect(fs.readFileSync(destination, 'utf8')).toBe('original');
      }
      expect(fs.readdirSync(root)).toEqual(['caller.ad']);
    } finally {
      await closeLoopbackServer(server);
    }
  },
);

test('a non-directory caller parent reports the retained script artifact ID', async () => {
  const root = mkdtempForTestSync('script-parent-');
  const parent = path.join(root, 'parent');
  fs.writeFileSync(parent, 'protected');
  const server = http.createServer((_req, res) => res.end('open Demo\n'));
  try {
    const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    await expect(
      materializeRemoteArtifacts(
        { baseUrl, token: 'test' },
        {
          token: 'test',
          session: 'owned',
          command: 'session_save_script',
          positionals: [],
          meta: { cwd: root },
        },
        {
          ok: true,
          data: {
            artifacts: [
              {
                field: 'savedScript',
                artifactType: 'session-script',
                artifactId: 'retained-script',
                localPath: path.join(parent, 'out.ad'),
              },
            ],
          },
        },
        createTestHostEnvironment(),
      ),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { artifactId: 'retained-script', reason: 'script_download_failed' },
    });
    expect(fs.readFileSync(parent, 'utf8')).toBe('protected');
  } finally {
    await closeLoopbackServer(server);
  }
});
