import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import { sendToDaemon } from '../daemon-client.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { currentDaemonCodeSignature } from '../../__tests__/test-utils/daemon-http-fixture.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  supportsLoopbackBind,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

test.sequential.for([DEVELOPER_DIR, '', undefined])(
  'sendToDaemon forwards local DEVELOPER_DIR (%s) and strips remote developerDir',
  async (developerDir, t) => {
    if (!(await supportsLoopbackBind())) {
      t.skip('loopback listeners are not permitted in this environment');
      return;
    }
    const saved = {
      developerDir: process.env.DEVELOPER_DIR,
      baseUrl: process.env.AGENT_DEVICE_DAEMON_BASE_URL,
      authToken: process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN,
    };
    restoreEnv('DEVELOPER_DIR', developerDir);
    delete process.env.AGENT_DEVICE_DAEMON_BASE_URL;
    delete process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
    const stateDir = mkdtempForTestSync('agent-device-developer-dir-daemon-');
    let localMeta: Record<string, unknown> | undefined;
    const socketDaemon = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let body = '';
      socket.on('data', (chunk) => {
        body += chunk;
        if (!body.includes('\n')) return;
        const request: { meta?: Record<string, unknown> } = JSON.parse(body.trim());
        localMeta = request.meta;
        socket.end(`${JSON.stringify({ ok: true, data: {} })}\n`);
      });
    });
    let remoteMeta: Record<string, unknown> | undefined;
    let remoteCalled = false;
    const remoteDaemon = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        if (req.method === 'GET') {
          res.end();
          return;
        }
        const rpc: { id: string; params: { meta?: Record<string, unknown> } } = JSON.parse(body);
        remoteCalled = true;
        remoteMeta = rpc.params.meta;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { ok: true, data: {} } }));
      });
    });

    try {
      writeDaemonInfo(stateDir, await listenOnLoopback(socketDaemon));
      await sendToDaemon({
        session: 'default',
        command: 'devices',
        positionals: [],
        flags: { stateDir, daemonTransport: 'socket' },
        meta: { requestId: 'req-developer-dir-local' },
      });

      process.env.AGENT_DEVICE_DAEMON_BASE_URL = `http://127.0.0.1:${await listenOnLoopback(remoteDaemon)}`;
      process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = 'remote-secret';
      await sendToDaemon({
        session: 'default',
        command: 'devices',
        positionals: [],
        meta: { requestId: 'req-developer-dir-remote', developerDir: DEVELOPER_DIR },
      });
    } finally {
      await closeLoopbackServer(socketDaemon);
      await closeLoopbackServer(remoteDaemon);
      fs.rmSync(stateDir, { recursive: true, force: true });
      restoreEnv('DEVELOPER_DIR', saved.developerDir);
      restoreEnv('AGENT_DEVICE_DAEMON_BASE_URL', saved.baseUrl);
      restoreEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', saved.authToken);
    }
    assert.equal(localMeta?.developerDir, developerDir);
    assert.ok(remoteCalled, 'the remote daemon received the request');
    assert.equal(remoteMeta?.developerDir, undefined);
  },
);

function writeDaemonInfo(stateDir: string, port: number): void {
  const paths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    `${JSON.stringify({
      port,
      transport: 'socket',
      token: 'local-secret',
      pid: process.pid,
      version: readVersion(),
      codeSignature: currentDaemonCodeSignature(),
      processStartTime: readProcessStartTime(process.pid) ?? undefined,
    })}\n`,
    'utf8',
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
