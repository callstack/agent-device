import net from 'node:net';
import { INTERNAL_COMMANDS } from '@agent-device/command-registry/catalog';
import { createRequestId } from '@agent-device/host-kit/diagnostics';
import { loadNodeHttpRequester, consumeTextLines } from '@agent-device/host-kit/transport';
import type { DaemonRequest } from '../daemon/daemon-request.ts';
import type { DaemonInfo } from './daemon-client-metadata.ts';

// The post-timeout liveness probe (#3177): the question a daemon reset may no longer assume.
// The daemon owns request-scoped recovery — destroying the timed-out connection cancels exactly
// that request — so a reset is only justified for a daemon that answers nothing. The probe asks
// on FRESH connections: the request that timed out proves nothing about the next round trip, and
// a probe on the old connection would be canceled by the same teardown that recovers it.

// The probe's window, shared by both legs: the extra latency a caller of a reset-eligible
// timed-out request can pay before its error lands. It sits beside the transport's
// `LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS` (same endpoints, asked before an RPC) and stays an order
// of magnitude under the narrowest reset-eligible envelope — pinned against the registry's 90s
// default in `__tests__/daemon-client-liveness-probe.test.ts` — because a wrong "unresponsive"
// verdict here kills a live shared daemon.
export const LIVENESS_PROBE_BUDGET_MS = 1_000;

/**
 * Whether this local daemon answers anything within the probe budget: its HTTP health route, or
 * one sessionless RPC on its socket. An answer on either leg proves the daemon's event loop serves
 * fresh requests; a refused or silent leg answers "not this one", not "not the daemon".
 *
 * Both legs run CONCURRENTLY against one shared deadline because the finding is per-daemon, not
 * per-leg: a sequential probe lets a silently-hanging leg spend the whole window and veto the
 * other leg's live answer — resetting a daemon the other transport proves alive. The first
 * AFFIRMATIVE is unrevocable, so it settles the probe at once instead of making the caller's
 * error wait on a leg that has nothing left to say. Each leg settles no later than the ABSOLUTE
 * deadline (not the transports' own idle timeouts, which a trickling endpoint resets forever),
 * so the negative verdict always arrives inside the window. A leg never rejects: a probe that
 * cannot ask is an endpoint that did not answer. `session` rides along so an isolation-scoped
 * daemon routes the probe like the request it follows.
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

// One leg: settles once, no later than its deadline, and tears its transport down either way. The
// deadline is ABSOLUTE — the transports' own idle timeouts never fire while an endpoint keeps
// trickling bytes — so the caller's error always lands inside the probe window.
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
      // The deadline can close before a leg finishes building its transport (the HTTP leg awaits
      // its requester), so a late arrival is torn down on the spot.
      if (settled) destroyTransport();
    },
  };
}

function probeHttpHealth(httpPort: number, deadlineAtMs: number): ProbeLeg {
  const probe = createProbeLeg(deadlineAtMs);
  void (async () => {
    const transport = await loadNodeHttpRequester('http:');
    const request = transport.request(
      { host: '127.0.0.1', port: String(httpPort), path: '/health', method: 'GET' },
      (res) => {
        // Any status is an answer: the health route is served by the daemon's own event loop
        // before any request handling, so reaching it at all proves it serves fresh requests.
        // Drain so the response cannot hold the probe's socket open past its finding.
        res.resume();
        probe.settle(true);
      },
    );
    request.on('error', () => probe.settle(false));
    probe.attach(() => request.destroy());
    request.end();
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
  const socket = net.createConnection({ host: '127.0.0.1', port });
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
