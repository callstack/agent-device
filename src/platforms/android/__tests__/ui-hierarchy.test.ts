import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildSnapshotState } from '../../../daemon/handlers/snapshot-capture.ts';
import { isNodeVisibleOnScreen } from '../../../snapshot/mobile-snapshot-semantics.ts';
import { androidUiNodes, parseUiHierarchy } from '../ui-hierarchy.ts';

test('parseUiHierarchy does not truncate when no max node count is requested', () => {
  const xml = [
    '<hierarchy>',
    ...Array.from(
      { length: 900 },
      (_, index) =>
        `<node text="Item ${index}" class="android.widget.TextView" enabled="true" bounds="[0,${index}][100,${index + 1}]" />`,
    ),
    '</hierarchy>',
  ].join('');

  const result = parseUiHierarchy(xml, undefined, { raw: true });

  assert.equal(result.nodes.length, 900);
  assert.equal(result.truncated, undefined);
});

test('parseUiHierarchy reads double-quoted Android node attributes', () => {
  const xml =
    '<hierarchy><node class="android.widget.TextView" text="Hello" content-desc="Greeting" resource-id="com.demo:id/title" bounds="[10,20][110,60]" clickable="true" enabled="true"/></hierarchy>';

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Hello');
  assert.equal(result.nodes[0]!.label, 'Hello');
  assert.equal(result.nodes[0]!.identifier, 'com.demo:id/title');
  assert.deepEqual(result.nodes[0]!.rect, { x: 10, y: 20, width: 100, height: 40 });
  assert.equal(result.nodes[0]!.hittable, true);
  assert.equal(result.nodes[0]!.enabled, true);
  assert.equal(result.nodes[0]!.visibleToUser, undefined);
});

test('parseUiHierarchy reads single-quoted Android node attributes', () => {
  const xml =
    "<hierarchy><node class='android.widget.TextView' text='Hello' content-desc='Greeting' resource-id='com.demo:id/title' bounds='[10,20][110,60]' clickable='true' enabled='true'/></hierarchy>";

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Hello');
  assert.equal(result.nodes[0]!.label, 'Hello');
  assert.equal(result.nodes[0]!.identifier, 'com.demo:id/title');
  assert.deepEqual(result.nodes[0]!.rect, { x: 10, y: 20, width: 100, height: 40 });
  assert.equal(result.nodes[0]!.hittable, true);
  assert.equal(result.nodes[0]!.enabled, true);
});

test('parseUiHierarchy supports mixed quote styles in one node', () => {
  const xml =
    '<hierarchy><node class="android.widget.TextView" text=\'Hello\' content-desc="Greeting" resource-id=\'com.demo:id/title\' bounds="[10,20][110,60]"/></hierarchy>';

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Hello');
  assert.equal(result.nodes[0]!.label, 'Hello');
  assert.equal(result.nodes[0]!.identifier, 'com.demo:id/title');
});

test('parseUiHierarchy decodes XML entities in Android node attributes', () => {
  const xml =
    '<hierarchy><node class="android.widget.TextView" text="Line 1&#10;Line 2&#9;&amp;&lt;&gt;&quot;&apos;" bounds="[0,0][10,10]"/></hierarchy>';

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Line 1\nLine 2\t&<>"\'');
  assert.equal(result.nodes[0]!.label, 'Line 1\nLine 2\t&<>"\'');
});

test('parseUiHierarchy keeps visible Android nodes with meaningful test identifiers', () => {
  const xml = `<hierarchy>
  <node class="android.widget.ScrollView" package="com.example.app" bounds="[0,0][1080,1886]" clickable="true" visible-to-user="true">
    <node class="android.view.ViewGroup" package="com.example.app" resource-id="album-0" bounds="[0,0][540,540]" visible-to-user="true"/>
    <node class="android.widget.ImageView" package="com.example.app" bounds="[0,0][540,540]" visible-to-user="true"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, {});

  assert.equal(
    result.nodes.some((node) => node.identifier === 'album-0'),
    true,
  );
});

test('interactive Android snapshots keep a fixed sibling outside filtered scroll content (#1377)', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][400,800]" visible-to-user="true">
    <node class="android.view.View" bounds="[0,0][400,800]" visible-to-user="true">
      <node class="android.widget.ScrollView" bounds="[0,100][400,800]" scrollable="true" visible-to-user="true">
        <node class="android.widget.TextView" text="Row 1" bounds="[0,100][400,160]" clickable="true" visible-to-user="true"/>
      </node>
      <node class="android.view.View" bounds="[0,0][400,100]" visible-to-user="true">
        <node class="android.view.View" resource-id="header-action" bounds="[340,20][400,80]" clickable="true" visible-to-user="true"/>
      </node>
    </node>
  </node>
</hierarchy>`;

  const parsed = parseUiHierarchy(xml, 800, { interactiveOnly: true });
  const snapshot = buildSnapshotState(
    { nodes: parsed.nodes, backend: 'android' },
    { snapshotInteractiveOnly: true },
  );
  const header = snapshot.nodes.find((node) => node.identifier === 'header-action');

  assert.equal(header?.parentIndex, undefined);
  assert.equal(header && isNodeVisibleOnScreen(header, snapshot.nodes), true);
});

test('parseUiHierarchy reads Android bounds with negative coordinates', () => {
  const xml =
    '<hierarchy><node class="android.widget.TextView" text="Clipped" bounds="[0,935][-67,994]"/></hierarchy>';

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.deepEqual(result.nodes[0]!.rect, { x: 0, y: 935, width: 0, height: 59 });
});

test('androidUiNodes exposes decoded Android hierarchy metadata', () => {
  const xml =
    '<hierarchy><node package="com.example.app" class="android.widget.EditText" text="Fish &amp; Chips" content-desc="Search&#10;field" resource-id="com.example.app:id/search" bounds="[10,20][110,70]" clickable="false" enabled="true" visible-to-user="true" drawing-order="4" focusable="true" focused="true" password="true" window-index="0" window-type="1" window-layer="3" window-active="true" window-focused="false" window-bounds="[0,0][390,844]"/></hierarchy>';

  assert.deepEqual(Array.from(androidUiNodes(xml)), [
    {
      text: 'Fish & Chips',
      desc: 'Search\nfield',
      resourceId: 'com.example.app:id/search',
      packageName: 'com.example.app',
      className: 'android.widget.EditText',
      bounds: '[10,20][110,70]',
      rect: { x: 10, y: 20, width: 100, height: 50 },
      clickable: false,
      enabled: true,
      visibleToUser: true,
      drawingOrder: 4,
      focusable: true,
      focused: true,
      password: true,
      windowIndex: 0,
      windowType: 1,
      windowLayer: 3,
      windowActive: true,
      windowFocused: false,
      windowRect: { x: 0, y: 0, width: 390, height: 844 },
    },
  ]);
});

test('parseUiHierarchy discards stale inactive Android application windows', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][390,844]" window-index="0" window-type="1" window-layer="10" window-active="true" window-focused="true" window-bounds="[0,0][390,844]">
    <node class="android.widget.TextView" text="Foreground article" bounds="[10,20][200,60]" enabled="true"/>
  </node>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][300,844]" window-index="1" window-type="1" window-layer="9" window-active="false" window-focused="false" window-bounds="[0,0][300,844]">
    <node class="android.widget.TextView" text="Stale drawer item" bounds="[10,20][200,60]" enabled="true"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Foreground article'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Stale drawer item'),
    false,
  );
});

test('parseUiHierarchy keeps the active Android application overlay window', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][390,844]" window-index="0" window-type="1" window-layer="9" window-active="false" window-focused="false" window-bounds="[0,0][390,844]">
    <node class="android.widget.TextView" text="Covered content" bounds="[10,20][200,60]" enabled="true"/>
  </node>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][300,844]" window-index="1" window-type="1" window-layer="10" window-active="true" window-focused="true" window-bounds="[0,0][300,844]">
    <node class="android.widget.TextView" text="Foreground drawer item" bounds="[10,20][200,60]" enabled="true"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Covered content'),
    false,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Foreground drawer item'),
    true,
  );
});

test('parseUiHierarchy keeps only the top active Android application window', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][390,844]" window-index="0" window-type="1" window-layer="9" window-active="true" window-focused="false" window-bounds="[0,0][390,844]">
    <node class="android.widget.TextView" text="Active stale content" bounds="[10,20][200,60]" enabled="true"/>
  </node>
  <node class="android.widget.FrameLayout" package="com.example.app" bounds="[0,0][390,844]" window-index="1" window-type="1" window-layer="10" window-active="true" window-focused="true" window-bounds="[0,0][390,844]">
    <node class="android.widget.TextView" text="Top active content" bounds="[10,20][200,60]" enabled="true"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Active stale content'),
    false,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Top active content'),
    true,
  );
});

test('parseUiHierarchy excludes Android nodes that are not visible to the user', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">
    <node class="android.widget.Button" text="Visible action" bounds="[10,20][200,60]" clickable="true" enabled="true" visible-to-user="true"/>
    <node class="android.widget.Button" text="Hidden drawer action" bounds="[10,80][200,120]" clickable="true" enabled="true" visible-to-user="false"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { interactiveOnly: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Visible action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Hidden drawer action'),
    false,
  );
});

test('parseUiHierarchy keeps focused non-clickable Android TV nodes in interactive snapshots', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][960,540]" enabled="true" visible-to-user="true">
    <node class="android.widget.TextView" text="Featured" bounds="[80,80][360,160]" clickable="false" focusable="true" focused="true" enabled="true" visible-to-user="true"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { interactiveOnly: true });
  const focused = result.nodes.find((node) => node.label === 'Featured');

  assert.equal(focused?.focused, true);
  assert.equal(focused?.hittable, false);
});

test('parseUiHierarchy prunes Android nodes that are not visible to the user in raw snapshots', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">
    <node class="android.widget.Button" text="Hidden drawer action" bounds="[10,80][200,120]" clickable="true" enabled="true" visible-to-user="false"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes[0]!.visibleToUser, true);
  assert.equal(
    result.nodes.some((node) => node.label === 'Hidden drawer action'),
    false,
  );
});

test('parseUiHierarchy prunes descendants of Android nodes that are not visible to the user', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" enabled="true" visible-to-user="false">
      <node class="android.widget.Button" text="Hidden drawer action" bounds="[10,80][200,120]" clickable="true" enabled="true" visible-to-user="true"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Hidden drawer action'),
    false,
  );
});

test('parseUiHierarchy prunes lower drawing-order subtrees covered by a foreground sibling', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Foreground action" bounds="[24,420][366,480]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.ScrollView" bounds="[0,120][300,844]" scrollable="true" clickable="true" enabled="true" visible-to-user="true" drawing-order="1">
        <node class="android.widget.Button" text="Hidden drawer action" bounds="[0,220][280,280]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
      </node>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Foreground action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Hidden drawer action'),
    false,
  );
});

test('parseUiHierarchy keeps visible identifier-only markers beside covering content', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" resource-id="post-auth-screen" bounds="[0,120][390,844]" visible-to-user="true" drawing-order="1"/>
    <node class="android.view.ViewGroup" bounds="[0,120][390,844]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Tab 1" bounds="[0,120][195,180]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.identifier === 'post-auth-screen'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Tab 1'),
    true,
  );
});

test('parseUiHierarchy keeps visible side-by-side drawer and content subtrees', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][120,844]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Visible drawer action" bounds="[0,220][110,280]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[120,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Visible content action" bounds="[150,420][366,480]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Visible drawer action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Visible content action'),
    true,
  );
});

test('parseUiHierarchy keeps lower siblings when drawing-order metadata is unavailable', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true">
      <node class="android.widget.Button" text="Foreground action" bounds="[24,420][366,480]" clickable="true" enabled="true" visible-to-user="true"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true">
      <node class="android.widget.Button" text="Legacy drawer action" bounds="[0,220][280,280]" clickable="true" enabled="true" visible-to-user="true"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Foreground action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Legacy drawer action'),
    true,
  );
});

test('parseUiHierarchy keeps overlapping siblings when drawing-order ties', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="First tied action" bounds="[24,420][366,480]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Second tied action" bounds="[0,220][280,280]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'First tied action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Second tied action'),
    true,
  );
});

test('parseUiHierarchy keeps lower siblings below the covered-area threshold', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,717]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Partial overlay action" bounds="[24,420][366,480]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Mostly visible action" bounds="[0,760][280,820]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Partial overlay action'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Mostly visible action'),
    true,
  );
});

test('parseUiHierarchy keeps lower siblings covered only by non-agent-visible overlays', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="2"/>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Still visible action" bounds="[0,220][280,280]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Still visible action'),
    true,
  );
});

test('parseUiHierarchy keeps React Native content under a transparent Expo tools overlay', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.TextView" text="Agent Device Tester" bounds="[24,80][280,140]" enabled="true" visible-to-user="true" drawing-order="1"/>
      <node class="android.widget.Button" text="Gesture lab" bounds="[24,180][280,240]" clickable="true" enabled="true" visible-to-user="true" drawing-order="2"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.ImageView" content-desc="Tools" bounds="[320,80][360,120]" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(
    result.nodes.some((node) => node.label === 'Agent Device Tester'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Gesture lab'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === 'Tools'),
    true,
  );
});

test('parseUiHierarchy ignores attribute-name prefix spoofing', () => {
  const xml =
    "<hierarchy><node class='android.widget.TextView' hint-text='Spoofed' text='Actual' bounds='[10,20][110,60]'/></hierarchy>";

  const result = parseUiHierarchy(xml, 800, { raw: true });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Actual');
});
