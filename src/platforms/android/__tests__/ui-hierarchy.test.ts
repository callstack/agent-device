import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildSnapshotState } from '../../../core/snapshot-state.ts';
import { isNodeVisibleOnScreen } from '@agent-device/contracts/snapshot';
import { androidUiNodes, parseUiHierarchyTree } from '../ui-hierarchy.ts';
import { parseUiHierarchy } from './ui-hierarchy-fixtures.ts';
import { androidSnapshotPublicationInput } from '../snapshot-capture.ts';

function publishUiHierarchy(xml: string) {
  const captured = parseUiHierarchy(xml, 800, {});
  return buildSnapshotState(androidSnapshotPublicationInput(captured), {});
}

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

test('interactive Android snapshots keep Compose semantic views inside actionable parents', () => {
  const xml = `<hierarchy>
  <node class="android.view.View" package="com.example.app" bounds="[923,158][1049,284]" clickable="true" visible-to-user="true">
    <node class="android.view.View" package="com.example.app" content-desc="Start a call" bounds="[954,189][1017,252]" visible-to-user="true"/>
    <node class="android.widget.Button" package="com.example.app" bounds="[933,168][1038,273]" visible-to-user="true"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, { interactiveOnly: true });

  assert.equal(result.nodes[0]?.hittable, true);
  assert.equal(result.nodes[1]?.label, 'Start a call');
  assert.equal(result.nodes[1]?.parentIndex, 0);
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
  assert.equal('drawingOrder' in parseUiHierarchyTree(xml).children[0]!, false);
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

  const result = parseUiHierarchy(xml, 800, {});
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

  const result = parseUiHierarchy(xml, 800, {});
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

  const result = parseUiHierarchy(xml, 800, {});
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
  // A D-pad control an agent can drive is a target regardless of which input model reaches it.
  assert.equal(focused?.hittable, true);
});

test('parseUiHierarchy reads an omitted clickable attribute the same as clickable="false"', () => {
  // The snapshot helper omits false attributes; stock UiAutomator writes them out. Those are two
  // encodings of one control, so every derived answer — public projection and pruning alike — has
  // to agree. Reading an absent attribute as a value is what made them diverge.
  const tree = (clickable: string) => `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.TextView" text="Foreground tile" bounds="[0,120][390,844]" enabled="true" visible-to-user="true" focusable="true" ${clickable} drawing-order="1"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.TextView" text="Background row" bounds="[0,220][280,280]" enabled="true" visible-to-user="true" focusable="true" ${clickable} drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const omitted = publishUiHierarchy(tree(''));
  const explicitFalse = publishUiHierarchy(tree('clickable="false"'));

  assert.deepEqual(
    explicitFalse.nodes.map((node) => [node.label, node.hittable]),
    omitted.nodes.map((node) => [node.label, node.hittable]),
  );
  // Both encodings must also agree that the foreground surface blocks the background one.
  for (const result of [omitted, explicitFalse]) {
    assert.equal(
      result.nodes.some((node) => node.label === 'Foreground tile'),
      true,
    );
    const covered = result.nodes.find((node) => node.label === 'Background row');
    assert.equal(covered?.hittable, false);
    assert.equal(covered?.interactionBlocked, 'covered');
  }
});

test('parseUiHierarchy hides Android nodes that are not visible to the user in regular snapshots', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" enabled="true" visible-to-user="true">
    <node class="android.widget.Button" text="Hidden drawer action" bounds="[10,80][200,120]" clickable="true" enabled="true" visible-to-user="false"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, {});
  assert.equal(
    result.nodes.some((node) => node.label === 'Hidden drawer action'),
    false,
  );
});

test('raw Android snapshots retain acquisition-only nodes while publication annotates covered actions (C1/C3)', () => {
  // Invisible and stale-window classification belongs to regular presentation. Occlusion does not
  // change membership: daemon publication keeps covered controls visible but non-actionable.
  const xml = `<hierarchy>
  <node window-index="0" window-type="1" window-layer="10" window-active="false" window-focused="false" class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.widget.Button" text="Stale window action" bounds="[0,0][390,60]" clickable="true" visible-to-user="true" drawing-order="1"/>
  </node>
  <node window-index="1" window-type="1" window-layer="20" window-active="true" window-focused="true" class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" clickable="true" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Foreground action" bounds="[24,420][366,480]" clickable="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Covered drawer action" bounds="[0,220][280,280]" clickable="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.widget.Button" text="Invisible action" bounds="[10,80][200,120]" clickable="true" visible-to-user="false" drawing-order="3"/>
  </node>
</hierarchy>`;
  const labels = (options: Parameters<typeof parseUiHierarchy>[2]) =>
    parseUiHierarchy(xml, 800, options)
      .nodes.map((node) => node.label)
      .filter((label): label is string => Boolean(label));

  assert.deepEqual(labels({ raw: true }), [
    'Stale window action',
    'Foreground action',
    'Covered drawer action',
    'Invisible action',
  ]);
  assert.deepEqual(labels({}), ['Foreground action', 'Covered drawer action']);
  assert.deepEqual(labels({ interactiveOnly: true }), [
    'Foreground action',
    'Covered drawer action',
  ]);
  const published = publishUiHierarchy(xml);
  assert.equal(
    published.nodes.find((node) => node.label === 'Covered drawer action')?.interactionBlocked,
    'covered',
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

  const result = parseUiHierarchy(xml, 800, {});
  assert.equal(
    result.nodes.some((node) => node.label === 'Hidden drawer action'),
    false,
  );
});

test('published Android snapshots use exact API 24 order and fail conservative without it', () => {
  // A pushed screen (header, scrollable body, footer) drawn above a still-attached drawer surface.
  // The pushed screen's presented content lies over the drawer's content, so the drawer is covered.
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" content-desc="Back" bounds="[8,40][56,88]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
      <node class="android.widget.TextView" text="Foreground screen" bounds="[72,44][300,84]" enabled="true" visible-to-user="true" drawing-order="2"/>
      <node class="android.widget.ScrollView" bounds="[0,120][390,780]" scrollable="true" enabled="true" visible-to-user="true" drawing-order="3">
        <node class="android.widget.Button" text="Foreground action" bounds="[24,140][366,200]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
      </node>
      <node class="android.widget.Button" text="Foreground footer" bounds="[0,780][390,844]" clickable="true" enabled="true" visible-to-user="true" drawing-order="4"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.ScrollView" bounds="[0,120][300,844]" scrollable="true" clickable="true" enabled="true" visible-to-user="true" drawing-order="1">
        <node class="android.widget.Button" text="Hidden drawer action" bounds="[0,220][280,280]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
      </node>
    </node>
  </node>
</hierarchy>`;

  const api24 = publishUiHierarchy(xml);
  const api23 = publishUiHierarchy(xml.replaceAll(/ drawing-order="\d+"/g, ''));

  assert.equal(
    api24.nodes.some((node) => node.label === 'Foreground action'),
    true,
  );
  const covered = api24.nodes.find((node) => node.label === 'Hidden drawer action');
  assert.equal(covered?.hittable, false);
  assert.equal(covered?.interactionBlocked, 'covered');
  assert.deepEqual(covered?.presentationHints, ['covered']);
  const unavailable = api23.nodes.find((node) => node.label === 'Hidden drawer action');
  assert.equal(unavailable?.hittable, true);
  assert.equal(unavailable?.interactionBlocked, undefined);
});

test('parseUiHierarchy keeps app content under a full-screen overlay holding one floating icon (#1806)', () => {
  // DoraemonKit injects a full-screen FrameLayout above the whole Activity purely as a drag surface
  // for a small floating icon. It presents only the icon, so it can only hide what sits under it.
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][1224,2860]" visible-to-user="true" drawing-order="0">
    <node class="android.widget.LinearLayout" bounds="[0,0][1224,2860]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.TextView" text="Editor" bounds="[48,160][600,240]" enabled="true" visible-to-user="true" drawing-order="1"/>
      <node class="android.widget.Button" text="Save" bounds="[48,2600][1176,2760]" clickable="true" enabled="true" visible-to-user="true" drawing-order="2"/>
    </node>
    <node class="android.widget.FrameLayout" resource-id="com.example.app:id/dokit_contentview_id" content-desc="dokit_contentview_id_DokitFrameLayout[1]" bounds="[0,146][1224,2912]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.ImageView" content-desc="DoKit" bounds="[1000,1200][1189,1389]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = publishUiHierarchy(xml);
  assert.deepEqual(
    result.nodes.filter((node) => node.label).map((node) => node.label),
    ['Editor', 'Save', 'dokit_contentview_id_DokitFrameLayout[1]', 'DoKit'],
  );
  assert.equal(result.nodes.find((node) => node.label === 'Save')?.hittable, true);
  assert.equal(result.nodes.find((node) => node.label === 'Save')?.interactionBlocked, undefined);
});

test('parseUiHierarchy keeps app content beside an empty labelled full-screen placeholder (#1806)', () => {
  // A match_parent placeholder container that stays VISIBLE and only receives a fragment later.
  // Its content-desc is an announcement, not paint: it draws nothing over the app.
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.widget.LinearLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Toolbar action" bounds="[0,40][390,100]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.widget.FrameLayout" resource-id="com.example.app:id/panel_host" content-desc="View[1]" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="2"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, {});
  assert.equal(
    result.nodes.some((node) => node.label === 'Toolbar action'),
    true,
  );
});

test('parseUiHierarchy keeps app content under an overlay whose only controls sit in opposite corners', () => {
  // Two floating controls in opposite corners present two corners, not the screen between them.
  // A bounding box of the presented content would span the viewport and condemn the whole app.
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.widget.LinearLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.TextView" text="Editor" bounds="[24,60][300,120]" enabled="true" visible-to-user="true" drawing-order="1"/>
      <node class="android.widget.ScrollView" bounds="[0,140][390,760]" scrollable="true" enabled="true" visible-to-user="true" drawing-order="2">
        <node class="android.widget.Button" text="Save" bounds="[24,400][366,460]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
      </node>
    </node>
    <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.ImageView" content-desc="Debug menu" bounds="[8,8][56,56]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
      <node class="android.widget.ImageView" content-desc="Frame stats" bounds="[334,788][382,836]" clickable="true" enabled="true" visible-to-user="true" drawing-order="2"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, {});
  assert.deepEqual(
    result.nodes.filter((node) => node.label).map((node) => node.label),
    ['Editor', 'Save', 'Debug menu', 'Frame stats'],
  );
});

test('parseUiHierarchy keeps app content under a focusable full-screen overlay holding one clickable icon', () => {
  // The Telegram wrapper from #1733, but with one floating clickable icon inside it. The icon makes
  // the wrapper a covering candidate; its focusability must still not paint the box, or the wrapper
  // condemns the whole app under it exactly as it did before #1733.
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.TextView" text="Your phone number" bounds="[24,200][366,260]" enabled="true" visible-to-user="true" drawing-order="1"/>
      <node class="android.widget.EditText" text="208 379 7171" bounds="[24,320][366,380]" clickable="true" focusable="true" enabled="true" visible-to-user="true" drawing-order="2"/>
    </node>
    <node class="android.view.View" bounds="[0,0][390,844]" enabled="true" visible-to-user="true" focusable="true" drawing-order="3">
      <node class="android.widget.ImageView" content-desc="Attach" bounds="[330,780][380,830]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, {});
  assert.deepEqual(
    result.nodes.filter((node) => node.label).map((node) => node.label),
    ['Your phone number', '208 379 7171', 'Attach'],
  );
});

test('parseUiHierarchy counts identifier-only markers toward what a covered sibling shows', () => {
  // A screen container carrying testID markers whose only painted content is one corner icon,
  // under a clickable header bar. The bar covers the icon, but the agent would also lose the
  // markers, which sit well outside the bar — so the container is not covered.
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" resource-id="home-screen" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.ImageView" content-desc="Menu" bounds="[8,8][56,56]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
      <node class="android.view.ViewGroup" resource-id="home-body" bounds="[0,120][390,844]" visible-to-user="true" drawing-order="2"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,120]" clickable="true" enabled="true" visible-to-user="true" drawing-order="2">
      <node class="android.widget.TextView" text="Header" bounds="[72,40][300,80]" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, {});
  assert.equal(
    result.nodes.some((node) => node.identifier === 'home-body'),
    true,
  );
});

test('parseUiHierarchy compares presented footprints so a sparse overlay never condemns a rich sibling', () => {
  // The overlay's only content is a corner badge; the sibling's content spans the screen. Box
  // geometry alone (overlay box ⊇ sibling box) would call this covered.
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.Button" text="Top action" bounds="[24,60][366,120]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
      <node class="android.widget.Button" text="Bottom action" bounds="[24,760][366,820]" clickable="true" enabled="true" visible-to-user="true" drawing-order="2"/>
    </node>
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Badge" bounds="[330,20][380,70]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, {});
  assert.deepEqual(
    result.nodes.filter((node) => node.label).map((node) => node.label),
    ['Top action', 'Bottom action', 'Badge'],
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

  const result = parseUiHierarchy(xml, 800, {});
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

  const result = parseUiHierarchy(xml, 800, {});
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

  const result = parseUiHierarchy(xml, 800, {});
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

  const result = parseUiHierarchy(xml, 800, {});
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

  const result = parseUiHierarchy(xml, 800, {});
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

  const result = parseUiHierarchy(xml, 800, {});
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

  const result = parseUiHierarchy(xml, 800, {});
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

test('parseUiHierarchy keeps app content under a childless focusable full-screen overlay', () => {
  // Telegram wraps every screen in a childless full-screen focusable View drawn above the content
  // container. Focusability is accessibility traversal, not paint (#1733).
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.View" bounds="[0,0][390,844]" enabled="true" visible-to-user="true" focusable="true" drawing-order="3"/>
    <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="1">
      <node class="android.widget.TextView" text="Your phone number" bounds="[24,200][366,260]" enabled="true" visible-to-user="true" drawing-order="1"/>
      <node class="android.widget.EditText" text="208 379 7171" bounds="[24,320][366,380]" clickable="true" focusable="true" enabled="true" visible-to-user="true" drawing-order="2"/>
    </node>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, {});
  assert.equal(
    result.nodes.some((node) => node.label === 'Your phone number'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === '208 379 7171'),
    true,
  );
});

test('parseUiHierarchy keeps an overlapped text leaf drawn inside a composite widget sibling', () => {
  // Telegram renders the "+" of "+1" as a TextView sitting inside the country-code EditText's box.
  const xml = `<hierarchy>
  <node class="android.widget.LinearLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.widget.EditText" text="1" content-desc="Country code" bounds="[40,300][130,380]" clickable="true" focusable="true" enabled="true" visible-to-user="true" drawing-order="2"/>
    <node class="android.widget.TextView" text="+" bounds="[40,310][55,370]" enabled="true" visible-to-user="true" drawing-order="1"/>
  </node>
</hierarchy>`;

  const result = parseUiHierarchy(xml, 800, {});
  assert.equal(
    result.nodes.some((node) => node.label === '+'),
    true,
  );
  assert.equal(
    result.nodes.some((node) => node.label === '1'),
    true,
  );
});

test('published Android snapshots block a clickable leaf covered by a foreground sibling', () => {
  // A tap-to-dismiss scrim is itself a touch target, so it blocks controls under its whole box.
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true" drawing-order="0">
    <node class="android.view.ViewGroup" bounds="[0,0][390,844]" clickable="true" enabled="true" visible-to-user="true" drawing-order="2">
      <node class="android.widget.Button" text="Modal action" bounds="[24,420][366,480]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
    </node>
    <node class="android.widget.Button" text="Behind the modal" bounds="[0,220][280,280]" clickable="true" enabled="true" visible-to-user="true" drawing-order="1"/>
  </node>
</hierarchy>`;

  const result = publishUiHierarchy(xml);
  assert.equal(
    result.nodes.some((node) => node.label === 'Modal action'),
    true,
  );
  const covered = result.nodes.find((node) => node.label === 'Behind the modal');
  assert.equal(covered?.hittable, false);
  assert.equal(covered?.interactionBlocked, 'covered');
});

test('parseUiHierarchy ignores attribute-name prefix spoofing', () => {
  const xml =
    "<hierarchy><node class='android.widget.TextView' hint-text='Spoofed' text='Actual' bounds='[10,20][110,60]'/></hierarchy>";

  const result = parseUiHierarchy(xml, 800, {});
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]!.value, 'Actual');
});
