import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml } from './html.js';

test('escapes text and attribute metacharacters in graph names', () => {
  assert.equal(escapeHtml(`a&<b>"'`), 'a&amp;&lt;b&gt;&quot;&#39;');
});
