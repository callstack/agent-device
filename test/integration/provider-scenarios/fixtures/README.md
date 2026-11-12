# Localhost TLS fixture

`localhost-cert.pem` and `localhost-key.pem` are public test data for loopback HTTPS integration.
The key is intentionally shared. It is not a deployment credential.

Only the test server uses the key. Test clients trust the matching certificate through a per-client
`ca` option. The fixture does not change a machine trust store or disable certificate verification.
Do not use this pair for a deployed service or add it to a shared trust store.

The certificate covers `localhost` and `127.0.0.1`. Its validity ends in November 2036.
Replace both files together before expiry. Keeping the pair in the fixture avoids an OpenSSL
executable or certificate-generation dependency in the test runner.

To regenerate the pair, use OpenSSL 3 or later. This replaces both public test fixtures.
From the repository root, run:

```sh
openssl req -x509 -newkey rsa:2048 -noenc -sha256 -days 3650 \
  -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout test/integration/provider-scenarios/fixtures/localhost-key.pem \
  -out test/integration/provider-scenarios/fixtures/localhost-cert.pem
```

Commit the pair together. Verify both TLS consumers:

```sh
pnpm exec vitest run --project unit-core packages/daemon/src/server/http/http-server-upload-origin.test.ts
pnpm exec vitest run --project provider-integration test/integration/provider-scenarios/remote-proxy-artifact-tenant.test.ts
```
