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
