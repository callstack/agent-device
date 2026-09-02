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
