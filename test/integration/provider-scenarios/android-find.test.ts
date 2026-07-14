import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../src/__tests__/test-utils/index.ts';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import { arrayEqual, assertCommandCall } from './assertions.ts';
import { androidSettingsXml, androidSnapshotHelperOutput } from './android-world.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';

test('Provider-backed integration Android find flow covers refs, wait, ambiguity, and first/last selection', async () => {
  const adbCalls: string[][] = [];
  let searchText = '';
  let includeDuplicateAppsRow = false;
  const adbProvider: AndroidAdbProvider = {
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    exec: async (args) => {
      adbCalls.push([...args]);
      if (args[0] === 'shell' && args[1] === 'input' && args[2] === 'text') {
        searchText = String(args[3] ?? '').replaceAll('%s', ' ');
      }
      return androidFindAdbResult(args, searchText, includeDuplicateAppsRow);
    },
  };
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => adbProvider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });

  try {
    const client = daemon.client();
    const selection = { platform: 'android' as const, serial: PROVIDER_SCENARIO_ANDROID.id };

    const open = await client.apps.open({ app: 'settings', ...selection });
    assert.equal(open.device?.id, PROVIDER_SCENARIO_ANDROID.id);

    const snapshot = await client.capture.snapshot({ interactiveOnly: true, ...selection });
    assert.equal(snapshot.nodes.find((node) => node.label === 'Apps')?.ref, 'e2');
    assert.equal(snapshot.nodes.find((node) => node.label === 'Search')?.ref, 'e3');

    const attrs = await client.interactions.find({
      locator: 'label',
      query: 'Apps',
      action: 'getAttrs',
      ...selection,
    });
    const attrsRef = attrs.ref;
    assertString(attrsRef, 'find attrs ref');
    assert.match(attrsRef, /^@e\d+$/);
    assert.equal((attrs.node as { label?: string } | undefined)?.label, 'Apps');
    // ADR 0014: a read-only find partially publishes its returned ref, so it is
    // consumed in pinned form (`@eN~s<gen>`) — a plain ref would require a
    // complete frame.
    const attrsGeneration = (attrs as { refsGeneration?: number }).refsGeneration;
    assert.equal(typeof attrsGeneration, 'number');
    const attrsPinnedRef = `${attrsRef}~s${attrsGeneration}`;

    const exists = await client.interactions.find({
      locator: 'label',
      query: 'Apps',
      action: 'exists',
      ...selection,
    });
    assert.equal(exists.found, true);

    const pressFoundRef = await client.interactions.press({ ref: attrsPinnedRef, ...selection });
    assert.equal(pressFoundRef.x, 88);
    assert.equal(pressFoundRef.y, 151);

    const focusedSearch = await client.interactions.find({
      locator: 'id',
      query: 'search',
      action: 'focus',
      ...selection,
    });
    assert.equal(focusedSearch.x, 195);
    assert.equal(focusedSearch.y, 52);

    const typed = await client.interactions.find({
      locator: 'id',
      query: 'search',
      action: 'type',
      value: 'Display',
      ...selection,
    });
    assert.equal(typed.text, 'Display');

    const searchTextResult = await client.interactions.find({
      locator: 'text',
      query: 'Display',
      action: 'getText',
      ...selection,
    });
    const searchTextRef = searchTextResult.ref;
    assertString(searchTextRef, 'find text ref');
    assert.match(searchTextRef, /^@e\d+$/);
    assert.equal(searchTextResult.text, 'Display');

    const filled = await client.interactions.find({
      locator: 'id',
      query: 'search',
      action: 'fill',
      value: 'Network',
      ...selection,
    });
    assert.equal(filled.text, 'Network');

    const waitForApps = await client.interactions.find({
      locator: 'label',
      query: 'Apps',
      action: 'wait',
      timeoutMs: 100,
      ...selection,
    });
    assert.equal(waitForApps.found, true);

    const invalidFlags = await daemon.callCommand('find', ['label', 'Apps', 'click'], {
      findFirst: true,
      findLast: true,
      ...selection,
    });
    assert.equal(invalidFlags.json?.error?.data?.code, 'INVALID_ARGS');
    assert.match(invalidFlags.json?.error?.message ?? '', /only one of --first or --last/);

    includeDuplicateAppsRow = true;
    const duplicateSnapshot = await client.capture.snapshot({
      interactiveOnly: true,
      ...selection,
    });
    assert.equal(
      duplicateSnapshot.nodes.filter((node) => node.label === 'Apps').length,
      2,
      JSON.stringify(duplicateSnapshot.nodes),
    );

    await assert.rejects(
      client.interactions.find({
        locator: 'role',
        query: 'textview',
        action: 'click',
        ...selection,
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AMBIGUOUS_MATCH',
    );

    const firstAppMatch = await client.interactions.find({
      locator: 'role',
      query: 'textview',
      action: 'click',
      first: true,
      ...selection,
    });
    assert.equal(firstAppMatch.ref, '@e2');
    assert.equal(firstAppMatch.x, 88);
    assert.equal(firstAppMatch.y, 151);

    const lastAppMatch = await client.interactions.find({
      locator: 'role',
      query: 'textview',
      action: 'click',
      last: true,
      ...selection,
    });
    assert.equal(lastAppMatch.ref, '@e4');
    assert.equal(lastAppMatch.x, 122);
    assert.equal(lastAppMatch.y, 217);

    assertCommandCall(adbCalls, ['shell', 'input', 'tap', '88', '151']);
    assertCommandCall(adbCalls, ['shell', 'input', 'tap', '122', '217']);
    assertCommandCall(adbCalls, ['shell', 'input', 'tap', '195', '52']);
    assertCommandCall(adbCalls, ['shell', 'input', 'text', 'Display']);
    assertCommandCall(adbCalls, ['shell', 'input', 'text', 'Network']);
    assert.equal(
      adbCalls.filter((call) => arrayEqual(call, ['shell', 'input', 'tap', '88', '151'])).length,
      2,
    );
  } finally {
    await daemon.close();
  }
});

function androidFindAdbResult(
  args: string[],
  searchText: string,
  includeDuplicateAppsRow: boolean,
): { stdout: string; stderr: string; exitCode: number } {
  if (args.join(' ') === 'shell getprop sys.boot_completed') {
    return { stdout: '1\n', stderr: '', exitCode: 0 };
  }
  if (args.join(' ') === 'shell dumpsys window windows') {
    return {
      stdout: 'mCurrentFocus=Window{42 u0 com.android.settings/.Settings}\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (args.join(' ').startsWith('shell am instrument ')) {
    return {
      stdout: androidSnapshotHelperOutput(
        androidSettingsXml(searchText, { duplicateAppsRow: includeDuplicateAppsRow }),
      ),
      stderr: '',
      exitCode: 0,
    };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

function assertString(value: unknown, label: string): asserts value is string {
  assert.equal(typeof value, 'string', `${label} should be a string`);
}
