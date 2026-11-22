import { describe, expect, test } from 'vitest';
import { safeInstanceErrorText } from './error-text.ts';

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

  test('ignores a short header word, which is a scheme name rather than a secret', () => {
    expect(safeInstanceErrorText('Bearer is not enough', ['Bearer ab'])).toBe(
      'Bearer is not enough',
    );
  });
});
