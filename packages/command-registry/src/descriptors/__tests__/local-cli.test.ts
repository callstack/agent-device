import { LOCAL_CLI_COMMAND_DESCRIPTORS } from '../local-cli.ts';
import { expect, test } from 'vitest';

// the local client-backed commands: the command names it declares are pinned as literals, so a descriptor that
// leaves this family file — or a second copy of one — lands in this diff instead of being
// noticed only through a derived view.
test('local-cli declares exactly its own commands', () => {
  expect(LOCAL_CLI_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name).sort()).toEqual([
    'auth',
    'cdp',
    'connect',
    'connection',
    'daemon',
    'debug',
    'device',
    'disconnect',
    'mcp',
    'metro',
    'proxy',
    'react-devtools',
    'session',
    'takeover',
    'web',
  ]);
});
