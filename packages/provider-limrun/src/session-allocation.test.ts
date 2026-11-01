import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'vitest';
import Limrun from '@limrun/api';
import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { allocateLimrunAndroidSession, allocateLimrunIosSession } from './session-allocation.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

/**
 * An instance create whose answer was lost is the one request this runtime must not repeat: Limrun may have
 * made the instance already, and the SDK's own retries would POST again and rent a second instance no owner
 * learns about. These cases put the real SDK in front of a local server, since that retry is decided below the
 * request boundary every other Limrun suite replaces.
 */

test('the Android instance create asks the SDK for one attempt, so a lost answer rents no second instance', async () => {
  const routes: string[] = [];
  const server = await startInstanceServer(async (request) => {
    routes.push(`${String(request.method)} ${request.path}`);
    // The instance may well have been made; this answer never arrives.
    request.drop();
  });
  const rented: string[] = [];
  try {
    await assert.rejects(
      async () =>
        await allocateLimrunAndroidSession(
          allocationParams(server),
          (instanceId) => void rented.push(instanceId),
        ),
    );
  } finally {
    await server.close();
  }
  // One POST, so at most one instance: the SDK was not left to resolve the ambiguity by asking again.
  assert.deepEqual(routes, ['POST /v1/android_instances']);
  // Nothing was named, since no answer came back to name it.
  assert.deepEqual(rented, []);
});

test('the iOS instance create asks the SDK for one attempt, so a lost answer rents no second instance', async () => {
  const routes: string[] = [];
  const server = await startInstanceServer(async (request) => {
    routes.push(`${String(request.method)} ${request.path}`);
    request.drop();
  });
  const rented: string[] = [];
  try {
    await assert.rejects(
      async () =>
        await allocateLimrunIosSession(
          allocationParams(server),
          (instanceId) => void rented.push(instanceId),
        ),
    );
  } finally {
    await server.close();
  }
  assert.deepEqual(routes, ['POST /v1/ios_instances']);
  assert.deepEqual(rented, []);
});

test('an Android instance that answers without its endpoints is reported as rented and left for its owner', async () => {
  const routes: string[] = [];
  const server = await startInstanceServer(async (request) => {
    routes.push(`${String(request.method)} ${request.path}`);
    await request.respond(
      200,
      JSON.stringify({ metadata: { id: 'android-instance-9' }, status: { token: 'lim_token' } }),
    );
  });
  const rented: string[] = [];
  try {
    await assert.rejects(
      async () =>
        await allocateLimrunAndroidSession(
          allocationParams(server),
          (instanceId) => void rented.push(instanceId),
        ),
      (error) =>
        error instanceof AppError &&
        error.code === 'COMMAND_FAILED' &&
        /did not expose API and ADB websocket endpoints/.test(error.message),
    );
  } finally {
    await server.close();
  }
  // The create names what it rented before any session is built on it, which is what lets the caller's owner
  // end it; the helper does not delete it here, where a refusal could be swallowed.
  assert.deepEqual(rented, ['android-instance-9']);
  assert.deepEqual(routes, ['POST /v1/android_instances']);
});

function allocationParams(server: InstanceServer) {
  return {
    limrun: new Limrun({ apiKey: server.key, baseURL: server.baseUrl }),
    lease: {
      leaseId: 'lease-single-attempt',
      tenantId: 'team-a',
      runId: 'run-a',
      backend: 'android-instance',
      leaseProvider: 'limrun',
      createdAt: 1,
      heartbeatAt: 1,
      expiresAt: 60_001,
    } satisfies DeviceLease,
    metadata: { displayName: 'agent-device', labels: { provider: 'limrun' } },
    dependencies: unreachedDependencies,
  };
}

/**
 * The host and platform adapters none of these cases reaches: the create, or the endpoints it names, answer
 * first. Any step through one of these means a case lost its premise and fails on the spot.
 */
const unreachedDependencies = {
  android: {
    createPortReverse: async (): Promise<never> => {
      throw new Error('expected no session for an instance whose endpoints never arrived');
    },
  },
} as unknown as LimrunRuntimeDependencies;

type InstanceServer = Readonly<{
  baseUrl: string;
  key: string;
  close(): Promise<void>;
}>;

type ReceivedRequest = Readonly<{
  method: string | undefined;
  path: string;
  /** Ends the connection without an answer, the ambiguity a retry must not resolve by POSTing again. */
  drop(): void;
  respond(status: number, body: string): Promise<void>;
}>;

function startInstanceServer(
  onRequest: (request: ReceivedRequest) => Promise<void>,
): Promise<InstanceServer> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void onRequest({
        method: req.method,
        // The query is Limrun's own create parameters, not part of the route a retry would repeat.
        path: (req.url ?? '').split('?')[0] ?? '',
        drop: () => req.socket.destroy(),
        respond: async (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body);
        },
      });
    });
  });
  return new Promise((started, failed) => {
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      started({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        key: 'lim_test_key',
        close: async () =>
          await new Promise<void>((closed, closeFailed) => {
            server.close((error) => (error ? closeFailed(error) : closed()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
