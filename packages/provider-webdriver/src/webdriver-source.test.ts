import assert from 'node:assert/strict';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { test } from 'vitest';
import {
  scrollFrameFromAndroidWebDriverSource,
  scrollFrameFromIosWebDriverSource,
} from './webdriver-scroll-frame.ts';
import { parseWebDriverSourceFacts } from './webdriver-source.ts';

test('Android WebDriver facts keep platform defaults and derive hittability from geometry', () => {
  const node = parseWebDriverSourceFacts(
    '<hierarchy><android.widget.Button text="Continue" bounds="[0,0][100,40]" /></hierarchy>',
    'android',
  ).nodes[0];

  assert.equal(node?.enabled, true);
  assert.equal(node?.visibleToUser, true);
  assert.equal(node?.hittable, true);
});

test('Android WebDriver facts treat invalid state attributes as false', () => {
  const node = parseWebDriverSourceFacts(
    '<hierarchy><android.widget.Button bounds="[0,0][100,40]" enabled="invalid" displayed="invalid" selected="false" focused="false" hittable="false" /></hierarchy>',
    'android',
  ).nodes[0];

  assert.equal(node?.enabled, false);
  assert.equal(node?.visibleToUser, false);
  assert.equal(node?.selected, false);
  assert.equal(node?.focused, false);
  assert.equal(node?.hittable, false);
});

// UiAutomator2 reports a field's content as `text`, the attribute every other node is labelled
// by, so a filled field used to read as a node labelled with its own value and no value at all:
// `toHaveValue` saw "" on a field holding "Ada Lovelace".
test("Android WebDriver facts name a node by its text, carry a content description beside it, and read a field's text as its value", () => {
  const [field, label] = parseWebDriverSourceFacts(
    '<hierarchy>' +
      '<android.widget.EditText text="Ada Lovelace" content-desc="Name field" hint="Your name" bounds="[0,0][100,40]" />' +
      '<android.widget.TextView text="Ada Lovelace" bounds="[0,120][100,160]" />' +
      '</hierarchy>',
    'android',
  ).nodes;

  assert.deepEqual(
    [
      field!.value,
      field!.label,
      field!.contentDescription,
      field!.placeholder,
      field!.hintShowing,
      field!.editable,
    ],
    ['Ada Lovelace', 'Ada Lovelace', 'Name field', 'Your name', undefined, true],
  );
  assert.deepEqual(
    [label!.label, label!.value, 'editable' in label!],
    ['Ada Lovelace', undefined, false],
  );
});

test('Android WebDriver facts read a hinted field as empty, a masked field as a password, and a disabled field as not editable', () => {
  const [hinted, secure, disabled, lookalike] = parseWebDriverSourceFacts(
    '<hierarchy>' +
      '<android.widget.EditText text="Your name" hint="Your name" hint-showing="true" bounds="[0,40][100,80]" />' +
      '<android.widget.EditText text="••••••" password="true" bounds="[0,80][100,120]" />' +
      '<android.widget.EditText text="locked" enabled="false" bounds="[0,120][100,160]" />' +
      '<com.edittext.sample.CustomButton text="Go" bounds="[0,160][100,200]" />' +
      '</hierarchy>',
    'android',
  ).nodes;

  // The hint is the label, as the native helper reads it, so `label="Your name"` still finds the field.
  assert.deepEqual(
    [hinted!.value, hinted!.label, hinted!.placeholder, hinted!.hintShowing],
    ['', 'Your name', 'Your name', true],
  );
  assert.deepEqual([secure!.password, secure!.editable], [true, true]);
  assert.deepEqual([disabled!.value, disabled!.editable], ['locked', false]);
  // Only the class name's last segment decides, as `isFillableType` reads it.
  assert.deepEqual(
    [lookalike!.label, lookalike!.value, 'editable' in lookalike!],
    ['Go', undefined, false],
  );
});

// UiAutomator2 writes `checkable="false" checked="false"` on every node, so `checked` is a fact
// only where `checkable` says the node can be.
test('Android WebDriver facts carry the checked state of checkable controls only', () => {
  const [on, off, button, legacySwitch] = parseWebDriverSourceFacts(
    '<hierarchy>' +
      '<android.widget.Switch checkable="true" checked="true" bounds="[0,0][100,40]" />' +
      '<android.widget.CheckBox checkable="true" checked="false" bounds="[0,40][100,80]" />' +
      '<android.widget.Button checkable="false" checked="false" bounds="[0,80][100,120]" />' +
      '<android.widget.Switch checked="true" bounds="[0,120][100,160]" />' +
      '</hierarchy>',
    'android',
  ).nodes;

  assert.deepEqual(
    [on!.checked, off!.checked, 'checked' in button!, legacySwitch!.checked],
    [true, false, false, true],
  );
});

// The native iOS runner reports no checked, editable, or password facts, so the WebDriver
// projection stays at that parity: a switch keeps its state as its value.
test('iOS WebDriver facts keep a switch value as a value and add no field facts', () => {
  const [toggle, field, secure] = parseWebDriverSourceFacts(
    '<AppiumAUT>' +
      '<XCUIElementTypeSwitch name="Wi-Fi" value="1" x="0" y="0" width="50" height="30" />' +
      '<XCUIElementTypeTextField name="email" value="ada@example.com" x="0" y="40" width="100" height="40" />' +
      '<XCUIElementTypeSecureTextField name="password" value="••••" x="0" y="80" width="100" height="40" />' +
      '</AppiumAUT>',
  ).nodes;

  assert.deepEqual([toggle!.value, 'checked' in toggle!], ['1', false]);
  assert.deepEqual(
    [field!.value, 'editable' in field!, 'password' in secure!],
    ['ada@example.com', false, false],
  );
});

test('WebDriver iOS facts preserve hardened attributes and geometry', () => {
  const facts = parseWebDriverSourceFacts(
    '<hierarchy><node text="A &gt; B" resource-id="login" bounds="[0,0][10,10]" displayed="true" enabled="true" /></hierarchy>',
  );
  const node = facts.nodes[0];

  assert.equal(node?.label, 'A > B');
  assert.equal(node?.identifier, 'login');
  assert.deepEqual(node?.rect, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(node?.enabled, true);
  assert.equal(node?.visibleToUser, true);
  assert.equal(node?.hittable, undefined);
  assert.throws(
    () => parseWebDriverSourceFacts('<node __proto__="polluted" text="x" />'),
    /Unsupported XML attribute name "__proto__"/,
  );
});

test('WebDriver iOS facts do not fill absent provider attributes', () => {
  const node = parseWebDriverSourceFacts(
    '<AppiumAUT><XCUIElementTypeButton name="Continue" x="0" y="0" width="100" height="40" /></AppiumAUT>',
  ).nodes[0];

  assert.equal(node?.label, 'Continue');
  assert.equal(node?.identifier, 'Continue');
  assert.equal('enabled' in (node ?? {}), false);
  assert.equal('selected' in (node ?? {}), false);
  assert.equal('focused' in (node ?? {}), false);
  assert.equal('visibleToUser' in (node ?? {}), false);
  assert.equal('hittable' in (node ?? {}), false);
});

test('WebDriver iOS facts preserve explicitly reported hittability', () => {
  const node = parseWebDriverSourceFacts(
    '<AppiumAUT><XCUIElementTypeButton name="Continue" hittable="true" /></AppiumAUT>',
  ).nodes[0];

  assert.equal(node?.hittable, true);
});

test('WebDriver iOS facts preserve roots without claiming hierarchy completeness', () => {
  const facts = parseWebDriverSourceFacts(
    '<AppiumAUT truncated="true"><XCUIElementTypeApplication x="0" y="0" width="390" height="844" /></AppiumAUT>',
  );

  assert.equal('truncated' in facts, false);
  assert.deepEqual(facts.roots, [
    {
      type: 'XCUIElementTypeApplication',
      rect: { x: 0, y: 0, width: 390, height: 844 },
      rectStatus: 'reported',
    },
  ]);
  assert.deepEqual(
    facts.nodes.map((node) => node.type),
    ['XCUIElementTypeApplication'],
  );
});

test('WebDriver iOS facts classify invalid root geometry', () => {
  const facts = parseWebDriverSourceFacts(
    '<AppiumAUT><XCUIElementTypeApplication x="0" y="0" width="invalid" height="844" /></AppiumAUT>',
  );

  assert.deepEqual(facts.roots, [
    {
      type: 'XCUIElementTypeApplication',
      rectStatus: 'invalid',
    },
  ]);
});

test('WebDriver iOS facts do not call partial root geometry invalid', () => {
  const facts = parseWebDriverSourceFacts(
    '<AppiumAUT><XCUIElementTypeApplication x="0" y="0" /></AppiumAUT>',
  );

  assert.deepEqual(facts.roots, [
    {
      type: 'XCUIElementTypeApplication',
      rectStatus: 'not-provided',
    },
  ]);
});

test('WebDriver iOS scroll frame prefers visible scrollable containers', async () => {
  assert.deepEqual(
    await scrollFrameFromIosWebDriverSource(
      '<AppiumAUT>' +
        '<XCUIElementTypeApplication bounds="[0,0][390,844]" />' +
        '<XCUIElementTypeScrollView bounds="[0,100][390,700]" visible="true" />' +
        '<XCUIElementTypeScrollView bounds="[0,100][30,30]" visible="true" />' +
        '</AppiumAUT>',
    ),
    { x: 0, y: 100, width: 390, height: 600 },
  );
});

test('Android WebDriver scroll frame prefers visible scrollable containers', async () => {
  assert.deepEqual(
    await scrollFrameFromAndroidWebDriverSource(
      '<hierarchy>' +
        '<android.widget.FrameLayout bounds="[0,0][1080,2400]" displayed="true" />' +
        '<android.widget.ListView bounds="[0,393][1080,1496]" displayed="true" />' +
        '<android.support.v7.widget.RecyclerView bounds="[18,597][1062,1196]" displayed="false" />' +
        '</hierarchy>',
    ),
    { x: 0, y: 393, width: 1080, height: 1103 },
  );
});

// UiAutomator2 names a tag by class and repeats it as `class`; a source may instead emit a generic
// `<node class=…>`. Both shapes describe the same widget, so they must publish the same facts.
const ANDROID_WIDGET_ATTRIBUTES =
  'index="0" package="com.example.app" text="" resource-id="com.example.app:id/w" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" displayed="true"';

function androidSourceShapes(
  className: string,
  bounds: string,
): ReadonlyArray<readonly [shape: string, source: string]> {
  const attributes = `${ANDROID_WIDGET_ATTRIBUTES} class="${className}" bounds="${bounds}"`;
  return [
    ['class-named tag', `<hierarchy rotation="0"><${className} ${attributes} /></hierarchy>`],
    ['generic node tag', `<hierarchy rotation="0"><node ${attributes} /></hierarchy>`],
  ];
}

const ANDROID_CLASS_IDENTITY_CASES = [
  {
    widget: 'EditText',
    className: 'android.widget.EditText',
    kind: 'text-field',
    editable: true,
    scrollContainer: false,
  },
  {
    widget: 'ScrollView',
    className: 'android.widget.ScrollView',
    kind: 'scroll-area',
    editable: undefined,
    scrollContainer: true,
  },
  {
    widget: 'RecyclerView',
    className: 'androidx.recyclerview.widget.RecyclerView',
    kind: 'list',
    editable: undefined,
    scrollContainer: true,
  },
  {
    widget: 'Button',
    className: 'android.widget.Button',
    kind: 'button',
    editable: undefined,
    scrollContainer: false,
  },
] as const;

for (const expected of ANDROID_CLASS_IDENTITY_CASES) {
  for (const [shape, source] of androidSourceShapes(expected.className, '[0,200][1080,1600]')) {
    test(`Android WebDriver facts publish a ${expected.widget} the same from a ${shape}`, async () => {
      const [node] = attachRefs(parseWebDriverSourceFacts(source, 'android').nodes).slice(-1);

      assert.equal(node!.type, expected.className);
      assert.equal(node!.role, expected.className);
      assert.equal(node!.kind, expected.kind);
      assert.equal(node!.editable, expected.editable);
      assert.deepEqual(
        await scrollFrameFromAndroidWebDriverSource(source),
        expected.scrollContainer ? { x: 0, y: 200, width: 1080, height: 1400 } : undefined,
      );
    });
  }
}

test('Android WebDriver facts fall back to the tag when a node reports no class', () => {
  const [empty, missing] = parseWebDriverSourceFacts(
    '<hierarchy>' +
      '<android.widget.Button class="" text="Go" bounds="[0,0][100,40]" />' +
      '<android.widget.TextView text="Hi" bounds="[0,40][100,80]" />' +
      '</hierarchy>',
    'android',
  ).nodes;

  assert.deepEqual(
    [empty!.type, missing!.type],
    ['android.widget.Button', 'android.widget.TextView'],
  );
});

test('Android WebDriver facts read a generic node tag as checkable by its class when no checkable attribute is reported', () => {
  const [node] = parseWebDriverSourceFacts(
    '<node class="android.widget.Switch" checked="true" bounds="[0,0][100,40]" />',
    'android',
  ).nodes;

  assert.equal(node!.checked, true);
});

test('iOS WebDriver facts keep the tag as the type whatever a class attribute says', () => {
  const [node] = parseWebDriverSourceFacts(
    '<AppiumAUT><XCUIElementTypeButton class="android.widget.EditText" name="Go" x="0" y="0" width="100" height="40" /></AppiumAUT>',
  ).nodes;

  assert.equal(node!.type, 'XCUIElementTypeButton');
});

test('Appium hint state uses reported evidence instead of text equality', () => {
  const nodes = parseWebDriverSourceFacts(
    '<hierarchy>' +
      '<android.widget.EditText text="Prompt" hint="Prompt" hint-showing="false" />' +
      '<android.widget.EditText text="Prompt" hint="Prompt" />' +
      '<android.widget.EditText text="Prompt" hint="Prompt" hint-showing="invalid" />' +
      '<android.widget.EditText text="Prompt" hint="Prompt" hintShowing="true" />' +
      '</hierarchy>',
    'android',
  ).nodes;
  assert.deepEqual(
    nodes.map((node) => [node.value, node.hintShowing]),
    [
      ['Prompt', false],
      ['Prompt', undefined],
      ['Prompt', undefined],
      ['', true],
    ],
  );
});

test('custom Android fields carry reported hint facts beside their content', () => {
  const nodes = parseWebDriverSourceFacts(
    '<hierarchy>' +
      '<com.example.CustomInput editable="true" text="Your name" hint="Your name" hint-showing="false" />' +
      '<com.example.CustomInput editable="true" text="Your name" hint="Your name" hint-showing="true" />' +
      '</hierarchy>',
    'android',
  ).nodes;
  assert.deepEqual(
    nodes.map((node) => [node.value, node.placeholder, node.hintShowing]),
    [
      ['Your name', 'Your name', false],
      ['', 'Your name', true],
    ],
  );
});

test('UiAutomator2 showing-hint distinguishes an empty field from hint-equal content', () => {
  const nodes = parseWebDriverSourceFacts(
    '<hierarchy>' +
      '<android.widget.EditText text="Your name" hint="Your name" showing-hint="true" input-type="1" />' +
      '<android.widget.EditText text="Your name" hint="Your name" showing-hint="false" input-type="1" />' +
      '<android.widget.EditText text="Your name" hint="Your name" showing-hint="unknown" input-type="1" />' +
      '</hierarchy>',
    'android',
  ).nodes;
  assert.deepEqual(
    nodes.map((node) => [node.value, node.placeholder, node.hintShowing]),
    [
      ['', 'Your name', true],
      ['Your name', 'Your name', false],
      ['Your name', 'Your name', undefined],
    ],
  );
});

test('UiAutomator2 input-type retains custom field content without echoing non-field labels', () => {
  const nodes = parseWebDriverSourceFacts(
    '<hierarchy>' +
      '<com.example.CustomField text="Custom content" hint="Custom hint" showing-hint="false" input-type="1" />' +
      '<com.example.CustomField text="Custom hint" hint="Custom hint" showing-hint="true" input-type="1" />' +
      ['2', '3', '4', '129']
        .map(
          (inputType) =>
            `<com.example.CustomField text="Typed content" input-type="${inputType}" />`,
        )
        .join('') +
      ['0', '5', '16', '-1', '1.5', 'invalid', '4294967297']
        .map(
          (inputType) =>
            `<android.widget.TextView text="Static label" input-type="${inputType}" />`,
        )
        .join('') +
      '</hierarchy>',
    'android',
  ).nodes;
  assert.deepEqual(
    nodes.map((node) => node.value),
    [
      'Custom content',
      '',
      'Typed content',
      'Typed content',
      'Typed content',
      'Typed content',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
  );
});
