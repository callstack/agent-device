import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitDiagnostic } from '../../../src/utils/diagnostics.ts';
import { test } from 'vitest';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { androidSettingsXml, createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

/** The authoring lifecycle status of the world's live session, or `undefined` outside authoring. */
function authoringPublicationStatus(world: {
  daemon: { session: () => { scriptPublication?: { kind: string; status?: string } } | undefined };
}): string | undefined {
  const publication = world.daemon.session()?.scriptPublication;
  return publication?.kind === 'authoring' ? publication.status : undefined;
}

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
      assert.equal(authoringPublicationStatus(world), 'published');

      const liveSnapshot = await client.capture.snapshot({ interactiveOnly: true });
      assert.ok(liveSnapshot.nodes.some((node) => node.label === 'Search'));
      const flaggedClose = await world.daemon.callCommand('close', [], { saveScript: scriptPath });
      assertRpcError(flaggedClose, 'INVALID_ARGS', /cannot re-publish/);
      assert.ok(world.daemon.session(), 'flagged close must preserve the published live session');
      await client.sessions.close();

      const replay = await world.daemon.callCommand('replay', [scriptPath], world.selection);
      const replayData = assertRpcOk<{ session?: string; sessionActive?: boolean }>(replay);
      assert.equal(replayData.session, 'default');
      // ADR 0016 / #1384: the published script has no terminal `close`, so the
      // real (not test-fixture-injected) daemon response reports the session
      // still active — this is the exact producer line the client-lifecycle
      // tests in daemon-client-lifecycle.test.ts assume but cannot themselves
      // exercise, since they inject sessionActive via a fake HTTP fixture.
      assert.equal(replayData.sessionActive, true);
      assert.ok(world.daemon.session(), 'a close-less replay must not tear down the session');
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
      assert.equal(authoringPublicationStatus(world), 'armed');

      const second = await world.daemon.callCommand('open', ['settings'], {
        ...world.selection,
        relaunch: true,
      });
      const secondData = assertRpcOk<{ warnings?: string[] }>(second);
      assert.match(String(secondData.warnings), /publication was aborted/i);
      assert.equal(authoringPublicationStatus(world), 'aborted');

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

test('parameterized fill publishes only ${VAR} and replay resolves it immediately before fill', async () => {
  const secret = 'OpaqueProviderValue1348';
  let injectedText: string | undefined;
  let capturesAfterInjection = 0;
  await withProviderScenarioResource(
    async () =>
      await createAndroidSettingsWorld({
        nativeTextInjection: true,
        onTextInjection: (request) => {
          injectedText = request.text;
          capturesAfterInjection = 0;
          emitDiagnostic({
            phase: 'provider_text_echo_regression',
            data: { text: request.text },
          });
        },
        snapshotXml: () => {
          if (injectedText === undefined) return androidSettingsXml('');
          capturesAfterInjection += 1;
          const visibleText =
            capturesAfterInjection <= 3 ? injectedText : `prefix${injectedText}suffix`;
          return androidSettingsXml(visibleText);
        },
      }),
    async (world) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-parameterized-script-'));
      const scriptPath = path.join(root, 'parameterized-search.ad');
      const client = world.daemon.client();
      try {
        const opened = await client.apps.open({
          app: 'settings',
          saveScript: scriptPath,
          ...world.selection,
        });
        const snapshot = await client.capture.snapshot({
          interactiveOnly: true,
          ...world.selection,
        });
        const search = snapshot.nodes.find((node) => node.label === 'Search');
        assert.ok(search?.ref);

        const invalidName = await world.daemon.callCommand('fill', [`@${search.ref}`, secret], {
          ...world.selection,
          recordAs: 'password',
        });
        assertRpcError(invalidName, 'INVALID_ARGS', /Invalid --record-as variable/);
        assert.equal(world.textInjectionCalls.length, 0);

        const contradictory = await world.daemon.callCommand('fill', [`@${search.ref}`, secret], {
          ...world.selection,
          recordAs: 'SEARCH_TERM',
          noRecord: true,
        });
        assertRpcError(contradictory, 'INVALID_ARGS', /cannot be combined with --no-record/);
        assert.equal(world.textInjectionCalls.length, 0);

        const fill = await client.interactions.fill({
          ref: `@${search.ref}`,
          text: secret,
          recordAs: 'SEARCH_TERM',
          settle: true,
          settleQuietMs: 1,
          timeoutMs: 1_000,
          ...world.selection,
        });
        assert.equal(fill.text, '${SEARCH_TERM}');
        const settleOutput = JSON.stringify(fill.settle);
        assert.equal(settleOutput.includes(secret), false, settleOutput);
        assert.match(settleOutput, /prefix\$\{SEARCH_TERM\}suffix/);
        await client.command.wait({
          selector: 'id=android:id/title',
          ...world.selection,
        });

        const recordedState = JSON.stringify(world.daemon.session()?.actions);
        assert.equal(recordedState.includes(secret), false, recordedState);
        assert.match(recordedState, /\$\{SEARCH_TERM\}/);
        await client.sessions.saveScript({ path: scriptPath });
        const script = fs.readFileSync(scriptPath, 'utf8');
        assert.equal(script.includes(secret), false);
        assert.match(script, /\$\{SEARCH_TERM\}/);
        assert.equal(world.textInjectionCalls.at(-1)?.text, secret);
        await client.sessions.close();

        const callsBeforeMissingValue = world.textInjectionCalls.length;
        const missingValue = await world.daemon.callCommand(
          'replay',
          [scriptPath],
          world.selection,
        );
        assertRpcError(missingValue, 'INVALID_ARGS', /Unresolved variable \$\{SEARCH_TERM\}/);
        assert.equal(world.textInjectionCalls.length, callsBeforeMissingValue);
        await client.sessions.close();

        const replay = await world.daemon.callCommand(
          'replay',
          [scriptPath],
          {
            ...world.selection,
            replayEnv: [`SEARCH_TERM=${secret}`],
            verbose: true,
          },
          {
            meta: { debug: true, requestId: 'parameterized-replay-diagnostics' },
          },
        );
        assertRpcOk(replay);
        assert.equal(world.textInjectionCalls.at(-1)?.text, secret);
        const replayState = JSON.stringify(world.daemon.session()?.actions);
        assert.equal(replayState.includes(secret), false, replayState);
        assert.match(replayState, /\$\{SEARCH_TERM\}/);
        assert.ok(opened.sessionStateDir);
        const requestLog = fs.readFileSync(
          path.join(opened.sessionStateDir, 'requests', 'parameterized-replay-diagnostics.ndjson'),
          'utf8',
        );
        assert.match(requestLog, /provider_text_echo_regression/);
        assert.match(requestLog, /\[REDACTED\]/);
        assert.equal(requestLog.includes(secret), false);
        await client.sessions.close();

        await client.apps.open({ app: 'settings', ...world.selection });
        const callsBeforeUnarmed = world.textInjectionCalls.length;
        const unarmed = await world.daemon.callCommand(
          'fill',
          ['id=com.android.settings:id/search', secret],
          { ...world.selection, recordAs: 'SEARCH_TERM' },
        );
        assertRpcError(unarmed, 'INVALID_ARGS', /requires an armed script recording/);
        assert.equal(world.textInjectionCalls.length, callsBeforeUnarmed);
        await client.sessions.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}, 20_000);
