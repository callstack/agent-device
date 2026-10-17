import Limrun from '@limrun/api';
import { expect, test } from 'vitest';
import { limrunUserAgent } from './client-options.ts';

test('the Limrun SDK sends the agent-device prefix ahead of its own User-Agent', async () => {
  const userAgents: Array<string | null> = [];
  const limrun = new Limrun({
    apiKey: 'lim_test_key',
    baseURL: 'https://limrun.example',
    maxRetries: 0,
    userAgent: limrunUserAgent('1.2.3'),
    fetch: async (_url, init) => {
      userAgents.push(new Headers(init?.headers).get('user-agent'));
      return new Response(JSON.stringify({ metadata: { id: 'instance-1' }, status: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await limrun.iosInstances.create({});
  await limrun.androidInstances.delete('instance-1');

  expect(userAgents).toHaveLength(2);
  for (const userAgent of userAgents) {
    expect(userAgent).toMatch(/^agent-device-cli\/1\.2\.3 Limrun\/JS /);
  }
});
