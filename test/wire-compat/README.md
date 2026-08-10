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

## The two gates

| | Runs | Answers |
| --- | --- | --- |
| `wire-compat.test.ts` (`unit-core`) | every PR, offline, shallow-safe | does the ledger still match the source it describes? |
| `pnpm check:daemon-wire-compat` (`Released-Surface Compatibility`) | own `fetch-depth: 0` job | did the drift **since the last released tag** come with a bump or an ack? |

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

The one such gap today: the `/health` and `/rpc` path literals sit inside `http-server.ts` request
handlers, whose bodies churn for reasons that are not protocol changes. They stay reviewer-owned
because their failure mode is the loud one — a moved route 404s at connect time, before any payload
is exchanged. Everything digested here can misparse *silently*, which is the whole point.

Digests ignore comments and formatting, so reflowing a type or rewriting the prose above a field
does not move them; only the declaration's tokens do.

## Adding to the surface

The manifest's closure is checked, not asserted: `wire-compat.test.ts` walks each digested
declaration's AST and fails if it references a type declared in a manifest file that the manifest
itself omits. So adding `foo?: NewShape` to a wire type tells you to list `NewShape` rather than
letting the field that decides what the peer parses sit outside the gate.

To add a declaration by hand, put it in the group whose ADR 0006 bullet it serves and paste its
digest from the failure message.
