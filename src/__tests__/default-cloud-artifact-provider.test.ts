import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, test } from 'vitest';
import { createDefaultCloudArtifactProvider } from '../default-cloud-artifact-provider.ts';
import { withCommandExecutorOverride } from '../utils/exec.ts';

let activeServer: http.Server | undefined;

afterEach(async () => {
  if (!activeServer) return;
  await new Promise<void>((resolve, reject) => {
    activeServer?.close((error) => (error ? reject(error) : resolve()));
  });
  activeServer = undefined;
});

test('default cloud artifact provider maps BrowserStack historical sessions from env credentials', async () => {
  const server = await startSessionDetailsServer();
  const provider = createDefaultCloudArtifactProvider({
    BROWSERSTACK_USERNAME: 'user',
    BROWSERSTACK_ACCESS_KEY: 'key',
    BROWSERSTACK_SESSION_DETAILS_ENDPOINT: `${server.url}/sessions`,
  });

  const result = await provider.listCloudArtifacts?.({
    provider: 'browserstack',
    providerSessionId: 'wd-1',
  });

  assert.equal(result?.status, 'ready');
  assert.deepEqual(
    result?.cloudArtifacts.map((artifact) => artifact.kind),
    ['video', 'appium-log', 'device-log', 'provider-session', 'provider-session'],
  );
});

test('default cloud artifact provider maps AWS Device Farm historical sessions via aws cli', async () => {
  const calls: string[][] = [];
  const provider = createDefaultCloudArtifactProvider({});
  await withCommandExecutorOverride(
    async (cmd, args) => {
      calls.push([cmd, ...args]);
      return {
        stdout: JSON.stringify({
          artifacts: [
            {
              name: args.includes('LOG') ? 'Appium Server Output' : 'Video',
              type: args.includes('LOG') ? 'APPIUM_SERVER_OUTPUT' : 'VIDEO',
              extension: args.includes('LOG') ? 'log' : 'mp4',
              url: 'https://aws.example/artifact',
            },
          ],
        }),
        stderr: '',
        exitCode: 0,
      };
    },
    async () => {
      const result = await provider.listCloudArtifacts?.({
        provider: 'aws-device-farm',
        providerSessionId: 'arn:aws:devicefarm:us-west-2:123:session/project/session/00000',
      });
      assert.equal(result?.status, 'ready');
      assert.deepEqual(
        result?.cloudArtifacts.map((artifact) => artifact.kind),
        ['video', 'appium-log'],
      );
    },
  );

  assert.equal(calls[0]?.includes('us-west-2'), true);
  assert.equal(calls[1]?.includes('LOG'), true);
});

test('default cloud artifact provider ignores lookups without a provider session id', async () => {
  const provider = createDefaultCloudArtifactProvider({});

  const result = await provider.listCloudArtifacts?.({
    provider: 'browserstack',
  });

  assert.equal(result, undefined);
});

test('default cloud artifact provider does not treat broad aws as a provider name', async () => {
  const provider = createDefaultCloudArtifactProvider({});

  const result = await provider.listCloudArtifacts?.({
    provider: 'aws',
    providerSessionId: 'arn:aws:devicefarm:us-west-2:123:session/project/session/00000',
  });

  assert.equal(result, undefined);
});

async function startSessionDetailsServer(): Promise<{ url: string }> {
  const server = http.createServer((req, res) => respond(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  activeServer = server;
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}` };
}

function respond(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' && req.url === '/sessions/wd-1.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        automation_session: {
          video_url: 'https://browserstack.example/video.mp4',
          appium_logs_url: 'https://browserstack.example/appium.log',
          device_logs_url: 'https://browserstack.example/device.log',
          browser_url: 'https://browserstack.example/dashboard',
          public_url: 'https://browserstack.example/public',
        },
      }),
    );
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}
