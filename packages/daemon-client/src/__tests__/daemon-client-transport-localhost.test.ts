// A remote daemon URL that names `localhost` is admitted by name, so every send to it must connect
// only to a loopback address, whatever the resolver answers.

import { afterEach, expect, test, vi } from 'vitest';
import dns from 'node:dns';
import http from 'node:http';
import { isCredentialTransportRefusal } from '@agent-device/contracts/credential-transport';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  bindTestCommandHost,
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import {
  probeDaemonReachability,
  readRemoteDaemonHealth,
  sendRequest,
} from '../daemon-client-transport.ts';

bindTestCommandHost();

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => closeLoopbackServer(server)));
});

test('a localhost that resolves off loopback receives no health, probe or RPC request', async () => {
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.end('{}');
  });
  servers.push(server);
  const info = {
    token: 'daemon-secret',
    pid: 0,
    baseUrl: `http://localhost:${await listenOnLoopback(server)}`,
  };
  // `0.0.0.0` reaches this machine's listener and is not a loopback address.
  vi.spyOn(dns, 'lookup').mockImplementation(((
    _hostname: string,
    options: dns.LookupOptions,
    callback: (...answer: unknown[]) => void,
  ) => {
    if (options.all) callback(null, [{ address: '0.0.0.0', family: 4 }]);
    else callback(null, '0.0.0.0', 4);
  }) as typeof dns.lookup);

  await expect(readRemoteDaemonHealth(info, 2_000)).rejects.toSatisfy(isCredentialTransportRefusal);
  expect(await probeDaemonReachability(info, 'http', 2_000)).toMatchObject({ reachable: false });
  await expect(
    sendRequest(
      info,
      { token: info.token, session: 'default', command: 'devices', positionals: [], flags: {} },
      'http',
      resolveDaemonPaths(mkdtempForTestSync('daemon-client-localhost-')),
      2_000,
      { host: createTestHostEnvironment() },
    ),
  ).rejects.toSatisfy(isCredentialTransportRefusal);

  expect(received).toEqual([]);
});
