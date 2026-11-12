import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});
vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return { ...actual, sleep: vi.fn() };
});

import { bindMissingAndroidHelperHost } from './test-utils/android-host-test-setup.ts';

import { snapshotAndroid } from '../snapshot.ts';

import { buildUiHierarchySnapshot, parseUiHierarchyTree } from '../ui-hierarchy.ts';

import * as diagnosticsModule from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';

import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { type AndroidAdbExecutor } from '../snapshot-helper.ts';

import {
  androidHelperInstrumentationOutput as helperOutput,
  ANDROID_HELPER_INSTALLED_VERSION_PROBE as installedHelperProbe,
} from './snapshot-helper-session.fixtures.ts';

import {
  mockSleep,
  device,
  helperArtifact,
  snapshotAndroidWithHelper,
  createHelperAdb,
  androidSnapshotHelperAdb,
  captureDiagnostics,
  resetSnapshotTestState,
} from './test-utils/android-snapshot-test-world.ts';

beforeEach(resetSnapshotTestState);
afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

test('snapshotAndroid emits helper failure diagnostics', async () => {
  const helperAdb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
        stderr: '',
      };
    }
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop')
      return { exitCode: 0, stdout: '', stderr: '' };
    return { exitCode: 1, stdout: '', stderr: 'helper unavailable' };
  };

  const diagnostics = await captureDiagnostics(
    { session: 'snapshot-failure', requestId: 'req-2', command: 'snapshot', debug: true },
    async () => {
      await assert.rejects(
        () => snapshotAndroid(device, { helperAdb, helperArtifact }),
        (error: unknown) => {
          assert(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /helper unavailable/);
          return true;
        },
      );
      return diagnosticsModule.flushDiagnosticsToSessionFile({ force: true })?.path ?? null;
    },
  );

  assert.match(diagnostics, /android_snapshot_helper_failed/);
  assert.match(diagnostics, /helper unavailable/);
});

test('snapshotAndroid emits unavailable diagnostics when helper artifact is missing', async () => {
  bindMissingAndroidHelperHost();
  const diagnostics = await captureDiagnostics(
    {
      session: 'snapshot-helper-missing',
      requestId: 'req-missing',
      command: 'snapshot',
      debug: true,
    },
    async () => {
      await assert.rejects(() => snapshotAndroid(device), /Android snapshot helper is unavailable/);
      return diagnosticsModule.flushDiagnosticsToSessionFile({ force: true })?.path ?? null;
    },
  );

  assert.match(diagnostics, /android_snapshot_helper_artifact_resolution/);
  assert.match(diagnostics, /android_snapshot_helper_unavailable/);
  assert.match(diagnostics, /artifact_not_found/);
});

test('snapshotAndroid gives an actionable hint when the helper artifact is missing on disk', async () => {
  bindMissingAndroidHelperHost();
  await assert.rejects(
    () => snapshotAndroid(device),
    (error) => {
      assert.match((error as Error).message, /the bundled helper artifact was not found/);
      const hint = String((error as { details?: Record<string, unknown> }).details?.hint);
      assert.match(hint, /pnpm build:android/);
      assert.match(hint, /prepack/);
      assert.match(hint, /\.manifest\.json/);
      assert.match(hint, /\.apk/);
      // The npm package excludes *.idsig by design — the hint must never claim it is required.
      assert.doesNotMatch(hint, /idsig/);
      return true;
    },
  );
});

test('snapshotAndroid distinguishes a device-side install rejection from a missing build artifact', async () => {
  const helperAdb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      // No installed package reported, so ensureAndroidSnapshotHelper treats the
      // helper as missing and attempts a real install.
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'install') {
      return { exitCode: 1, stdout: '', stderr: 'Failure [INSTALL_FAILED_TEST_ONLY]' };
    }
    throw new Error(`unexpected adb args: ${args.join(' ')}`);
  };

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    (error) => {
      const message = (error as Error).message;
      assert.match(message, /Android snapshot helper failed/);
      assert.match(message, /Failed to install Android snapshot helper/);
      assert.match(message, /INSTALL_FAILED_TEST_ONLY/);
      const hint = String((error as { details?: Record<string, unknown> }).details?.hint);
      assert.match(hint, /device-side install failure/);
      assert.doesNotMatch(hint, /pnpm build:android/);
      return true;
    },
  );
});

test('snapshotAndroid preserves upstream diagnosticId and logPath through the capture rewrap', async () => {
  const helperAdb = createHelperAdb({
    instrument: async () => {
      throw new AppError('COMMAND_FAILED', 'helper capture exploded', {
        diagnosticId: 'diag-upstream',
        logPath: '/tmp/upstream.ndjson',
      });
    },
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    (error) => {
      assert.match((error as Error).message, /Android snapshot helper failed/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.diagnosticId, 'diag-upstream');
      assert.equal(details?.logPath, '/tmp/upstream.ndjson');
      return true;
    },
  );
});

test('snapshotAndroid emits timeout diagnostics when helper capture times out', async () => {
  const helperAdb = createHelperAdb({
    instrument: async () => {
      throw new AppError('COMMAND_FAILED', 'helper capture timed out');
    },
  });

  const diagnostics = await captureDiagnostics(
    {
      session: 'snapshot-helper-timeout',
      requestId: 'req-timeout',
      command: 'snapshot',
      debug: true,
    },
    async () => {
      await assert.rejects(
        () => snapshotAndroidWithHelper(helperAdb),
        /Android snapshot helper failed: helper capture timed out/,
      );
      return diagnosticsModule.flushDiagnosticsToSessionFile({ force: true })?.path ?? null;
    },
  );

  assert.match(diagnostics, /android_snapshot_helper_failed/);
  assert.match(diagnostics, /helper capture timed out/);
});

test('snapshotAndroid fails closed after unparseable helper output', async () => {
  const calls: (readonly string[])[] = [];
  const helperAdb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args.includes('--show-versioncode')) return installedHelperProbe;
    if (args.includes('instrument')) return { exitCode: 0, stdout: '', stderr: '' };
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    /Android snapshot helper failed.*output could not be parsed/,
  );
  assert.equal(
    calls.some((args) => args.includes('instrument')),
    true,
  );
  assert.equal(
    calls.some(
      (args) => args.join(' ') === 'shell am force-stop com.callstack.agentdevice.snapshothelper',
    ),
    true,
  );
  assert.equal(
    calls.some((args) => args.includes('exec-out')),
    false,
  );
  assert.equal(mockSleep.mock.calls.at(-1)?.[0], 150);
});

test('snapshotAndroid fails closed after helper adb timeout', async () => {
  const helperAdb = createHelperAdb({
    instrument: async (args) => {
      throw new AppError('COMMAND_FAILED', 'adb timed out after 8000ms', {
        args,
        timeoutMs: 8000,
      });
    },
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /Android snapshot helper failed: adb timed out after 8000ms/);
      assert.equal(error.details?.androidSnapshotHelperFailureReason, 'adb timed out after 8000ms');
      return true;
    },
  );
});

test('snapshotAndroid re-probes helper install after helper capture failure', async () => {
  let versionProbeCount = 0;
  let instrumentAttempts = 0;
  const helperAdb: AndroidAdbExecutor = async (args) => {
    if (args.includes('--show-versioncode')) {
      versionProbeCount += 1;
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
        stderr: '',
      };
    }
    if (args.includes('instrument')) {
      instrumentAttempts += 1;
      if (instrumentAttempts === 1) {
        return { exitCode: 1, stdout: '', stderr: 'instrumentation failed' };
      }
      return {
        exitCode: 0,
        stdout: helperOutput('<hierarchy><node text="helper" bounds="[0,0][10,10]" /></hierarchy>'),
        stderr: '',
      };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };
  const helperOptions = {
    helperAdb,
    helperArtifact,
  };

  await assert.rejects(
    () => snapshotAndroid(device, helperOptions),
    (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /instrumentation failed/);
      return true;
    },
  );
  const helper = await snapshotAndroid(device, helperOptions);

  assert.equal(helper.androidSnapshot.backend, 'android-helper');
  assert.equal(helper.nodes[0]?.label, 'helper');
  assert.equal(versionProbeCount, 2);
});

test('snapshotAndroid preserves hidden scroll content hints in interactive snapshots', async () => {
  // Mid-scroll: Android offers both scroll actions, so the helper reports both directions.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" content-desc="Messages" scrollable="true" can-scroll-forward="true" can-scroll-backward="true" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,600]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Earlier message" bounds="[0,100][390,268]" clickable="true" focusable="true" />
        <node class="android.widget.Button" text="Visible message" bounds="[0,268][390,436]" clickable="true" focusable="true" />
        <node class="android.widget.Button" text="Later message" bounds="[0,436][390,604]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml), {
    interactiveOnly: true,
  });
  const scrollArea = result.nodes.find((node) => node.type === 'android.widget.ScrollView');

  assert.ok(scrollArea);
  assert.equal(scrollArea?.hiddenContentAbove, true);
  assert.equal(scrollArea?.hiddenContentBelow, true);
});

test('snapshotAndroid keeps generic-id scroll containers in interactive snapshots', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" resource-id="com.android.settings:id/main_content_scrollable_container" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,600]" clickable="false" focusable="false">
        <node class="android.widget.TextView" text="Network &amp; internet" bounds="[20,140][240,180]" clickable="false" focusable="false" />
        <node class="android.widget.Button" text="Apps" bounds="[20,240][200,288]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml, ''), {
    interactiveOnly: true,
  });
  const scrollArea = result.nodes.find(
    (node) =>
      node.type === 'android.widget.ScrollView' &&
      node.identifier === 'com.android.settings:id/main_content_scrollable_container',
  );

  assert.ok(scrollArea);
});

test('snapshotAndroid skips activity dump when snapshot has no scrollable nodes', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.Button" text="Continue" bounds="[20,120][200,180]" clickable="true" focusable="true" />
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml), {
    interactiveOnly: true,
  });

  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]?.label, 'Continue');
});

// A scrollable-typed node that Android does not report as scrollable (a list short enough to fit)
// is the one shape that still reached `dumpsys activity top` after #1288 capped it. The probe can
// only ever run when the helper reported no scroll actions at all — which is exactly when there is
// no scrollable content to describe — so it must not run, at any budget (#1270).
test('snapshotAndroid never probes the activity dump for scroll hints', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.widget.Button" text="Continue" bounds="[20,120][200,180]" clickable="true" focusable="true" />
    </node>
  </node>
</hierarchy>`;
  const activityDumpCalls: (readonly string[])[] = [];
  const helperAdb = createHelperAdb({
    instrument: async () => ({ exitCode: 0, stdout: helperOutput(xml), stderr: '' }),
    activity: async (args) => {
      activityDumpCalls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await snapshotAndroidWithHelper(helperAdb);
  await snapshotAndroidWithHelper(helperAdb, { interactiveOnly: true });

  assert.deepEqual(activityDumpCalls, []);
});

test('snapshotAndroid skips hidden content hints when disabled', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.widget.Button" text="Continue" bounds="[20,120][200,180]" clickable="true" focusable="true" />
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml), {
    includeHiddenContentHints: false,
  });

  assert.equal(
    result.nodes.some((node) => node.type === 'android.widget.ScrollView'),
    true,
  );
});

test('snapshotAndroid uses helper scroll action hints without activity dump', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" scrollable="true" can-scroll-forward="true" can-scroll-backward="false" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,600]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Continue" bounds="[20,120][200,180]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml));
  const scrollArea = result.nodes.find((node) => node.type === 'android.widget.ScrollView');

  assert.ok(scrollArea);
  assert.equal(scrollArea.hiddenContentBelow, true);
  assert.equal(scrollArea.hiddenContentAbove, undefined);
});

test('snapshotAndroid does not convert horizontal helper scroll action to vertical hints', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.HorizontalScrollView" scrollable="true" can-scroll-forward="true" can-scroll-backward="false" bounds="[0,100][390,220]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][800,220]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="First" bounds="[20,120][200,180]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml));
  const scrollArea = result.nodes.find(
    (node) => node.type === 'android.widget.HorizontalScrollView',
  );

  assert.ok(scrollArea);
  assert.equal(scrollArea.hiddenContentBelow, undefined);
  assert.equal(scrollArea.hiddenContentAbove, undefined);
});

test('snapshotAndroid derives hidden content hints for interactive snapshots from shared visibility semantics', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" content-desc="Messages" bounds="[0,100][390,500]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,500]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Visible message" bounds="[0,120][390,180]" clickable="true" focusable="true" />
        <node class="android.widget.TextView" text="Offscreen message" bounds="[0,560][390,620]" clickable="false" focusable="false" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml), {
    interactiveOnly: true,
  });
  const scrollArea = result.nodes.find((node) => node.type === 'android.widget.ScrollView');

  assert.ok(scrollArea);
  assert.equal(
    result.nodes.some((node) => node.type === 'android.view.ViewGroup'),
    false,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Offscreen message'),
    false,
  );
  assert.equal(scrollArea?.hiddenContentAbove, undefined);
  assert.equal(scrollArea?.hiddenContentBelow, true);
});

test('snapshotAndroid omits zero-area interactive nodes from interactive snapshots', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" scrollable="true" can-scroll-forward="true" can-scroll-backward="false" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,600]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Visible action" bounds="[20,120][200,180]" clickable="true" focusable="true" />
        <node class="android.widget.Button" text="Collapsed action" bounds="[20,844][200,844]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml), {
    interactiveOnly: true,
  });

  assert.equal(
    result.nodes.some((node) => node.label === 'Visible action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Collapsed action'),
    false,
  );
  assert.equal(
    result.nodes.some(
      (node) => node.rect !== undefined && (node.rect.width <= 0 || node.rect.height <= 0),
    ),
    false,
  );
});

test('snapshotAndroid preserves bottomed-out hidden-above hints in interactive snapshots', async () => {
  // Scrolled to the bottom: only the backward action remains, so nothing is hidden below.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" content-desc="Messages" scrollable="true" can-scroll-forward="false" can-scroll-backward="true" bounds="[0,100][390,600]" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,600]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Last message" bounds="[0,432][390,600]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = await snapshotAndroidWithHelper(androidSnapshotHelperAdb(xml), {
    interactiveOnly: true,
  });
  const scrollArea = result.nodes.find(
    (node) => node.hiddenContentAbove === true || node.hiddenContentBelow === true,
  );

  assert.ok(scrollArea);
  assert.equal(scrollArea?.hiddenContentAbove, true);
  assert.equal(scrollArea?.hiddenContentBelow, undefined);
});

test('buildUiHierarchySnapshot derives hidden content hints from can-scroll-* on the presented node', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" clickable="false" focusable="false">
    <node class="android.widget.ScrollView" content-desc="Messages" bounds="[0,100][390,500]" scrollable="true" can-scroll-forward="true" can-scroll-backward="true" clickable="false" focusable="false">
      <node class="android.view.ViewGroup" bounds="[0,100][390,500]" clickable="false" focusable="false">
        <node class="android.widget.Button" text="Visible message" bounds="[0,120][390,180]" clickable="true" focusable="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const tree = parseUiHierarchyTree(xml);
  const scrollNode = tree.children[0]?.children[0];
  assert.ok(scrollNode);

  const result = buildUiHierarchySnapshot(tree, 800, { interactiveOnly: true });
  const scrollArea = result.nodes.find((node) => node.label === 'Messages');

  assert.ok(scrollArea);
  assert.equal(result.sourceNodes[result.nodes.indexOf(scrollArea)], scrollNode);
  assert.equal(scrollArea.hiddenContentAbove, true);
  assert.equal(scrollArea.hiddenContentBelow, true);
});
