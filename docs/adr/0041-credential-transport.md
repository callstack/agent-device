# ADR 0041: Credential Transport — HTTPS or Loopback for Configured Credential Destinations

## Status

Accepted (2026-11-28). agent-device 0.21.x warns before sending a credential that fails the rule; 0.22 refuses as described below.
ADR 0006 continues to govern checked RPC.

## Rules at a glance

1. **Supported remote setup.** The daemon and `agent-device proxy` listen on loopback.
   A TLS tunnel (cloudflared, ngrok, Tailscale Serve) or `ssh -L` carries remote traffic.
   Remote clients connect with an `https://` URL, or with a loopback URL through the SSH forward.
   In this setup, a first-party credential crosses a network only inside TLS or SSH.
2. **One admission rule.** Before agent-device sends a first-party credential to a URL that an operator configured, the URL must use `https:` or name a loopback host over `http:`.
   Otherwise the client refuses with `INVALID_ARGS` and `details.reason: 'insecure_credential_transport'`.
   The refusal happens before any network I/O.
   It names the URL origin and the override, and never the credential.
3. **Loopback** is `localhost` or an IPv4, IPv6, or IPv4-mapped loopback literal, after WHATWG URL parsing.
   The rule never resolves names and never infers encryption from a private range, a DNS suffix, or an interface.
4. **One operator override.** `AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT=1` in the sending process's environment admits plain HTTP to any host.
   It relaxes only this rule.
   It never relaxes URL validation, the remote authentication requirement, cloud issuer binding, or checked RPC.
   Only the operator's environment sets it. A fetched profile, ticket, bridge message, or remote request cannot set it.
5. **Admission points.** The rule applies at these destinations:
   - the remote daemon base URL, from any source (flag, environment, SDK, connection profile, cloud profile);
   - the cloud base URL, including the issuer stored at login when a refresh uses it;
   - the Metro bridge base URL that receives the Metro or daemon bearer;
   - the `@agent-device/proxy` `upstreamBaseUrl`, when the proxy uses its own transport;
   - a direct-upload ticket URL. If a ticket fails the rule, the client discards it unsent and uses the legacy upload on the admitted daemon base.
6. **No redirect policy.** This decision adds no redirect handling.
   The protocol rules on main stay: checked RPC never follows a redirect (ADR 0006), cloud auth stays on its issuing origin, and streamed uploads stay same-origin.

## Reason

RFC 6750 §5.3 says that a client must use TLS or equivalent transport security for bearer tokens.
Credential-sending clients with a remote destination commonly refuse cleartext by default and exempt loopback: Docker registries, Go module fetches, and Git Credential Manager do so.
Each of those tools has one explicit opt-in.
A warning is not sufficient: an unattended agent or CI job sends the token before a person reads the warning.

The realistic failure is an operator mistake, not an attacker.
Examples are a plain `http://` URL typed for a LAN host, or a proxy behind a TLS tunnel started without `--public-origin`.
In the second case the proxy writes the client credential into an `http://` upload ticket for the public host, and the credential crosses the internet in cleartext.
One check at the place that reads each configured URL prevents both mistakes.

Redirects need no general policy.
An on-path observer of a plaintext request already has the credential, so refusing its redirect protects nothing.
Over TLS, only the server that the operator configured can issue a redirect.
The paths that carry the daemon token already do not follow redirects: the daemon client uses `node:http`, upload preflight uses `redirect: 'error'`, and the checked RPC route forbids redirects.

## Rejected alternatives

- **Warn and continue.** The credential leaks before anyone reads the warning. It is rejected as the permanent design and used only as the one-release transition in 0.21.x, so existing setups get notice before 0.22.
- **Infer encryption** from RFC 1918, CGNAT, IPv6 ULA, `.ts.net`, or interface membership. An address does not prove the route. Tailscale users can use Tailscale Serve for HTTPS, or set the override.
- **Per-host override list** (as Docker `--insecure-registry` and `GOINSECURE` do). A client process has one daemon destination. A boolean is enough.
- **General redirect inspection or a custom HTTP client.** No realistic actor gains from it. Redirect issuers are the operator's own services.
- **Extend the rule to provider URLs (Limrun, Revyl), the Metro dev-server relay, and returned WebSocket URLs.** These carry no first-party credential, or their owner already has a rule. Revyl already admits only HTTPS or loopback HTTP for its backend.
- **Check an embedder's custom proxy transport.** `upstreamFetch` replaces the network route, so its URL can be a logical name. The embedder owns that route.
- **Authorization-only daemon auth in this decision.** The token is also in `x-agent-device-token` and in JSON-RPC `params.token`. These copies matter only after a cross-origin redirect from the operator's own HTTPS service. A wire cleanup can follow as its own change.

## Consequences

- The 0.21.x warning names the URL origin and the fixes.
- An existing LAN `http://` deployment must move to HTTPS or `ssh -L`, or set the override.
- An `@agent-device/proxy` embedder with a non-loopback HTTP upstream and the default transport must set the override or supply `upstreamFetch`.
- A misconfigured `--public-origin` costs an extra transfer through the daemon instead of a cleartext credential.
- The operator keeps these duties, which the supported setup already meets:
  keep the daemon token secret, set `--public-origin` behind a TLS terminator, keep the onward hop from a TLS terminator on loopback, and bypass any environment HTTP proxy for loopback (`NO_PROXY=127.0.0.1,localhost`).

## Review rules

- A finding must name the actor, the capability that the actor needs, and the credential that the actor reads.
  If the actor needs a capability that this decision excludes, such as reading TLS traffic or controlling the operator's own server, reject the finding.
- A finding against the supported remote setup must give reproduction steps that start from that setup.
  If the steps depart from the setup, name the departure.
  If the departure is not a configuration that the docs support or a likely operator mistake, reject the finding.
- For a redirect finding, name the party that issues the redirect.
  If only the operator's own service can issue it, reject the finding.
  If that party can already read the first request, treat the finding as a plaintext finding.
- To add an admission point, show that a first-party credential goes to an operator-configured URL there.
- Do not add redirect handling for credential secrecy. Keep the redirect rules of ADR 0006, cloud auth, and upload streaming. They protect protocol invariants.
- If a claim depends on runtime behavior, reproduce it with a script of 20 lines or fewer before you write code.
  Record the runtime version, the platform, every relevant setting (such as `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, and `NO_PROXY`), and the observed output.
- Before you request a new protection layer, check whether a change at one existing owner, or a deletion, keeps the invariant.
