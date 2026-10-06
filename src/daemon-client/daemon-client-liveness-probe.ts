import net from 'node:net';
import { INTERNAL_COMMANDS } from '@agent-device/command-registry/catalog';
import { createRequestId } from '@agent-device/host-kit/diagnostics';
import { loadNodeHttpRequester, consumeTextLines } from '@agent-device/host-kit/transport';
import type { DaemonRequest } from '../daemon/daemon-request.ts';
import type { DaemonInfo } from './daemon-client-metadata.ts';

// The post-timeout liveness probe (#3177): the question a daemon reset may no longer assume. The
// daemon owns request-scoped recovery, so a reset is only justified for a daemon that answers
// nothing, and it must be asked on FRESH connections — the timed-out connection is the one the
// transport already tore down to cancel that request.

// The extra latency a caller of a reset-eligible timed-out request can pay before its error lands.
// An order of magnitude under the narrowest reset-eligible envelope (pinned in
// `__tests__/daemon-client-liveness-probe.test.ts`): a wrong "unresponsive" verdict kills a live
// shared daemon.
export const LIVENESS_PROBE_BUDGET_MS = 1_000;

/**
 * Whether this local daemon answers anything within the probe budget: its HTTP health route, or
 * one sessionless RPC on its socket. An answer on either leg proves the daemon's event loop serves
 * fresh requests; a refused or silent leg answers "not this one", not "not the daemon".
 *
 * Both legs run CONCURRENTLY against one shared deadline: the finding is per-daemon, not per-leg,
 * and a leg that hangs must not spend the window the other leg needs. The first AFFIRMATIVE is
 * unrevocable and settles at once. The deadline is ABSOLUTE — a leg whose endpoint trickles bytes
 * would outlive an idle timeout, and the negative verdict must land inside the window. A leg never
 * rejects: a probe that cannot ask is an endpoint that did not answer. `session` rides along so an
 * isolation-scoped daemon routes the probe like the request it follows.
 */
export async function probeDaemonResponsive(
  info: DaemonInfo,
  params: Readonly<{ session?: string }> = {},
): Promise<boolean> {
  const deadlineAtMs = Date.now() + LIVENESS_PROBE_BUDGET_MS;
  const legs: ProbeLeg[] = [];
  if (info.httpPort) legs.push(probeHttpHealth(info.httpPort, deadlineAtMs));
  if (info.port) legs.push(probeSocketRpc(info.port, info.token, params.session, deadlineAtMs));
  if (legs.length === 0) return false;
  return await new Promise<boolean>((resolve) => {
    let outstanding = legs.length;
    const settle = (answered: boolean): void => {
      if (answered) {
        for (const leg of legs) leg.cancel();
        resolve(true);
        return;
      }
      if (--outstanding === 0) resolve(false);
    };
    for (const leg of legs) leg.answer.then(settle, () => settle(false));
  });
}

type ProbeLeg = Readonly<{ answer: Promise<boolean>; cancel: () => void }>;

function createProbeLeg(deadlineAtMs: number): {
  leg: ProbeLeg;
  settle: (answered: boolean) => void;
  attach: (destroyTransport: () => void) => void;
} {
  let settled = false;
  let destroy: (() => void) | undefined;
  let resolveAnswer: (answered: boolean) => void = () => {};
  const answer = new Promise<boolean>((resolve) => {
    resolveAnswer = resolve;
  });
  const deadlineHandle = setTimeout(() => settle(false), Math.max(1, deadlineAtMs - Date.now()));
  deadlineHandle.unref?.();
  function settle(answered: boolean): void {
    if (settled) return;
    settled = true;
    clearTimeout(deadlineHandle);
    destroy?.();
    resolveAnswer(answered);
  }
  return {
    leg: { answer, cancel: () => settle(false) },
    settle,
    attach: (destroyTransport) => {
      destroy = destroyTransport;
      // The deadline can close before a leg builds its transport, so a late arrival is torn down.
      if (settled) destroyTransport();
    },
  };
}

function probeHttpHealth(httpPort: number, deadlineAtMs: number): ProbeLeg {
  const probe = createProbeLeg(deadlineAtMs);
  // `readDaemonInfo` accepts any positive integer port, and `transport.request` throws on one out
  // of range; this leg builds detached, so the throw would reach the caller as an unhandled
  // rejection.
  void (async () => {
    try {
      const transport = await loadNodeHttpRequester('http:');
      const request = transport.request(
        // `agent: false` is load-bearing, not hygiene: since Node 19 the global agent keeps sockets
        // alive, so a pooled request would ride an idle socket from an earlier command's health read
        // instead of the FRESH connection this probe exists to make — and a half-torn-down pooled
        // socket would answer "silent", resetting a live daemon.
        { host: '127.0.0.1', port: String(httpPort), path: '/health', method: 'GET', agent: false },
        (res) => {
          // Any status is an answer: the health route is served before any request handling, so
          // reaching it proves the event loop serves fresh requests. Drain so the response cannot
          // hold the socket open past the finding.
          res.resume();
          probe.settle(true);
        },
      );
      request.on('error', () => probe.settle(false));
      probe.attach(() => request.destroy());
      request.end();
    } catch {
      probe.settle(false);
    }
  })();
  return probe.leg;
}

function probeSocketRpc(
  port: number,
  token: string,
  session: string | undefined,
  deadlineAtMs: number,
): ProbeLeg {
  const probe = createProbeLeg(deadlineAtMs);
  // The same malformed-record shape as the HTTP leg, and this one builds synchronously: a throw
  // here would escape `probeDaemonResponsive` altogether, replacing the caller's timeout error
  // with a crash from the recovery path and discarding the other leg's answer.
  let socket: net.Socket;
  try {
    socket = net.createConnection({ host: '127.0.0.1', port });
  } catch {
    probe.settle(false);
    return probe.leg;
  }
  probe.attach(() => socket.destroy());
  const request = buildLivenessProbeRequest(token, session);
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write(`${JSON.stringify(request)}\n`);
  });
  socket.on('data', (chunk) => {
    const parsed = consumeTextLines(buffer, chunk);
    buffer = parsed.buffer;
    // Any answer line counts, including an error for a probe the daemon declined: the finding is
    // that it reads and answers, not that it accepted this command.
    if (parsed.lines.length > 0) probe.settle(true);
  });
  socket.on('error', () => probe.settle(false));
  socket.on('close', () => probe.settle(false));
  return probe.leg;
}

/**
 * The probe's request: `session_list`, which derives `sessionExecutionLockExempt: true` (plus
 * lease-admission and selector-validation exemptions), so it never queues behind the session or
 * device locks the timed-out request's work may still hold. The `session` field is required on
 * the wire; an omitted one falls back to the daemon's own routing default.
 */
function buildLivenessProbeRequest(token: string, session: string | undefined): DaemonRequest {
  return {
    token,
    session: session || 'default',
    command: INTERNAL_COMMANDS.sessionList,
    positionals: [],
    flags: {},
    meta: { requestId: createRequestId() },
  };
}
