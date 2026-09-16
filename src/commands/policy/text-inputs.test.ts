import { describe, expect, test } from 'vitest';
import { parsePolicyTextInputs, policyInputEnvName, resolveTextInput } from './text-inputs.ts';
import type { PolicyCandidate } from './policy-contract.ts';

const phoneField: PolicyCandidate = {
  ref: '@e5',
  role: 'textfield',
  name: 'Phone number',
  identifier: 'phoneField',
  value: '',
};

describe('policy text inputs', () => {
  test('parses repeated key=value tokens, keeping a value that contains =', () => {
    expect(parsePolicyTextInputs(['phone=5555550100', 'note=a=b'])).toEqual(
      new Map([
        ['phone', '5555550100'],
        ['note', 'a=b'],
      ]),
    );
  });

  test('refuses a token that is not key=value', () => {
    expect(() => parsePolicyTextInputs(['5555550100'])).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('--input expects key=value'),
      }),
    );
  });

  test('matches a key against the field identifier', () => {
    expect(resolveTextInput(phoneField, parsePolicyTextInputs(['phone=5550100']), {})).toEqual({
      key: 'phone',
      text: '5550100',
    });
  });

  test('prefers an exact match over a containing one', () => {
    const inputs = parsePolicyTextInputs(['phone=containing', 'phonefield=exact']);
    expect(resolveTextInput(phoneField, inputs, {})?.text).toBe('exact');
  });

  test('reads a value from the environment so a secret stays out of argv', () => {
    const env = { [policyInputEnvName('code')]: '482493' };
    const codeField: PolicyCandidate = {
      ref: '@e7',
      role: 'textfield',
      name: 'Code',
      identifier: 'codeField',
      value: '',
    };
    expect(resolveTextInput(codeField, new Map(), env)).toEqual({ key: 'code', text: '482493' });
  });

  test('names the environment entry for a key', () => {
    expect(policyInputEnvName('one-time code')).toBe('AGENT_DEVICE_INPUT_ONE_TIME_CODE');
  });

  test('returns nothing when no entry matches the field', () => {
    expect(resolveTextInput(phoneField, parsePolicyTextInputs(['code=1']), {})).toBeUndefined();
  });
});
