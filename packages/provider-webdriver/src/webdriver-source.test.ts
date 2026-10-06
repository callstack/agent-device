import assert from 'node:assert/strict';
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
    ['Ada Lovelace', 'Ada Lovelace', 'Name field', 'Your name', false, true],
  );
  assert.deepEqual(
    [label!.label, label!.value, 'editable' in label!],
    ['Ada Lovelace', undefined, false],
  );
});

test('Android WebDriver facts read a hinted field as empty, a masked field as a password, and a disabled field as not editable', () => {
  const [hinted, secure, disabled, lookalike] = parseWebDriverSourceFacts(
    '<hierarchy>' +
      '<android.widget.EditText text="Your name" hint="Your name" bounds="[0,40][100,80]" />' +
      '<android.widget.EditText text="••••••" password="true" bounds="[0,80][100,120]" />' +
      '<android.widget.EditText text="locked" enabled="false" bounds="[0,120][100,160]" />' +
      '<com.edittext.sample.CustomButton text="Go" bounds="[0,160][100,200]" />' +
      '</hierarchy>',
    'android',
  ).nodes;

  // The hint is the label, as the native helper reads it, so `label="Your name"` still finds the field.
  assert.deepEqual(
    [hinted!.value, hinted!.label, hinted!.placeholder, hinted!.hintShowing],
    [undefined, 'Your name', 'Your name', true],
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

test('WebDriver iOS scroll frame prefers visible scrollable containers', () => {
  assert.deepEqual(
    scrollFrameFromIosWebDriverSource(
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
