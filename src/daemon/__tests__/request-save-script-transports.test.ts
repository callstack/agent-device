import { isSessionRecording } from '../session-script-publication-capability.ts';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
/**
 * #1478 (P4-pre): raw-wire counterfactuals for the `flags.saveScript` seam.
 *
 * The CLI/Node/MCP surfaces only ever emit `--save-script` for its released
 * owners, so the arming path is reachable only by a hand-built request. Both
 * daemon transports funnel through the SAME request handler
 * (`createRequestHandler`, wired into `createSocketServer` and
 * `createDaemonHttpServer` by `daemon-runtime.ts`), so the rejection is pinned
 * here on both wires: an unsupported command carrying the flag must not reach
 * admission or device work, must not arm publication, and must not leave a
 * `.ad` artifact behind.
 */
import fs from 'node:fs';
import { NO_SCRIPT_PUBLICATION, scriptTargetPath } from '../session-script-publication-state.ts';
import net from 'node:net';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';
import { SessionStore } from '../session-store.ts';
import { createDaemonHttpServer } from '../server/http-server.ts';
import { createSocketServer, listenNetServer } from '../server/transport.ts';
import type { DaemonInvokeFn, DaemonResponse, SessionState } from '../types.ts';
import { makeIosSession } from '../../__tests__/test-utils/index.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const TOKEN = 'save-script-transport-token';
const SESSION = 'save-script-transport';
const UNSUPPORTED_MESSAGE = '--save-script is supported only by close, open, replay.';

type WireRequest = {
  token?: string;
  session?: string;
  command: string;
  positionals?: string[];
  flags?: Record<string, unknown>;
};

type Harness = {
  root: string;
  sessionStore: SessionStore;
  session: SessionState;
  handleRequest: DaemonInvokeFn;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(): Harness {
  const root = mkdtempForTestSync('agent-device-save-script-transport-');
  roots.push(root);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const session = makeIosSession(SESSION);
  sessionStore.set(SESSION, session);
  const handleRequest = createRequestHandler({
    logPath: path.join(root, 'daemon.log'),
    token: TOKEN,
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { root, sessionStore, session, handleRequest };
}

async function sendOverSocket(
  handleRequest: DaemonInvokeFn,
  request: WireRequest,
): Promise<DaemonResponse> {
  const server = createSocketServer(handleRequest);
  try {
    const port = await listenNetServer(server);
    const socket = net.createConnection({ host: '127.0.0.1', port });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });
      return await new Promise<DaemonResponse>((resolve, reject) => {
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          const newline = buffer.indexOf('\n');
          if (newline === -1) return;
          resolve(JSON.parse(buffer.slice(0, newline)) as DaemonResponse);
        });
        socket.once('error', reject);
        socket.write(`${JSON.stringify({ token: TOKEN, session: SESSION, ...request })}\n`);
      });
    } finally {
      socket.destroy();
    }
  } finally {
    await closeLoopbackServer(server);
  }
}

async function sendOverHttp(
  handleRequest: DaemonInvokeFn,
  request: WireRequest,
): Promise<DaemonResponse> {
  const server = await createDaemonHttpServer({ handleRequest, token: TOKEN });
  try {
    const port = await listenOnLoopback(server);
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-save-script',
        method: 'agent_device.command',
        params: { token: TOKEN, session: SESSION, ...request },
      }),
    });
    const body = (await response.json()) as {
      result?: { ok: boolean; data?: Record<string, unknown> };
      // Project the ADR 0010 diagnostics fields too: dropping them here would
      // let `diagnosticId`/`logPath` regress while these tests stayed green.
      error?: {
        data?: {
          code?: string;
          message?: string;
          hint?: string;
          diagnosticId?: string;
          logPath?: string;
        };
      };
    };
    if (body.error?.data) {
      const { code, message, hint, diagnosticId, logPath } = body.error.data;
      return {
        ok: false,
        error: { code: code ?? 'UNKNOWN', message: message ?? '', hint, diagnosticId, logPath },
      };
    }
    return (body.result ?? {
      ok: false,
      error: { code: 'UNKNOWN', message: 'no result' },
    }) as DaemonResponse;
  } finally {
    await closeLoopbackServer(server);
  }
}

const TRANSPORTS = [
  ['socket', sendOverSocket],
  ['http', sendOverHttp],
] as const satisfies readonly (readonly [
  string,
  (handleRequest: DaemonInvokeFn, request: WireRequest) => Promise<DaemonResponse>,
])[];

function listAdArtifacts(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ad'));
}

for (const [transport, send] of TRANSPORTS) {
  test(`${transport}: raw saveScript on a recordable command never arms or writes a script`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const { root, sessionStore, session, handleRequest } = setup();

    const rejected = await send(handleRequest, {
      command: 'trace',
      positionals: ['start'],
      flags: { saveScript: `${root}/forged.ad` },
    });

    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe('INVALID_ARGS');
    expect(rejected.error.message).toBe(UNSUPPORTED_MESSAGE);
    expect(rejected.error.hint).toMatch(/session save-script/);
    // ADR 0010 decision 6: a failed request stays traceable. Asserted on both
    // transports so the HTTP projection cannot silently drop these again.
    expect(rejected.error.diagnosticId).toBeTruthy();
    expect(rejected.error.logPath).toBeTruthy();
    const rejectionLogPath = rejected.error.logPath as string;
    expect(fs.existsSync(rejectionLogPath)).toBe(true);
    expect(fs.readFileSync(rejectionLogPath, 'utf8')).toMatch(/save_script_flag_rejected/);

    // No handler work: the trace never started and no action was recorded.
    expect(session.trace).toBe(undefined);
    expect(session.actions).toEqual([]);
    // No arming: no publication lifecycle, so the session records nothing.
    expect(isSessionRecording(session)).toBe(false);
    expect(session.scriptPublication).toBe(undefined);
    // No artifact: the write a later close/teardown would attempt publishes nothing.
    expect(sessionStore.writeSessionLog(session)).toEqual({ written: false });
    expect(listAdArtifacts(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'forged.ad'))).toBe(false);

    // Counterfactual: the very same request without the flag does reach the
    // handler and does record its action, so the rejection above is the flag.
    const accepted = await send(handleRequest, { command: 'trace', positionals: ['start'] });
    expect(accepted.ok).toBe(true);
    expect(session.trace?.outPath).toMatch(/\.trace\.log$/);
    expect(session.actions.map((action) => action.command)).toEqual(['trace']);
    expect(isSessionRecording(session)).toBe(false);
    expect(listAdArtifacts(root)).toEqual([]);
  });

  test(`${transport}: the rejection lands before admission`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const { handleRequest } = setup();

    // `sessionIsolation: 'tenant'` without a tenant is rejected by
    // `scopeRequestSession`, the first step of request admission. Getting the
    // save-script message instead proves the flag seam runs ahead of it.
    const response = await send(handleRequest, {
      command: 'record',
      positionals: ['stop'],
      flags: { saveScript: true, sessionIsolation: 'tenant' },
    });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.message).toBe(UNSUPPORTED_MESSAGE);
    expect(response.error.message).not.toMatch(/tenant/);
  });

  test(`${transport}: the released owners still carry the flag to their handlers`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const { handleRequest } = setup();

    // `replay` is a flag owner, so the seam lets it through and the request
    // fails only on its own missing-path validation, downstream of admission.
    const response = await send(handleRequest, {
      command: 'replay',
      positionals: [],
      flags: { saveScript: true },
    });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.message).toBe('replay requires a path');
  });
}

test('a batch step cannot smuggle the flag onto a non-owner command', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { root, session, handleRequest } = setup();

  // Batch step flags are free-form passthrough into the same request entry
  // point, so they are the third face of the same raw arming path — the step's
  // nested request meets the seam exactly like a top-level one.
  const response = await sendOverSocket(handleRequest, {
    command: 'batch',
    positionals: [],
    flags: {
      batchSteps: [
        { command: 'trace', positionals: ['start'], flags: { saveScript: `${root}/forged.ad` } },
      ],
    },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).toMatch(UNSUPPORTED_MESSAGE);
  expect(session.trace).toBe(undefined);
  expect(isSessionRecording(session)).toBe(false);
  expect(listAdArtifacts(root)).toEqual([]);
});

test('an owner-armed session still records its target and publishes its script', () => {
  const { root, sessionStore, session } = setup();
  const target = path.join(root, 'published.ad');

  // What `open`/`close --save-script` do once past the seam: arm the session,
  // then publish at teardown. Unchanged by the ingress rejection.
  sessionStore.recordAction(session, {
    command: 'open',
    positionals: ['Example'],
    flags: { saveScript: target },
    result: { session: SESSION },
  });
  expect(isSessionRecording(session)).toBe(true);
  expect(scriptTargetPath(session.scriptPublication ?? NO_SCRIPT_PUBLICATION)).toBe(target);

  const result = sessionStore.writeSessionLog(session);
  expect(result).toEqual({ written: true, path: target, actionCount: 1 });
  expect(fs.readFileSync(target, 'utf8')).toMatch(/^open /m);
});
