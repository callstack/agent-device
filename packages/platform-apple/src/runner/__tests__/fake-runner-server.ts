import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A deterministic fake iOS runner: a local HTTP server standing in for the
 * XCTest runner process, scripted per request. Recovery/retry suites drive the
 * REAL send stack (executeRunnerCommandWithSession → transport fetch) against
 * it instead of vi-mocking internal functions — the #1631 testing seam. Each
 * incoming request consumes the next scripted response; running out of script
 * fails loudly rather than improvising.
 */

export type FakeRunnerResponse =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'runnerError'; code: string; message: string }
  | { kind: 'hangUp' };

export type FakeRunnerRequest = {
  command: string;
  body: Record<string, unknown>;
};

export type FakeRunnerServer = {
  port: number;
  requests: FakeRunnerRequest[];
  close: () => Promise<void>;
};

/**
 * Per-command scripts. Production sends a readiness `uptime` probe before a
 * mutating command, and recovery sends `status` afterwards, so a rigid
 * one-queue script couples every test to that ordering; keying by command
 * lets a test say only what it cares about. Each command's list is consumed
 * in order, and a command with no script left answers `ok` with no data.
 */
export type FakeRunnerCommandScript = Record<string, FakeRunnerResponse[]>;

export async function startFakeRunnerServer(
  script: FakeRunnerResponse[] | FakeRunnerCommandScript,
): Promise<FakeRunnerServer> {
  const sequential = Array.isArray(script) ? [...script] : undefined;
  const byCommand = Array.isArray(script)
    ? undefined
    : Object.fromEntries(Object.entries(script).map(([key, list]) => [key, [...list]]));
  const remaining = sequential ?? [];
  const requests: FakeRunnerRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = parseBody(raw);
      requests.push({ command: String(body.command ?? ''), body });
      const next = byCommand
        ? (byCommand[String(body.command ?? '')]?.shift() ?? { kind: 'ok' as const, data: {} })
        : remaining.shift();
      if (!next) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: { message: 'fake runner script exhausted' } }));
        return;
      }
      if (next.kind === 'hangUp') {
        res.destroy();
        return;
      }
      if (next.kind === 'runnerError') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: { code: next.code, message: next.message } }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, data: next.data }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function parseBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
