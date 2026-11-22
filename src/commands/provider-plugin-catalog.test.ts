import {
  getProviderPluginDeclaration,
  providerPluginAdmission,
  providerPluginDeclarations,
} from '@agent-device/contracts/provider-plugin-catalog';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { providerPluginHelp, providerPluginInstallCommand } from './provider-plugin-catalog.ts';

const NIGHTLY_0_22 = '0.22.0-nightly-0-22.20261118.187';
const MAIN_NIGHTLY_0_22 = '0.22.0-nightly.20261118.186';

function declaration(provider: string) {
  const found = getProviderPluginDeclaration(provider);
  assert.ok(found, `Expected ${provider} in the provider plugin catalog`);
  return found;
}

test.each([NIGHTLY_0_22, MAIN_NIGHTLY_0_22])(
  '0.22 nightly core %s names the plugin release built with it',
  (coreVersion) => {
    for (const { provider } of providerPluginDeclarations()) {
      assert.equal(
        providerPluginInstallCommand(declaration(provider), coreVersion),
        `agent-device plugins add @agent-device/${provider}@${coreVersion}`,
      );
    }
  },
);

test('a 0.22 source checkout names the nightly tag', () => {
  assert.equal(
    providerPluginInstallCommand(declaration('browserstack'), '0.22.0-dev'),
    'agent-device plugins add @agent-device/browserstack@nightly-0.22',
  );
});

test('a core outside the 0.22 nightlies keeps the plain package selector', () => {
  for (const coreVersion of ['0.21.40-nightly.20261118.186', '0.22.0', '0.0.0']) {
    assert.equal(
      providerPluginInstallCommand(declaration('aws-device-farm'), coreVersion),
      'agent-device plugins add @agent-device/aws-device-farm',
      `core ${coreVersion} must not name a release it cannot match`,
    );
  }
});

test('stable cores use the stable provider packages', () => {
  for (const provider of ['testmu', 'revyl', 'webos', 'tizen']) {
    assert.equal(
      providerPluginInstallCommand(declaration(provider), '0.21.39'),
      `agent-device plugins add @agent-device/${provider}`,
    );
  }
});

test('the catalog exposes every row, so the release check sees every install hint', () => {
  const declarations = providerPluginDeclarations();
  assert.deepEqual(
    declarations.map((plugin) => plugin.package),
    declarations.map((plugin) => `@agent-device/${plugin.provider}`),
  );
  // The release install-hint check reads this list, so a lookup answers for every row it names.
  for (const plugin of declarations) {
    assert.equal(getProviderPluginDeclaration(plugin.provider), plugin);
  }
});

test('the catalog names which plugin providers a route must admit itself', () => {
  // Limrun is the one provider the core ships no runtime for, so a route driving its connection
  // refuses it without the plugin. Every other row keeps the route's own admission.
  assert.equal(providerPluginAdmission('limrun'), 'provider');
  for (const provider of ['aws-device-farm', 'browserstack', 'revyl', 'testmu', 'webos', 'tizen']) {
    assert.equal(providerPluginAdmission(provider), 'route', provider);
  }
  assert.equal(providerPluginAdmission(undefined), 'route');
  assert.equal(providerPluginAdmission('unknown-provider'), 'route');
});

test('help gives nightly and stable users the same plugin selectors as recovery', () => {
  const nightly = providerPluginHelp(NIGHTLY_0_22);
  const stable = providerPluginHelp('0.22.0');
  for (const provider of ['browserstack', 'aws-device-farm']) {
    assert.ok(nightly.includes(`connect ${provider}; @agent-device/${provider}@${NIGHTLY_0_22})`));
    assert.ok(stable.includes(`connect ${provider}; @agent-device/${provider})`));
  }
  assert.ok(nightly.includes(`TestMu AI (connect testmu; @agent-device/testmu@${NIGHTLY_0_22})`));
});
