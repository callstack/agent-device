import { expect, test } from 'vitest';
import { resolveRequestSessionAtIntake } from './request-session-intake.ts';

const OMITTED = { internal: { sessionOmitted: true } };

test.each([
  ['a missing session', {}, { session: 'default', ...OMITTED }],
  ['a blank session', { session: '  ' }, { session: 'default', ...OMITTED }],
  ['a session that is not a string', { session: 7 }, { session: 'default', ...OMITTED }],
  [
    'the literal default from a client that named none',
    { session: 'default', meta: { sessionExplicit: false } },
    { session: 'default', ...OMITTED },
  ],
  [
    'a client that names the default session in its meta',
    { session: 'default', meta: { sessionExplicit: true } },
    { session: 'default' },
  ],
  [
    'a client that names its session in its flags',
    { session: 'default', flags: { session: 'default' }, meta: { sessionExplicit: false } },
    { session: 'default' },
  ],
  ['a caller that predates the fact', { session: 'default' }, { session: 'default' }],
  ['a named session', { session: 'agent-a' }, { session: 'agent-a' }],
])('intake reads %s', (_label, request, expected) => {
  expect(resolveRequestSessionAtIntake(request)).toEqual(expected);
});
