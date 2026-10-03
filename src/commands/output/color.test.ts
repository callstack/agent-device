import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { test } from 'vitest';
import { colorize, supportsColor } from './color.ts';

test('supportsColor uses the stream TTY state by default', () => {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  try {
    assert.equal(supportsColor({ isTTY: true }), true);
    assert.equal(supportsColor({ isTTY: false }), false);
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
});

test('supportsColor honors explicit environment overrides', () => {
  const originalForceColor = process.env.FORCE_COLOR;
  const originalNoColor = process.env.NO_COLOR;
  try {
    process.env.FORCE_COLOR = '0';
    delete process.env.NO_COLOR;
    assert.equal(supportsColor({ isTTY: true }), false);

    process.env.FORCE_COLOR = '1';
    assert.equal(supportsColor({ isTTY: false }), true);

    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
    assert.equal(supportsColor({ isTTY: true }), false);
  } finally {
    if (typeof originalForceColor === 'string') process.env.FORCE_COLOR = originalForceColor;
    else delete process.env.FORCE_COLOR;
    if (typeof originalNoColor === 'string') process.env.NO_COLOR = originalNoColor;
    else delete process.env.NO_COLOR;
  }
});

test('colorize applies ANSI formatting without changing the text', () => {
  const text = colorize('warning', 'yellow', { validateStream: false });

  assert.equal(stripVTControlCharacters(text), 'warning');
  assert.equal(text.includes('\u001b[33m'), true);
});
