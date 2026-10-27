import { attachRefs } from '@agent-device/kernel/snapshot';
import { withoutSettleChrome } from '@agent-device/capture-kit/snapshot-chrome';
import { expect, test } from 'vitest';
import { parseUiHierarchyTree } from '../ui-hierarchy.ts';
import { buildUiHierarchySnapshot } from '../ui-hierarchy-builder.ts';

test('builder clips each Android node to its owning window before regular presentation', () => {
  // Planted red on the pre-#1968 builder: the dialog descendant inherited the largest application
  // viewport instead of the dialog window and kept a positive rectangle outside that window.
  const tree = parseUiHierarchyTree(`<hierarchy>
    <node class="android.widget.FrameLayout" bounds="[0,0][400,800]"
      window-bounds="[0,0][400,800]" window-index="0" window-type="1"
      window-layer="1" window-active="true" window-focused="true" visible-to-user="true">
      <node class="android.widget.Button" text="Main action" bounds="[20,20][180,80]"
        clickable="true" visible-to-user="true" />
    </node>
    <node class="android.widget.FrameLayout" bounds="[100,100][300,300]"
      window-bounds="[100,100][300,300]" window-index="1" window-type="2"
      window-layer="2" window-active="true" window-focused="true" visible-to-user="true">
      <node class="android.widget.Button" text="Outside dialog" bounds="[120,320][180,380]"
        clickable="true" visible-to-user="true" />
    </node>
  </hierarchy>`);

  const { nodes } = buildUiHierarchySnapshot(tree, undefined, {});
  expect(nodes.find((node) => node.label === 'Outside dialog')).toBeUndefined();
});

test('system-bar membership survives omitted containers and stays separate from the shade and overlays', () => {
  const tree = parseUiHierarchyTree(`<hierarchy>
    <node class="android.widget.FrameLayout" package="com.android.systemui" resource-id="com.android.systemui:id/status_bar_container" bounds="[0,0][400,24]">
      <node class="android.widget.TextView" package="com.android.systemui" text="Clock" bounds="[0,0][40,24]" />
      <node class="android.widget.Button" package="com.example" text="Foreign action" bounds="[40,0][80,24]" clickable="true" />
    </node>
    <node class="android.widget.FrameLayout" package="com.android.systemui" resource-id="com.android.systemui:id/navigation_bar_frame" bounds="[0,760][400,800]">
      <node class="android.widget.Button" package="com.android.systemui" text="Back" bounds="[0,760][40,800]" clickable="true" />
    </node>
    <node class="android.widget.FrameLayout" package="com.android.systemui" resource-id="com.android.systemui:id/split_shade_status_bar" bounds="[0,24][400,80]">
      <node class="android.widget.TextView" package="com.android.systemui" text="Shade clock" bounds="[0,24][40,80]" />
    </node>
    <node class="android.widget.Button" package="com.android.systemui" resource-id="com.android.systemui:id/volume_dialog" text="Volume" bounds="[0,80][40,120]" clickable="true" />
    <node class="android.widget.Button" package="android" resource-id="android:id/button1" text="Dialog OK" bounds="[0,120][40,160]" clickable="true" />
    <node class="android.widget.Button" package="com.android.systemui" resource-id="com.android.systemui:id/status_bar_notification_row" text="Notification" bounds="[0,160][40,200]" clickable="true" />
    <node class="android.widget.Button" package="com.example" resource-id="com.android.systemui:id/status_bar" text="Spoofed bar" bounds="[0,200][40,240]" clickable="true" />
  </hierarchy>`);
  for (const options of [{}, { raw: true }, { interactiveOnly: true }, { scope: 'Back' }]) {
    const { nodes } = buildUiHierarchySnapshot(tree, undefined, options);
    expect(nodes.find((node) => node.label === 'Back')?.systemBar).toBe('navigation');
    if (options.scope) continue;
    expect(
      withoutSettleChrome(attachRefs(nodes), 'com.example').some(
        (node) => node.label === 'Notification',
      ),
    ).toBe(true);
    if (!options.interactiveOnly)
      expect(nodes.find((node) => node.label === 'Clock')?.systemBar).toBe('status');
    for (const label of [
      'Foreign action',
      'Shade clock',
      'Volume',
      'Dialog OK',
      'Notification',
      'Spoofed bar',
    ]) {
      const node = nodes.find((node) => node.label === label);
      if (label === 'Shade clock' && options.interactiveOnly) continue;
      expect(node, label).toBeDefined();
      expect(node, label).not.toHaveProperty('systemBar');
    }
    if (options.interactiveOnly)
      expect(
        nodes.some((node) => node.identifier === 'com.android.systemui:id/navigation_bar_frame'),
      ).toBe(false);
  }
});

test('launcher-hosted navigation survives omitted wrappers while taskbar app icons stay separate', () => {
  const tree = parseUiHierarchyTree(`<hierarchy>
    <node class="android.widget.FrameLayout" package="com.google.android.apps.nexuslauncher" resource-id="com.google.android.apps.nexuslauncher:id/taskbar_container" bounds="[0,760][400,800]">
      <node class="android.widget.FrameLayout" package="com.google.android.apps.nexuslauncher" resource-id="com.google.android.apps.nexuslauncher:id/navbuttons_view" bounds="[0,760][200,800]">
        <node class="android.widget.Button" package="com.google.android.apps.nexuslauncher" text="Back" bounds="[0,760][40,800]" clickable="true" />
        <node class="android.widget.Button" package="com.android.systemui" text="Foreign action" bounds="[40,760][80,800]" clickable="true" />
      </node>
      <node class="android.widget.Button" package="com.google.android.apps.nexuslauncher" text="Dock app" bounds="[200,760][240,800]" clickable="true" />
    </node>
  </hierarchy>`);
  const { nodes } = buildUiHierarchySnapshot(tree, undefined, { interactiveOnly: true });
  expect(nodes.find((node) => node.label === 'Back')?.systemBar).toBe('navigation');
  expect(nodes.find((node) => node.label === 'Foreign action')).not.toHaveProperty('systemBar');
  expect(nodes.find((node) => node.label === 'Dock app')).not.toHaveProperty('systemBar');
  expect(withoutSettleChrome(attachRefs(nodes), 'com.example').map((node) => node.label)).toEqual([
    'Foreign action',
    'Dock app',
  ]);
});

test('folds a Compose role node into its clickable parent only when every guard holds', () => {
  const tree = parseUiHierarchyTree(`<hierarchy>
    <node class="android.widget.FrameLayout" bounds="[0,0][1000,1000]" visible-to-user="true">
      <node class="android.view.View" resource-id="compose-container" bounds="[0,0][1000,100]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.TextView" text="Continue" bounds="[400,0][600,100]" visible-to-user="true" />
        <node class="android.widget.Button" checked="false" bounds="[0,0][1000,100]" visible-to-user="true" />
      </node>
      <node class="android.view.View" resource-id="compose-checkbox" bounds="[0,100][1000,200]"
        clickable="true" checked="true" visible-to-user="true">
        <node class="android.widget.CheckBox" bounds="[0,130][1000,190]" visible-to-user="true" />
      </node>
      <node class="android.view.View" resource-id="labeled-role" bounds="[0,200][1000,300]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.Button" text="Details" bounds="[0,200][1000,300]" visible-to-user="true" />
      </node>
      <node class="android.view.View" resource-id="identified-role" bounds="[0,300][1000,400]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.Button" resource-id="inner" bounds="[0,300][1000,400]" visible-to-user="true" />
      </node>
      <node class="android.view.View" resource-id="parent-role" bounds="[0,400][1000,500]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.Button" bounds="[0,400][1000,500]" visible-to-user="true">
          <node class="android.widget.TextView" text="Inside" bounds="[400,400][600,500]" visible-to-user="true" />
        </node>
      </node>
      <node class="android.view.View" resource-id="nested-control" bounds="[0,500][1000,600]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.Button" clickable="true" bounds="[0,500][1000,600]" visible-to-user="true" />
      </node>
      <node class="android.view.View" resource-id="hidden-role" bounds="[0,600][1000,700]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.Button" bounds="[0,600][1000,700]" visible-to-user="false" />
      </node>
      <node class="android.view.View" resource-id="outside-role" bounds="[0,700][1000,800]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.CheckBox" bounds="[900,700][1100,800]" visible-to-user="true" />
      </node>
      <node class="android.view.View" resource-id="passive-parent" bounds="[0,800][1000,900]"
         visible-to-user="true">
        <node class="android.widget.Button" bounds="[0,800][1000,900]" visible-to-user="true" />
      </node>
      <node class="android.widget.LinearLayout" resource-id="native-parent" bounds="[0,900][1000,950]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.Button" bounds="[0,900][1000,950]" visible-to-user="true" />
      </node>
      <node class="android.view.View" resource-id="non-role-child" bounds="[0,950][1000,1000]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.ImageView" bounds="[0,950][1000,1000]" visible-to-user="true" />
      </node>
      <node class="android.view.View" resource-id="compose-radio" bounds="[0,1000][1000,1050]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.RadioButton" bounds="[0,1010][1000,1040]" visible-to-user="true" />
      </node>
      <node class="android.view.View" resource-id="compose-spinner" bounds="[0,1050][1000,1100]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.Spinner" bounds="[0,1060][1000,1090]" visible-to-user="true" />
      </node>
      <node class="android.view.View" resource-id="compose-picker" bounds="[0,1100][1000,1150]"
        clickable="true" visible-to-user="true">
        <node class="android.widget.NumberPicker" bounds="[0,1110][1000,1140]" visible-to-user="true" />
      </node>
    </node>
  </hierarchy>`);

  const describe = (nodes: ReturnType<typeof buildUiHierarchySnapshot>['nodes']) =>
    nodes
      .filter((node) => node.type !== 'android.widget.FrameLayout')
      .map((node) =>
        [node.type?.split('.').pop(), node.identifier ?? node.label ?? ''].join(' ').trim(),
      );
  const regular = buildUiHierarchySnapshot(tree, undefined, {}).nodes;
  const interactive = buildUiHierarchySnapshot(tree, undefined, { interactiveOnly: true }).nodes;

  expect(describe(regular)).toEqual([
    'Button compose-container',
    'TextView Continue',
    'CheckBox compose-checkbox',
    'View labeled-role',
    'Button Details',
    'View identified-role',
    'Button inner',
    'View parent-role',
    'Button',
    'TextView Inside',
    'View nested-control',
    'Button',
    'View hidden-role',
    'View outside-role',
    'CheckBox',
    'View passive-parent',
    'Button',
    'LinearLayout native-parent',
    'Button',
    'View non-role-child',
    'ImageView',
    'RadioButton compose-radio',
    'Spinner compose-spinner',
    'NumberPicker compose-picker',
  ]);
  expect(regular.find((node) => node.identifier === 'compose-checkbox')?.checked).toBe(true);
  expect(interactive.find((node) => node.identifier === 'compose-container')?.type).toBe(
    'android.widget.Button',
  );
});
