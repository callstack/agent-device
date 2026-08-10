# Daemon RPC wire ledger

ADR 0006 says exactly when `DAEMON_RPC_PROTOCOL_VERSION` must be bumped. Until #1432 nothing
checked that it was.

The runtime guard already refuses a mismatched peer — `readRemoteDaemonHealth` compares
`/health`'s `rpcProtocolVersion` before sending any RPC. But it only fires when someone remembered
the bump. A wire change that skipped it left both sides advertising protocol 2 while parsing
different payloads, which is the failure ADR 0006 was written to prevent.

This directory closes that: `surface.ts` declares which declarations cross the boundary,
`ledger.json` records what they hashed to and at which protocol version, and two gates hold the
ledger honest from opposite sides.

## Why this boundary and not the local daemon

A local daemon cannot skew. `isReusableDaemonInfo` (`src/daemon/client/daemon-client-lifecycle.ts`)
takes over any daemon whose package version differs from the client's, so the two are always the
same build.

Cross-machine is the opposite by design. ADR 0006: "a 0.15 client and 0.17 remote daemon can often
interoperate" — `agent-device proxy`, cloud/limrun providers, and a remote macOS host all run
skewed on purpose, and package version is explicitly *not* the compatibility gate there. The one
place version skew is designed in was the one place with no gate.

## The three gates

| | Runs | Answers |
| --- | --- | --- |
| `wire-compat.test.ts` (`unit-core`) | every PR, offline, shallow-safe | does the ledger still match the source it describes, and is the manifest closed? |
| `wire-mutations.test.ts` (`unit-core`) | every PR | does the gate actually **catch** each class of wire break? |
| `pnpm check:daemon-wire-compat` (`Released-Surface Compatibility`) | own `fetch-depth: 0` job | did the drift **since the last released tag** come with a bump or an ack? |

The mutation lane exists because the first two answer "the manifest describes
today's source", never "the manifest describes the *right* source". A gate can
list 151 declarations, pass every check, and still miss the seam that breaks a
skewed peer — which is exactly what review found in the first version of this
directory. Each case there mutates one real listed declaration the way a real
break would (method renamed, envelope unframed, auth header dropped, upload
ticket field renamed, 308 downgraded, artifact route narrowed, health-version
check defeated, 308 resume contract broken on the client side) and asserts the
digest moves. Two guards keep them honest: the mutation is applied **inside the
declaration's own span** so it cannot silently hit a sibling that shares the
substring, and the unmutated digest must equal the ledger's so the case is
pinned to the declaration the gate really watches.

The split is forced, not stylistic. From a single commit a bumped ledger and an unbumped one are
both just an edited file, so only a baseline read out of git can tell them apart — the same reason
the replay-compat corpus splits its provenance verifier out of the unit lane.

**Baseline is the released tag, never arbitrary git history.** An unreleased shape has no peer in
the wild to be incompatible with (AGENTS.md, "Unreleased API surface dies free"), so mid-branch
churn is free and only the net change since publication has to be justified.

## When the gate fails

It names the declaration and prints the digest to paste. Decide which ADR 0006 case you are in:

**Breaking** — a peer on the previous protocol would misinterpret the payload rather than fail
clearly. Removing wire surface is always this case; an ack cannot cover a removal, because a
released peer can still send it.

1. Bump `DAEMON_RPC_PROTOCOL_VERSION` (`src/daemon/http-health.ts`).
2. Set `ledger.json`'s `protocolVersion` to match, and paste the new digests.
3. ADR 0006 also wants a remote-client regression test proving mismatched protocols fail before
   command RPC.

**Additive** — ADR 0006's own list: a new optional request field an older daemon can ignore or
reject with a normal command error, a new optional response field an older client can ignore.

1. Paste the new digest into `ledger.json`.
2. Add a `compatibleChanges` entry naming the declaration, carrying **that same digest**, and
   saying why the older peer still parses correctly.

An ack is keyed by the digest it covers so it expires: the next change to the same declaration
produces a different digest and needs its own rationale. One "added an optional field" ack cannot
launder every later change. Stale acks fail the unit lane — drop them; git history is the audit
trail, the ledger is the gate.

There is deliberately **no regenerate script**. A stale entry is fixed by pasting the one digest
the failure prints, so every ledger line in a diff is a wire declaration someone decided to change
— the same reason `fallow-baselines` are not bulk-refreshed.

## What is covered, and what is not

`surface.ts` groups declarations by the ADR 0006 bullet each serves, quoting the bullet, so the
manifest can be checked against the decision rather than against someone's summary of it. Where a
bullet is only partly digestible the group carries an `uncovered` note saying which part is
reviewer-owned and why — a gate that implies coverage it does not provide is worse than one that
admits the gap (AGENTS.md, "a registry claim is not a semantic check").

**Both sides of every boundary are listed** — four boundaries, producer and consumer each:

| Boundary | Producer | Consumer |
| --- | --- | --- |
| `/rpc` | method sets, request projections, `createRpcError`, envelope serializers | `buildHttpRpcPayload`, lease-method mapping, `parseDaemonHttpResponseBody`, `toDaemonHttpRpcError` |
| `/health` | `DaemonHealthPayload`, `buildDaemonHealthPayload` | `RemoteDaemonHealth`, `readHealthPayload`, `readRemoteDaemonHealth` |
| `/upload` | route resolver, preflight/finalize/308 handlers, body parsers | `UploadPreflightResponse`, `parseUploadPreflightResult`, direct/legacy/finalize senders, `PreparedUploadArtifact` |
| `/upload` resume (308) | `handleResumableUpload` emits 308 + offset headers | `isUploadResumeStatus`, `parseUploadResumeOffset`, `buildUploadRequestHeaders`, `streamFileToHttpRequestAttempt` |
| `/artifacts/*` | route resolver, inventory and download framing | `buildDaemonArtifactUrl`, `downloadRemoteArtifact`, materialization |

A client-only change breaks an older daemon just as surely as the reverse. Two consumers are the
sharpest cases: narrowing `readHealthPayload` or `readRemoteDaemonHealth` disables the very refusal
ADR 0006 was written to guarantee, and narrowing `parseUploadResumeOffset` or
`buildUploadRequestHeaders` breaks resume against a daemon still emitting the released 308 contract.

That took three review rounds, and the pattern is worth naming: each round the coverage sentence was
written ahead of the coverage. Round one digested only payload *types*; round two added producers but
left the auxiliary consumers out; round three still had the daemon *producing* 308 with nothing
proving the client still *consumes* it. Prefer the table above and the `uncovered` notes over any
prose claim — those are checkable against `surface.ts`, and a sentence is not.

The one remaining gap: `createDaemonHttpServer`, the 200-line dispatcher, and the `/health` and
`/rpc` path literals inside it. Everything it dispatches *with* is digested individually, so what is
uncovered is the wiring — and its failure mode is the loud one, a 404 at connect time before any
payload is exchanged. Everything digested here can misparse *silently*, which is the whole point.

Digests ignore comments and formatting, so reflowing a type or rewriting the prose above a field
does not move them; only the declaration's tokens do.

## The closure, and why it fails closed

`wire-compat.test.ts` walks each listed declaration's AST and resolves every type name it
references — through relative imports, workspace specifiers (via the owning package's own `exports`
map), and façade re-export chains. Every name must land somewhere someone wrote down:

- a **listed** declaration, or
- a **waiver** in `closure-policy.ts` — a repo declaration that is genuinely not payload, with the
  reason it cannot change what a peer parses, or
- a **declared external module** (`node:http`, `undici`) with no declaration site here, or
- the TypeScript/Node global set.

Anything else fails. The earlier version skipped names it could not place, which made the whole
claim hollow: a listed type could grow `foo?: ImportedShape` from an unlisted module and stay green.
Three probes in `wire-mutations.test.ts` prove the walk really reaches across each boundary form —
drop a listed declaration from the claimed set and the closure must report it.

Challenge the waivers first when reviewing this directory; they are where coverage is traded away.
The largest pair (`InternalRequestOptions`, `CommandFlags`) rests on ADR 0006's own additive rule:
those reach the peer inside `DaemonRequest`'s untyped `flags`/`input` bags, and the decision says a
new flag needs no bump. If a flag ever becomes a typed field, list the type instead of widening the
waiver.

## Adding to the surface

Put the declaration in the group whose ADR 0006 bullet it serves and paste its digest from the
failure message. If it introduces a new break class, add a case to `wire-mutations.test.ts` — a
listed declaration with no proof that mutating it fails is a claim, not a gate.
