import { buildDaemonRpcRequest } from '@agent-device/contracts/lease-scope';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, vi } from 'vitest';
import { createAgentDeviceClient } from '@agent-device/client';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { assertRpcOk } from './assertions.ts';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';
import { createProviderScenarioProxy } from './harness-proxy.ts';
import { runCliCapture } from '../../../src/__tests__/cli-capture.ts';
import { installIsolatedCliTestEnv } from '../../../src/__tests__/cli-test-env.ts';
import { createCommandToolExecutor } from '../../../src/mcp/command-tools.ts';

/** A script version the daemon writes in its private directory. */
function isDaemonScriptPath(file: fs.PathLike): boolean {
  return String(file).includes(`${path.sep}remote-scripts${path.sep}`);
}

test('a remote recording keeps the caller script current and close writes the final script', async () => {
  await withProviderScenarioResource(
    () => createAndroidSettingsWorld({ nativeTextInjection: true }),
    async (world) => {
      const root = mkdtempForTestSync('remote-script-provider-');
      const destination = path.join(root, 'caller', 'journey.ad');
      fs.mkdirSync(path.dirname(destination));
      fs.writeFileSync(destination, 'an earlier recording\n');
      const proxy = await createProviderScenarioProxy(world.daemon, {
        clientToken: 'script-client',
      });
      const client = createAgentDeviceClient({
        daemonBaseUrl: proxy.baseUrl,
        daemonAuthToken: 'script-client',
        session: 'script-author',
        stateDir: path.join(root, 'client-state'),
      });
      try {
        await assert.rejects(
          client.apps.open({ app: 'settings', saveScript: destination, ...world.selection }),
          (error: unknown) => {
            assert.equal(
              (error as { details?: { reason?: string } }).details?.reason,
              'script_target_exists',
            );
            return true;
          },
        );
        assert.equal(fs.readFileSync(destination, 'utf8'), 'an earlier recording\n');
        await client.apps.open({
          app: 'settings',
          saveScript: destination,
          force: true,
          ...world.selection,
        });
        assert.match(fs.readFileSync(destination, 'utf8'), /^open /m);

        await client.interactions.fill({
          selector: 'id="com.android.settings:id/search"',
          text: 'fixture-input',
          recordAs: 'SEARCH_TERM',
          ...world.selection,
        });
        await client.command.wait({ selector: 'label="Apps"', ...world.selection });
        const current = fs.readFileSync(destination, 'utf8');
        assert.match(current, /agent-device:target-v1/);
        assert.ok(current.includes('${SEARCH_TERM}'));
        assert.equal(current.includes('fixture-input'), false);
        assert.equal(current.includes(root), false);
        assert.doesNotMatch(current, /^close/m);

        const reply = proxy.forwarded.filter((r) => r.route === '/rpc').at(-1);
        assert.ok(reply);
        const raw = JSON.parse(reply.responseBody).result.data;
        assert.notEqual(raw.savedScript, destination);
        const artifact = raw.artifacts.find(
          (a: { artifactType: string }) => a.artifactType === 'session-script',
        );
        assert.ok(artifact?.artifactId);
        const served = proxy.forwarded.find((r) => r.route === `/artifacts/${artifact.artifactId}`);
        assert.equal(served?.responseBody, current);

        await client.sessions.close();
        const final = fs.readFileSync(destination, 'utf8');
        assert.ok(final.startsWith(current.trimEnd()));
        assert.match(final, /^close/m);

        const replay = await client.replay.run({
          path: destination,
          env: ['SEARCH_TERM=second-input'],
          ...world.selection,
        });
        assert.equal(replay.sessionActive, false);
        world.assertNoHostAdbCalls();
      } finally {
        await proxy.close();
      }
    },
  );
}, 20_000);

test('raw remote RPC without a caller path receives script versions by artifact ID', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const proxy = await createProviderScenarioProxy(world.daemon, { clientToken: 'raw-client' });
    const rpc = async (
      command: string,
      positionals: string[],
      flags: DaemonWireRequest['flags'],
      meta?: DaemonWireRequest['meta'],
    ) => {
      const response = await fetch(`${proxy.baseUrl}/rpc`, {
        method: 'POST',
        headers: { authorization: 'Bearer raw-client', 'content-type': 'application/json' },
        body: JSON.stringify(
          buildDaemonRpcRequest(
            { token: 'raw-client', session: 'raw-author', command, positionals, flags, meta },
            { id: command, includeTokenParam: false },
          ),
        ),
      });
      const reply = await response.json();
      assert.equal(response.status, reply.error ? 400 : 200);
      return reply.result ?? { ok: false, error: reply.error.data };
    };
    type ScriptArtifact = {
      artifactType: string;
      artifactId: string;
      path?: string;
      scriptPublicationId?: string;
    };
    const scriptArtifact = (data: { artifacts: ScriptArtifact[] }) =>
      data.artifacts.find((entry) => entry.artifactType === 'session-script');
    const download = async (data: { artifacts: ScriptArtifact[] }) => {
      const artifact = scriptArtifact(data);
      assert.ok(artifact?.artifactId);
      assert.equal(artifact.path, undefined);
      const url = `${proxy.baseUrl}/artifacts/${artifact.artifactId}`;
      assert.equal((await fetch(url)).status, 401);
      const downloaded = await fetch(url, { headers: { authorization: 'Bearer raw-client' } });
      assert.equal(downloaded.status, 200);
      return await downloaded.text();
    };
    try {
      const flags = { ...world.selection, saveScript: true };
      const unnamed = await rpc('open', ['settings'], flags);
      assert.equal(unnamed.error?.details?.reason, 'REMOTE_HOST_INPUT_DENIED');
      const scriptPublicationId = crypto.randomUUID();
      const opened = await rpc('open', ['settings'], flags, { scriptPublicationId });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      assert.match(await download(opened.data), /^open /m);
      assert.equal(opened.data.scriptPublicationId, scriptPublicationId);
      assert.equal(scriptArtifact(opened.data)?.scriptPublicationId, scriptPublicationId);

      const published = await rpc('session_save_script', [], {});
      assert.equal(published.ok, false);
      assert.equal(published.error.details.reason, 'REMOTE_HOST_INPUT_DENIED');

      const closed = await rpc('close', [], {});
      assert.equal(closed.ok, true, JSON.stringify(closed));
      assert.match(await download(closed.data), /^close/m);
      assert.equal(closed.data.scriptPublicationId, scriptPublicationId);
      assert.equal(scriptArtifact(closed.data)?.scriptPublicationId, scriptPublicationId);
      world.assertNoHostAdbCalls();
    } finally {
      await proxy.close();
    }
  });
}, 20_000);

test('a failed script write keeps the action successful and discloses the delivery failure', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const proxy = await createProviderScenarioProxy(world.daemon, { clientToken: 'raw-client' });
    const realLinkSync = fs.linkSync;
    const linkSpy = vi.spyOn(fs, 'linkSync');
    try {
      assertRpcOk(
        await proxy.callCommand(
          'raw-client',
          'open',
          ['settings'],
          { ...world.selection, saveScript: true },
          { meta: { scriptPublicationId: crypto.randomUUID() } },
        ),
      );
      linkSpy.mockImplementation((existing, destination) => {
        if (isDaemonScriptPath(destination)) {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return realLinkSync(existing, destination);
      });
      const failed = assertRpcOk<{
        artifacts?: { artifactType?: string }[];
        scriptDeliveryFailure?: { reason: string; message: string; hint: string };
        warnings?: string[];
      }>(await proxy.callCommand('raw-client', 'wait', ['label="Apps"'], world.selection));
      assert.equal(failed.scriptDeliveryFailure?.reason, 'script_delivery_failed');
      assert.doesNotMatch(JSON.stringify(failed), /disk full|remote-scripts/);
      assert.ok(
        failed.warnings?.some((warning) => warning.includes(failed.scriptDeliveryFailure!.hint)),
      );
      assert.equal(
        failed.artifacts?.some((artifact) => artifact.artifactType === 'session-script') ?? false,
        false,
      );
      // A digest response narrows the command's result but keeps the delivery failure.
      const digest = assertRpcOk<{
        nodeCount?: number;
        scriptDeliveryFailure?: { reason: string };
      }>(
        await proxy.callCommand('raw-client', 'snapshot', [], world.selection, {
          meta: { responseLevel: 'digest' },
        }),
      );
      assert.equal(typeof digest.nodeCount, 'number');
      assert.equal(digest.scriptDeliveryFailure?.reason, 'script_delivery_failed');

      linkSpy.mockRestore();
      const delivered = assertRpcOk<{
        artifacts: { artifactType?: string; scriptRevision?: number }[];
      }>(await proxy.callCommand('raw-client', 'wait', ['label="Apps"'], world.selection));
      assert.equal(
        delivered.artifacts.find((artifact) => artifact.artifactType === 'session-script')
          ?.scriptRevision,
        2,
      );
      assertRpcOk(await proxy.callCommand('raw-client', 'close'));
    } finally {
      linkSpy.mockRestore();
      await proxy.close();
    }
  });
}, 20_000);

test('a failed final write keeps the close and the client forgets the recording', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const root = mkdtempForTestSync('remote-script-close-');
    const destination = path.join(root, 'journey.ad');
    const stateDir = path.join(root, 'client-state');
    const proxy = await createProviderScenarioProxy(world.daemon, { clientToken: 'script-client' });
    const client = createAgentDeviceClient({
      daemonBaseUrl: proxy.baseUrl,
      daemonAuthToken: 'script-client',
      session: 'close-failure',
      stateDir,
    });
    const realLinkSync = fs.linkSync;
    const linkSpy = vi.spyOn(fs, 'linkSync');
    try {
      await client.apps.open({ app: 'settings', saveScript: destination, ...world.selection });
      const opened = fs.readFileSync(destination, 'utf8');
      linkSpy.mockImplementation((existing, target) => {
        if (isDaemonScriptPath(target)) {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return realLinkSync(existing, target);
      });

      const closeResult = await client.sessions.close();

      const reply = proxy.forwarded.filter((r) => r.route === '/rpc').at(-1);
      assert.ok(reply);
      const closed = JSON.parse(reply.responseBody).result;
      assert.equal(closed.ok, true);
      assert.equal(closed.data.scriptDeliveryFailure.reason, 'script_delivery_failed');
      assert.doesNotMatch(reply.responseBody, /disk full/);
      assert.ok(
        closed.data.warnings.some((warning: string) =>
          warning.includes(closed.data.scriptDeliveryFailure.hint),
        ),
      );
      // The SDK result carries the same typed failure and warning the wire answers, so a caller that
      // never reads stdout sees the stale file.
      assert.deepEqual(closeResult.scriptDeliveryFailure, closed.data.scriptDeliveryFailure);
      assert.ok(
        closeResult.warnings?.some((warning) =>
          warning.includes(closed.data.scriptDeliveryFailure.hint),
        ),
        JSON.stringify(closeResult.warnings),
      );
      assert.equal(fs.readFileSync(destination, 'utf8'), opened);
      const records = path.join(stateDir, 'remote-connections', 'session-scripts');
      assert.deepEqual(
        fs.readdirSync(records).filter((name) => name.endsWith('.json')),
        [],
      );
    } finally {
      linkSpy.mockRestore();
      await proxy.close();
    }
  });
}, 20_000);

test('a failed refresh download through the client keeps the success of the one action it ran', async () => {
  await withProviderScenarioResource(
    () => createAndroidSettingsWorld({ nativeTextInjection: true }),
    async (world) => {
      const root = mkdtempForTestSync('remote-script-refresh-');
      const destination = path.join(root, 'journey.ad');
      let refuseArtifacts = false;
      const proxy = await createProviderScenarioProxy(world.daemon, {
        clientToken: 'script-client',
      });
      const upstream = new URL(proxy.baseUrl);
      const gate = http.createServer((req, res) => {
        if (refuseArtifacts && req.url?.includes('/artifacts/')) {
          res.writeHead(503).end('unavailable');
          return;
        }
        const forwarded = http.request(
          {
            host: upstream.hostname,
            port: upstream.port,
            method: req.method,
            path: req.url,
            headers: req.headers,
          },
          (reply) => {
            res.writeHead(reply.statusCode ?? 502, reply.headers);
            reply.pipe(res);
          },
        );
        forwarded.on('error', () => res.destroy());
        req.pipe(forwarded);
      });
      const gatePort = await listenOnLoopback(gate);
      const client = createAgentDeviceClient({
        daemonBaseUrl: `http://127.0.0.1:${gatePort}${upstream.pathname}`,
        daemonAuthToken: 'script-client',
        session: 'refresh',
        stateDir: path.join(root, 'client-state'),
      });
      try {
        await client.apps.open({ app: 'settings', saveScript: destination, ...world.selection });
        const opened = fs.readFileSync(destination, 'utf8');

        refuseArtifacts = true;
        // The fill succeeded on the device, so a failed script download keeps its success.
        await client.interactions.fill({
          selector: 'id="com.android.settings:id/search"',
          text: 'fixture-input',
          ...world.selection,
        });
        assert.equal(world.textInjectionCalls.length, 1);
        assert.equal(fs.readFileSync(destination, 'utf8'), opened);

        refuseArtifacts = false;
        await client.sessions.close();
        const final = fs.readFileSync(destination, 'utf8');
        assert.match(final, /^fill /m);
        assert.match(final, /^close/m);
        assert.equal(world.textInjectionCalls.length, 1);
      } finally {
        await closeLoopbackServer(gate);
        await proxy.close();
      }
    },
  );
}, 20_000);

test('a direct daemon refreshes the caller script on every action and retires an aborted recording', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const root = mkdtempForTestSync('remote-script-direct-');
    const destination = path.join(root, 'journey.ad');
    const stateDir = path.join(root, 'client-state');
    const client = createAgentDeviceClient({
      daemonBaseUrl: world.daemon.baseUrl,
      daemonAuthToken: world.daemon.token,
      session: 'direct-author',
      stateDir,
    });
    const records = path.join(stateDir, 'remote-connections', 'session-scripts');
    const recordFiles = () => fs.readdirSync(records).filter((name) => name.endsWith('.json'));

    await client.apps.open({ app: 'settings', saveScript: destination, ...world.selection });
    await client.command.wait({ selector: 'label="Apps"', ...world.selection });
    assert.match(fs.readFileSync(destination, 'utf8'), /^wait /m);
    await client.sessions.close();
    assert.match(fs.readFileSync(destination, 'utf8'), /^close/m);
    assert.deepEqual(recordFiles(), []);

    const aborted = path.join(root, 'aborted.ad');
    await client.apps.open({ app: 'settings', saveScript: aborted, ...world.selection });
    assert.equal(recordFiles().length, 1);
    const abortedBytes = fs.readFileSync(aborted, 'utf8');
    await client.apps.open({ app: 'settings', ...world.selection });
    await client.sessions.close();
    assert.deepEqual(recordFiles(), []);
    assert.equal(fs.readFileSync(aborted, 'utf8'), abortedBytes);
    world.assertNoHostAdbCalls();
  });
}, 20_000);

test('capture commands refresh the caller script through a proxy', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const root = mkdtempForTestSync('remote-script-capture-');
    const destination = path.join(root, 'journey.ad');
    const proxy = await createProviderScenarioProxy(world.daemon, { clientToken: 'script-client' });
    const client = createAgentDeviceClient({
      daemonBaseUrl: proxy.baseUrl,
      daemonAuthToken: 'script-client',
      session: 'capture-author',
      stateDir: path.join(root, 'client-state'),
    });
    try {
      await client.apps.open({ app: 'settings', saveScript: destination, ...world.selection });
      await client.recording.trace({
        action: 'start',
        path: path.join(root, 'session.trace'),
        ...world.selection,
      });
      assert.match(fs.readFileSync(destination, 'utf8'), /^trace "start"/m);
      await client.observability.perf({ area: 'frames', ...world.selection });
      assert.match(fs.readFileSync(destination, 'utf8'), /^perf\b/m);
      await client.sessions.close();
    } finally {
      await proxy.close();
    }
  });
}, 20_000);

test('close delivers the final script after it stops an app log', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const root = mkdtempForTestSync('remote-script-capture-close-');
    const destination = path.join(root, 'journey.ad');
    const stateDir = path.join(root, 'client-state');
    const proxy = await createProviderScenarioProxy(world.daemon, { clientToken: 'script-client' });
    const client = createAgentDeviceClient({
      daemonBaseUrl: proxy.baseUrl,
      daemonAuthToken: 'script-client',
      session: 'capture-close',
      stateDir,
    });
    try {
      await client.apps.open({ app: 'settings', saveScript: destination, ...world.selection });
      await client.observability.logs({ action: 'start', ...world.selection });

      await client.sessions.close();

      assert.match(fs.readFileSync(destination, 'utf8'), /^close/m);
      const records = path.join(stateDir, 'remote-connections', 'session-scripts');
      assert.deepEqual(
        fs.readdirSync(records).filter((name) => name.endsWith('.json')),
        [],
      );
    } finally {
      await proxy.close();
    }
  });
}, 20_000);

/**
 * The caller surfaces a remote recording reads (#4564): an action whose script version did not
 * arrive stays successful, so the SDK result, the CLI output and the MCP tool result are the only
 * channels that say the caller file is stale. One gate refuses the artifact downloads of one
 * surface's close at a time, so each surface answers its own failing delivery.
 */
test('the SDK, the CLI and MCP each disclose a failed final script delivery', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const root = mkdtempForTestSync('remote-script-surfaces-');
    const proxy = await createProviderScenarioProxy(world.daemon, { clientToken: 'script-client' });
    let refuseArtifacts = false;
    const gate = await createArtifactGate(proxy.baseUrl, () => refuseArtifacts);
    const remoteEnv = {
      AGENT_DEVICE_DAEMON_BASE_URL: gate.baseUrl,
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'script-client',
      AGENT_DEVICE_DAEMON_TRANSPORT: 'http',
    };
    const recordFiles = (stateDir: string) =>
      fs
        .readdirSync(path.join(stateDir, 'remote-connections', 'session-scripts'), {
          withFileTypes: true,
        })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name);
    try {
      // The SDK: the typed failure and the warning ride the close result itself.
      const sdkStateDir = path.join(root, 'sdk-state');
      const sdkFile = path.join(root, 'sdk.ad');
      const sdk = createAgentDeviceClient({
        daemonBaseUrl: gate.baseUrl,
        daemonAuthToken: 'script-client',
        session: 'sdk-surfaces',
        stateDir: sdkStateDir,
      });
      await sdk.apps.open({ app: 'settings', saveScript: sdkFile, ...world.selection });
      refuseArtifacts = true;
      const sdkClose = await sdk.sessions.close();
      refuseArtifacts = false;
      assert.equal(sdkClose.scriptDeliveryFailure?.reason, 'script_delivery_failed');
      assert.ok(
        sdkClose.warnings?.some((warning) =>
          warning.includes(sdkClose.scriptDeliveryFailure!.hint),
        ),
        JSON.stringify(sdkClose.warnings),
      );
      assert.doesNotMatch(fs.readFileSync(sdkFile, 'utf8'), /^close/m);
      assert.deepEqual(recordFiles(sdkStateDir), []);

      // The CLI with `--json`: an agent reading machine output gets the typed field.
      const jsonStateDir = path.join(root, 'cli-json-state');
      const jsonFile = path.join(root, 'cli-json.ad');
      const cli = (argv: string[], stateDir: string) =>
        runCliCapture(argv, {
          cwd: root,
          env: { ...remoteEnv, AGENT_DEVICE_STATE_DIR: stateDir },
          useRealDaemonClient: true,
        });
      const jsonOpen = await cli(
        [
          'open',
          'settings',
          '--json',
          '--session',
          'cli-json',
          '--save-script',
          jsonFile,
          '--platform',
          world.selection.platform,
          '--serial',
          world.selection.serial,
        ],
        jsonStateDir,
      );
      assert.equal(jsonOpen.code, null, jsonOpen.stderr);
      refuseArtifacts = true;
      const jsonClose = await cli(['close', '--json', '--session', 'cli-json'], jsonStateDir);
      refuseArtifacts = false;
      assert.equal(jsonClose.code, null, jsonClose.stderr);
      const jsonPayload = JSON.parse(jsonClose.stdout);
      assert.equal(jsonPayload.success, true, jsonClose.stdout);
      assert.equal(jsonPayload.data.scriptDeliveryFailure.reason, 'script_delivery_failed');
      assert.ok(
        Array.isArray(jsonPayload.data.warnings) &&
          jsonPayload.data.warnings.some((warning: string) =>
            warning.includes(jsonPayload.data.scriptDeliveryFailure.hint),
          ),
        jsonClose.stdout,
      );
      assert.doesNotMatch(fs.readFileSync(jsonFile, 'utf8'), /^close/m);

      // The CLI for a human: the warning is a line the terminal prints.
      const humanStateDir = path.join(root, 'cli-human-state');
      const humanFile = path.join(root, 'cli-human.ad');
      const humanOpen = await cli(
        [
          'open',
          'settings',
          '--session',
          'cli-human',
          '--save-script',
          humanFile,
          '--platform',
          world.selection.platform,
          '--serial',
          world.selection.serial,
        ],
        humanStateDir,
      );
      assert.equal(humanOpen.code, null, humanOpen.stderr);
      refuseArtifacts = true;
      const humanClose = await cli(['close', '--session', 'cli-human'], humanStateDir);
      refuseArtifacts = false;
      assert.equal(humanClose.code, null, humanClose.stderr);
      assert.match(
        `${humanClose.stdout}${humanClose.stderr}`,
        /Warning: .*remote script could not be saved/i,
      );

      // MCP: the tool text the model reads carries the warning, and machine output carries the field.
      const mcpStateDir = path.join(root, 'mcp-state');
      const mcpFile = path.join(root, 'mcp.ad');
      const restoreEnv = installIsolatedCliTestEnv({
        ...remoteEnv,
        AGENT_DEVICE_STATE_DIR: mcpStateDir,
      });
      try {
        const executor = createCommandToolExecutor({ structuredContent: 'always' });
        const mcpOpen = await executor.execute('open', {
          app: 'settings',
          session: 'mcp-surfaces',
          saveScript: mcpFile,
          ...world.selection,
        });
        assert.equal(mcpOpen.isError, false, JSON.stringify(mcpOpen));
        refuseArtifacts = true;
        const mcpClose = await executor.execute('close', { session: 'mcp-surfaces' });
        refuseArtifacts = false;
        assert.equal(mcpClose.isError, false, JSON.stringify(mcpClose));
        assert.match(
          mcpClose.content.map((part) => part.text ?? '').join('\n'),
          /Warning: .*remote script could not be saved/i,
        );
        assert.equal(
          (mcpClose.structuredContent as { scriptDeliveryFailure?: { reason?: string } })
            ?.scriptDeliveryFailure?.reason,
          'script_delivery_failed',
        );
      } finally {
        restoreEnv();
      }
      assert.doesNotMatch(fs.readFileSync(mcpFile, 'utf8'), /^close/m);
      world.assertNoHostAdbCalls();
    } finally {
      await gate.close();
      await proxy.close();
    }
  });
}, 30_000);
/**
 * A gate in front of the daemon proxy that answers the artifact downloads of a refused moment with
 * 503, which is how these scenarios make one delivery fail.
 */
async function createArtifactGate(
  upstreamUrl: string,
  refused: () => boolean,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const upstream = new URL(upstreamUrl);
  const gate = http.createServer((req, res) => {
    if (refused() && req.url?.includes('/artifacts/')) {
      res.writeHead(503).end('unavailable');
      return;
    }
    const forwarded = http.request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    forwarded.on('error', () => res.destroy());
    req.pipe(forwarded);
  });
  return {
    baseUrl: `http://127.0.0.1:${await listenOnLoopback(gate)}${upstream.pathname}`,
    close: () => closeLoopbackServer(gate),
  };
}
