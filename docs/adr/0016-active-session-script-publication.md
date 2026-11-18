# ADR 0016: Active-Session Script Publication

## Status

Accepted.
This ADR is implemented on `main`, including the #1349 identity-level destination-guard amendment.

Implementation owners are `packages/daemon/src/sessions/handlers/session-script-publication.ts` and `packages/daemon/src/core/session-script-active-publication.ts`.
Remote delivery (#4511 amendment) is owned by `packages/daemon/src/core/session-script-publication-capability.ts` and, on the client, `packages/remote/src/session-script-destination.ts`.

## Rules at a glance

This section is a normative summary.
[Decision](#decision) contains the binding contracts and refusal cases.

- `session save-script [path] [--force]` publishes the current ordinary script recording without closing the app or the session.
  The session stays live at the destination.
- Recording lifecycle:
  - Only the initial `open --save-script` of a new session establishes **ARMED**.
  - From ARMED, a second successful plain `open` causes **ABORTED**.
  - From ARMED, only a successful atomic `session save-script` establishes **PUBLISHED**.
  - ABORTED and PUBLISHED are terminal until the session is destroyed.
  - A filesystem or target failure leaves the recording ARMED and retryable.
- Publication requires exactly one initial recorded `open`, a portable selector-`wait` destination guard after the last descriptor-classified mutating action, and no unresolved session-local `@ref`.
  Since #1349, the `target-v1` annotation of the guard must be `verification: "verified"`.
  Every refusal happens before filesystem work and names its recovery.
- The destination a caller names with `--save-script=<path>` is judged before anything is created.
  Host-kit requires it absolute; `resolveUserPath` folds a relative or `~/` spelling lexically before that.
  Every directory the walk looks a name up in must be owned by the current user or root, and must be either closed to entries from others or sticky.
  What is missing is created one level at a time at 0700, inside the directory the walk just judged.
  The local file is exactly 0600. The remote client requests 0600, and the umask can narrow it.
  The rule is POSIX-only. A refusal before creation leaves nothing behind; a refusal after creation starts can leave the empty directories already created.
  The daemon's own state-directory chain is outside this decision (#4649).
- Repair transactions (ADR 0012) are disjoint from this lifecycle.
  A session with `saveScriptBoundary` set refuses this action without a change to repair state.
- A remote recording is delivered, not published (#4511 amendment).
  Each recorded action refreshes the caller's `--save-script` file, and close overwrites it with the final script.
  `session save-script` refuses a remote recording.
- `ReplayCommandResult.sessionActive` comes from the daemon's session store, never from a re-parse of the script.
  This signal lets a one-shot client keep the daemon alive on a close-less handoff.
- Sensitive `fill` inputs must be recorded as placeholders through `fill --record-as <VAR>` (ADR 0017, shipped for #1348).
  Unparameterized `fill`/`type` values persist literally into the artifact, so a secret entered without `--record-as` is published.
  The protection is scoped to the recording session (ADR 0017's #1398 amendment).
  A later action's own recorded evidence can never re-serialize an app-rendered echo of an already-parameterized value either.

## Context

The replay repair study found that re-recording a drifted journey was cheaper than repairing it in two of the three measured drift classes.
The immediate reusable unit is an **open-to-destination script**.
This self-contained `.ad` script opens the app, performs the complete journey to screen X, and verifies a destination landmark.
It leaves the app session active there, so an agent can continue with new work.

Ordinary script recording currently combines two concerns.
`open --save-script[=<path>]` arms recording before the first interaction.
Thus, selector chains and ADR 0012 `target-v1` identity evidence are captured at action time.
`close` publishes the accumulated script, records a terminal `close`, and tears down the session.
That artifact is suitable as a closed test flow, but not as a live starting state.

Publication only at the end of an ordinary unarmed session is insufficient.
Session history retains the commands.
But the resolved target tree that `target-v1` evidence needs is deliberately discarded after each action.
Late publication can serialize selector text, but it cannot reconstruct which element the action actually targeted.
Unconditional identity capture for every session would change normal interaction execution.
Recording disables direct selector fast paths when evidence requires a capture-backed route.
That performance and data-retention change has not been measured.

Issue [#1346](https://github.com/callstack/agent-device/issues/1346) and the disposable [`session-save-script` prototype](https://github.com/callstack/agent-device/tree/agent/prototype-session-save-replay/scripts/prototypes/session-save-script) record the motivating workflow and API trial.
Composable lifecycle-free fragments remain a separate decision in [#1336](https://github.com/callstack/agent-device/issues/1336).

## Decision

Add an explicit publication action for an already-armed ordinary script recording:

```sh
agent-device open com.example.app --relaunch --save-script=screen-x.ad
# perform the complete journey to screen X
agent-device wait 'role="heading" label="Screen X"'
agent-device session save-script
```

`session save-script [path] [--force]` publishes the current ordinary script recording without closing the app or deleting the session.
An explicit `path` retargets the recording under the existing target/force authorization rules.
Without it, publication uses the path armed by `open --save-script` or the existing generated default.

### Recording lifecycle

An ordinary recording eligible for active-session publication has three states:

- **ARMED**: only the initial successful `open --save-script[=<path>]` of a new session, recorded as action zero, establishes this state.
  The session records portable action inputs and fresh target identity evidence.
- **ABORTED**: another successful plain `open` while ARMED establishes this state.
  The app operation may continue.
  But the recording is no longer a single-open bootstrap, and close-time publication is disarmed.
  The successful `open` response warns that a fresh session is required to author another script.
- **PUBLISHED**: only a successful atomic `session save-script` establishes this state.
  That command commits the complete history from the sole recorded `open` through the current action.
  The session remains active at the destination, but close-time script publication is disarmed.

A filesystem or target-collision failure leaves the recording ARMED, including its path and same-target `--force` authorization.
Thus, the caller can correct the target or permissions and retry.
ABORTED and PUBLISHED are terminal until the session is destroyed.
In either state, `session save-script` fails with an explicit error and never writes.

Every existing arming entry point respects terminality.
On any existing session, `open --save-script` is rejected before app dispatch.
This includes unarmed, ARMED, ABORTED, and PUBLISHED sessions.
A later plain `open` is allowed.
It changes ARMED to ABORTED and leaves ABORTED/PUBLISHED unchanged.
In ABORTED or PUBLISHED, `close --save-script[=<path>]` is rejected before platform close or filesystem work.
Thus, the caller can retry with plain `close`.
Plain `close` tears down ABORTED/PUBLISHED without writing.
The close of an unpublished ARMED recording retains the existing close-time publication behavior.
A fresh session is the only re-arming boundary.

**Amendment (2026-08-02, shipped).** A never-armed session has no recorded `open --save-script` at all.
The lifecycle above has no fourth pre-ARMED state name for it.
Before this amendment, such a session used the same close-time write path as an ARMED recording.
`close --save-script` on it added the request to the authoring lifecycle at record time and published anyway.
Live evidence showed that this produced a script whose actions had selector fallback chains but no recording-time `target-v1` evidence.
The caller got no signal that evidence capture never ran.
Degraded replay verification is worse than an explicit refusal.
Now, `close --save-script` on a never-armed session is rejected before any teardown or filesystem work, the same way as in ABORTED/PUBLISHED.
The refusal names `open --save-script` as the recovery.
A plain `close` still tears the session down without writing.
This case is distinct from [#1533](https://github.com/callstack/agent-device/issues/1533), which concerns an already-ARMED-then-ABORTED session.
In that session, flag ingress re-enabled recording and let a *bare* `close` publish.
A bare `close` has no `--save-script` on the close itself.
The amendments below resolve that case.

**Amendment (#1533, shipped).** Before this amendment, only `abortAuthoringOnSecondOpen` enforced the ABORTED terminality above.
It cleared `session.recordSession`.
That enforcement depended on operation order, not on construction.
`recordSession` was an evidence-capture flag that several surfaces set directly.
Thus, a later `--save-script` re-armed it while the status stayed ABORTED.
A *bare* `close` then published the full session log through a writer that could refuse only repair transactions.
For `close --save-script` in ABORTED, this ADR specifies a refusal that promises the caller that plain `close` "tears down without writing".
Thus, the gap also made an existing error message untrue.

ABORTED is now terminal by construction.
`--save-script` arms recording through one rule that the publication projection owns.
That rule answers "not recording" for an ABORTED lifecycle on every surface that handles the flag.
These surfaces are the re-open builder, the close finalizer, and the recorded-action ingress.
Thus, the flag can no longer contradict the status.
The aggregate likewise answers publication authorization.
The writer asks one publication-blocked question.
That question covers not-recording, an uncommittable or committed repair, and an ABORTED authoring lifecycle alike.
Thus, every path that reaches the writer refuses: bare `close`, teardown, idle-reap, and active publication.
ARMED and PUBLISHED lifecycles and every repair transaction are unchanged.
No state name, transition, or entry point in the lifecycle above is added or altered.

**Amendment (#1533 follow-up, shipped).** The rule above still relied on a stored `SessionState.recordSession` field.
Every writer had to set that field in step with the lifecycle.
Routing the writes through one place made the two agree, but it did not make disagreement unrepresentable.
The field remained a second source of truth for a question that the aggregate already answered.

Recording is now **derived**, not stored.
`isRecordingPublication` reads it from the lifecycle, and the field is gone:

- Ordinary authoring records only while ARMED.
- A repair transaction records for its whole lifetime, terminal statuses included.

The derivation has three consequences:

- No surface can arm recording without a move of the lifecycle that authorizes it.
  Thus, the #1533 drift is unrepresentable, not only guarded against.
  `publishOpenSession` and the close finalizer now make no recording decision at all.
- The aggregate answers the whole publication gate of the writer.
  The separate ABORTED check of the writer is gone, because a terminal authoring lifecycle is already not recording.
  Thus, no second gate can disagree with the first about *authoring*.
- Evidence capture and publication authorization now derive from the same aggregate.
  But they deliberately remain **distinct predicates**.
  - They coincide for ordinary authoring: ARMED both records and publishes, and ABORTED and PUBLISHED do neither.
  - They do NOT coincide for repair.
    `isRecordingPublication` is true for every repair status, `committed` and `aborted` included.
    Publication additionally requires `isRepairArmedWriteBlocked` to pass.
    That check refuses a committed transaction (idempotent no-op) and a transaction that is not yet committable (ADR 0012 decision 6, C2).
  - Thus, a repair that captures evidence is not necessarily a repair that may publish.
    A merge of the two predicates would silently republish or commit a prefix.

This change is behavior-preserving.
The derivation reproduces exactly what the flag held at every transition.
This amendment deliberately does not answer one real question: should a *committed* repair still capture recording-time evidence?
The old flag said yes.
A change to that answer is a behavior change, not a derivation.

**Amendment (#4511, shipped).** A remote caller cannot read the daemon target, so a remote `open --save-script=<path>` delivers its recording to the caller.
It adds no state name, command, or flag:

- Before it sends the open, the client mints a random publication ID and records the destination and the `--force` grant under it in its state directory (`remote-connections/session-scripts/`), keyed by the endpoint, the tenant, the session, and that ID. That directory is the client's own private state, not a script destination: the client creates it the way it always did, with one recursive `mkdir` that forces nothing on a directory that already stands, and the only file ever written there is the client's own record. The script itself is published by the daemon to its own sessions directory; the client's own copy goes to the caller's destination, judged by the rule under [Caller-named destination](#caller-named-destination).
  The open carries the ID in `meta.scriptPublicationId` and never the caller path.
  A daemon answer that does not name the ID removes the record.
  A failed open may still have armed the recording, so it keeps its record.
- The daemon arms the recording under that ID, which `open` and `close` name in `scriptPublicationId`.
  After each successful request that records into the ARMED recording, the daemon writes the recording so far, without a terminal `close`, and returns it as a `session-script` artifact with the ID and a growing `scriptRevision`.
  The close-time write is the final version and has the highest revision; close takes it from the close-time write itself, so a capture that close stops first never hides recorded actions.
  Each version, the final one included, is a fresh file, requested at 0600 through the generic publisher, in a 0700 directory under the daemon's sessions directory, and is downloaded once.
  It registers for download for the tenant that opened the recording, whatever the tenant, capture filters, or network marker of the request that recorded it.
- The client writes a version only to the destination of a record that matches its ID and scope, and only when its revision is newer than the last published one.
  The `savedScript` field and the `session-script` type are reserved for this path, so a script artifact under another field writes nothing.
  Thus, a daemon response never establishes a destination, and another publication's or another session's version writes nothing.
  The download streams, capped at 8 MiB, into a new file requested at 0600, created exclusively and never through a symbolic link, in a staging directory beside the destination that is requested at 0700; the umask can narrow both modes.
  Under the record lock, the record names the version and the staged file's device and inode before the rename or link, and the next version settles that entry from the destination's identity.
  A second name keeps the staged inode, and its staging directory, on disk while the record may name it, so no later file can reuse that inode; settling or retiring the entry removes the staging directory.
  The record lists each staging directory before a download writes to it, so retiring or sweeping the record also removes the staging that a crashed download left behind.
  The first version is linked exclusively, as a local close-time write is, unless the open granted `--force`; a symbolic or hard link at the destination is replaced as a directory entry and never written through.
- If this machine cannot download or save a version, the action also keeps its success and carries the same `scriptDeliveryFailure` and warning; a script delivery failure never changes the outcome of the action that recorded it.
- A close retires the record it names, even when the final version or another artifact fails, and reports the first error. The record is marked retired before its staging directories are removed, so a staging directory that cannot be removed leaves a record that authorizes no later version; a record that cannot be marked retired is removed at once, along with its staging directories. The next open removes retired records. If the client state directory allows neither write, the record stays active and the close logs the failure, so a later version for that publication could still be saved.
  A record that outlives its open stays inert, because only its own ID matches it; creating a record removes records untouched for seven days.
- If the daemon cannot write a version, the action keeps its success and returns `scriptDeliveryFailure` (`script_delivery_failed`) and a warning without the daemon-host path; the caller file keeps the previous version.
  A local close that cannot write its script still fails as before.
- Teardown without `close` writes no daemon file; the caller keeps the version from the last recorded action.
- At the public HTTP boundary, `saveScript` is accepted only as `true` on `open` with a well-formed publication ID.
  `session save-script` refuses a remote recording (`remote_script_publication_unsupported`), and remote `close --save-script`, `replay --save-script`, and `--save-script` in batch steps stay refused.
  A batch whose steps record or close an armed remote recording is not refused. The daemon collects the versions and the close that the batch's steps wrote, and delivers them on the batch response as one `scriptDeliveryReceipt` (#4595).
- The daemon reports the `script-artifacts` capability in `/health`, through a proxy in its upstream health; the client refuses a remote `--save-script` before dispatch without it.

### Caller-named destination

A destination a caller names — `--save-script=<path>` on the local route, or the same path in the remote client's publication record (#4511 amendment) — is judged before anything is created.

**Guarantee.** A destination is accepted only when no other non-root local user can replace or plant a component the publish traverses. Each such directory is owned by the current user or by root, and is either closed to entries from others (neither group- nor world-writable) or sticky. A shared sticky directory lets others add new names but not replace an entry they do not own, so the walk passes through one, may create a missing private subdirectory in one this user or root owns, and never creates the script entry directly in it. A private sticky directory this user or root owns can receive the entry. Once that holds, every existing entry on the route stays in place, so the judged path is the path the publish reaches. The rule closes the window with PERMISSIONS, not with timing. On a local filesystem with no ACLs on the judged directories, no other non-root local user can steer where the recording is written or create that file. It is not a promise that nobody else can read the file. Accounts in the macOS admin group, and the installed Xcode, are trusted like root, because an admin can already use sudo, so a replaced `/Applications/Xcode.app` is out of scope. A caller that keeps executable state, such as the Swift helper cache, asks the same walk for private ancestry: every directory it traverses must also be closed to the group and other users, sticky or not, and is judged before the walk creates anything.

**Path input.** Both routes expand the caller's path with `resolveUserPath` (`packages/host-kit/src/internal/path-resolution.ts`) before they ask host-kit. An absolute spelling reaches the walk intact. A relative or `~/` spelling is folded lexically first, by `path.resolve` against the working directory or `path.join` onto the home directory, so a `..` in it is applied as text before the walk sees it. Host-kit refuses a relative destination at its entry (`relative_destination`) on every platform: walking one would put the working directory in the judged chain, and Node can answer that name stale after a `chdir`. Before that expansion, host-kit judges the spelled final name with `scriptEntryName`: a trailing separator names the same entry it always did, and a name that is not one file is refused (`unnamed_entry`) — empty, a root, `.` or `..` (which the expansion would fold away), a bare `~`, a NUL or lone surrogate, a name over 255 bytes on POSIX (255 UTF-16 code units on Windows), and on Windows a device or pipe namespace path, a reserved device name, a reserved character, a trailing dot or space, or a `:` past the drive.

**Walk.** Host-kit owns the sequence as ONE call, which both publishers make before staging: walk, refuse, create what is missing, walk again, and answer with the judged directory and its identity. The walk emulates the kernel's path resolution from `/`, one component at a time. It skips `.`, applies `..` to the directory PHYSICALLY stood in, and reads every other component with ONE `lstat`, which judges the entry the name holds. It judges a directory and enters it. It judges a symbolic link where the link stands, then queues the target's components: from `/` for an absolute target, from the link's directory for a relative one. A name reached twice, through a `..` or an alias, is judged again from a fresh `lstat`. The walk counts link hops and refuses at `link_loop_exceeded` below the kernel's limit (macOS 32, Linux 40), and it refuses a component that is neither a directory nor a link (`not_a_directory`). An absent component ends the walk short of the entry's directory, so a refusal in that walk leaves no directories behind.

**Creation.** The missing tail is created at 0700, ONE LEVEL AT A TIME inside the directory just judged, and the walk then runs again. A `..` queued behind an absent component is refused (`unresolvable_parent`) before anything is created, because the kernel cannot apply it until the name before it exists. A refusal in the first walk creates nothing. A refusal after creation starts leaves the empty directories this call already created. A level that appears between the walk and its `mkdir` is judged by the same rule: a private directory this user or root owns is adopted, any other directory is refused, and an entry that is not a directory is refused (`entry_appeared`). Only the walk over the completed chain, and an adopted level, ask whether others can create entries where the next name lands (`shared_parent`), because the levels this call creates are its own. A second walk that does not arrive at the entry's directory is refused (`unreachable_parent`). Directories are made at 0700 because under umask 002 a mode-less `mkdir` gives 0775, which the next check refuses.

**Answer and staging.** Both publishers stage and create the entry inside the physical directory the walk answers, spelled from it and never from the caller's spelling. A temporary sibling beside the caller's spelling could stand in a directory the walk never judged, where another local user can reach it. On POSIX the local publish writes its temporary sibling, makes it exactly 0600 with `chmod` before the entry exists, and commits it with an exclusive link or a rename; nothing asynchronous runs between its walk and that commit. The remote client requests 0600 when it opens the file, and the umask can narrow that mode. Remote delivery stages bytes between the judgment and the rename, so `confirmScriptDestination` walks again. A refusal from that walk is `script_ancestor_untrusted`; a directory whose `dev:ino` differs from the identity the answer carried is `script_ancestry_replaced` (`parent_replaced`). The local publish makes one preparation call and compares nothing. The ownership rule excludes the attacker; the comparison is defense in depth. A version delivered again is answered under the record lock from the committed file, only while its SHA-256 matches the digest the record keeps and the entry is verified unchanged as far as size and timestamps can show; a same-length rewrite within one tick of a coarse-timestamp filesystem, such as ext4 with one-second ticks, can go unseen, and needs write access to the file.

**Sticky directories.** The sticky bit excuses a directory the walk passes THROUGH when the current user or root owns it, because only an entry's owner or root can then replace that entry. A sticky directory another user owns is refused: those bits shield other users from that owner, not the reverse. Inside a sticky directory this user or root owns, the walk may create a missing private subdirectory, but it refuses to create the script entry in any parent that admits entries from others, because anyone could create that name first. Every followed link is judged with `untrustedLinkExposure` against the directory that holds it, at any depth: the link is accepted when that directory keeps others from adding entries, or when that directory is sticky and this user or root owns the link. The link's own mode is never consulted, because a link's bits say nothing about access on Linux. Root-owned system aliases (macOS `/tmp` to `/private/tmp`, `/var` to `/private/var`) keep working.

**Group-writable directories.** The exposure checks run in order: ownership, sticky bit, world write, group write. A directory another user owns is refused as `foreign_owned` first. A non-sticky directory this user or root owns is refused as `world_writable` when others can write it, and otherwise as `shared_group_writable` (with a `chmod g-w` hint) when its group can. The sticky bit excuses a writable directory for passing through, and nothing else does. This refuses a home directory configured as `0775`, even with a per-user group, because membership cannot be proven. On a systemd host, `systemd-userdbd` and `userdbctl` serve users and memberships that `/etc/passwd` and `/etc/group` never show, even when `nsswitch.conf` names only `files systemd`. Reading the account files would also make the answer depend on the host's name service, which no other part of this rule does. `chmod g-w <directory>` is the one-command recovery.

**Platform limits.** The rule is POSIX-only. On Windows the walk does not run: owners, mode bits and link shape are not read, `chmod` toggles only the read-only bit, creation is a recursive `mkdir`, and access is the ACL of the directory the operator chose.

| Case | Result | Permitted side effects |
| --- | --- | --- |
| A route through a non-sticky world-writable directory this user or root owns, reached directly or through a link target | Refused, `world_writable` | None |
| A route through a link that neither this user nor root owns, in a shared sticky directory this user or root owns | Refused, `planted_link` | None |
| A `..` applied, as the kernel applies it, to the physical directory reached, landing in a non-sticky world-writable directory this user or root owns | Refused, `world_writable` | None |
| A relative link target, resolved from the directory that holds the link, that crosses a non-sticky world-writable directory this user or root owns | Refused, `world_writable` | None |
| A `..` queued behind a missing directory | Refused, `unresolvable_parent` | None |
| A `..` over directories that all exist and are private | Accepted where the kernel lands | The entry |
| A missing parent below a sticky directory this user or root owns | Accepted | The parent, at 0700, and the published entry in it |
| A missing parent below a non-sticky world-writable directory this user or root owns | Refused, `world_writable` | None |
| A missing level created meanwhile as this user's private directory | Accepted | The entry |
| A missing level created meanwhile: foreign-owned; or owned by this user or root and non-sticky world-writable, non-sticky with group write but no other write, or sticky with either write bit | Refused, `foreign_owned`, `world_writable`, `shared_group_writable`, or `shared_parent` respectively | Directories this call already created |
| The entry directly inside a shared sticky directory this user or root owns (a foreign-owned one is `foreign_owned` first) | Refused, `shared_parent` | None |
| A directory another user created first in sticky `/tmp` | Refused, `foreign_owned` | None |
| A non-sticky directory this user or root owns with the group-write bit set and the other-write bit clear | Refused, `shared_group_writable` | None |
| A link loop, or a file as a path component | Refused, `link_loop_exceeded` or `not_a_directory` | None |
| A relative destination at host-kit's entry | Refused, `relative_destination` | None |
| A remote destination directory replaced while a version downloads | Refused: `script_ancestor_untrusted` when the confirming walk rejects the replacement, `script_ancestry_replaced` (`parent_replaced`) when only its `dev:ino` differs | No entry |

Rejected: `realpath`, because it answers only the final directory, and a JS `realpath` folds a `..` lexically where the kernel applies it to the link's target.
Rejected: `stat` for a component, because it resolves the name a second time and can answer a different entry than the one judged.
Rejected: a recursive `mkdir` of the missing tail, because a link planted at an absent name carries the creation past the judged ground, with privileges when run as root.
Rejected: refusing every directory that appears concurrently, because two saves into one new directory meet there routinely.
Rejected: accepting a group-writable directory whose group looks private, because membership cannot be proven.
Rejected: publishing relative to a verified directory handle, because Node exposes no `openat` or `renameat` without native code; the permissions rule substitutes for it.

The daemon's own state-directory chain is OUT of this decision, and this ADR carries no verdict for it. A destination a caller names is the only thing this rule judges: the daemon's default recording under its `sessions/` directory, and `sessions/remote-scripts/`, keep `main`'s behavior and are not walked here. Whether that chain gets a guard of its own, and what becomes of a recording the daemon picks a path for, are decided in follow-up [#4649](https://github.com/callstack/agent-device/issues/4649), which also folds in [#4620](https://github.com/callstack/agent-device/issues/4620).

### What the guarantee does not cover

The rule judges ownership bits, mode bits and link shape. Three things sit outside it, and no combination of them is a reason to expect confidentiality:

- **ACLs.** The rule does not read ACLs. macOS consults an ACL ahead of the mode bits, so a directory at 0700 can still grant `everyone` write, and a 0600 file can inherit an `everyone` read entry. A Linux POSIX ACL's named entries are bounded by its mask, which the group mode bits show, so the judged modes also bound them. Checking ACLs is deliberately not implemented. Callers who need that guarantee choose the destination's permissions and ACLs together.
- **Network filesystems.** NFS, SMB and FUSE mounts answer ownership, mode and link questions however the server pleases, and their uids are usually not this host's. A script destination on a network mount is outside the guarantee.
- **Mounts.** The walk judges the directory it sees at each step and has no separate check of mount provenance. A directory mounted over a judged one after the judgment receives the write. Only the remote route confirms after its download: it catches a mount when the fresh walk rejects the mounted directory or finds a different `dev:ino`, and misses one made before the judgment or after the confirmation.

A local write refuses with `script_ancestor_untrusted`. `script_ancestry_replaced` is the remote route's own refusal: only there does a confirmation run between the judgment and the rename, and it reports a destination directory replaced meanwhile. Either reason reaches a caller as the `scriptDeliveryFailure` cause, and the CAUSE IS ALWAYS THE CLIENT'S OWN: the client found the failure on its filesystem, so the daemon names no cause of its own on a delivery failure it discloses, and a daemon-host write error keeps only the generic delivery reason (#4584).
Every result that can carry a script version discloses a failed delivery: the SDK result, the CLI human output and `--json`, and the MCP tool result each carry `scriptDeliveryFailure` and the warning, so no caller reads a stale file as current.
A batch delivers through one receipt the daemon's request owner answers on the batch reply, successful or failed (#4595). The daemon collects each executed step's script effects as the batch runner reports them, because a step's own reply travels inside a result entry a client must not read. The receipt names the newest full-script version of the recording, the plan position of a step that closed it, and the typed failures; it is answered only for a request whose nested steps fed it, so every single-command reply keeps the shape it had before. A client validates the receipt against its own record and its submitted plan, downloads at most its one version, and treats a receipt it cannot fully account for as authorizing nothing.
A failed batch distinguishes what its error omits from what it gets wrong. An answer that names no failing step, or one whose close sits at or past a step the plan confirms never reached, proves no close: the version and the failures still settle, because the daemon answered them about that client's own publication, and only the retirement is dropped. Silently dropping them would leave the caller's file stale with no warning. An answer that names a step, or a command at that step, the submitted plan does not carry is a malformed answer and authorizes nothing at all.
A response artifact may write only a field it creates. `savedScript`, `artifacts`, `scriptDeliveryFailure` and `warnings` belong to the client: an invalid artifact that names one as its `field` leaves that field untouched, so a peer can neither replace the destination the client chose nor erase the disclosure of a delivery it just failed.
This receipt requires RPC protocol 3: protocol-2 clients ignore it, so admitting a batch close for them could leave the caller's final script undelivered. The health compatibility gate rejects those skewed peers before dispatch (ADR 0006).
Rejected: deriving delivery effects by interpreting the batch's step entries, partial results and failure position, because six review rounds kept finding answers that made a client deliver the wrong version, retire a recording that never closed, or drop a failure (#4582).
Rejected: a remote `session save-script` download, because it added a second publication path and a retry protocol.
Rejected: delivery only at close, because a session that an external owner closes would lose its recording.
Rejected: daemon-minted recording IDs bound through per-request claims, because the claim, binding, and tombstone protocol cost more than a client-minted ID that only its own client can match.
Consequence: each recorded action of a remote ARMED recording costs one script write and one artifact download.

This lifecycle is distinct from the ADR 0012 repair transaction.
`session save-script` rejects a session with `saveScriptBoundary` set.
The refusal directs the caller to finish or abort the repair through its existing `replay --from` and teardown commit protocol.
Active-session publication never:

- Marks a repair COMPLETE.
- Commits a healed slice.
- Writes `# agent-device:heal-complete`.
- Changes repair tombstone semantics.

### Destination readiness and replay handoff

The destination is an authored postcondition, not the last navigation action.
Before publication, the recorded suffix after the last mutating action must contain a `wait` whose target is a portable selector or selector chain.
That selector must identify a landmark on the ready destination screen.
A duration wait, `wait stable`, or `wait @ref` does not qualify.
But `wait stable` may follow the landmark wait.
The publisher validates the serialized guard before filesystem work.
The publisher never relies on repair-only bare-ref rejection.
Without this **destination guard**, `session save-script` refuses publication and tells the author to record one.
V1 does not infer a screen identity from a snapshot or synthesize an implicit guard.

**Amendment (#1349, shipped).** The guard is now identity-level, not merely selector-level.
A selector wait recorded while ARMED captures landmark-mode `target-v1` evidence for the matched element (ADR 0012's read-only-step amendment).
A qualifying destination guard is exactly a selector wait whose annotation is `verification: "verified"`.
A selector wait on an identity-empty element (no id and no label) records no annotation and does not qualify.
Publication refuses it with a recovery hint that names a labeled/id-bearing landmark.

On replay, polling is preserved.
The wait keeps polling until a selector match carries the recorded identity (local identity + leaf-anchored ancestry prefix).
If the wait reaches its deadline with only same-selector impostors, it fails closed as an `identity-mismatch` `REPLAY_DIVERGENCE` before the wait reports success.
A provider-scenario regression covers the reshuffled-screen false-pass below.
That regression records, publishes, then replays against a reshuffled tree whose same-label node is under a different id/ancestry.

**Amendment (#1398, ADR 0017).** An identity-empty landmark is not the only case that fails to qualify.
A selector wait can have an app-rendered echo as its only identity.
If that echo is of a literal that the recording session already parameterized through `fill --record-as`, the wait also records no annotation.
This is ADR 0017's session-scoped echo protection.
Thus, that wait does not qualify as a destination guard either.
Publication refuses it with the same recovery hint and directs the author to a stable, non-value-bearing landmark.
This refusal enforces exactly the fix that the motivating scenario of issue #1398 applied by hand.

The original selector-level caveat is retained as context.
The guard proved that an element that matches its selector exists.
It did not prove that the element is the same landmark element observed while authoring.
Thus, a reshuffled screen with the same weak label elsewhere could false-pass.
[#1349](https://github.com/callstack/agent-device/issues/1349) owned the identity design for waits and remaining read-only steps.
That design preserves polling.
ADR 0012's pre-action `target-v1` verification cannot be attached to a wait unchanged, because a not-yet-present landmark is the expected starting condition.
Thus, the identity check runs after the wait's selector resolves and before the wait reports success.
ADR 0012's #1349 amendment defines the mechanism and the read-only-step coverage classification.

The phrase "last mutating action" derives from a request-sensitive recording-effect trait on the central `CommandDescriptor`.
Every command that records session actions requires this trait, and a completeness test guards it.
It is not a publisher-local command-name set.
The trait distinguishes app-state mutation from observation for subcommands, such as read-only versus mutating `find`, `keyboard`, and `alert` actions.
The existing conservative `refFrameEffect: may-invalidate` classification is not precise enough for this boundary.

On consumption, a script without `close` preserves the existing replay behavior.
The named session stays active, and the successful `ReplayCommandResult` returns its `session` id.
The caller binds subsequent commands to that returned id.
Replay reports success only after the destination guard completes.
The absence of `close` changes neither action dispatch nor when replay reports success.

**Response shape (issue #1384).** `ReplayCommandResult` carries a required `sessionActive: boolean`.
The daemon computes it when it builds the response, from whether `session` still exists in the daemon's own store.
The daemon never computes it by a re-parse of the script for `close`.
This field lets the real CLI/IPC client (not only the in-process handler) actually honor "the session stays active".
Before this field, the response had no explicit signal.
The one-shot `replay`/`test` teardown of the client had no way to distinguish a still-active handoff from a finished one.
It tore the owning daemon down regardless (`packages/daemon-client/src/daemon-client-lifecycle.ts`).
`sessionActive` is `true` for every close-less run, including a `--from` resume.
It is `false` once the terminal `close` of the script, or the deferred equivalent of a repair-armed run, has executed.

### Sensitive inputs

Executable `.ad` artifacts serialize ordinary action inputs literally.
Diagnostic and event-log redaction cannot protect an input that replay must later execute.
ADR 0017 resolves #1348 for explicit sensitive fills.
`fill ... --record-as PASSWORD` sends the live text to the app while it records only `${PASSWORD}`.
Replay receives the value through `AD_VAR_PASSWORD` or `--env PASSWORD=<value>`.

This protection is opt-in and fill-only.
Unparameterized fill/type inputs remain literal artifact content.
Thus, authors must use ADR 0017 for each sensitive fill and avoid secret-bearing `type` steps.
CLI help states both the safe workflow and the remaining literal-input warning next to publication guidance.

ADR 0017's #1398 amendment extends this protection to the whole recording session.
A later, unrelated recorded action can no longer re-serialize an app-rendered echo of an already-parameterized literal into its own result or `target-v1` evidence.
Thus, a value protected once by `--record-as` stays protected for every action recorded after it in the same session, not only in its own originating fill.

### Artifact contract

The published `.ad`:

- Contains exactly one recorded `open` as its first action, and every recordable action through the publication request.
- Contains a portable selector/selector-chain destination guard after its last descriptor-classified mutating action.
- Does not append or serialize `session save-script` or `close`.
- Uses the ordinary session context header, selector-chain optimization, and canonical `target-v1` annotations captured while ARMED.
- Fails with an explicit error instead of emitting an unresolved session-local `@ref`.
  It also fails with an explicit error instead of dropping target evidence that ADR 0012 requires for an element-targeting recorded action.
- Uses the existing same-directory atomic publication primitive.
  It refuses every existing target unless `--force` authorizes atomic replacement.

The success response identifies the final path and session and reports the number of serialized actions.
The command must fail before writing in each of these cases:

- There is no active session.
- Recording was not armed.
- The recording is ABORTED or PUBLISHED.
- The history does not contain exactly one initial `open`.
- No portable destination guard exists.
- A repair transaction owns the session.

Every failure explains the recovery action.
No failure degrades to `{ written: false }` success.

### Surface and naming

V1 extends the existing `session` command and the typed session client surface.
It does not introduce `script start/stop`, marks, or a second replay engine.
CLI help makes the two phases explicit:

1. The existing `--save-script` flag arms evidence capture.
2. `session save-script` publishes without teardown.

This ADR does not rename or deprecate `--save-script`.
The flag and the session action name the same persisted artifact.
`open --save-script` configures the eventual target of the armed recording.
`session save-script` requests publication now.
`save-replay` is rejected, because replay is the act of executing that script, not the artifact being saved.

## Consequences

- Agents can record onboarding or deep navigation as one self-contained starting state, replay it from scratch, and continue from the resulting live session.
- The workflow has two explicit moments.
  Evidence must be armed before the first target action.
  The destination is known only when the caller publishes.
- Normal unarmed interactions keep their current fast paths and retention behavior.
- A successful active-session publication cannot collide with a later close-time auto-save.
- A second successful open abandons the in-flight artifact instead of silently publishing a multi-open bootstrap.
  Authoring resumes only in a fresh session.
- Intermediate lifecycle-free fragments, entry guards, include semantics, composed digests, and shared fragment pinning remain entirely under #1336.
- Secret-bearing fill authoring uses ADR 0017's explicit `--record-as <VAR>` contract.
  Unparameterized fill/type inputs remain literal script content.
  Arbitrary history ranges remain out of scope.
- On consumption (issue #1384), a `replay` whose script has no terminal `close` leaves a live daemon and app session behind.
  This includes the owned/ephemeral daemon of the ordinary one-shot `replay` invocation.
  The client keeps that daemon alive and reports a `--state-dir` address hint for it instead of a teardown.
  Thus, an unattended close-less replay (for example, in CI) leaks a session exactly like a session opened interactively.
  Ordinary idle-reap or an explicit `close` bounds it, never the process lifetime of the one-shot command.
  This is the intended shape of "the caller owns close", not an accident.
  Recorded test flows already end with `close`, so `test` runs are unaffected.

## Alternatives Considered

- **Save any session history at the end.** Rejected, because target identity evidence cannot be reconstructed after the interaction.
  The resulting artifact would weaken ADR 0012's provenance model.
- **Capture full target evidence in every session.** Rejected until its direct-path latency, capture count, memory, and event-log costs are measured.
  It would alter ordinary interaction behavior to make one authoring command shorter.
- **`close --no-close` or `--save-script --no-close`.** Rejected, because a command named for teardown would conditionally preserve the session.
  It also would not solve late arming.
- **General `script start/stop` or history marks.** Rejected, because the accepted v1 boundary is exactly one recorded `open` through one destination.
  Arbitrary slices require entry-state semantics and belong with fragment design.
- **`replay save`.** Rejected, because `replay <path>` consumes an artifact while publication consumes a live session.
  The session owns the source data and lifecycle.
- **Infer a destination fingerprint at publication.** Rejected for v1, because screen identity and readiness are app semantics.
  A caller-authored target wait is explicit, already recordable, and fails at the correct point during cold replay.

## Validation Required for Implementation

- An unarmed session refuses publication before filesystem work and names `open --save-script` as the recovery.
- An armed session without a destination guard refuses publication before filesystem work and names a selector-targeted `wait` as the recovery.
  `wait @ref`, duration waits, and `wait stable` are covered refusal cases.
- A second successful plain `open` changes ARMED to ABORTED and disables all publication.
  `open --save-script` on an existing session is rejected before app dispatch.
- An armed session publishes `open` plus target-annotated actions without `close`.
  It returns the final path, remains active, and can continue to accept commands.
- The artifact replays from a cold start, completes its destination guard, returns the live session id, and accepts a subsequent command on that session.
- Every action in ADR 0012's existing target-binding command set has canonical identity evidence, and no unresolved `@ref` reaches disk.
  Since #1349, the destination guard additionally requires verified recorded landmark identity.
  A reshuffled-screen false-pass regression proves that replay fails closed.
- Existing-target refusal preserves the original bytes.
  `--force` replaces atomically.
  A failed publish remains retryable.
- A relative destination is refused at entry, and a refused destination creates no directory anywhere in the chain it names.
- A group-writable directory is refused whoever owns it, with the `chmod g-w` hint, and a group this user owns is no exception: membership cannot be proven from `/etc/passwd` and `/etc/group`, because `systemd-userdbd` serves memberships those files never show.
- Every directory the publish creates answers `0700` under umask 002, and the published file answers `0600`.
- After PUBLISHED, later ordinary actions remain usable, and a repeated `session save-script` fails.
  Plain `open --relaunch` cannot re-arm.
  `open --save-script` is rejected before app dispatch.
- In ABORTED/PUBLISHED, `close --save-script[=<other>]` is rejected before platform close.
  Plain `close` tears down without writing.
  The close of an unpublished ARMED recording preserves the current close-time publication behavior.
- On a never-armed session (2026-08-02 amendment), `close --save-script` is likewise rejected before platform close or filesystem work.
  The refusal names `open --save-script` as the recovery.
  Plain `close` still tears down without writing.
  The rejected request does not delete the session.
- Descriptor completeness tests classify the mutation effect of every recordable request, including request-sensitive read-only/mutating subcommands.
  Destination-guard ordering consumes only that trait.
- Repair-armed sessions refuse this action without a change to repair state.
- CLI help documents ADR 0017's `--record-as` workflow.
  CLI help warns that unparameterized fill/type inputs remain literal script content.
- Provider-backed integration scenarios cover the public daemon route.
  Live iOS and Android runs prove the saved artifact and the post-save session behavior on real backends.
