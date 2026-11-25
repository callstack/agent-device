import net from 'node:net';

/** How long one reachability probe of the local daemon's loopback endpoint may take. */
export const LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS = 500;

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
 * One connect to one loopback port. A refusal from the host is reported as a denial: it is not an
 * answer from the daemon, and it is the only reachability evidence a sandboxed client can be refused.
 */
export function probeLoopbackPort(
  port: number | undefined,
  transport: LoopbackTransport,
  timeoutMs = LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS,
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
    socket.setTimeout(Math.min(LOCAL_DAEMON_HEALTHCHECK_TIMEOUT_MS, Math.ceil(timeoutMs)));
    socket.on('timeout', () => {
      finish({ reachable: false });
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const denial = readLoopbackConnectDenial(error.code, transport, port);
      finish(denial ? { reachable: false, denial } : { reachable: false });
    });
  });
}
