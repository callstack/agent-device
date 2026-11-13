import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { createAgentDeviceClient } from '@agent-device/client';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';
import { createProviderScenarioProxy } from './harness-proxy.ts';

for (const publication of ['active', 'active-force'] as const) {
  test(`remote ${publication} publication downloads a reusable script through the owning proxy`, async () => {
    await withProviderScenarioResource(
      () => createAndroidSettingsWorld({ nativeTextInjection: true }),
      async (world) => {
        const root = mkdtempForTestSync('remote-script-provider-');
        const destination = path.join(root, 'caller', 'journey.ad');
        if (publication === 'active-force') {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, 'protected');
        }
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
          await recordRemoteJourney(world, client, publication, destination);
          const published = await client.sessions.saveScript(
            publication === 'active-force' ? { path: destination } : {},
          );
          assert.equal(published.savedScript, destination);
          const text = fs.readFileSync(destination, 'utf8');
          assert.match(text, /open/);
          assert.match(text, /agent-device:target-v1/);
          assert.equal(text.includes(root), false);
          if (publication === 'active') {
            assert.equal(text.includes('fixture-input'), false);
            assert.ok(text.includes('${SEARCH_TERM}'));
          }
          const reply = proxy.forwarded.filter((r) => r.route === '/rpc').at(-1);
          assert.ok(reply);
          const raw = JSON.parse(reply.responseBody).result.data;
          assert.notEqual(raw.savedScript, destination);
          const artifact = raw.artifacts.find(
            (a: { artifactType: string }) => a.artifactType === 'session-script',
          );
          assert.ok(artifact?.artifactId);
          assert.ok(
            proxy.forwarded.some((r) => r.route.includes('/artifacts/') && r.statusCode === 200),
          );
          // Retry by ID remains possible after bytes arrived but local publication could have failed.
          const again = await fetch(`${proxy.baseUrl}/artifacts/${artifact.artifactId}`, {
            headers: { authorization: 'Bearer script-client' },
          });
          assert.equal(again.status, 200);
          assert.equal(await again.text(), text);
          const snapshot = await client.capture.snapshot({ interactiveOnly: true });
          assert.ok(snapshot.nodes.some((node) => node.label === 'Apps'));
          await client.sessions.close();
          // Input transport reads only the caller's script; the daemon executes the returned source.
          const replay = await client.replay.run({
            path: destination,
            env: ['SEARCH_TERM=second-input'],
            ...world.selection,
          });
          assert.equal(replay.sessionActive, true);
          await client.sessions.close();
          world.assertNoHostAdbCalls();
        } finally {
          await proxy.close();
        }
      },
    );
  }, 20_000);
}

async function recordRemoteJourney(
  world: Awaited<ReturnType<typeof createAndroidSettingsWorld>>,
  client: ReturnType<typeof createAgentDeviceClient>,
  publication: string,
  destination: string,
): Promise<void> {
  await client.apps.open({
    app: 'settings',
    saveScript: destination,
    force: publication === 'active-force',
    ...world.selection,
  });
  if (publication === 'active') {
    await client.interactions.fill({
      selector: 'id="com.android.settings:id/search"',
      text: 'fixture-input',
      recordAs: 'SEARCH_TERM',
      ...world.selection,
    });
  }
  await client.command.wait({ selector: 'label="Apps"', ...world.selection });
}
