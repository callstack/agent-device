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
  | { kind: 'hangUp' }
  /** Hangs up on this request and every later one for the command: the entry is never consumed. */
  | { kind: 'hangUpAlways' }
  /** Hangs up and stops listening, as a runner process that died mid-command. */
  | { kind: 'exit' };

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
  let stopped: Promise<void> | undefined;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = parseBody(raw);
      requests.push({ command: String(body.command ?? ''), body });
      const next = byCommand
        ? (takeScriptedResponse(byCommand[String(body.command ?? '')]) ?? {
            kind: 'ok' as const,
            data: {},
          })
        : takeScriptedResponse(remaining);
      if (next?.kind === 'exit') {
        res.destroy();
        stopped ??= new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        return;
      }
      writeFakeRunnerResponse(res, next);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () =>
      stopped ??
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** The next scripted reply; a `hangUpAlways` entry stays at the head of its queue. */
function takeScriptedResponse(
  queue: FakeRunnerResponse[] | undefined,
): FakeRunnerResponse | undefined {
  return queue?.[0]?.kind === 'hangUpAlways' ? queue[0] : queue?.shift();
}

function writeFakeRunnerResponse(
  res: http.ServerResponse,
  next: Exclude<FakeRunnerResponse, { kind: 'exit' }> | undefined,
): void {
  if (!next) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: { message: 'fake runner script exhausted' } }));
    return;
  }
  if (next.kind === 'hangUp' || next.kind === 'hangUpAlways') {
    res.destroy();
    return;
  }
  res.setHeader('content-type', 'application/json');
  if (next.kind === 'runnerError') {
    res.end(JSON.stringify({ ok: false, error: { code: next.code, message: next.message } }));
    return;
  }
  res.end(JSON.stringify({ ok: true, data: next.data }));
}

function parseBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
