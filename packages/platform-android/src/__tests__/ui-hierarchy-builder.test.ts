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
  expect(nodes.find((node) => node.label === 'Outside dialog')).toMatchObject({
    rect: { x: 120, y: 320, width: 0, height: 0 },
    hittable: undefined,
  });
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
