import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { admitCredentialDestination } from './credential-admission.ts';

let stderr: string[] = [];

beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('an insecure destination is warned about once per origin and not refused', () => {
  admitCredentialDestination('http://user:hunter2@once.example.test:7777/a?token=secret', {});
  admitCredentialDestination('http://once.example.test:7777/b', {});
  admitCredentialDestination('http://once.example.test:8888', {});

  expect(stderr).toHaveLength(2);
  expect(stderr[0]).toMatch(/^Warning: .*http:\/\/once\.example\.test:7777 .*cleartext/);
  expect(stderr[0]).toContain('agent-device 0.22 will refuse this');
  for (const fix of ['https', 'ssh -L', 'Tailscale Serve']) expect(stderr[0]).toContain(fix);
  expect(stderr[0]).toContain('AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT=1');
  expect(stderr.join('')).not.toMatch(/user|hunter2|secret/);
  expect(stderr[1]).toContain('http://once.example.test:8888');
});

test('a stderr that fails does not change the outcome', () => {
  const listeners = process.stderr.listenerCount('error');
  let listenersAtWrite = 0;
  vi.mocked(process.stderr.write).mockImplementation(() => {
    // A closed reader reports EPIPE as an event; without a listener at write time it is fatal.
    listenersAtWrite = process.stderr.listenerCount('error');
    throw new Error('EPIPE');
  });

  expect(() => admitCredentialDestination('http://broken-stderr.example.test', {})).not.toThrow();
  expect(listenersAtWrite).toBe(listeners + 1);
});

test('a secure destination and the override stay silent', () => {
  admitCredentialDestination('https://quiet.example.test', {});
  admitCredentialDestination('http://127.0.0.1:4310', {});
  admitCredentialDestination('http://quiet.example.test', {
    AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT: '1',
  });

  expect(stderr).toEqual([]);
});
