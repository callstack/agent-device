import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScrubber, leaksName, REDACTED, tokenize, wordsOf } from './redaction.ts';

test('tokenises on non-alphanumerics and camelCase boundaries', () => {
  assert.deepEqual(
    tokenize('packages/host-kit/src/hostKit HostKit AXBridge').map((t) => t.text),
    ['packages', 'host', 'kit', 'src', 'host', 'kit', 'host', 'kit', 'ax', 'bridge'],
  );
  assert.deepEqual(wordsOf('daemon-server'), ['daemon', 'server']);
  assert.deepEqual(wordsOf('(root)'), ['root']);
});

test('scrubs every spelling of a family name, longest names first', () => {
  const scrubber = createScrubber(['host-kit', 'cli', 'cli-schema', 'daemon-server', 'daemon']);
  assert.deepEqual(scrubber.targets, ['cli-schema', 'daemon-server', 'host-kit', 'cli', 'daemon']);
  assert.equal(
    scrubber.scrub('packages/host-kit/src/a.ts uses hostKit and HostKit'),
    `packages/${REDACTED}/src/a.ts uses ${REDACTED} and ${REDACTED}`,
  );
  assert.equal(
    scrubber.scrub('src/cli-schema/x.ts, src/cli/y.ts'),
    `src/${REDACTED}/x.ts, src/${REDACTED}/y.ts`,
  );
  assert.equal(scrubber.scrub('src/daemon/handlers.ts'), `src/${REDACTED}/handlers.ts`);
});

test('leaves words that merely contain a family name alone', () => {
  const scrubber = createScrubber(['cli', 'core', 'mcp']);
  assert.equal(scrubber.scrub('client clicks the scoreboard'), 'client clicks the scoreboard');
  assert.equal(leaksName('client clicks the scoreboard', ['cli', 'core']), false);
});

test('leak detection and scrubbing agree by construction', () => {
  const names = ['capture-kit', 'commands', '(root)'];
  const scrubber = createScrubber(names);
  for (const text of [
    'move captureKit to packages/capture-kit',
    'the commands folder',
    'repo root path',
    'CaptureKit/Commands',
  ]) {
    assert.equal(leaksName(text, names), true, text);
    assert.equal(leaksName(scrubber.scrub(text), names), false, scrubber.scrub(text));
  }
  assert.equal(scrubber.scrub('nothing here'), 'nothing here');
});
