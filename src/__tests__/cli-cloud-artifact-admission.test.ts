import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createDaemonTransport } from '@agent-device/daemon-client';
import { sendRemoteScriptOpen } from '@agent-device/remote/daemon-artifacts';
import {
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { resolveCloudAdmission } from '../cli/connection/active-connection.ts';
import {
  readCloudConnection,
  tryWithConnectionLock,
  writeCloudConnection,
} from '../cli/connection/cloud-connection-record.ts';
import { runCliCapture } from './cli-capture.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

for (const delivery of ['ordinary artifact', 'script artifact', 'failed batch receipt']) {
  test(`releases hosted admission while a ${delivery} body is still streaming`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const location = {
      stateDir: mkdtempForTestSync('cloud-artifact-admission-'),
      session: 'cloud-qa',
    };
    const env = {
      AGENT_DEVICE_SESSION: location.session,
      AGENT_DEVICE_STATE_DIR: location.stateDir,
      AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example',
      AGENT_DEVICE_CLOUD_API_KEY_ORIGIN: 'https://cloud.example',
      AGENT_DEVICE_CLOUD_API_KEY: 'test-cloud-key',
    };
    const token = 'test-scoped-daemon-token';
    vi.stubGlobal('fetch', async () =>
      Response.json(
        {
          id: '00000000-0000-4000-8000-000000000001',
          vendor: 'provider-a',
          transport: 'agent-device-daemon',
          platform: 'ios',
          deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
          attach: {
            kind: 'agent-device-daemon',
            daemonBaseUrl: 'https://daemon.example',
            daemonAuthToken: token,
          },
        },
        { status: 201 },
      ),
    );
    const connected = await runCliCapture(['connect', 'cloud', '--platform', 'ios', '--json'], {
      env,
    });
    expect(connected.code, connected.stdout || connected.stderr).toBeNull();
    const state = readRemoteConnectionState(location)!;
    const binding = state.cloudSession!;
    const admit = (await resolveCloudAdmission({
      ...location,
      command: 'snapshot',
      usesSessions: true,
      host: createTestHostEnvironment({ env }),
      binding,
    }))!;
    const isOrdinary = delivery === 'ordinary artifact';
    const isFailedBatch = delivery === 'failed batch receipt';
    const destination = path.join(
      fs.realpathSync(location.stateDir),
      isOrdinary ? 'first.png' : 'session.ad',
    );
    const artifactRequests: Array<{ url: string; auth: string | undefined }> = [];
    let beginFirstBody!: (response: http.ServerResponse) => void;
    const firstBody = new Promise<http.ServerResponse>((resolve) => {
      beginFirstBody = resolve;
    });
    let reply: object;
    const server = http.createServer((request, response) => {
      request.resume();
      if (request.url === '/health') {
        response.end('{}');
      } else if (request.url === '/rpc') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: 'test', ...reply }));
      } else {
        artifactRequests.push({ url: request.url ?? '', auth: request.headers.authorization });
        if (request.url === '/artifacts/first') {
          response.write('open ');
          beginFirstBody(response);
        } else {
          response.end('unexpected follow-up bytes');
        }
      }
    });
    try {
      const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
      const request = {
        token,
        session: location.session,
        positionals: [],
        flags: { daemonBaseUrl: baseUrl },
      };
      if (isOrdinary) {
        reply = {
          result: {
            ok: true,
            data: {
              artifacts: [
                {
                  artifactId: 'first',
                  field: 'path',
                  artifactType: 'screenshot',
                  fileName: 'first.png',
                },
                {
                  artifactId: 'late',
                  field: 'secondPath',
                  artifactType: 'screenshot',
                  fileName: 'late.png',
                },
              ],
            },
          },
        };
      } else {
        const opened = await sendRemoteScriptOpen(
          { baseUrl, token, capabilities: ['script-artifacts'] },
          {
            ...request,
            command: 'open',
            meta: { clientArtifactPaths: { savedScript: destination } },
          },
          location.stateDir,
          async (openRequest) => ({
            ok: true,
            data: { scriptPublicationId: openRequest.meta?.scriptPublicationId },
          }),
        );
        const publicationId = opened.ok && opened.data?.scriptPublicationId;
        expect(publicationId).toEqual(expect.any(String));
        const version = {
          artifactId: 'first',
          field: 'savedScript',
          artifactType: 'session-script',
          scriptPublicationId: publicationId,
          scriptRevision: 1,
        };
        reply = isFailedBatch
          ? {
              error: {
                message: 'original batch failure',
                data: {
                  code: 'COMMAND_FAILED',
                  details: { scriptDeliveryReceipt: { publicationId, version } },
                },
              },
            }
          : { result: { ok: true, data: { artifacts: [version] } } };
      }

      const transport = createDaemonTransport(createTestHostEnvironment({ env }));
      let admissions = 0;
      const pending = transport(
        {
          ...request,
          command: isFailedBatch ? 'batch' : 'snapshot',
          meta: { cwd: location.stateDir },
        },
        {
          authToken: token,
          dispatch: async (start) => {
            admissions++;
            return await admit(start);
          },
        },
      ).then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      );
      const stalled = await Promise.race([firstBody, pending]);
      expect(stalled).toBeInstanceOf(http.ServerResponse);
      if (!(stalled instanceof http.ServerResponse)) return;

      const prior = readCloudConnection(location)!;
      const generation = randomUUID();
      try {
        await tryWithConnectionLock(location, () => {
          writeCloudConnection(location, { ...prior, generation });
          writeRemoteConnectionState({
            stateDir: location.stateDir,
            state: { ...state, cloudSession: { ...binding, generation } },
          });
        });
        expect(readCloudConnection(location)?.generation).toBe(generation);
        // Health, RPC, and the first artifact each have one handoff.
        expect(admissions).toBe(3);
      } finally {
        stalled.end('Demo\n');
        await pending;
      }

      if (isOrdinary) {
        expect(await pending).toMatchObject({
          error: { details: { reason: 'cloud_connection_changed' } },
        });
        expect(fs.existsSync(path.join(location.stateDir, 'late.png'))).toBe(false);
      } else if (isFailedBatch) {
        expect(await pending).toMatchObject({ error: { message: 'original batch failure' } });
      } else {
        expect(await pending).toMatchObject({
          response: { ok: true, data: { savedScript: destination } },
        });
      }
      expect(admissions).toBe(isOrdinary ? 4 : 3);
      expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
      expect(artifactRequests).toEqual([{ url: '/artifacts/first', auth: `Bearer ${token}` }]);
    } finally {
      await closeLoopbackServer(server);
    }
  });
}
