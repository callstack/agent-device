import net from 'node:net';
import { settleWithin } from '@agent-device/host-kit/settle-within';
import { loadNodeHttpRequester } from '@agent-device/host-kit/transport';

// One reachability probe of one daemon endpoint, and the verdict it answers with. The transport owns
// making requests; this module owns what an endpoint's silence MEANS, because a connect the HOST
// refused (EPERM or EACCES under a sandbox around this client) is evidence about this client and not
// evidence about the daemon. Nothing here is reached by a static value import: its one caller loads it
// with a function-scoped `await import` (`probeTransportEndpoint` in `daemon-client-transport.ts`), so
// no client entry surface evaluates a module for a verdict it only reads on a probe
// (`scripts/__tests__/eager-closure-budgets.ts`).

/** How long one loopback connect may take before the probe calls it silent. */
const LOOPBACK_CONNECT_TIMEOUT_MS = 500;

/** The errnos that say the host refused the connect itself, as a sandbox around the caller does. */
const LOOPBACK_DENIED_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES']);

/** The transport, or the endpoint family, one probe or refusal names. */
export type LoopbackTransport = 'socket' | 'http';

/**
 * One loopback connect this client was refused, with the endpoint it aimed at. A refusal is not an
 * answer from the daemon: nothing says whether the daemon behind that port is serving.
 */
export type LoopbackConnectDenial = Readonly<{
  errno: 'EPERM' | 'EACCES';
  transport: LoopbackTransport;
  port: number;
}>;

/**
 * What a reachability probe of one daemon found. `denial` is present only when nothing answered AND
 * the host refused the connect, which is what a sandbox around this client does.
 */
export type DaemonProbeVerdict = Readonly<{
  reachable: boolean;
  denial?: LoopbackConnectDenial;
}>;

/** One HTTP reachability probe: the health endpoint to ask, the auth it needs, and its time budget. */
export type HttpEndpointProbe = Readonly<{
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
}>;

/**
 * Whether an errno from a loopback connect says the host refused it, as a sandbox around this client
 * does. A refusal is not an answer from the daemon: unlike a reset or a timeout, it says nothing about
 * whether the daemon behind that port serves.
 */
export function readLoopbackConnectDenial(
  errno: string | undefined,
  transport: LoopbackTransport,
  port: number,
): LoopbackConnectDenial | undefined {
  if (!errno || !LOOPBACK_DENIED_CODES.has(errno)) return undefined;
  return { errno: errno as LoopbackConnectDenial['errno'], transport, port };
}

/**
 * One connect to one loopback port. A refusal from the host is reported as a denial, not as an answer
 * from the daemon: nothing says whether the daemon behind that port serves.
 */
export function probeLoopbackPort(
  port: number | undefined,
  transport: LoopbackTransport,
  timeoutMs = LOOPBACK_CONNECT_TIMEOUT_MS,
): Promise<DaemonProbeVerdict> {
  if (!port || timeoutMs <= 0) return Promise.resolve({ reachable: false });
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      finish({ reachable: true });
    });
    const finish = (verdict: DaemonProbeVerdict) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(verdict);
    };
    socket.setTimeout(Math.min(LOOPBACK_CONNECT_TIMEOUT_MS, Math.ceil(timeoutMs)));
    socket.on('timeout', () => {
      finish({ reachable: false });
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const denial = readLoopbackConnectDenial(error.code, transport, port);
      finish(denial ? { reachable: false, denial } : { reachable: false });
    });
  });
}

/**
 * Whether the HOST refuses this client's connects to the endpoints one registration advertises.
 *
 * The question a retirement asks, and it is narrower than reachability: whether this client is allowed
 * to reach that endpoint at all, not whether the daemon answers there. So each advertised port gets ONE
 * bare loopback connect — no health request, no retries, no waits. A sandbox that blocks local ports
 * refuses the connect itself (EPERM or EACCES), which is what this answers; a daemon that is merely busy
 * or hung answers with silence, and silence is not evidence about the host.
 *
 * A remote registration is answered `undefined` without a connect: a refusal to reach a remote host is
 * not the loopback denial this verdict names.
 */
export async function readAdvertisedConnectDenial(
  advertised: Readonly<{
    port?: number;
    httpPort?: number;
    remote: boolean;
  }>,
): Promise<LoopbackConnectDenial | undefined> {
  if (advertised.remote) return undefined;
  const endpoints: ReadonlyArray<readonly [number | undefined, LoopbackTransport]> = [
    [advertised.port, 'socket'],
    [advertised.httpPort, 'http'],
  ];
  // Both connects run at once: a guard a takeover waits on costs ONE connect window, not one per
  // advertised port, whatever the host does to a connect it neither allows nor answers.
  const verdicts = await Promise.all(
    endpoints.map(([port, transport]) => (port ? probeLoopbackPort(port, transport) : undefined)),
  );
  // The first refusal in endpoint order is the whole answer: this client cannot read the other
  // endpoint's silence as permission to retire what it cannot see.
  for (const verdict of verdicts) if (verdict?.denial) return verdict.denial;
  return undefined;
}

/**
 * One health request to one advertised endpoint, as a reachability verdict.
 *
 * The request is made on a FRESH connection: `agent: false` is load-bearing, not hygiene. Since Node
 * 19 the global agent keeps sockets alive, so a pooled request would ride an idle socket from an
 * earlier command rather than proving that a connect to this daemon is allowed NOW — which is the only
 * thing that can tell a refused endpoint from a silent one. The time budget is ABSOLUTE and covers
 * loading the requester, so a late loader never opens a request the probe already gave up on. That
 * wait goes through `settleWithin`, the one deadline primitive: it clears its own timer on every settle
 * path, so a probe that never asks a question leaves no timer behind.
 *
 * A response answers the probe. Only a connect the HOST refused to a LOOPBACK endpoint carries a
 * denial: a refusal is not an answer from the daemon, and a refusal on a remote endpoint is not the
 * loopback denial this verdict names.
 */
export async function probeHttpEndpoint(probe: HttpEndpointProbe): Promise<DaemonProbeVerdict> {
  const url = new URL(probe.endpoint);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (probe.timeoutMs <= 0) return { reachable: false };
  const deadlineAtMs = performance.now() + probe.timeoutMs;
  const loaded = await settleWithin(
    () => loadNodeHttpRequester(url, { subject: 'Daemon health probe URL' }),
    probe.timeoutMs,
  );
  if (loaded.kind === 'deadline') return { reachable: false };
  // What the loader spent is gone from the request's window: the budget belongs to the probe, not to
  // each step inside it.
  const requestTimeoutMs = deadlineAtMs - performance.now();
  if (requestTimeoutMs <= 0) return { reachable: false };
  const timeoutSignal = AbortSignal.timeout(Math.ceil(requestTimeoutMs));
  return await new Promise((resolve) => {
    const request = loaded.value.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: requestTimeoutMs,
        agent: false,
        signal: timeoutSignal,
        headers: probe.headers,
      },
      (response) => {
        // Any status under 500 is an answer from the daemon. The body is irrelevant to reachability,
        // so it is drained and dropped: an undrained response holds its socket open past the finding.
        response.resume();
        resolve({ reachable: (response.statusCode ?? 500) < 500 });
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve({ reachable: false });
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      const denial = loopback ? readLoopbackConnectDenial(error.code, 'http', port) : undefined;
      resolve(denial ? { reachable: false, denial } : { reachable: false });
    });
    request.end();
  });
}
