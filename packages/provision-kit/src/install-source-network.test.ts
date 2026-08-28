import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { afterEach, test, vi } from 'vitest';
import {
  approvePublicNetworkUrl,
  isBlockedIpAddress,
  isBlockedSourceHostname,
} from './install-source-network.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

test('blocks loopback, private, link-local, shared, and reserved address classes', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '203.0.113.10',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isBlockedIpAddress(address), true, address);
  }
  assert.equal(isBlockedIpAddress('93.184.216.34'), false);
  assert.equal(isBlockedIpAddress('2001:4860:4860::8888'), false);
});

test('rejects credentials and malformed hosts before DNS lookup', async () => {
  const lookupMock = vi.spyOn(dns, 'lookup');

  await assert.rejects(
    approvePublicNetworkUrl(new URL('https://user:pass@example.test/artifact'), {
      label: 'source URL',
    }),
    /credentials are not allowed/,
  );
  await assert.rejects(
    approvePublicNetworkUrl(
      {
        protocol: 'https:',
        username: '',
        password: '',
        hostname: 'bad%host',
      } as URL,
      { label: 'source URL' },
    ),
    /host is not allowed/,
  );

  assert.equal(isBlockedSourceHostname('bad%host'), true);
  assert.equal(lookupMock.mock.calls.length, 0);
});

test('rejects a hostname when any DNS answer is non-public', async () => {
  vi.spyOn(dns, 'lookup').mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ] as never);

  await assert.rejects(
    approvePublicNetworkUrl(new URL('https://example.test/artifact'), {
      label: 'source URL',
    }),
    /non-public address/,
  );
});

test('fails closed when DNS resolution fails or returns no answers', async () => {
  const lookupMock = vi
    .spyOn(dns, 'lookup')
    .mockRejectedValueOnce(new Error('DNS unavailable'))
    .mockResolvedValueOnce([] as never);

  await assert.rejects(
    approvePublicNetworkUrl(new URL('https://unavailable.example/artifact'), {
      label: 'source URL',
    }),
    /host could not be resolved/,
  );
  await assert.rejects(
    approvePublicNetworkUrl(new URL('https://empty.example/artifact'), {
      label: 'source URL',
    }),
    /host could not be resolved/,
  );
  assert.equal(lookupMock.mock.calls.length, 2);
});

test('returns the approved address and family for a public literal', async () => {
  await assert.doesNotReject(
    approvePublicNetworkUrl(new URL('https://93.184.216.34/artifact'), {
      label: 'Maestro runScript URL',
    }),
  );
  assert.deepEqual(
    await approvePublicNetworkUrl(new URL('https://93.184.216.34/artifact'), {
      label: 'Maestro runScript URL',
    }),
    { address: '93.184.216.34', family: 4 },
  );
});
