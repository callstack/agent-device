import assert from 'node:assert/strict';
import { test } from 'vitest';
import { scrollFrameFromWebDriverSource } from './webdriver-scroll-frame.ts';
import { parseWebDriverSource, parseWebDriverSourceFacts } from './webdriver-source.ts';

test('WebDriver source parsing preserves hardened attributes and geometry', () => {
  const nodes = parseWebDriverSource(
    '<hierarchy><node text="A &gt; B" resource-id="login" bounds="[0,0][10,10]" displayed="true" enabled="true" /></hierarchy>',
  );

  assert.equal(nodes[0]?.label, 'A > B');
  assert.equal(nodes[0]?.identifier, 'login');
  assert.deepEqual(nodes[0]?.rect, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(nodes[0]?.enabled, true);
  assert.equal(nodes[0]?.visibleToUser, true);
  assert.equal(nodes[0]?.hittable, undefined);
  assert.throws(
    () => parseWebDriverSource('<node __proto__="polluted" text="x" />'),
    /Unsupported XML attribute name "__proto__"/,
  );
});

test('WebDriver source facts do not fill absent provider attributes', () => {
  const node = parseWebDriverSource(
    '<AppiumAUT><XCUIElementTypeButton name="Continue" x="0" y="0" width="100" height="40" /></AppiumAUT>',
  )[0];

  assert.equal(node?.label, 'Continue');
  assert.equal(node?.identifier, 'Continue');
  assert.equal('enabled' in (node ?? {}), false);
  assert.equal('visibleToUser' in (node ?? {}), false);
  assert.equal('hittable' in (node ?? {}), false);
});

test('legacy WebDriver parsing keeps Android-derived hittability explicit at its call site', () => {
  const node = parseWebDriverSource(
    '<hierarchy><android.widget.Button text="Continue" bounds="[0,0][100,40]" /></hierarchy>',
    { mode: 'legacy-derived' },
  )[0];

  assert.equal(node?.enabled, true);
  assert.equal(node?.visibleToUser, true);
  assert.equal(node?.hittable, true);
});

test('WebDriver source facts expose provider truncation without publishing wrapper nodes', () => {
  const facts = parseWebDriverSourceFacts(
    '<AppiumAUT truncated="true"><XCUIElementTypeApplication x="0" y="0" width="390" height="844" /></AppiumAUT>',
  );

  assert.equal(facts.truncated, true);
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

test('WebDriver source facts classify invalid root geometry', () => {
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

test('WebDriver scroll frame prefers visible scrollable containers', () => {
  assert.deepEqual(
    scrollFrameFromWebDriverSource(
      '<hierarchy>' +
        '<android.widget.FrameLayout bounds="[0,0][1080,2400]" displayed="true" />' +
        '<android.widget.ListView bounds="[0,393][1080,1496]" displayed="true" />' +
        '<android.support.v7.widget.RecyclerView bounds="[18,597][1062,1196]" displayed="false" />' +
        '</hierarchy>',
    ),
    { x: 0, y: 393, width: 1080, height: 1103 },
  );
});
