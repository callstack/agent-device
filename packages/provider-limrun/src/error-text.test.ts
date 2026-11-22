import { describe, expect, test } from 'vitest';
import {
  createInstanceStreamScrubber,
  safeInstanceErrorText,
  safeTerminationReason,
} from './error-text.ts';

const TOKEN = 'liminst_5f4dcc3b5aa765d61d8327deb882cf99';

describe('safeInstanceErrorText', () => {
  test('removes a bare token an instance echoed unlabeled, alone and inside other text', () => {
    expect(safeInstanceErrorText(TOKEN, [`Bearer ${TOKEN}`])).toBe('[REDACTED]');
    expect(safeInstanceErrorText(`upstream rejected ${TOKEN} at boot`, [`Bearer ${TOKEN}`])).toBe(
      'upstream rejected [REDACTED] at boot',
    );
  });

  test('removes a sent header whole, and the bare token when only it was echoed', () => {
    const value = `Bearer ${TOKEN}`;
    expect(safeInstanceErrorText(`got ${value} twice: ${TOKEN}`, [value])).toBe(
      'got [REDACTED] twice: [REDACTED]',
    );
  });

  test('keeps diagnostic text that carries no sent value', () => {
    expect(safeInstanceErrorText('xctestrun is missing Runner section', [`Bearer ${TOKEN}`])).toBe(
      'xctestrun is missing Runner section',
    );
  });

  // The credential reader of an attached instance accepts any nonempty token, so a short one is still a
  // secret. The scheme name is not: it is the same word every request sends.
  test.each(['abc123', 'x', 'a b'])('removes a short credential however brief: %s', (token) => {
    expect(safeInstanceErrorText(`echo ${token} here`, [`Bearer ${token}`])).toBe(
      'echo [REDACTED] here',
    );
    expect(safeInstanceErrorText('Bearer is not enough', [`Bearer ${token}`])).toBe(
      'Bearer is not enough',
    );
  });
});

describe('createInstanceStreamScrubber', () => {
  const headers = [`Bearer ${TOKEN}`];

  test('removes a credential split across two chunks', () => {
    const scrubber = createInstanceStreamScrubber(headers);
    const half = Math.floor(TOKEN.length / 2);
    const published =
      scrubber.push(`stream said ${TOKEN.slice(0, half)}`) +
      scrubber.push(`${TOKEN.slice(half)} then stopped`) +
      scrubber.flush();

    expect(published).not.toContain(TOKEN);
    expect(published).toContain('stream said');
    expect(published).toContain('then stopped');
  });

  test.each([1, 2, 3, 7, 13, TOKEN.length, TOKEN.length + 5])(
    'removes a credential published in chunks of %i characters',
    (size) => {
      const scrubber = createInstanceStreamScrubber(headers);
      const line = `runner failed on ${TOKEN} during boot`;
      let published = '';
      for (let offset = 0; offset < line.length; offset += size) {
        published += scrubber.push(line.slice(offset, offset + size));
      }
      published += scrubber.flush();

      expect(published).not.toContain(TOKEN);
      expect(published).toContain('runner failed on');
      expect(published).toContain('during boot');
    },
  );

  test('answers with the whole text when nothing can still be a credential', () => {
    const scrubber = createInstanceStreamScrubber(headers);
    expect(scrubber.push('simulator booted but the runner exited early') + scrubber.flush()).toBe(
      'simulator booted but the runner exited early',
    );
  });

  // The stream is a live log: a reader waits on each push, so only a tail that could still be the start of
  // a credential may be held back. `'l'` is this token's first character, so it is the one held.
  test.each([
    ['simulator booted', 'simulator booted'],
    ['simulator booted l', 'simulator booted '],
  ] as const)('releases %j on the push that carries it', (chunk, expected) => {
    const scrubber = createInstanceStreamScrubber(headers);
    expect(scrubber.push(chunk)).toBe(expected);
  });

  test('a held character that turns out to be ordinary reaches the reader with its chunk', () => {
    const scrubber = createInstanceStreamScrubber(headers);
    expect(scrubber.push('booted l')).toBe('booted ');
    expect(scrubber.push('aunch succeeded')).toBe('launch succeeded');
    expect(scrubber.flush()).toBe('');
  });
});

describe('safeTerminationReason', () => {
  // The reason ends a lease through an error's message, and a message is not bound the way a detail is.
  test.each([
    ['  InactivityTimeout  ', 'InactivityTimeout'],
    [
      'inactivity timeout reached\nLIMRUN_API_KEY=leaked\nsecond line',
      'inactivity timeout reached LIMRUN_API_KEY=leaked second line',
    ],
  ] as const)('reads %j into one published line', (input, expected) => {
    expect(safeTerminationReason(input, [])).toBe(expected);
  });

  test('answers Unknown for a terminated instance that gave no reason', () => {
    for (const reason of [undefined, '', '   ']) {
      expect(safeTerminationReason(reason, [])).toBe('Unknown');
    }
  });

  test('publishes a reason that names the account key scrubbed, on one bounded line', () => {
    const apiKey = 'lim_test_key_0123456789abcdef';
    const reason = `terminated after ${'drain '.repeat(60)}while ${apiKey} was in use`;

    const published = safeTerminationReason(reason, [apiKey]);

    expect(published).not.toContain(apiKey);
    expect(published).not.toContain('\n');
    expect(published.length).toBeLessThanOrEqual(201);
  });

  // The bound falls inside the credential: the lead-in puts the token across the 200-character cut, so
  // shortening the text before it is read would publish the token's own first characters, which are no
  // longer a whole secret and so cannot be recognised or removed. The cut may also fall inside the marker
  // that stands for a credential, which must not be published half.
  test.each([180, 191, 200, 214, 229, 230, 231])(
    'bounds a reason whose credential starts at character %i without publishing a fragment',
    (leadIn) => {
      const reason = `${'x'.repeat(leadIn)} ${TOKEN} during drain`;

      const published = safeTerminationReason(reason, [`Bearer ${TOKEN}`]);

      for (let length = 6; length <= TOKEN.length; length++) {
        expect(published).not.toContain(TOKEN.slice(0, length));
      }
      const bounded = published.endsWith('…') ? published.slice(0, -1) : published;
      for (const partial of MARKER_PARTIALS) {
        expect(bounded.endsWith(partial)).toBe(false);
      }
      expect(published).not.toContain('\n');
      expect(published.length).toBeLessThanOrEqual(201);
    },
  );
});

/** Every proper prefix of the marker `safeInstanceErrorText` answers with. */
const MARKER = '[REDACTED]';
const MARKER_PARTIALS = Array.from({ length: MARKER.length - 1 }, (_, length) =>
  MARKER.slice(0, length + 1),
);

test('matches the exact bare token before normalizing whitespace', () => {
  const token = 'synthetic  instance-token';
  const sent = ['Bearer ' + token];
  expect(safeInstanceErrorText('refused ' + token, sent)).toBe('refused [REDACTED]');
  expect(safeTerminationReason('ended\nusing ' + token, sent)).toBe('ended using [REDACTED]');
});
