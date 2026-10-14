import assert from 'node:assert/strict';
import { withoutSettleChrome } from '@agent-device/capture-kit/snapshot-chrome';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { test } from 'vitest';
import { parseWebDriverAndroidSnapshotNodes } from './webdriver-android-source.ts';
import { parseWebDriverSourceFacts } from './webdriver-source.ts';

test('Android WebDriver carries package identity and system-bar membership per same-package subtree', () => {
  const source = `<hierarchy>
    <android.widget.FrameLayout package="com.android.systemui" resource-id="com.android.systemui:id/status_bar">
      <android.widget.TextView package="com.android.systemui" text="Clock" />
      <android.widget.Button package="com.example" text="Foreign" />
      <android.widget.TextView text="Unknown owner" />
    </android.widget.FrameLayout>
    <android.widget.FrameLayout package="com.android.systemui" resource-id="com.android.systemui:id/navigation_bar_frame">
      <android.widget.Button package="com.android.systemui" text="Back" />
    </android.widget.FrameLayout>
    <android.widget.FrameLayout package="com.android.systemui" resource-id="com.android.systemui:id/split_shade_status_bar">
      <android.widget.TextView package="com.android.systemui" text="Shade clock" />
    </android.widget.FrameLayout>
    <android.widget.Button package="com.android.systemui" resource-id="com.android.systemui:id/status_bar_notification_row" text="Popup" />
    <android.widget.Button package="android" text="Dialog" />
  </hierarchy>`;
  const nodes = parseWebDriverAndroidSnapshotNodes(source);
  assert.deepEqual(
    nodes.map((node) => node.systemBar),
    [
      'status',
      'status',
      undefined,
      undefined,
      'navigation',
      'navigation',
      undefined,
      undefined,
      undefined,
      undefined,
    ],
  );
  assert.equal(nodes.find((node) => node.label === 'Clock')?.bundleId, 'com.android.systemui');
  assert.equal(nodes.find((node) => node.label === 'Foreign')?.bundleId, 'com.example');
  assert.equal(nodes.find((node) => node.label === 'Dialog')?.bundleId, 'android');
  assert.equal(nodes.find((node) => node.label === 'Unknown owner')?.bundleId, undefined);
  assert.ok(
    parseWebDriverSourceFacts(source, 'ios').nodes.every(
      (node) => !('systemBar' in node) && !('bundleId' in node),
    ),
  );
});

test('Android Appium popup ids containing status_bar stay actionable through chrome classification', () => {
  const source = `<hierarchy><android.widget.Button package="com.android.systemui" resource-id="com.android.systemui:id/status_bar_notification_row" text="Open notification" bounds="[0,0][100,40]" /></hierarchy>`;
  const nodes = attachRefs(parseWebDriverAndroidSnapshotNodes(source));
  assert.deepEqual(
    withoutSettleChrome(nodes, 'com.example').map((node) => node.label),
    ['Open notification'],
  );
});

test('Android native wrappers retain unknown ownership barriers for membership and settle', () => {
  const nodes = parseWebDriverAndroidSnapshotNodes(
    `<hierarchy>
    <android.widget.FrameLayout package="com.android.systemui" resource-id="com.android.systemui:id/status_bar">
      <android.widget.FrameLayout index="0" class="android.widget.FrameLayout" bounds="[0,0][100,40]">
        <android.widget.Button package="com.android.systemui" text="Unknown subtree action" bounds="[0,0][100,40]" />
      </android.widget.FrameLayout>
    </android.widget.FrameLayout>
  </hierarchy>`,
  );
  assert.equal(nodes[0]?.systemBar, 'status');
  assert.equal(nodes.find((node) => node.label === 'Unknown subtree action')?.systemBar, undefined);
  assert.deepEqual(
    withoutSettleChrome(attachRefs(nodes), 'com.example').map((node) => node.label),
    [undefined, 'Unknown subtree action'],
  );
});

test('Appium launcher navbuttons are navigation chrome while the surrounding taskbar stays content', () => {
  const nodes = attachRefs(
    parseWebDriverAndroidSnapshotNodes(
      `<hierarchy>
    <android.widget.FrameLayout package="com.google.android.apps.nexuslauncher" resource-id="com.google.android.apps.nexuslauncher:id/taskbar_container">
      <android.widget.FrameLayout package="com.google.android.apps.nexuslauncher" resource-id="com.google.android.apps.nexuslauncher:id/navbuttons_view">
        <android.widget.Button package="com.google.android.apps.nexuslauncher" text="Back" />
      </android.widget.FrameLayout>
      <android.widget.Button package="com.google.android.apps.nexuslauncher" text="Dock app" />
    </android.widget.FrameLayout>
  </hierarchy>`,
    ),
  );
  assert.equal(nodes.find((node) => node.label === 'Back')?.systemBar, 'navigation');
  assert.equal(nodes.find((node) => node.label === 'Dock app')?.systemBar, undefined);
  assert.deepEqual(
    withoutSettleChrome(nodes, 'com.example').map((node) => node.label),
    [undefined, 'Dock app'],
  );
});
