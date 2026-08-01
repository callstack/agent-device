/**
 * Metro runtime helpers: normalize a Metro base URL and resolve the
 * host/port/scheme a client should connect through, given the runtime hints
 * a daemon response (or `AppOpenOptions.runtime`) carries.
 *
 * Demonstrates: `normalizeBaseUrl` and `resolveRuntimeTransport` from
 * `agent-device/metro`.
 *
 * Prerequisites: none — both functions are pure and need no daemon, device,
 * or running Metro bundler.
 *
 * Run: node --experimental-strip-types examples/sdk/metro-runtime.ts
 */
import { normalizeBaseUrl, resolveRuntimeTransport } from 'agent-device/metro';
import type { SessionRuntimeHints } from 'agent-device/contracts';

const baseUrl = normalizeBaseUrl('https://metro.example.dev///');
console.log(`normalized base URL: ${baseUrl}`);

const hints: SessionRuntimeHints = {
  platform: 'ios',
  metroHost: 'metro.example.dev',
  metroPort: 443,
};

const transport = resolveRuntimeTransport(hints);
if (!transport) {
  throw new Error('Unable to resolve a Metro runtime transport from the provided hints');
}

console.log(`resolved transport: ${transport.scheme}://${transport.host}:${transport.port}`);
