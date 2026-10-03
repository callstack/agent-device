import { test } from 'vitest';
import assert from 'node:assert/strict';
import { addByte, paethPredictor, predictByte } from './png-predictor.ts';

test('each filter predicts from the neighbours the format names', () => {
  assert.equal(predictByte(0, 40, 60, 20), 0);
  assert.equal(predictByte(1, 40, 60, 20), 40);
  assert.equal(predictByte(2, 40, 60, 20), 60);
  assert.equal(predictByte(3, 40, 60, 20), 50);
  assert.equal(predictByte(4, 40, 60, 20), 60);
});

test('a missing neighbour reads as zero', () => {
  assert.equal(predictByte(1, 0, 0, 0), 0);
  assert.equal(predictByte(3, 0, 80, 0), 40);
  assert.equal(predictByte(4, 0, 80, 0), 80);
});

test('Paeth takes the nearest of the three neighbours', () => {
  assert.equal(paethPredictor(10, 9, 8), 10);
  assert.equal(paethPredictor(100, 10, 90), 10);
  assert.equal(paethPredictor(10, 200, 100), 100);
  assert.equal(paethPredictor(0, 80, 0), 80);
});

test('reconstruction wraps at one byte, as the format requires', () => {
  assert.equal(addByte(250, 10), 4);
  assert.equal(addByte(4, -10), 250);
});
