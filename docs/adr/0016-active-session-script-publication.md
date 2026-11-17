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

- Before it sends the open, the client mints a random publication ID and records the destination and the `--force` grant under it in its state directory (`remote-connections/session-scripts/`), keyed by the endpoint, the tenant, the session, and that ID. That directory is the client's own private state, not a script destination: the client creates it the way it always did, with one recursive `mkdir` that forces nothing on a directory that already stands, and the only file ever written there is the client's own record. The script itself is published by the daemon, where the walk above judges every destination.
  The open carries the ID in `meta.scriptPublicationId` and never the caller path.
  A daemon answer that does not name the ID removes the record.
  A failed open may still have armed the recording, so it keeps its record.
- The daemon arms the recording under that ID, which `open` and `close` name in `scriptPublicationId`.
  After each successful request that records into the ARMED recording, the daemon writes the recording so far, without a terminal `close`, and returns it as a `session-script` artifact with the ID and a growing `scriptRevision`.
  The close-time write is the final version and has the highest revision; close takes it from the close-time write itself, so a capture that close stops first never hides recorded actions.
  Each version, the final one included, is a fresh 0600 file in a 0700 directory under the daemon's sessions directory, and is downloaded once. That directory is written only when the daemon's own state chain was established as private ground; a version the chain cannot claim is a failed delivery, not a file elsewhere (see the state-mode rule below).
  It registers for download for the tenant that opened the recording, whatever the tenant, capture filters, or network marker of the request that recorded it.
- The client writes a version only to the destination of a record that matches its ID and scope, and only when its revision is newer than the last published one.
  The `savedScript` field and the `session-script` type are reserved for this path, so a script artifact under another field writes nothing.
  Thus, a daemon response never establishes a destination, and another publication's or another session's version writes nothing.
  The download streams, capped at 8 MiB, into a new 0600 file, created exclusively and never through a symbolic link, in a 0700 staging directory beside the destination.
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

Both routes resolve an absolute destination before asking host-kit, and host-kit refuses a relative one at its entry. The walk that follows is the POSIX rule: it reads `lstat` of each name, so the chain it judges is the chain that gets created, and on Windows there is no such chain to walk — access there comes from an ACL, `chmod` toggles only the read-only bit, and creation is a recursive `mkdir`. A Windows destination is therefore outside this guarantee, and Windows relies on the ACL of the directory the operator chose. It owns parent creation as ONE call — walk, refuse, create what is missing at 0700 inside the judged directory, judge again, answer with the judged directory and its identity — and both the local writer and the remote client make that one call before staging. The identity travels with the answer, so the remote client stages each version inside the directory that answer named instead of walking the destination a second time. The rule closes the window with PERMISSIONS, not with timing.
A destination is accepted only when no other non-root local user can modify any directory the publish traverses. Each directory must be owned by the current user or by root, and its mode must keep its contents closed to others. Once that holds, nobody can swap a component out or plant one, so the path that was judged is the path the publish reaches; nothing depends on when a directory was judged.
The walk emulates the kernel's own path resolution, because that is the set of directories that has to be safe. It starts at `/` with the parent's components on a queue, and takes one component at a time: `.` is skipped; `..` moves to the parent of the directory PHYSICALLY stood in, never to the parent of the spelled string; any other component is looked up with `lstat` inside that directory. A directory is judged and entered. A symbolic link is judged where it physically stands and its target's components go on the front of the queue, restarting from `/` for an absolute target and continuing from the directory that holds the link for a relative one. An absent component ends the walk, and the walk reports that it stopped SHORT of the directory the entry is created in, rather than presenting the nearest ancestor as if it were that directory. Nothing calls `realpath`: it answers only with the final directory, so every directory stepped through on the way can disappear from the answer, and a JS `realpath` simplifies `..` lexically while the kernel applies it to the link's target.
Because the walk ends at the first component that does not exist, what it judged before any creation is exactly the chain that already stands, and a destination the rule refuses leaves no directories behind. The missing tail is then created at 0700 inside the judged directory, ONE LEVEL AT A TIME, and the walk runs again over the now-complete chain. One `mkdir` per name is what keeps the creation inside ground the walk stopped in: a recursive `mkdir` resolves the whole tail as text, so a link another local user plants at one of those absent names while the walk is still running carries the creation to the far side of it, where it leaves a directory behind and, run as root, creates one with privileges. A name that was absent when the walk looked and exists by the time `mkdir` reaches it is JUDGED, not refused and not trusted: two processes saving into the same new directory meet there, so refusing it (which an earlier shape did, as `entry_appeared`) failed a routine concurrent save. The entry under the name is read by the same single `lstat` every other step is read by and judged by the same rule, which adopts a private directory this user owns and refuses one another user owns, one the group or others can write, and a link. An appeared level is also asked whether other local users could add a name inside it, which a directory this call created itself is not: below one they can write, they can make the destination's own name first. Where nothing was missing, the first walk already judged the directory the entry is created in, and its answer is the answer. Every directory a script publish creates must itself pass the check it is judged by, under any umask: under umask 002 a mode-less creation is 0775, and the check that follows it would refuse the very directory the publish just made. The second question is where "could other local users add a name inside that directory" is asked, because below the first one the directories are the caller's own to create, at 0700.
Creating what is missing does not make every spelling resolvable. A `..` queued BEHIND the absent component is refused as `unresolvable_parent` before anything is created: the kernel cannot apply that step until the name before it exists, while a `mkdir` of the same spelling resolves it as text and builds what stands on the far side of it — `private/missing/../../shared/recordings` never gets `shared` judged, and the creation lands `shared/recordings` in ground any local user can write, beside a `private/missing` of its own. A `..` over directories that all exist is applied one step at a time, exactly as the kernel applies it. After creation, publishing proceeds only where the second walk ARRIVED at the directory the entry is created in; stopping short is a refusal (`unreachable_parent`), never a write into the nearest ancestor.
A RELATIVE destination is refused at entry (`relative_destination`). Both routes expand the caller's path to absolute before asking, and walking a relative name would mean walking the process's working directory too — whose NAME Node answers from the first query after the last `chdir`, so it can be stale while the process stands elsewhere. Refusing at the entry keeps that question out of the rule.
Shapes this closes, each of which an earlier shape of the rule accepted:
- A plain directory under a shared one can hold a link into a private destination, so the destination looks private while the ground it stands on is shared: `rec -> shared/relay/sub`, `shared` at 0777 and not sticky, `shared/relay -> chosen`. Judging each lookup catches `shared`.
- A link inside a link target hides its own directory, and a followed link's owner was never asked: `~/rec -> /tmp/relay -> ~/chosen`, `relay` another user's file in sticky `/tmp`. Every followed link is judged with `untrustedLinkExposure` against the directory that holds it, at any depth, so spelling the target directly and arriving through a link answer the same way.
- `..` applies to the directory the walk is in: with `home/work -> priv/x` and `priv/y` at 0777, `home/work/../y` lands in `priv/y`, not in the private `home/y` the normalized spelling names.
- A target may be spelled relative to the link that holds it, which is how `ln -s ../team/rec rec` is written, and it may contain a `..`. Both are applied one component at a time to the physical directory the walk reaches, never joined as text: `path.join` folds a `..` away, and the folded answer is a different directory.
- A relative destination would put the working directory into the judged chain, and a stale cwd name judges a directory the process is not in while the kernel resolves the destination in the moved one. Host-kit refuses relative destinations at its entry instead of emulating that resolution.
The walk ANSWERS with the physical directory the entry is created in, and that answer is used as it stands. Both publishers stage inside it and create the entry inside it, spelled from it; neither hands the spelled destination back to the filesystem. `path.dirname` and `path.join` of the spelled destination answer a different directory wherever the walk turned aside, and a temp or staging file in that directory is one another local user can list, reach, and put their own bytes behind before the publish renames it. Asking the kernel to resolve the spelled destination a second time, at the moment of the link or rename, resolves it through whatever stands on the path by then. Each entry is read from the host once per visit, by `lstat` and never by `stat`: `lstat` judges the ENTRY a name holds, while `stat` resolves the same name a second time and answers whatever it points at by then. A name a walk reaches twice, through a `..` or an alias, is judged again from a fresh `lstat` and reaches the same judgment; the walk keeps no memory of ground it stood on and no second identity check of it. An earlier shape kept such a memory and compared an identity on every re-visit and before every creation, refusing `parent_replaced`; it is CUT, because the ownership rule already excludes anyone who could make that swap — a directory the walk stands in is one this user or root owns that others cannot write in, or a sticky one where this user's entry cannot be replaced. The judgment a step rests on is the single `lstat` of that step: a symbolic link is judged as a link, against the directory that holds it, and the walk goes on to its target one component at a time rather than asking `stat` what the name resolves to.
A link hop count is kept and refused at `link_loop_exceeded` below the limit the kernel applies (macOS 32, Linux 40), so a walk that ran out of hops is a refusal rather than a pass, and a loop can never be trusted. A component that is neither a directory nor a link is refused as `not_a_directory`: the kernel cannot travel through it either. Root-owned system aliases (macOS `/tmp` to `/private/tmp`, `/var` to `/private/var`) keep working.
The sticky bit excuses a directory the walk passes THROUGH, when this user or root owns it, because it stops anyone but an entry's owner or root from replacing that entry; a sticky directory another user owns is refused, because those bits shield other users from that owner rather than the reverse. It never excuses creating the destination inside that directory, because anyone could create that name first. The link's own mode is never consulted: a link's bits say nothing about access on Linux, so what is judged is the directory the walk lands in, plus the ownership of the link and of the directory that holds it.
A group-writable directory is refused (`shared_group_writable`, with a `chmod g-w` hint), with the one exception of the sticky bit for passing THROUGH. An earlier shape of this rule carried a private-group exception, which read `/etc/group`, `/etc/passwd` and `/etc/nsswitch.conf` to admit a group-writable directory whose group was proven to hold no other user, and it is DROPPED. Membership cannot be proven on the platform that motivated it: stock Ubuntu and Debian ship `passwd: files systemd` and `group: files systemd`, a name service can hold a member no file shows, and no reading of those files closes that gap — the exception admitted nothing exactly where it was written to help, and every host it did admit could say the same thing by its mode instead. What replaces it: directories a script publish creates are created 0700, which covers every new directory under any umask, and an existing 0775 checkout is refused with a hint to `chmod g-w` it. The rule reads no account database, and its answer does not depend on which name services the host runs. The daemon's own state directories are part of that chain on both routes: the daemon creates and repairs the state directory, its `sessions/` directory and `remote-scripts/` at 0700 rather than leaving them to a mode-less `mkdir`, because under umask 002 a stock host would make `sessions/` 0775 and the rule above would then refuse the daemon's own default recordings and every remote-delivered version. That repair judges ground the way the walk does, and never through the NAME: the mode is forced through a descriptor opened `O_DIRECTORY | O_NOFOLLOW`, and only once the `fstat` of THAT DESCRIPTOR says this uid owns the entry. A repair given the name resolves it again, and a root daemon asked to repair a legacy state directory another user could write would reach through a `sessions` they left as a LINK and strip access from an owner who never ran the daemon. `O_NOFOLLOW` guards only the LAST name of that open, so the repair does not judge the requested level alone: it walks DOWN from the state base, `lstat`s each level under its own name, and repairs a level only when every level above it passed. A level that is a link, is not a directory, or belongs to another uid stops the descent, and that level and every level beneath it are left as they are. What the entry IS is asked before its mode, because on a host where a link carries its own mode a link at 0700 answers the mode question with the private mode and would pass unjudged.
Judging DOWN from the base is not the whole judgment, because the descent never questions the ground the base stands on. A local user who can write an ancestor ABOVE the base can rename the base and leave a link at its name between two of the repair's calls, and every level below then resolves on the far side of a link nothing judged; as root, the repair forces a mode there and reports the chain private. So the state base is resolved ONCE, first, by the same walk a script destination is judged by (`verifiedDirectoryPath` and `verifiedDirectoryAncestry` are that walk's own steps), and this ADR carries no second version of it. That resolution owns three things a spelled base cannot answer. It judges the ground ABOVE the base before a level is touched. It cuts any trailing SEPARATOR off the base's name before anything looks that entry up, because `state/` is the kernel resolving THROUGH a link at `state` — the `lstat`, the `O_NOFOLLOW` open and the `fchmod` that follows would all land on the far side, which is how `AGENT_DEVICE_STATE_DIR=/trusted/state/` with `state -> outside` moved `outside` from 0755 to 0700 and called the chain private. And it answers the PHYSICAL directory the walk arrived at, with the base's own final name re-attached unnormalized, because a spelled base is not the chain the kernel walks: `alias/../state` steps back out of wherever `alias` physically stands, while `path.relative` and path.join fold that step away, and a descent built from the folded text repairs and reports a different directory than the one judged. Every level the repair descends, and the path a caller is handed back to write under, is built from that one answer rather than re-derived. The rest of the daemon's state is NOT rebased onto it. Resolution, launch, the lock, the registration, the tombstones, the remote connection state, the publication records and the generated config keep the spelling the setting gave, exactly as before this rule: a client names those entries with the same setting and the same rule, and the kernel resolves a step for a process that only reads, so one spelling is one entry. Answering them with the verified chain would move each one out of what every client can name, and the daemon would write where its clients cannot look. The verified chain carries exactly two writers, because a CREATION is the only thing exposed to a caller-side normalize: a default recording under `sessions/`, and a remote version under `sessions/remote-scripts/`. Those two are appended below the base the path owner holds (`childPath`), ensured with `ensurePrivateDaemonStateDir`, and written at the answer that comes back, because that answer is both where the judged chain physically is and whether it is private ground. Names the repair walks, and the two directories the daemon creates for its own recordings, are therefore APPENDED below the answered base with `childPath`, never re-derived from the caller's spelling: `path.join`, `path.resolve` and `path.dirname` normalize, and a folded `alias/../state/sessions` names a different directory than the kernel creates, opens and repairs. What is compared to the caller's spelling instead is a NAME test: `stateTailBelow` asks `path.relative` for the names from the base down to the requested directory, rejects a tail that escapes (`..`, or an absolute answer), and hands only those NAMES to the descent, which re-attaches each one to the verified physical base. A `..`, an alias or a trailing separator in either argument therefore cannot move a level onto ground nothing judged, because no spelled path is ever joined onto anything. Nothing else adopts the answered spelling, so the rule reaches a name only where this code is the one that creates it. What those steps answer is pinned in host-kit, where the rule lives. The startup marker and the shutdown report still spell their own names with `path.join`, so on an aliased base those two files stay beside the alias; that is pre-existing behavior, tracked separately as #4620, not something this rule settles. The judgment covers what is ABOVE the base, plus the base's own entry as a name: the base and the levels under it are what the repair exists to make private, so a `sessions/` left at 0775 by umask 002 is repaired rather than refused. Where that rule refuses, nothing below is repaired, `daemon_state_mode_repair_skipped` names the ancestor and its exposure, and the chain answers not private. A sticky ancestor this user or root owns is passed through, because the destination rule passes it through: the sticky bit stops anyone but an entry's owner or root from renaming that entry, which is exactly the swap this closes. The consequence for a host whose state sits under a shared, non-sticky directory is that it delivers no daemon-picked recordings, on the same `state_chain_untrusted` refusal, startup and every other command unaffected. One name must not be repaired twice under two spellings: the session store keeps the state base it was HANDED rather than deriving `path.dirname(sessionsDir)`, because `path.join` folds a `..` step out of `sessionsDir` and the repair would then judge a chain the walk never arrived at — one session's artifacts in the folded tree, its script in the verified one. The base decides the answer, so the answer is used: a session artifact is created, written, read and removed under the path the repair RETURNS or its create-free twin `answeredDaemonStateDir` gives, never re-derived from `sessionsDir`. A tombstone written to the repaired chain and looked for in the folded text is a lost marker, and both writers caught their own `ENOENT`.

A state-mode repair NEVER decides whether the daemon starts, and it is not a second destination rule. It forces 0700 on a directory entry this uid owns, reached without following a link, and on nothing else; every other shape — a link, a name that is not a directory, a level another uid owns, or an error from any step it takes — changes nothing and emits `daemon_state_mode_repair_skipped`. The whole repair is wrapped, INCLUDING the walk that resolves the base, so `EACCES` on a directory this user cannot read, `ENOENT` on one that disappears meanwhile, `EIO` on the `close` that ends it, and `EIO` on an ancestor's `lstat` inside that walk are all reported the same way and stop there rather than reaching startup. What it CREATES follows the same order as the judgment, and that order is what a recursive `mkdir` could not give: each level of the chain is stood on and judged BEFORE anything is created below it, only a name found ABSENT is created, and it is created by host-kit's one per-level creator inside the directory this walk just judged. So `AGENT_DEVICE_STATE_DIR` with `state/sessions` a link to an existing directory answers `state_chain_untrusted` for a destination the daemon picks, and the directory the link points at gains NO `remote-scripts` — where one recursive `mkdir` before the judgment resolved the tail as TEXT, built that directory on the far side and forced its mode, with the daemon's privileges. A refusal therefore creates nothing FOR A SCRIPT, and that reaches the BASE too: the descent stops at a level it will not stand on whoever owns it, so a base owned by another uid, or planted as a link, gains no `sessions/remote-scripts` beneath it while answering `privateChain: false`. One caller is exempt from that silence, and it is exempt in the narrowest possible way. Startup, the session artifact directories and the tombstones write no script, and the daemon answers NOTHING without its own state levels — its log, lock, registration and every artifact path sit below them — so the own-state entry point (`ensureDaemonStateDir`) is still given those levels on ground the walk refused, and the fallback runs for ANY level that stops the descent, not only for the base. What it runs there is EXACTLY what main ran: one recursive `mkdir` of the directory the caller asked for, and NO mode change of any kind. Stopping the fallback at the base was a regression against main: with `state/sessions` a link and the session's own directory missing, `ensureSessionDir` returned a path to a directory nobody had made, and the idle-expiry tombstone write failed `ENOENT` inside its own best-effort catch, so the marker was lost in silence while main's recursive `mkdir` made the write succeed. It may not use `createMissingLevels`, because that creator's `mkdir`-then-`chmod`-BY-NAME is a two-step, and every other local user of a shared non-sticky ancestor holds the window between them — rename the directory this call just created, put a link at its name, and the `chmod` lands wherever they pointed, forcing 0700 on ground whose owner never ran the daemon. The per-level creator's own trust questions are asked of ground it was told is trusted, so feeding it an untrusted parent to borrow its link check would borrow the race with it. A fresh state directory inside shared non-sticky scratch therefore starts, opens its log and serves every command, and loses only the daemon-picked recordings; failing startup there would punish the exact container and shared-CI shapes this repair exists to keep working (#4565). Any creation redirect that survives on that path is main's own pre-existing behavior of a recursive `mkdir` over the spelled directory — including through a `sessions` that is a link, where the child appears on the far side — tracked with the other spelled-name paths in #4620 rather than changed here. The base spelled as a link to another disk is still the one name this crosses for an `own-state` caller: the walk judged the ground the link stands in, the operator chose that layout, and its state goes where the link points — reported as not private ground, so no recording of the daemon's own choosing is written there. Creation is best-effort in the sense that it never fails startup, not in the sense that it runs first: the rule `repairStateMode` applies to the log file is hygiene for a host the daemon owns, not a gate on a host it does not.
What the repair ANSWERS is a second thing from what it forces. It reports whether the whole chain from the state base down to the requested level is private ground: a real directory, this uid's, standing 0700, reached without following a link. Startup ignores that answer and starts either way, so a state directory on a bind-mounted CI volume, a `~/.agent-device` symlinked to another disk, and a container whose `sessions/` belongs to the mounted uid all still start with every command working. A SCRIPT DOES NOT ignore it. A destination the daemon picks for itself — a default recording under `sessions/`, a remote version under `sessions/remote-scripts/` — is written only on a chain that answered private, and refused otherwise with `state_chain_untrusted` and a hint naming that host shape and its fix. So the host whose state tree belongs to another uid keeps a working daemon and loses its daemon-picked recordings: an owner this process is not can replace that level at any moment, so it is not ground to publish a recording on. That refusal is the CHAIN VERDICT's own, not the destination walk's: the walk judges ground, and it ACCEPTS a symbolic link standing in a parent others cannot write, so `sessions -> outside` with `outside` at 0755 and owned by this user passes the walk and would land the version outside the state tree. A caller's `--save-script=<path>` keeps the old behavior on every one of those hosts: that destination is the caller's own, and the walk alone decides it. So the repair skips modes best-effort and never refuses STARTUP, and the only refusals of a RECORDING are the destination walk (a caller's path) and this chain answer (the daemon's own).
The script file is created 0600, locally and remotely alike, so a recording is not world-readable in a directory that is merely shared.
Remote delivery walks a destination TWICE per version where the parent already stands, THREE where a level has to be created, and compares identity ONCE either way. The local writer walks ONCE for the same reason, TWICE with a missing parent, and compares nothing. The first walk happens before staging, and where it stops short it creates the missing levels and walks again before answering; so a destination that has to be built costs one more walk on either route. It answers with the judged directory and that directory's `dev:ino`, and staging is allocated inside the directory that answer names. The second happens under the record lock right after the download, through `confirmScriptDestination`, and it is the one comparison: this walk's identity must be the one the earlier answer carried, or the version is refused (`parent_replaced`) instead of renamed into ground nobody judged. Two walks, not three: an earlier shape walked a third time at allocation to be told a directory the call one line earlier had already answered. One call, exported, owns that confirmation and the refusal it answers with, and the remote route holds no copy of either — a route that hand-rolls the reason, exposure, ancestor and hint drifts from the rule that produced them, and this one did. The local publish walks once and compares nothing, because nothing runs between its judgment and its rename. The ownership rule is what closes the window — anyone able to swap a judged directory was refused at it — so the retained comparison is defense in depth against a host whose modes moved, not what excludes the attacker.
Node exposes no `openat` or `renameat`, so publishing relative to a verified directory handle is not available without native code; the permissions rule is what substitutes for it.

### What the guarantee does not cover

The rule judges ownership bits, mode bits and link shape. Three things sit outside it, and no combination of them is a reason to expect confidentiality:

- **ACLs.** macOS and Linux filesystem ACLs are consulted ahead of the mode bits, and the rule does not read them. A directory at 0700 can still grant `everyone` write through an ACL, letting another user plant or swap a component; a 0600 file can still inherit an `everyone` read entry, so the file's mode is not a promise about who can read it. Checking ACLs is deliberately not implemented. Callers who need that guarantee on such a host choose the destination's permissions and ACLs together.
- **Network filesystems.** NFS, SMB and FUSE mounts answer ownership, mode and link questions however the server pleases, and an unverified server can change any of them while the publish runs. Uids on a mount are usually not the uids on this host either. A script destination on a network mount is outside the guarantee.
- **Bind mounts and mounts in general.** A directory can be mounted over another after the judgment, and the publish writes into whatever stands there. The `dev:ino` comparison notices a replaced destination directory on the same route that captured its identity; it cannot notice a mount that was already there and was never judged.

So the guarantee is: on a local filesystem with no ACLs on the directories the walk judges, no other non-root local user can steer where the recording is written or create that file. It is not a promise that nobody else can read the file.
A local write fails with `script_ancestor_untrusted`, `script_ancestry_replaced`, or `state_chain_untrusted` (a path the daemon picked itself, on a state chain the repair did not accept); a remote version keeps its command's success and carries that reason as the `scriptDeliveryFailure` cause.
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
