import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ANDROID_IME_HELPER_FIXTURE_ARTIFACT } from '../../../src/__tests__/test-utils/android-ime-helper.ts';
import {
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  androidSnapshotHelperOutput,
} from '../../../src/__tests__/test-utils/android-snapshot-helper.ts';
import type { AndroidAdbProvider } from '@agent-device/platform-android/mechanics';
import { assertRpcOk } from './assertions.ts';
import {
  androidImeLifecycleAdbResult,
  createAndroidProviderShellState,
} from './android-ime-lifecycle-world.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';

const PIXEL_DENSITY = 2.625;

// 100px is 38dp at this density: below the 48dp recommendation. 160px is 61dp.
const AUDIT_SCREEN_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<hierarchy rotation="0">',
  '  <node index="0" text="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" bounds="[0,0][1080,1920]" clickable="false" enabled="true">',
  '    <node index="0" text="Save" class="android.widget.Button" package="com.android.settings" content-desc="" bounds="[100,200][200,300]" clickable="true" enabled="true" />',
  '    <node index="1" text="Continue" class="android.widget.Button" package="com.android.settings" content-desc="" bounds="[100,400][260,560]" clickable="true" enabled="true" />',
  '    <node index="2" text="" class="android.widget.ImageButton" package="com.android.settings" content-desc="" bounds="[400,400][560,560]" clickable="true" enabled="true" />',
  '  </node>',
  '</hierarchy>',
].join('\n');

// A helper capture with the screen-reader facts: two named texts and no control, so no finding.
const ORDER_SCREEN_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<hierarchy rotation="0">',
  '  <node index="0" ax-id="0" window-type="1" window-index="0" window-bounds="[0,0][1080,1920]" text="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" bounds="[0,0][1080,1920]" enabled="true" important="true">',
  '    <node index="0" ax-id="1" text="Storage" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[100,200][980,300]" enabled="true" important="true" />',
  '    <node index="1" ax-id="2" text="42 GB used" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[100,400][980,500]" enabled="true" important="true" />',
  '  </node>',
  '</hierarchy>',
].join('\n');

function settingsAdbProvider(xml: string): AndroidAdbProvider {
  const ime = createAndroidProviderShellState();
  return {
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    imeHelperArtifact: ANDROID_IME_HELPER_FIXTURE_ARTIFACT,
    exec: async (args) => {
      const key = args.join(' ');
      const imeResult = androidImeLifecycleAdbResult(key, [...args], ime);
      if (imeResult) return imeResult;
      if (key === 'shell getprop sys.boot_completed') {
        return { stdout: '1\n', stderr: '', exitCode: 0 };
      }
      if (key === 'shell dumpsys window windows') {
        return {
          stdout: 'mCurrentFocus=Window{42 u0 com.android.settings/.Settings}\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (key.startsWith('shell am instrument ')) {
        return {
          stdout: androidSnapshotHelperOutput(xml, { pixelDensity: PIXEL_DENSITY }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

test('Provider-backed integration Android audit issues the estimated TalkBack order refs without findings', async () => {
  const adbProvider = settingsAdbProvider(ORDER_SCREEN_XML);
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => adbProvider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });
  try {
    const selection = { platform: 'android' as const, serial: PROVIDER_SCENARIO_ANDROID.id };
    assertRpcOk(await daemon.callCommand('open', ['settings'], selection));

    const audit = assertRpcOk(await daemon.callCommand('audit', [], selection));
    assert.deepEqual(audit.findings, []);
    const order = audit.screenReaderOrder as { windows: Array<{ refs: string[] }> };
    assert.equal(order.windows.length, 1);
    assert.equal(order.windows[0]!.refs.length, 2);
    assert.equal(typeof audit.refsGeneration, 'number');
    const ref = `${order.windows[0]!.refs[1]}-s${audit.refsGeneration}`;
    const read = assertRpcOk(await daemon.callCommand('get', ['text', ref], selection));
    assert.equal(read.text, '42 GB used');
  } finally {
    await daemon.close();
  }
});

test('Provider-backed integration Android audit converts captured pixels to dp before judging target size', async () => {
  const ime = createAndroidProviderShellState();
  const adbProvider: AndroidAdbProvider = {
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    imeHelperArtifact: ANDROID_IME_HELPER_FIXTURE_ARTIFACT,
    exec: async (args) => {
      const key = args.join(' ');
      const imeResult = androidImeLifecycleAdbResult(key, [...args], ime);
      if (imeResult) return imeResult;
      if (key === 'shell getprop sys.boot_completed') {
        return { stdout: '1\n', stderr: '', exitCode: 0 };
      }
      if (key === 'shell dumpsys window windows') {
        return {
          stdout: 'mCurrentFocus=Window{42 u0 com.android.settings/.Settings}\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (key.startsWith('shell am instrument ')) {
        return {
          stdout: androidSnapshotHelperOutput(AUDIT_SCREEN_XML, { pixelDensity: PIXEL_DENSITY }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const daemon = await createProviderScenarioHarness({
    androidAdbProvider: () => adbProvider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
  });
  try {
    const selection = { platform: 'android' as const, serial: PROVIDER_SCENARIO_ANDROID.id };
    assertRpcOk(await daemon.callCommand('open', ['settings'], selection));

    const audit = assertRpcOk(await daemon.callCommand('audit', [], selection));
    const findings = audit.findings as Array<{
      kind: string;
      detail?: { unit: string; width: number; recommendedSize: number };
    }>;
    assert.deepEqual(
      findings.map((finding) => finding.kind),
      ['small-target', 'missing-name'],
    );
    assert.deepEqual(findings[0]?.detail, {
      unit: 'dp',
      width: 38.1,
      height: 38.1,
      recommendedSize: 48,
    });
    assert.deepEqual(audit.limitations, []);
  } finally {
    await daemon.close();
  }
});
