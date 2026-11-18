#!/usr/bin/env node
import { AUTH_IDP_DEFAULT_URL } from '../src/auth-idp-fixture.ts';
import { startAuthIdpServer } from '../src/auth-idp-server.mjs';

const [flag, value, ...rest] = process.argv.slice(2);
const delayMs = Number(value ?? 0);
if (
  flag !== undefined &&
  (flag !== '--delay-ms' ||
    !value?.trim() ||
    !Number.isFinite(delayMs) ||
    delayMs < 0 ||
    rest.length)
) {
  console.error(
    'Usage: node --experimental-strip-types examples/test-app/scripts/serve-auth-idp.mjs [--delay-ms <n>]',
  );
  process.exitCode = 1;
} else {
  const provider = await startAuthIdpServer({ delayMs });
  console.log(`[auth-idp] ${AUTH_IDP_DEFAULT_URL} delayMs=${delayMs}`);
  process.once('SIGINT', () => provider.close());
  process.once('SIGTERM', () => provider.close());
}
