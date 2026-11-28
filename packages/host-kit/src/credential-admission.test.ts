import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { admitCredentialDestination } from './credential-admission.ts';

let stderr: string[] = [];

beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
    stderr.push(String(chunk));
    const callback = rest.find(
      (arg): arg is (error: Error | null) => void => typeof arg === 'function',
    );
    // A real stream calls back on a later tick, with null on success.
    if (callback) process.nextTick(callback, null);
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

test('a stderr that throws does not change the outcome or keep a listener', () => {
  const listeners = process.stderr.listenerCount('error');
  vi.mocked(process.stderr.write).mockImplementation(() => {
    throw new Error('EPIPE');
  });

  expect(() => admitCredentialDestination('http://broken-stderr.example.test', {})).not.toThrow();
  expect(process.stderr.listenerCount('error')).toBe(listeners);
});

test('warnings for 11 origins in one tick leave no error listener behind', async () => {
  const listeners = process.stderr.listenerCount('error');
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on('warning', onWarning);
  try {
    for (let index = 0; index < 11; index += 1) {
      admitCredentialDestination(`http://many-${index}.example.test`, {});
    }
    // Pending writes share at most one listener on the stream.
    expect(process.stderr.listenerCount('error')).toBeLessThanOrEqual(listeners + 1);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', onWarning);
  }

  expect(stderr).toHaveLength(11);
  expect(process.stderr.listenerCount('error')).toBe(listeners);
  expect(warnings.map((warning) => warning.name)).not.toContain('MaxListenersExceededWarning');
});

test('a secure destination and the override stay silent', () => {
  admitCredentialDestination('https://quiet.example.test', {});
  admitCredentialDestination('http://127.0.0.1:4310', {});
  admitCredentialDestination('http://quiet.example.test', {
    AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT: '1',
  });

  expect(stderr).toEqual([]);
});
