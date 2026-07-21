import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { createAndroidSettingsWorld } from './android-world.ts';
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
