import type { DaemonWireRequest } from '@agent-device/contracts/command';
import net from 'node:net';
import { INTERNAL_COMMANDS } from '@agent-device/command-registry/catalog';
import { createRequestId } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';
import { loadNodeHttpRequester, consumeTextLines } from '@agent-device/host-kit/transport';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import type {
  DaemonProbeVerdict,
  LoopbackConnectDenial,
  LoopbackTransport,
} from './daemon-client-loopback-probe.ts';

// The post-timeout liveness probe (#3177): the question that a daemon reset may no longer assume. The
// daemon owns request-scoped recovery, so a reset is only justified for a daemon that answers
// nothing, and it must be asked on FRESH connections — the timed-out connection is the one the
// transport already tore down to cancel that request.

// One probe window. A caller of a reset-eligible timed-out request can pay three of them, plus two
// short gaps, before its error lands. One window stays an order of magnitude under the narrowest
// reset-eligible envelope (pinned in `__tests__/daemon-client-liveness-probe.test.ts`): a wrong
// "unresponsive" verdict kills a live shared daemon.
export const LIVENESS_PROBE_BUDGET_MS = 1_000;
const UNRESPONSIVE_PROBES = 3;
const UNRESPONSIVE_PROBE_GAP_MS = 200;

/**
 * The one verdict that may end a daemon for answering nothing: every probe of several missed. Each
 * caller that retires on silence asks here, so the evidence is the same on every path. A probe the
 * HOST refused stops the round at once: a refusal is not a missed probe, and repeating it cannot
 * turn one into an answer about the daemon.
 */
export async function answersLivenessProbe(
  info: DaemonInfo,
  params: Readonly<{ session?: string }> = {},
): Promise<DaemonProbeVerdict> {
  for (let probe = 1; probe <= UNRESPONSIVE_PROBES; probe += 1) {
    const verdict = await probeDaemonResponsive(info, params);
    if (verdict.reachable || verdict.denial) return verdict;
    if (probe < UNRESPONSIVE_PROBES) await sleep(UNRESPONSIVE_PROBE_GAP_MS);
  }
  return { reachable: false };
}

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
 *
 * A verdict that is neither an answer nor a refusal is the only one that says the daemon served
 * nothing. A connect the host refused (EPERM or EACCES under a sandbox around this client) carries
 * that refusal instead, so no caller reads a daemon it cannot reach as an unresponsive one.
 */
export async function probeDaemonResponsive(
  info: DaemonInfo,
  params: Readonly<{ session?: string }> = {},
): Promise<DaemonProbeVerdict> {
  // The verdict's shape and the errno that names a refusal belong to the probe module. It is loaded
  // here, not at module scope: this file is a lazy path itself (`daemon-client-timeout.ts` imports it
  // on a timeout) and no client entry surface pays for a verdict it only reads on a probe.
  const { readLoopbackConnectDenial } = await import('./daemon-client-loopback-probe.ts');
  const deadlineAtMs = Date.now() + LIVENESS_PROBE_BUDGET_MS;
  const legs: ProbeLeg[] = [];
  if (info.httpPort) legs.push(probeHttpHealth(info.httpPort, deadlineAtMs));
  if (info.port) legs.push(probeSocketRpc(info.port, info.token, params.session, deadlineAtMs));
  if (legs.length === 0) return { reachable: false };
  const silent: SilentProbeLeg[] = [];
  return await new Promise<DaemonProbeVerdict>((resolve) => {
    let outstanding = legs.length;
    const settle = (answer: ProbeLegAnswer): void => {
      if (answer.answered) {
        for (const leg of legs) leg.cancel();
        resolve({ reachable: true });
        return;
      }
      silent.push(answer);
      if (--outstanding > 0) return;
      // Both legs answered nothing. A refusal among them withholds the unresponsive verdict: this
      // client cannot read the other leg's silence as proof the daemon is hung once the host has
      // shown it refuses this daemon's endpoint. Both legs are waited for rather than settled on the
      // first refusal, because an answer on either one is the better finding and the deadline bounds
      // the wait either way.
      const denial = silent
        .map((leg) => readLoopbackConnectDenial(leg.errno, leg.transport, leg.port))
        .find((verdict): verdict is LoopbackConnectDenial => verdict !== undefined);
      resolve(denial ? { reachable: false, denial } : { reachable: false });
    };
    for (const leg of legs) {
      leg.answer.then(settle, () => settle({ ...leg.endpoint, answered: false }));
    }
  });
}

/** The endpoint family and port one liveness leg probed. */
type ProbeEndpoint = Readonly<{ transport: LoopbackTransport; port: number }>;

/** One leg's answer: it served, or it did not, carrying the errno that refused its connect. */
type ProbeLegAnswer = ProbeEndpoint & Readonly<{ answered: boolean; errno?: string }>;

/** A leg that did not answer, kept so a refusal among them can be named at the end. */
type SilentProbeLeg = ProbeEndpoint & Readonly<{ errno?: string }>;

type ProbeLeg = Readonly<{
  answer: Promise<ProbeLegAnswer>;
  endpoint: ProbeEndpoint;
  cancel: () => void;
}>;

function createProbeLeg(
  endpoint: ProbeEndpoint,
  deadlineAtMs: number,
): {
  leg: ProbeLeg;
  settle: (answered: boolean, errno?: string) => void;
  attach: (destroyTransport: () => void) => void;
} {
  let settled = false;
  let destroy: (() => void) | undefined;
  const { promise: answer, resolve: resolveAnswer } = Promise.withResolvers<ProbeLegAnswer>();
  const deadlineHandle = setTimeout(() => settle(false), Math.max(1, deadlineAtMs - Date.now()));
  deadlineHandle.unref?.();
  function settle(answered: boolean, errno?: string): void {
    if (settled) return;
    settled = true;
    clearTimeout(deadlineHandle);
    destroy?.();
    resolveAnswer({ ...endpoint, answered, ...(errno === undefined ? {} : { errno }) });
  }
  return {
    leg: { answer, endpoint, cancel: () => settle(false) },
    settle,
    attach: (destroyTransport) => {
      destroy = destroyTransport;
      // The deadline can close before a leg builds its transport, so a late arrival is torn down.
      if (settled) destroyTransport();
    },
  };
}

function probeHttpHealth(httpPort: number, deadlineAtMs: number): ProbeLeg {
  const probe = createProbeLeg({ transport: 'http', port: httpPort }, deadlineAtMs);
  // This leg builds detached. Catch transport-construction errors here so they settle the probe.
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
      request.on('error', (error: NodeJS.ErrnoException) => probe.settle(false, error.code));
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
  const probe = createProbeLeg({ transport: 'socket', port }, deadlineAtMs);
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
  socket.on('error', (error: NodeJS.ErrnoException) => probe.settle(false, error.code));
  socket.on('close', () => probe.settle(false));
  return probe.leg;
}

/**
 * The probe's request: `session_list`, which derives `sessionExecutionLockExempt: true` (plus
 * lease-admission and selector-validation exemptions), so it never queues behind the session or
 * device locks the timed-out request's work may still hold. The `session` field is required on
 * the wire; an omitted one falls back to the daemon's own routing default.
 */
function buildLivenessProbeRequest(token: string, session: string | undefined): DaemonWireRequest {
  return {
    token,
    session: session || 'default',
    command: INTERNAL_COMMANDS.sessionList,
    positionals: [],
    flags: {},
    meta: { requestId: createRequestId() },
  };
}
