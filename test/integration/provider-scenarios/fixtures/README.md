# Localhost TLS fixture

`localhost-cert.pem` and `localhost-key.pem` are public test data for loopback HTTPS integration.
The key is intentionally shared. It is not a deployment credential.

Only the test server uses the key. Test clients trust the matching certificate through a per-client
`ca` option. The fixture does not change a machine trust store or disable certificate verification.
Do not use this pair for a deployed service or add it to a shared trust store.

The certificate names localhost and loopback addresses. Its validity ends in November 2036.
Replace both files together before expiry. Keeping the pair in the fixture avoids an OpenSSL
executable or certificate-generation dependency in the test runner.
