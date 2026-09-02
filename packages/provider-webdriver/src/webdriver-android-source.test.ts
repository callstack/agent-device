import assert from 'node:assert/strict';
import { test } from 'vitest';
import { scrollFrameFromAndroidWebDriverSource } from './webdriver-scroll-frame.ts';
import { parseAndroidWebDriverSource } from './webdriver-android-source.ts';

test('Android WebDriver parsing derives complete source state at its platform-owned call site', () => {
  const node = parseAndroidWebDriverSource(
    '<hierarchy><android.widget.Button text="Continue" bounds="[0,0][100,40]" /></hierarchy>',
  )[0];

  assert.equal(node?.enabled, true);
  assert.equal(node?.visibleToUser, true);
  assert.equal(node?.hittable, true);
});

test('Android WebDriver parsing keeps source booleans and ignores iOS hints', () => {
  const node = parseAndroidWebDriverSource(
    '<hierarchy><android.widget.Button bounds="[0,0][100,40]" enabled="invalid" displayed="invalid" selected="false" focused="false" hittable="false" /></hierarchy>',
  )[0];

  assert.equal(node?.enabled, false);
  assert.equal(node?.visibleToUser, false);
  assert.equal(node?.selected, false);
  assert.equal(node?.focused, false);
  assert.equal(node?.hittable, false);
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
