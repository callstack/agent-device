import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGeneratedJson } from './format-generated-json.mjs';

test('generated fixtures use the repository JSON format', () => {
  const formatted = formatGeneratedJson({ matches: ['card'], selected: 'card' });

  assert.equal(formatted, '{\n  "matches": ["card"],\n  "selected": "card"\n}\n');
  assert.deepEqual(JSON.parse(formatted), { matches: ['card'], selected: 'card' });
});
