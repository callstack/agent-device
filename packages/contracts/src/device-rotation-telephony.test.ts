import { expect, test } from 'vitest';
import {
  parseTelephonyEventInput,
  parseTelephonyPositionals,
  telephonyPositionals,
} from './device-rotation.ts';

test('parses each action with its number, normalizing the action and trimming the number', () => {
  expect(parseTelephonyEventInput({ action: ' CALL ', number: ' 5551234 ' })).toEqual({
    action: 'call',
    number: '5551234',
  });
  expect(parseTelephonyEventInput({ action: 'accept', number: '+15551234567' })).toEqual({
    action: 'accept',
    number: '+15551234567',
  });
  expect(parseTelephonyEventInput({ action: 'call', number: `+${'1'.repeat(15)}` })).toEqual({
    action: 'call',
    number: `+${'1'.repeat(15)}`,
  });
  expect(parseTelephonyEventInput({ action: 'cancel', number: '5551234' })).toEqual({
    action: 'cancel',
    number: '5551234',
  });
  expect(parseTelephonyEventInput({ action: 'sms', number: '5551234', text: ' hi ' })).toEqual({
    action: 'sms',
    number: '5551234',
    text: ' hi ',
  });
});

test('keeps SMS text verbatim, including quotes, backslashes, and line breaks', () => {
  const text = `It's "on"\nC:\\videos $HOME`;
  expect(parseTelephonyEventInput({ action: 'sms', number: '5551234', text })).toMatchObject({
    text,
  });
});

test('normalizes a CRLF line break to LF', () => {
  expect(
    parseTelephonyEventInput({ action: 'sms', number: '5551234', text: 'Line 1\r\nLine 2' }),
  ).toMatchObject({ text: 'Line 1\nLine 2' });
});

test.each([
  [{}, 'telephony requires an action'],
  [{ action: 'ring', number: '5551234' }, 'Invalid telephony action: ring'],
  [{ action: 'call' }, 'telephony call requires a phone number'],
  [{ action: 'call', number: '   ' }, 'telephony call requires a phone number'],
  [{ action: 'call', number: '555 1234' }, 'Invalid phone number'],
  [{ action: 'call', number: '+1-555-1234' }, 'Invalid phone number'],
  [{ action: 'call', number: '1'.repeat(16) }, 'Invalid phone number'],
  [{ action: 'cancel', number: '5551234', text: 'hi' }, 'takes only a phone number'],
  [{ action: 'sms', number: '5551234' }, 'telephony sms requires message text'],
  [{ action: 'sms', number: '5551234', text: '' }, 'telephony sms requires message text'],
  [{ action: 'sms', number: '5551234', text: 'a\rb' }, 'must not contain control characters'],
  [{ action: 'sms', number: '5551234', text: 'a\u0000b' }, 'must not contain control characters'],
  [{ action: 'sms', number: '5551234', text: 'a\u0085b' }, 'must not contain control characters'],
])('refuses %o with INVALID_ARGS', (input, message) => {
  expect(() => parseTelephonyEventInput(input)).toThrow(
    expect.objectContaining({ code: 'INVALID_ARGS', message: expect.stringContaining(message) }),
  );
});

test('positionals join the SMS words and round-trip through the daemon positionals', () => {
  const sms = parseTelephonyPositionals(['sms', '5551234', 'Your', 'code', 'is', '42']);
  expect(sms).toEqual({ action: 'sms', number: '5551234', text: 'Your code is 42' });
  expect(telephonyPositionals(sms)).toEqual(['sms', '5551234', 'Your code is 42']);
  expect(parseTelephonyPositionals(telephonyPositionals(sms))).toEqual(sms);

  const call = parseTelephonyPositionals(['call', '5551234']);
  expect(telephonyPositionals(call)).toEqual(['call', '5551234']);
});
