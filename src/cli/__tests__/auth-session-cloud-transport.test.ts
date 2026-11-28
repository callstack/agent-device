// Cloud login, refresh and profile requests warn before a credential goes over plain http to a host
// that is not loopback. The stored issuer is judged too, and the override covers it.

import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { beginStderrCapture, mkdtempForTestSync, type StreamCapture } from '@agent-device/test-kit';
import { loginWithDeviceAuth, resolveRemoteAuth, writeCliSession } from '../auth-session.ts';
import { CLI_SESSION_FORMAT_VERSION } from '../cli-session-format.ts';
import { resolveCloudConnectProfile } from '../connection/cloud-profile.ts';

const flags = {
  json: false,
  help: false,
  version: false,
  daemonBaseUrl: 'https://bridge.agent-device.dev',
};

let stderr: StreamCapture | undefined;
afterEach(() => {
  stderr?.restore();
});

/** A cloud that records the stderr written by the time each request reaches it. */
function recordingCloud(answer: (url: string) => unknown) {
  stderr = beginStderrCapture();
  const atSend: string[] = [];
  const fetch = async (url: URL | RequestInfo): Promise<Response> => {
    atSend.push(stderr!.read());
    return Response.json(answer(String(url)));
  };
  return { atSend, fetch };
}

function storeSession(cloudBaseUrl: string): string {
  const stateDir = mkdtempForTestSync('agent-device-cloud-transport-');
  writeCliSession({
    stateDir,
    session: {
      version: CLI_SESSION_FORMAT_VERSION,
      id: 'session-1',
      cloudBaseUrl,
      refreshCredential: 'adc_refresh_secret',
      createdAt: new Date().toISOString(),
    },
  });
  return stateDir;
}

test('login warns before the first request to a plain http cloud', async () => {
  const cloud = recordingCloud((url) =>
    url.endsWith('/start')
      ? {
          deviceCode: 'device-secret',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://cloud.example.test/authorize',
        }
      : {
          status: 'approved',
          accessToken: 'adc_agent_login',
          cliSession: { id: 'session-new', refreshCredential: 'adc_refresh_new' },
        },
  );

  await loginWithDeviceAuth({
    stateDir: mkdtempForTestSync('agent-device-cloud-transport-login-'),
    flags,
    env: { AGENT_DEVICE_CLOUD_BASE_URL: 'http://login.example.test' },
    io: {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderr: { write: () => true },
      openBrowser: async () => {},
      fetch: cloud.fetch,
    },
  });

  assert.equal(cloud.atSend.length, 2);
  assert.match(cloud.atSend[0]!, /http:\/\/login\.example\.test are sent in cleartext/);
  assert.equal(cloud.atSend[1], cloud.atSend[0], 'one warning per origin');
});

test.each([
  ['warns about', 'http://issuer.example.test', {}, /issuer\.example\.test are sent in cleartext/],
  [
    'honors the override for',
    'http://allowed-issuer.example.test',
    { AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT: '1' },
    /^$/,
  ],
] as const)('a refresh %s the stored plain http issuer', async (_label, issuer, env, expected) => {
  const cloud = recordingCloud(() => ({ accessToken: 'adc_agent_fresh' }));

  await resolveRemoteAuth({
    command: 'snapshot',
    flags,
    stateDir: storeSession(issuer),
    allowInteractiveLogin: false,
    env,
    io: { fetch: cloud.fetch },
  });

  assert.equal(cloud.atSend.length, 1);
  assert.match(cloud.atSend[0]!, expected);
});

test('the profile request warns before it sends the access token', async () => {
  const cloud = recordingCloud(() => ({}));

  await assert.rejects(
    resolveCloudConnectProfile({
      flags,
      stateDir: mkdtempForTestSync('agent-device-cloud-transport-profile-'),
      cwd: process.cwd(),
      env: {
        AGENT_DEVICE_CLOUD_BASE_URL: 'http://profile.example.test',
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'adc_live_secret',
      },
      fetchImpl: cloud.fetch,
    }),
    /missing profile/,
  );

  assert.equal(cloud.atSend.length, 1);
  assert.match(cloud.atSend[0]!, /http:\/\/profile\.example\.test are sent in cleartext/);
  assert.doesNotMatch(cloud.atSend[0]!, /adc_live_secret/);
});
