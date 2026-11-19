import { expect, test } from 'vitest';
import {
  daemonStartupProgressMessage,
  parseDaemonStartupProgressMessage,
} from '@agent-device/daemon-contracts/daemon-startup-phases';

test.each([
  'modules-loaded',
  'composition-loaded',
  'lock-acquired',
  'recovery-finished',
  'listening',
  'registered',
] as const)('the %s phase message parses', (phase) => {
  expect(parseDaemonStartupProgressMessage(daemonStartupProgressMessage(phase))).toBe(phase);
});

test.each([
  ['null', null],
  ['a string', 'daemon-startup-phase'],
  ['an unknown type', { type: 'heartbeat', phase: 'listening' }],
  ['an unknown phase', { type: 'daemon-startup-phase', phase: 'heartbeat' }],
  ['a non-string phase', { type: 'daemon-startup-phase', phase: 7 }],
])('parsing ignores %s', (_name, message) => {
  expect(parseDaemonStartupProgressMessage(message)).toBeNull();
});
