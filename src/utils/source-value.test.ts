import { describe, expect, test } from 'vitest';
import { buildPrimaryEnvVarName, parseSourceValue } from './source-value.ts';
import type { SourceValueDefinition } from './source-value.ts';

const LABEL = 'config file';

function parse(definition: SourceValueDefinition, value: unknown) {
  return parseSourceValue(definition, value, LABEL, 'someKey');
}

function expectInvalidArgs(fn: () => unknown, messageFragment?: string) {
  expect(fn).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      ...(messageFragment ? { message: expect.stringContaining(messageFragment) } : {}),
    }),
  );
}

describe('buildPrimaryEnvVarName', () => {
  test('converts camelCase keys into a prefixed SCREAMING_SNAKE env var', () => {
    expect(buildPrimaryEnvVarName('iosSimulatorDeviceSet')).toBe(
      'AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET',
    );
  });

  test('replaces characters that are illegal in env var names with underscores', () => {
    expect(buildPrimaryEnvVarName('foo.bar-baz')).toBe('AGENT_DEVICE_FOO_BAR_BAZ');
  });
});

describe('parseSourceValue booleans', () => {
  test('passes through real booleans untouched', () => {
    expect(parse({ type: 'boolean' }, true)).toBe(true);
    expect(parse({ type: 'boolean' }, false)).toBe(false);
  });

  test('accepts the documented truthy and falsy string literals', () => {
    for (const truthy of ['1', 'true', 'YES', ' on ']) {
      expect(parse({ type: 'boolean' }, truthy)).toBe(true);
    }
    for (const falsy of ['0', 'false', 'No', 'OFF']) {
      expect(parse({ type: 'boolean' }, falsy)).toBe(false);
    }
  });

  test('rejects strings that are not boolean literals', () => {
    expectInvalidArgs(() => parse({ type: 'boolean' }, 'maybe'), 'Expected boolean');
  });

  test('rejects non-string, non-boolean values', () => {
    expectInvalidArgs(() => parse({ type: 'boolean' }, 5), 'Expected boolean');
  });
});

describe('parseSourceValue booleanOrString', () => {
  const definition: SourceValueDefinition = { type: 'booleanOrString' };

  test('keeps booleans as booleans', () => {
    expect(parse(definition, true)).toBe(true);
  });

  test('coerces boolean-like strings into booleans', () => {
    expect(parse(definition, 'off')).toBe(false);
    expect(parse(definition, 'on')).toBe(true);
  });

  test('keeps arbitrary non-empty strings as strings', () => {
    expect(parse(definition, 'staging')).toBe('staging');
  });

  test('rejects empty strings', () => {
    expectInvalidArgs(() => parse(definition, '   '), 'boolean or non-empty string');
  });
});

describe('parseSourceValue strings', () => {
  test('accepts non-empty strings', () => {
    expect(parse({ type: 'string' }, 'value')).toBe('value');
  });

  test('rejects blank strings and non-strings', () => {
    expectInvalidArgs(() => parse({ type: 'string' }, '  '), 'non-empty string');
    expectInvalidArgs(() => parse({ type: 'string' }, 42), 'non-empty string');
  });
});

describe('parseSourceValue enums', () => {
  const definition: SourceValueDefinition = {
    type: 'enum',
    enumValues: ['ios', 'android', 'linux'],
  };

  test('accepts members of the enum', () => {
    expect(parse(definition, 'android')).toBe('android');
  });

  test('rejects values outside the enum and lists the allowed values', () => {
    expectInvalidArgs(() => parse(definition, 'windows'), 'ios, android, linux');
  });

  test('rejects non-string enum inputs', () => {
    expectInvalidArgs(() => parse(definition, 3));
  });
});

describe('parseSourceValue enum flags with setValue', () => {
  const definition: SourceValueDefinition = {
    type: 'enum',
    enumValues: ['fast'],
    setValue: 'fast',
  };

  test('returns the configured value when the input already equals it', () => {
    expect(parse(definition, 'fast')).toBe('fast');
  });

  test('treats truthy boolean-like inputs as opting in', () => {
    expect(parse(definition, true)).toBe('fast');
    expect(parse(definition, '')).toBe('fast');
    expect(parse(definition, '1')).toBe('fast');
    expect(parse(definition, 'true')).toBe('fast');
  });

  test('treats falsy boolean-like inputs as opting out', () => {
    expect(parse(definition, false)).toBeUndefined();
    expect(parse(definition, '0')).toBeUndefined();
    expect(parse(definition, 'false')).toBeUndefined();
  });

  test('rejects inputs that are not boolean-like', () => {
    expectInvalidArgs(() => parse(definition, 7), 'boolean-like value for enum flag');
  });
});

describe('parseSourceValue integers', () => {
  test('accepts numbers and numeric strings', () => {
    expect(parse({ type: 'int' }, 12)).toBe(12);
    expect(parse({ type: 'int' }, '34')).toBe(34);
  });

  test('rejects non-integers and non-numeric input', () => {
    expectInvalidArgs(() => parse({ type: 'int' }, 1.5), 'Expected integer');
    expectInvalidArgs(() => parse({ type: 'int' }, 'abc'), 'Expected integer');
    expectInvalidArgs(() => parse({ type: 'int' }, {}), 'Expected integer');
  });

  test('enforces the min bound', () => {
    expect(parse({ type: 'int', min: 0 }, 0)).toBe(0);
    expectInvalidArgs(() => parse({ type: 'int', min: 1 }, 0), 'Must be >= 1');
  });

  test('enforces the max bound', () => {
    expect(parse({ type: 'int', max: 10 }, 10)).toBe(10);
    expectInvalidArgs(() => parse({ type: 'int', max: 5 }, 6), 'Must be <= 5');
  });
});

describe('parseSourceValue numbers', () => {
  test('accepts finite decimal numbers and numeric strings', () => {
    expect(parse({ type: 'number' }, 0.3)).toBe(0.3);
    expect(parse({ type: 'number' }, '0.75')).toBe(0.75);
  });

  test('rejects non-numeric input and enforces bounds', () => {
    expectInvalidArgs(() => parse({ type: 'number' }, 'abc'), 'Expected number');
    expectInvalidArgs(() => parse({ type: 'number', min: 0.01 }, 0), 'Must be >= 0.01');
    expectInvalidArgs(() => parse({ type: 'number', max: 1 }, 1.1), 'Must be <= 1');
  });
});

describe('parseSourceValue multiple', () => {
  test('maps over an array, parsing each entry with the singular definition', () => {
    expect(parse({ type: 'int', multiple: true }, ['1', '2', 3])).toEqual([1, 2, 3]);
  });

  test('wraps a single scalar value into a one-element array', () => {
    expect(parse({ type: 'string', multiple: true }, 'only')).toEqual(['only']);
  });

  test('propagates validation errors from individual entries', () => {
    expectInvalidArgs(
      () => parse({ type: 'int', multiple: true }, ['1', 'nope']),
      'Expected integer',
    );
  });
});
