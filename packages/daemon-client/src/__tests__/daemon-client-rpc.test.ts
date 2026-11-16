import assert from 'node:assert/strict';
import { test } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import {
  materializeRemoteArtifacts,
  sendRemoteScriptOpen,
} from '@agent-device/remote/daemon-artifacts';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { buildHttpRpcPayload, handleDaemonHttpResponseBody } from '../daemon-client-rpc.ts';

test('lease allocation transports an optional initial provider app', () => {
  const payload = buildHttpRpcPayload(
    {
      token: 'daemon-token',
      session: 'qa-android',
      command: 'lease_allocate',
      positionals: [],
      flags: { providerApp: 'Example.apk' },
      meta: {
        requestId: 'lease-req',
        tenantId: 'acme',
        runId: 'run-123',
        leaseBackend: 'android-instance',
        leaseTtlMs: 30_000,
      },
    },
    { includeTokenParam: false },
  );

  assert.equal(payload.method, 'agent_device.lease.allocate');
  assert.deepEqual(payload.params, {
    session: 'qa-android',
    tenantId: 'acme',
    runId: 'run-123',
    ttlMs: 30_000,
    backend: 'android-instance',
    providerApp: 'Example.apk',
  });
});

test('lease allocation transports a caller-chosen lease id', () => {
  const payload = buildHttpRpcPayload(
    {
      token: 'daemon-token',
      session: 'default',
      command: 'lease_allocate',
      positionals: [],
      meta: {
        requestId: 'lease-req',
        tenantId: 'proxy',
        runId: 'proxy-client-1',
        leaseId: 'abcdef0123456789abcdef0123456789',
      },
    },
    { includeTokenParam: false },
  );

  assert.deepEqual(payload.params, {
    session: 'default',
    tenantId: 'proxy',
    runId: 'proxy-client-1',
    leaseId: 'abcdef0123456789abcdef0123456789',
  });
});

test('lease allocation transports the provider configuration the session needs (#2494)', () => {
  const payload = buildHttpRpcPayload(
    {
      token: 'daemon-token',
      session: 'qa-ios',
      command: 'lease_allocate',
      positionals: [],
      flags: {
        platform: 'ios',
        device: 'iPhone 15',
        providerApp: 'bs://app-id',
        providerOsVersion: '17',
        providerDeviceType: 'real',
        providerProject: 'MyProject',
        providerBuild: 'Build-2026-09-11',
        providerSessionName: 'smoke — iOS',
        providerDeviceOrientation: 'portrait',
        providerNoResignApp: true,
      },
      meta: {
        requestId: 'lease-req',
        tenantId: 'acme',
        runId: 'run-123',
        leaseBackend: 'ios-instance',
        leaseProvider: 'browserstack',
      },
    },
    { includeTokenParam: false },
  );

  assert.deepEqual(payload.params, {
    session: 'qa-ios',
    tenantId: 'acme',
    runId: 'run-123',
    backend: 'ios-instance',
    leaseProvider: 'browserstack',
    platform: 'ios',
    device: 'iPhone 15',
    providerApp: 'bs://app-id',
    providerOsVersion: '17',
    providerDeviceType: 'real',
    providerProject: 'MyProject',
    providerBuild: 'Build-2026-09-11',
    providerSessionName: 'smoke — iOS',
    providerDeviceOrientation: 'portrait',
    providerNoResignApp: true,
  });
});

test('lease allocation carries the device selectors a proxy daemon picks by', () => {
  const payload = buildHttpRpcPayload(
    {
      token: 'daemon-token',
      session: 'adc-proxy',
      command: 'lease_allocate',
      positionals: [],
      flags: {
        platform: 'ios',
        target: 'tv',
        device: 'Apple TV',
        udid: 'SIM-1',
        serial: 'S-1',
        iosSimulatorDeviceSet: '/sims',
        androidDeviceAllowlist: 'S-1',
      },
      meta: { requestId: 'lease-req', tenantId: 'proxy', runId: 'proxy-client-1' },
    },
    { includeTokenParam: false },
  );

  assert.deepEqual(payload.params, {
    session: 'adc-proxy',
    tenantId: 'proxy',
    runId: 'proxy-client-1',
    platform: 'ios',
    target: 'tv',
    device: 'Apple TV',
    udid: 'SIM-1',
    serial: 'S-1',
    iosSimulatorDeviceSet: '/sims',
    androidDeviceAllowlist: 'S-1',
  });
});

test('HTTP RPC errors sanitize an untrusted cause before rehydration', () => {
  const secret = 'adc_agent_remote-secret';
  const oversizedCode = `apiKey=${secret} ${'c'.repeat(500)}`;
  const message =
    `download https://user:pass@example.test/app?token=${secret} failed: bearer ${secret} ` +
    'x'.repeat(500);
  let rejected: unknown;

  handleDaemonHttpResponseBody(
    JSON.stringify({
      error: {
        data: {
          code: 'COMMAND_FAILED',
          message: 'remote download failed',
          cause: { code: oversizedCode, message },
        },
      },
    }),
    {
      host: createTestHostEnvironment(),
      info: { token: 'daemon-token', pid: 1 },
      req: {
        command: 'apps_install_source',
        positionals: [],
        token: 'daemon-token',
        session: 'test-session',
      },
      stateDir: '/tmp/agent-device-test',
      resolve: () => undefined,
      reject: (error) => {
        rejected = error;
      },
    },
  );

  assert.ok(rejected instanceof AppError);
  const cause = rejected.cause as { code?: string; message: string } | undefined;
  assert.ok(cause);
  assert.equal(JSON.stringify(cause).includes(secret), false);
  assert.match(cause.message, /REDACTED/);
  assert.equal(cause.message.length, 400);
  assert.match(cause.message, /<truncated>$/);
  assert.match(cause.code ?? '', /^apiKey=\[REDACTED\]/);
  assert.equal(cause.code?.length, 400);
  assert.match(cause.code ?? '', /<truncated>$/);
});

test('lease allocation carries the device spec a proxy backend picks by', () => {
  const payload = buildHttpRpcPayload(
    {
      token: 'daemon-token',
      session: 'adc-proxy',
      command: 'lease_allocate',
      positionals: [],
      flags: {
        platform: 'android',
        osVersion: '>=34',
        imageTag: 'google_apis_playstore',
        physical: true,
      },
      meta: { requestId: 'lease-req', tenantId: 'proxy', runId: 'proxy-run' },
    },
    { includeTokenParam: false },
  );

  assert.equal(payload.method, 'agent_device.lease.allocate');
  assert.deepEqual(payload.params, {
    session: 'adc-proxy',
    tenantId: 'proxy',
    runId: 'proxy-run',
    platform: 'android',
    osVersion: '>=34',
    imageTag: 'google_apis_playstore',
    physical: true,
  });
});

/**
 * A failed batch is an error, so nothing about it reaches the code that materializes a successful
 * response's artifacts. The steps that DID finish have to be delivered from the error's
 * `partialResults` all the same: `[wait, close, snapshot]` that fails on `snapshot` still owes the
 * caller the final script the close step wrote, and still has to forget a recording the daemon no
 * longer has. The batch's own error stands.
 */
test('a failed remote batch delivers the scripts of the steps that finished and keeps its error', async () => {
  const finalScript = 'open Demo\nwait 100\nclose\n';
  const server = scriptServer({ v1: 'open Demo\n', final: finalScript });
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const root = fs.realpathSync(mkdtempForTestSync('rpc-batch-partial-'));
  const stateDir = path.join(root, 'state');
  const destination = path.join(root, 'journey.ad');
  const host = createTestHostEnvironment();
  try {
    const publicationId = await openRemoteRecording(baseUrl, stateDir, destination);

    let rejected: unknown;
    await new Promise<void>((resolve) => {
      handleDaemonHttpResponseBody(
        JSON.stringify({
          error: {
            data: {
              code: 'COMMAND_FAILED',
              message: 'Batch failed at step 3 (snapshot): snapshot failed',
              details: {
                step: 3,
                command: 'snapshot',
                executed: 2,
                total: 3,
                partialResults: [
                  { step: 1, command: 'wait', ok: true, durationMs: 1, data: { waited: true } },
                  {
                    step: 2,
                    command: 'close',
                    ok: true,
                    durationMs: 1,
                    data: {
                      scriptPublicationId: publicationId,
                      artifacts: [scriptArtifact('final', 2, publicationId)],
                    },
                  },
                ],
              },
            },
          },
        }),
        {
          info: { token: 'daemon-token', pid: 1, baseUrl },
          // The report says step 3 failed after 2 finished steps, so the caller submitted three.
          req: batchRequest('wait', 'close', 'snapshot'),
          stateDir,
          host,
          resolve: () => resolve(),
          reject: (error) => {
            rejected = error;
            resolve();
          },
        },
      );
    });

    assert.ok(rejected instanceof AppError, `Expected the batch error, got ${String(rejected)}`);
    assert.match(rejected.message, /Batch failed at step 3 \(snapshot\)/);
    assert.equal(rejected.details?.step, 3);
    // The close step's script reached the caller file, and the client stopped tracking the recording.
    assert.equal(fs.readFileSync(destination, 'utf8'), finalScript);
    assert.deepEqual(activeScriptRecords(stateDir), []);
  } finally {
    await closeLoopbackServer(server);
  }
});

/**
 * A failed batch delivers only what the caller submitted. A step entry the plan never named earns no
 * download and no retirement, even inside an error.
 */
test('a failed remote batch delivers nothing for a step the caller never submitted', async () => {
  const server = scriptServer({ v1: 'open Demo\n', final: 'open Demo\nwait 100\nclose\n' });
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const root = fs.realpathSync(mkdtempForTestSync('rpc-batch-unauthorized-'));
  const stateDir = path.join(root, 'state');
  const destination = path.join(root, 'journey.ad');
  const host = createTestHostEnvironment();
  try {
    const publicationId = await openRemoteRecording(baseUrl, stateDir, destination);

    await new Promise<void>((resolve) => {
      handleDaemonHttpResponseBody(
        JSON.stringify({
          error: {
            data: {
              code: 'COMMAND_FAILED',
              message: 'Batch failed at step 2 (wait): wait failed',
              details: {
                step: 2,
                command: 'wait',
                // The caller submitted one `wait` step; this entry claims a close of its publication.
                partialResults: [
                  {
                    step: 1,
                    command: 'close',
                    ok: true,
                    durationMs: 1,
                    data: {
                      scriptPublicationId: publicationId,
                      artifacts: [scriptArtifact('final', 2, publicationId)],
                    },
                  },
                ],
              },
            },
          },
        }),
        {
          info: { token: 'daemon-token', pid: 1, baseUrl },
          req: batchRequest('wait'),
          stateDir,
          host,
          resolve: () => resolve(),
          reject: () => resolve(),
        },
      );
    });

    assert.equal(fs.readFileSync(destination, 'utf8'), 'open Demo\n');
    assert.equal(activeScriptRecords(stateDir).length, 1);
  } finally {
    await closeLoopbackServer(server);
  }
});

/**
 * A failed batch reports the step that failed and how many steps ran. The runner puts an entry in
 * `partialResults` ONLY for a step it finished before the failure, so successful entries for steps at
 * or after the reported failure describe work that never happened. Neither a download nor the end of
 * the caller's recording may follow from them: `[wait, close, snapshot]` that reports step 3 after 0
 * executed steps still owes the caller its file and its record.
 */
test('a failed remote batch whose step report disagrees with its entries delivers nothing', async () => {
  const server = scriptServer({ v1: 'open Demo\n', final: 'open Demo\nwait 100\nclose\n' });
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const root = fs.realpathSync(mkdtempForTestSync('rpc-batch-forged-'));
  const stateDir = path.join(root, 'state');
  const destination = path.join(root, 'journey.ad');
  const host = createTestHostEnvironment();
  try {
    const publicationId = await openRemoteRecording(baseUrl, stateDir, destination);

    let rejected: unknown;
    await new Promise<void>((resolve) => {
      handleDaemonHttpResponseBody(
        JSON.stringify({
          error: {
            data: {
              code: 'COMMAND_FAILED',
              message: 'Batch failed at step 3 (snapshot): snapshot failed',
              details: {
                // Says nothing finished, and attaches a finished close of this client's publication.
                step: 3,
                command: 'snapshot',
                executed: 0,
                total: 3,
                partialResults: [
                  { step: 1, command: 'wait', ok: true, durationMs: 1, data: { waited: true } },
                  {
                    step: 2,
                    command: 'close',
                    ok: true,
                    durationMs: 1,
                    data: {
                      scriptPublicationId: publicationId,
                      artifacts: [scriptArtifact('final', 2, publicationId)],
                    },
                  },
                ],
              },
            },
          },
        }),
        {
          info: { token: 'daemon-token', pid: 1, baseUrl },
          req: batchRequest('wait', 'close', 'snapshot'),
          stateDir,
          host,
          resolve: () => resolve(),
          reject: (error) => {
            rejected = error;
            resolve();
          },
        },
      );
    });

    assert.ok(rejected instanceof AppError, `Expected the batch error, got ${String(rejected)}`);
    // A close the caller never ran writes nothing and retires nothing.
    assert.equal(fs.readFileSync(destination, 'utf8'), 'open Demo\n');
    assert.equal(activeScriptRecords(stateDir).length, 1);
  } finally {
    await closeLoopbackServer(server);
  }
});

/**
 * The runner's step report has to describe a step of THIS caller's plan. A report that names a step
 * the plan does not have, or names a step under another command, describes work this client never
 * submitted, so it finishes nothing: no download, and no end to the caller's recording.
 */
test('a failed remote batch whose report does not describe the submitted plan delivers nothing', async () => {
  const reports: Array<
    Readonly<{ label: string; plan: string[]; details: Record<string, unknown> }>
  > = [
    {
      // Names step 3 of a two-step plan.
      label: 'a step the plan does not have',
      plan: ['wait', 'close'],
      details: { step: 3, command: 'snapshot', executed: 2 },
    },
    {
      // Names a real step of a three-step plan under another command.
      label: 'a command the plan does not name there',
      plan: ['wait', 'close', 'snapshot'],
      details: { step: 3, command: 'wait', executed: 2 },
    },
  ];

  for (const report of reports) {
    const server = scriptServer({ v1: 'open Demo\n', final: 'open Demo\nwait 100\nclose\n' });
    const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    const root = fs.realpathSync(mkdtempForTestSync('rpc-batch-report-mismatch-'));
    const stateDir = path.join(root, 'state');
    const destination = path.join(root, 'journey.ad');
    try {
      const publicationId = await openRemoteRecording(baseUrl, stateDir, destination);

      await new Promise<void>((resolve) => {
        handleDaemonHttpResponseBody(
          JSON.stringify({
            error: {
              data: {
                code: 'COMMAND_FAILED',
                message: `Batch failed at step ${String(report.details.step)}`,
                details: {
                  ...report.details,
                  total: report.plan.length,
                  // A finished close of this client's publication, planted at the last executed step.
                  partialResults: [
                    { step: 1, command: 'wait', ok: true, durationMs: 1, data: { waited: true } },
                    {
                      step: 2,
                      command: 'close',
                      ok: true,
                      durationMs: 1,
                      data: {
                        scriptPublicationId: publicationId,
                        artifacts: [scriptArtifact('final', 2, publicationId)],
                      },
                    },
                  ],
                },
              },
            },
          }),
          {
            info: { token: 'daemon-token', pid: 1, baseUrl },
            req: batchRequest(...report.plan),
            stateDir,
            host: createTestHostEnvironment(),
            resolve: () => resolve(),
            reject: () => resolve(),
          },
        );
      });

      assert.equal(fs.readFileSync(destination, 'utf8'), 'open Demo\n', report.label);
      assert.equal(activeScriptRecords(stateDir).length, 1, report.label);
    } finally {
      await closeLoopbackServer(server);
    }
  }
});

function batchRequest(...commands: string[]): DaemonWireRequest {
  return {
    token: 'daemon-token',
    session: 'journey',
    command: 'batch',
    positionals: [],
    flags: { batchSteps: commands.map((command) => ({ command })) },
  };
}

function scriptArtifact(artifactId: string, revision: number, publicationId: string) {
  return {
    field: 'savedScript',
    artifactType: 'session-script',
    artifactId,
    scriptPublicationId: publicationId,
    scriptRevision: revision,
  };
}

/** Serves the script versions it is given; anything else answers 503. */
function scriptServer(bodies: Record<string, string>): http.Server {
  return http.createServer((req, res) => {
    const id = decodeURIComponent(req.url?.replace('/artifacts/', '') ?? '');
    const body = bodies[id];
    if (body === undefined) {
      res.writeHead(503).end('unavailable');
      return;
    }
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
}

/** A remote `open --save-script` the daemon answered with version 1, as this client arms it. */
async function openRemoteRecording(
  baseUrl: string,
  stateDir: string,
  destination: string,
): Promise<string> {
  let publicationId = '';
  await sendRemoteScriptOpen(
    { baseUrl, token: 'daemon-token', capabilities: ['script-artifacts'] },
    {
      token: 'daemon-token',
      session: 'journey',
      command: 'open',
      positionals: [],
      flags: { saveScript: true },
      meta: { clientArtifactPaths: { savedScript: destination } },
    },
    stateDir,
    async (next) => {
      publicationId = next.meta?.scriptPublicationId as string;
      return await materializeRemoteArtifacts(
        { baseUrl, token: 'daemon-token' },
        next,
        {
          ok: true,
          data: {
            scriptPublicationId: publicationId,
            artifacts: [scriptArtifact('v1', 1, publicationId)],
          },
        },
        createTestHostEnvironment(),
        stateDir,
      );
    },
  );
  assert.equal(fs.readFileSync(destination, 'utf8'), 'open Demo\n');
  return publicationId;
}

function activeScriptRecords(stateDir: string): string[] {
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.endsWith('.json'))
    : [];
}
