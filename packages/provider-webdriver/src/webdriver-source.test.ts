import assert from 'node:assert/strict';
import { test } from 'vitest';
import { scrollFrameFromWebDriverSource } from './webdriver-scroll-frame.ts';
import { parseWebDriverSource } from './webdriver-source.ts';

test('WebDriver source parsing preserves hardened attributes and geometry', () => {
  const nodes = parseWebDriverSource(
    '<hierarchy><node text="A &gt; B" resource-id="login" bounds="[0,0][10,10]" displayed="true" /></hierarchy>',
  );

  assert.equal(nodes[0]?.label, 'A > B');
  assert.equal(nodes[0]?.identifier, 'login');
  assert.deepEqual(nodes[0]?.rect, { x: 0, y: 0, width: 10, height: 10 });
  assert.throws(
    () => parseWebDriverSource('<node __proto__="polluted" text="x" />'),
    /Unsupported XML attribute name "__proto__"/,
  );
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
