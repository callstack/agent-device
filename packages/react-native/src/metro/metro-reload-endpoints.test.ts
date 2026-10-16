import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parsePort, resolveMetroReloadEndpoints } from './metro-reload-endpoints.ts';

test('a Metro port is a whole number from 1 to 65535', () => {
  assert.equal(parsePort('8082', 8081), 8082);
  assert.equal(parsePort(undefined, 8081), 8081);
  for (const value of ['8081oops', '80.5', '0', '65536', '-1']) {
    assert.throws(() => parsePort(value, 8081), /Invalid Metro port/, value);
  }
});

test('reload endpoint resolution prioritizes explicit flags, then session runtime hints, then defaults', () => {
  // no-hint default: neither an explicit flag nor a runtime hint is present.
  assert.equal(resolveMetroReloadEndpoints({}).reloadUrl, 'http://localhost:8081/reload');

  // hint-only: a session runtime hint resolves the target when no flag is given.
  assert.equal(
    resolveMetroReloadEndpoints({ runtime: { metroHost: '127.0.0.1', metroPort: 9200 } }).reloadUrl,
    'http://127.0.0.1:9200/reload',
  );

  // flag-overrides-hint: an explicit flag wins over a conflicting session runtime hint.
  assert.equal(
    resolveMetroReloadEndpoints({
      metroHost: '10.0.0.5',
      metroPort: 9300,
      runtime: { metroHost: '127.0.0.1', metroPort: 9200 },
    }).reloadUrl,
    'http://10.0.0.5:9300/reload',
  );

  // A single explicit flag still overrides only its own field; the hint fills the rest.
  assert.equal(
    resolveMetroReloadEndpoints({
      metroPort: 9400,
      runtime: { metroHost: '192.168.1.5', metroPort: 9200 },
    }).reloadUrl,
    'http://192.168.1.5:9400/reload',
  );
});

test('resolveMetroReloadEndpoints keeps the bundle URL mount prefix instead of collapsing to the host root', () => {
  // Expo virtual entry at the server root: the entry-module path is not a mount prefix, so the
  // endpoints live at the root (verified live: Expo serves /message at the server root).
  assert.deepEqual(
    resolveMetroReloadEndpoints({
      runtime: {
        metroHost: '127.0.0.1',
        metroPort: 8082,
        bundleUrl:
          'http://127.0.0.1:8082/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&minify=false',
      },
    }),
    {
      reloadUrl: 'http://127.0.0.1:8082/reload',
      messageSocketUrl: 'ws://127.0.0.1:8082/message',
    },
  );

  // Proxy/mount prefix carrying the Expo virtual entry keeps the mount prefix only.
  assert.deepEqual(
    resolveMetroReloadEndpoints({
      bundleUrl:
        'http://proxy.example.test/tenant-42/.expo/.virtual-metro-entry.bundle?platform=android',
    }),
    {
      reloadUrl: 'http://proxy.example.test/tenant-42/reload',
      messageSocketUrl: 'ws://proxy.example.test/tenant-42/message',
    },
  );

  // Proxy/mount prefix carrying a plain index.bundle keeps the prefix (Re.Pack/RN over a proxy);
  // https maps the message socket to wss.
  assert.deepEqual(
    resolveMetroReloadEndpoints({
      bundleUrl: 'https://proxy.example.test/metro/runtime-1/index.bundle?platform=ios',
    }),
    {
      reloadUrl: 'https://proxy.example.test/metro/runtime-1/reload',
      messageSocketUrl: 'wss://proxy.example.test/metro/runtime-1/message',
    },
  );

  // Root index.bundle still reloads at the host root.
  assert.deepEqual(
    resolveMetroReloadEndpoints({
      bundleUrl: 'http://127.0.0.1:8081/index.bundle?platform=ios',
    }),
    {
      reloadUrl: 'http://127.0.0.1:8081/reload',
      messageSocketUrl: 'ws://127.0.0.1:8081/message',
    },
  );
});
