import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { findCommandMetadata } from './command-metadata.ts';

// The UI target is top-level keys, the vocabulary an agent guesses without loading the schema.
test.for([
  [{ ref: '@e6' }, { ref: '@e6' }],
  [
    { ref: '@e6', label: 'Products' },
    { ref: '@e6', label: 'Products' },
  ],
  [{ selector: 'id=home/products' }, { selector: 'id=home/products' }],
  [
    { x: 120, y: 340 },
    { x: 120, y: 340 },
  ],
] as const)('press reads %j as its UI target', ([input, target]) => {
  expect(findCommandMetadata('press').readInput(input)).toMatchObject(target);
});

test.for([
  [{}, /Expected a UI target/],
  [{ ref: '@e6', selector: 'id=a' }, /got ref and selector/],
  [{ selector: 'id=a', x: 1, y: 2 }, /got selector and x\/y/],
  [{ x: 120 }, /Expected x and y together/],
  [{ selector: 'id=a', label: 'A' }, /label applies only with ref/],
] as const)('press refuses %j', ([input, message]) => {
  expect(() => findCommandMetadata('press').readInput(input)).toThrow(message);
});

// The schema cannot state "exactly one target": a top-level oneOf/anyOf/allOf in a tool input
// schema is rejected by some model clients. The reader enforces it, and its hint names the forms.
test.for([{}, { ref: '@e6', selector: 'id=a' }, { x: 120 }] as const)(
  'press answers %j with INVALID_ARGS and the target forms',
  (input) => {
    try {
      findCommandMetadata('press').readInput(input);
      expect.unreachable('press should refuse the input');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_ARGS');
      expect((error as AppError).details?.hint).toMatch(/\{"ref":"@e12"\}|\{"x":120,"y":340\}/);
    }
  },
);

test('the removed nested target answers with the top-level spelling', () => {
  const read = () =>
    findCommandMetadata('press').readInput({ target: { kind: 'ref', ref: '@e6' } });
  expect(read).toThrow(AppError);
  expect(read).toThrow(/target was removed.*\{"ref":"@e12"\}/);
});

test('get takes a ref or selector but no point', () => {
  const get = findCommandMetadata('get');
  expect(get.readInput({ format: 'text', selector: 'id=a' })).toMatchObject({ selector: 'id=a' });
  expect(get.inputSchema.properties).not.toHaveProperty('x');
  expect(get.inputSchema.properties).not.toHaveProperty('target');
});

// `target` without a UI target field is the deviceTarget alias. An interaction command retires
// it, so the alias must not reappear in its schema as a string a model could write a ref into.
test('interaction schemas advertise top-level target keys and no target', () => {
  for (const name of ['press', 'click', 'fill', 'longpress', 'hover'] as const) {
    const properties = findCommandMetadata(name).inputSchema.properties ?? {};
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['ref', 'label', 'selector', 'x', 'y']),
    );
    expect(properties).not.toHaveProperty('target');
  }
});
