import { expect, test } from 'vitest';
import {
  buildRemoteTempArtifactPath,
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
  isRemoteTempArtifactPath,
} from '@agent-device/contracts/daemon-http';
import { restrictRemoteHttpRequest } from './http-authorization.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';

function restrict(request: Omit<DaemonRequest, 'token' | 'session'>) {
  return restrictRemoteHttpRequest(
    { token: 'test', session: 'owned', ...request },
    false,
    DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
  );
}

test.each(['open', 'session_save_script'])(
  'public %s allocates its script output on the daemon',
  (command) => {
    const active = command === 'session_save_script';
    const result = restrict({
      command,
      positionals: [],
      flags: active ? {} : { saveScript: true },
      meta: { clientArtifactPaths: { savedScript: '/caller/out.ad' } },
    });
    const allocated = active ? result.positionals[0] : result.flags?.saveScript;
    expect(typeof allocated).toBe('string');
    expect(result.internal?.remoteScriptDelivery).toBe(true);
    expect(isRemoteTempArtifactPath(allocated as string, 'script', '.ad')).toBe(true);
    expect(result.meta?.clientArtifactPaths?.savedScript).toBe('/caller/out.ad');
  },
);

test.each([
  ...['replay', 'close'].map((command) => ({
    command,
    positionals: [],
    flags: { saveScript: buildRemoteTempArtifactPath('script', '.ad') },
  })),
  { command: 'open', positionals: [], flags: { saveScript: '/host/private.ad' } },
  { command: 'session_save_script', positionals: ['/host/private.ad'] },
  { command: 'session_save_script', positionals: [], input: { path: '/host/private.ad' } },
  { command: 'open', positionals: [], input: { saveScript: true } },
])('public script publication refuses host paths and alternate input carriers', (request) => {
  expect(() => restrict(request)).toThrowError(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      details: expect.objectContaining({ reason: 'REMOTE_HOST_INPUT_DENIED' }),
    }),
  );
});
