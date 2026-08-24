import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitDiagnostic } from '../../../src/utils/diagnostics.ts';
import { INTERNAL_COMMANDS } from '../../../src/command-catalog.ts';
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

test('provider route can suppress an authored terminal close for a live replay handoff', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-keep-session-provider-'));
    const scriptPath = path.join(root, 'settings-with-close.ad');
    fs.writeFileSync(scriptPath, ['open "settings"', 'close', ''].join('\n'));
    const client = world.daemon.client();
    try {
      const replay = await client.replay.run({
        path: scriptPath,
        keepSession: true,
        ...world.selection,
      });
      assert.equal(replay.session, 'default');
      assert.equal(replay.sessionActive, true);
      assert.ok(world.daemon.session(), 'keepSession must preserve the replay-opened session');

      const takeoverSnapshot = await client.capture.snapshot({ interactiveOnly: true });
      assert.ok(takeoverSnapshot.nodes.some((node) => node.label === 'Search'));

      await client.sessions.close();
      assert.equal(world.daemon.session(), undefined);
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
        const divergence = (errorData.details as Record<string, unknown> | undefined)
          ?.divergence as
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

// Live evidence (2026-08-02): a plain `open` (no arming) followed by `close --save-script` used to
// silently publish anyway — the close request armed authoring at record time and published moments
// later in the same request, producing a script with selector fallback chains but NO recording-time
// `target-v1` evidence and no signal to the caller that the evidence was missing. The daemon now
// rejects this before any teardown or filesystem work, and the session stays open so a plain close
// still completes cleanly (it just does not publish).
test('an unarmed session refuses close --save-script and closes cleanly on plain close', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-unarmed-close-provider-'));
    const scriptPath = path.join(root, 'unarmed.ad');
    try {
      const opened = await world.daemon.callCommand('open', ['settings'], { ...world.selection });
      assertRpcOk(opened);
      assert.equal(authoringPublicationStatus(world), undefined);

      const flaggedClose = await world.daemon.callCommand('close', [], { saveScript: scriptPath });
      assertRpcError(flaggedClose, 'INVALID_ARGS', /not armed/);
      assert.ok(world.daemon.session(), 'flagged close must not tear down the unarmed session');
      assert.equal(fs.existsSync(scriptPath), false);

      const plainClose = await world.daemon.callCommand('close');
      assertRpcOk(plainClose);
      assert.equal(world.daemon.session(), undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}, 20_000);

// The counterpart to the unarmed refusal above: an `open --save-script`-armed session must still
// publish through the ordinary close-time route (not just through `session save-script`), and the
// published script must carry the same recording-time `target-v1` evidence.
test('an armed session still publishes target-v1 evidence through close --save-script', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-armed-close-provider-'));
    const scriptPath = path.join(root, 'armed-close.ad');
    const client = world.daemon.client();
    try {
      await client.apps.open({
        app: 'settings',
        saveScript: scriptPath,
        ...world.selection,
      });
      assert.equal(authoringPublicationStatus(world), 'armed');

      const snapshot = await client.capture.snapshot({ interactiveOnly: true, ...world.selection });
      const search = snapshot.nodes.find((node) => node.label === 'Search');
      assert.ok(search?.ref, JSON.stringify(snapshot.nodes));
      await client.interactions.click({ ref: `@${search.ref}`, ...world.selection });

      const close = await world.daemon.callCommand('close', [], { saveScript: scriptPath });
      assertRpcOk(close);
      assert.equal(fs.existsSync(scriptPath), true);
      const script = fs.readFileSync(scriptPath, 'utf8');
      assert.match(script, /agent-device:target-v1/);
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

// #1398: a LATER, distinct read-only action can independently observe an
// app-rendered echo of an already-parameterized fill's literal — here, a
// confirmation label containing the typed search term, the exact scenario
// that motivated the issue (a provider scenario whose destination guard
// waited on a populated field carrying the opaque input value). The fix must
// keep the literal out of session state/publication AND refuse to let an
// echoing landmark serve as the ADR 0016 destination guard, through the real
// provider/publication path rather than a serializer helper.
function settingsXmlWithSearchResult(searchText: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hierarchy rotation="0">',
    '  <node index="0" text="" resource-id="com.android.settings:id/main_content_scrollable_container" class="android.widget.ScrollView" package="com.android.settings" content-desc="" bounds="[0,0][390,600]" clickable="false" enabled="true">',
    '    <node index="0" text="Apps" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[24,124][152,178]" clickable="true" enabled="true" focusable="true" focused="false" />',
    `    <node index="1" text="${searchText}" resource-id="com.android.settings:id/search" class="android.widget.EditText" package="com.android.settings" content-desc="Search" bounds="[16,24][374,80]" clickable="true" enabled="true" focusable="true" focused="true" password="false" />`,
    ...(searchText
      ? [
          `    <node index="2" text="Results for ${searchText}" resource-id="com.android.settings:id/results_summary" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[24,190][350,244]" clickable="false" enabled="true" />`,
        ]
      : []),
    '  </node>',
    '</hierarchy>',
  ].join('\n');
}

test('#1398: a read-only wait recorded after a parameterized fill never re-serializes an app-rendered echo, and cannot serve as the destination guard', async () => {
  const secret = 'OpaqueEchoValue1398';
  let injectedText: string | undefined;
  await withProviderScenarioResource(
    async () =>
      await createAndroidSettingsWorld({
        nativeTextInjection: true,
        onTextInjection: (request) => {
          injectedText = request.text;
        },
        snapshotXml: () => settingsXmlWithSearchResult(injectedText ?? ''),
      }),
    async (world) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-echo-protection-'));
      const scriptPath = path.join(root, 'echo-protection.ad');
      const client = world.daemon.client();
      try {
        await client.apps.open({ app: 'settings', saveScript: scriptPath, ...world.selection });
        const snapshot = await client.capture.snapshot({
          interactiveOnly: true,
          ...world.selection,
        });
        const search = snapshot.nodes.find((node) => node.label === 'Search');
        assert.ok(search?.ref);

        await client.interactions.fill({
          ref: `@${search.ref}`,
          text: secret,
          recordAs: 'SEARCH_TERM',
          settle: true,
          settleQuietMs: 1,
          timeoutMs: 1_000,
          ...world.selection,
        });

        // The app echoes the typed value back in an unrelated confirmation
        // label. A wait on it records, but must never carry the literal.
        await client.command.wait({
          selector: 'id="com.android.settings:id/results_summary"',
          ...world.selection,
        });

        const stateBeforeGuard = JSON.stringify(world.daemon.session()?.actions);
        assert.equal(stateBeforeGuard.includes(secret), false, stateBeforeGuard);
        assert.match(stateBeforeGuard, /\$\{SEARCH_TERM\}/);

        // Being the only wait so far, it cannot serve as the destination
        // guard: its ONLY identity was the parameterized-value echo, so
        // landmark evidence was dropped rather than published unverifiable.
        const refusedPublish = await world.daemon.callCommand(
          INTERNAL_COMMANDS.sessionSaveScript,
          [scriptPath],
          world.selection,
        );
        assertRpcError(refusedPublish, 'COMMAND_FAILED', /destination guard/);

        // Recording a stable, non-value-bearing landmark — mirroring the
        // real-world fix of switching to the "Apps" landmark — recovers a
        // valid guard.
        await client.command.wait({ selector: 'label="Apps"', ...world.selection });
        const published = await client.sessions.saveScript({ path: scriptPath });
        assert.equal(published.savedScript, scriptPath);

        const script = fs.readFileSync(scriptPath, 'utf8');
        assert.equal(script.includes(secret), false, script);
        assert.match(script, /\$\{SEARCH_TERM\}/);

        const lines = script.split('\n');
        const resultsLineIndex = lines.findIndex((line) => line.includes('results_summary'));
        assert.ok(resultsLineIndex > 0, script);
        assert.equal(
          lines[resultsLineIndex - 1]?.includes('agent-device:target-v1'),
          false,
          script,
        );
        const guardLineIndex = lines.findIndex(
          (line) => line.startsWith('wait ') && line.includes('Apps'),
        );
        assert.ok(guardLineIndex > 0, script);
        assert.match(
          lines[guardLineIndex - 1] ?? '',
          /agent-device:target-v1.*"verification":"verified"/,
        );

        await client.sessions.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}, 20_000);
