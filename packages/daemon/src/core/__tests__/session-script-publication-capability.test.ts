import { expect, test } from 'vitest';
import { isArmedRemoteRecording } from '../session-script-publication-capability.ts';
import {
  authoringPublication,
  makeAuthoringSession,
} from '../../__tests__/support/session-factories.ts';

test.each([
  { name: 'an armed remote recording', status: 'armed', remote: true, expected: true },
  { name: 'an armed local recording', status: 'armed', remote: false, expected: false },
  { name: 'an aborted remote recording', status: 'aborted', remote: true, expected: false },
] as const)('$name is an armed remote recording: $expected', ({ status, remote, expected }) => {
  const session = makeAuthoringSession('journey', {
    scriptPublication: authoringPublication(status, { remote }),
  });

  expect(isArmedRemoteRecording(session)).toBe(expected);
});
