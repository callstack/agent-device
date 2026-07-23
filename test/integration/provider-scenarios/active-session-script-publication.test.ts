import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { androidSettingsXml, createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

test('provider route publishes and replays an open-to-destination script with a live handoff', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-active-script-provider-'));
    const scriptPath = path.join(root, 'settings-search.ad');
    const client = world.daemon.client();
    try {
      await client.apps.open({
        app: 'settings',
        saveScript: scriptPath,
        ...world.selection,
      });
      await client.command.wait({ selector: 'label="Search"', ...world.selection });

      const published = await client.sessions.saveScript({ path: scriptPath });
      assert.equal(published.savedScript, scriptPath);
      assert.equal(published.session, 'default');
      assert.equal(published.actionCount, 2);
      assert.equal(world.daemon.session()?.scriptRecordingState, 'published');

      const liveSnapshot = await client.capture.snapshot({ interactiveOnly: true });
      assert.ok(liveSnapshot.nodes.some((node) => node.label === 'Search'));
      const flaggedClose = await world.daemon.callCommand('close', [], { saveScript: scriptPath });
      assertRpcError(flaggedClose, 'INVALID_ARGS', /cannot re-publish/);
      assert.ok(world.daemon.session(), 'flagged close must preserve the published live session');
      await client.sessions.close();

      const replay = await world.daemon.callCommand('replay', [scriptPath], world.selection);
      assert.equal(assertRpcOk<{ session?: string }>(replay).session, 'default');
      const replaySnapshot = await client.capture.snapshot({ interactiveOnly: true });
      assert.ok(replaySnapshot.nodes.some((node) => node.label === 'Search'));
      await client.sessions.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}, 20_000);

// #1349 / ADR 0016 reshuffled-screen false-pass regression: the destination
// guard must prove recorded landmark IDENTITY, not selector existence. The
// replay lands on a reshuffled screen that still contains a node labeled
// "Search" — under a different id and ancestry — so the selector alone would
// have passed the old guard. With landmark verification the wait must fail
// closed through the bounded REPLAY_DIVERGENCE contract instead of
// reporting the destination ready.
test('replaying a published script against a reshuffled screen fails closed instead of false-passing the guard', async () => {
  let phase: 'record' | 'replay' = 'record';
  const reshuffledXml = () =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<hierarchy rotation="0">',
      '  <node index="0" text="" resource-id="com.android.settings:id/results_panel" class="android.widget.LinearLayout" package="com.android.settings" content-desc="" bounds="[0,0][390,600]" clickable="false" enabled="true">',
      '    <node index="0" text="Search" resource-id="android:id/summary" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[24,124][152,178]" clickable="false" enabled="true" />',
      '  </node>',
      '</hierarchy>',
    ].join('\n');
  await withProviderScenarioResource(
    () =>
      createAndroidSettingsWorld({
        snapshotXml: () => (phase === 'record' ? androidSettingsXml('') : reshuffledXml()),
      }),
    async (world) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-reshuffle-guard-provider-'));
      const scriptPath = path.join(root, 'settings-search.ad');
      const client = world.daemon.client();
      try {
        await client.apps.open({
          app: 'settings',
          saveScript: scriptPath,
          ...world.selection,
        });
        await client.command.wait({
          selector: 'label="Search"',
          timeoutMs: 1500,
          ...world.selection,
        });
        const published = await client.sessions.saveScript({ path: scriptPath });
        assert.equal(published.savedScript, scriptPath);
        // The published guard carries recorded landmark identity.
        assert.match(fs.readFileSync(scriptPath, 'utf8'), /agent-device:target-v1/);
        await client.sessions.close();

        phase = 'replay';
        const replay = await world.daemon.callCommand('replay', [scriptPath], world.selection);
        const errorData = assertRpcError(replay, 'REPLAY_DIVERGENCE', /wait/i);
        const divergence = (errorData.details as Record<string, unknown> | undefined)?.divergence as
          | { kind?: string; targetBinding?: { classification?: string; matchCount?: number } }
          | undefined;
        assert.equal(divergence?.kind, 'identity-mismatch');
        // matchCount >= 1 is the false-pass proof: the selector alone DID
        // match the reshuffled screen; only identity refused it.
        assert.ok((divergence?.targetBinding?.matchCount ?? 0) >= 1);
        await world.daemon.callCommand('close');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}, 30_000);

test('a second successful open aborts publication and terminal save flags fail before close', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-aborted-script-provider-'));
    const scriptPath = path.join(root, 'aborted.ad');
    try {
      const first = await world.daemon.callCommand('open', ['settings'], {
        ...world.selection,
        saveScript: scriptPath,
      });
      assertRpcOk(first);

      const rearm = await world.daemon.callCommand('open', ['settings'], {
        ...world.selection,
        relaunch: true,
        saveScript: scriptPath,
      });
      assertRpcError(rearm, 'INVALID_ARGS', /only arm a fresh session/);
      assert.equal(world.daemon.session()?.scriptRecordingState, 'armed');

      const second = await world.daemon.callCommand('open', ['settings'], {
        ...world.selection,
        relaunch: true,
      });
      const secondData = assertRpcOk<{ warnings?: string[] }>(second);
      assert.match(String(secondData.warnings), /publication was aborted/i);
      assert.equal(world.daemon.session()?.scriptRecordingState, 'aborted');

      const publication = await world.daemon.callCommand('session_save_script', [scriptPath]);
      assertRpcError(publication, 'COMMAND_FAILED', /aborted by a second successful open/);

      const flaggedClose = await world.daemon.callCommand('close', [], { saveScript: scriptPath });
      assertRpcError(flaggedClose, 'INVALID_ARGS', /terminal recording/);
      assert.ok(world.daemon.session(), 'flagged close must not tear down the session');
      assert.equal(fs.existsSync(scriptPath), false);

      const plainClose = await world.daemon.callCommand('close');
      assertRpcOk(plainClose);
      assert.equal(world.daemon.session(), undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}, 20_000);
