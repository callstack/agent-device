import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  getProviderPluginDeclaration,
  providerPluginHelp,
  providerPluginInstallCommand,
} from './provider-plugin-catalog.ts';

// The release `scripts/release-version.mjs` stamps on the 0.22 source branch, beside the shapes it
// never stamps: main's `-dev`, the current line's nightly, a stable release, and the `0.0.0`
// placeholder that sits under a channel plugin's `latest` tag.
const NIGHTLY_0_22 = '0.22.0-nightly-0-22.20261118.187';

function declaration(provider: string) {
  const found = getProviderPluginDeclaration(provider);
  assert.ok(found, `Expected ${provider} in the provider plugin catalog`);
  return found;
}

test('a 0.22 nightly core names the plugin release built with it', () => {
  for (const provider of ['browserstack', 'aws-device-farm']) {
    assert.equal(
      providerPluginInstallCommand(declaration(provider), NIGHTLY_0_22),
      `agent-device plugins add @agent-device/${provider}@${NIGHTLY_0_22}`,
    );
  }
});

test('a 0.22 source checkout names the nightly tag', () => {
  assert.equal(
    providerPluginInstallCommand(declaration('browserstack'), '0.22.0-dev'),
    'agent-device plugins add @agent-device/browserstack@nightly-0.22',
  );
});

test('a core outside the 0.22 nightly channel keeps the plain package selector', () => {
  for (const coreVersion of ['0.21.40-nightly.20261118.186', '0.22.0', '0.0.0']) {
    assert.equal(
      providerPluginInstallCommand(declaration('aws-device-farm'), coreVersion),
      'agent-device plugins add @agent-device/aws-device-farm',
      `core ${coreVersion} must not name a release it cannot match`,
    );
  }
});

test('a plugin that ships every release ignores the channel of the core', () => {
  for (const provider of ['testmu', 'revyl', 'webos', 'tizen']) {
    assert.equal(
      providerPluginInstallCommand(declaration(provider), NIGHTLY_0_22),
      `agent-device plugins add @agent-device/${provider}`,
    );
    assert.equal(
      providerPluginInstallCommand(declaration(provider), '0.21.39'),
      `agent-device plugins add @agent-device/${provider}`,
    );
  }
});

test('help gives nightly and stable users the same plugin selectors as recovery', () => {
  const nightly = providerPluginHelp(NIGHTLY_0_22);
  const stable = providerPluginHelp('0.22.0');
  for (const provider of ['browserstack', 'aws-device-farm']) {
    assert.ok(nightly.includes(`connect ${provider}; @agent-device/${provider}@${NIGHTLY_0_22})`));
    assert.ok(stable.includes(`connect ${provider}; @agent-device/${provider})`));
  }
  assert.match(nightly, /TestMu AI \(connect testmu; @agent-device\/testmu\)/);
});
