# Recording finalizer ownership

When you compile a recording helper, give the compiler private attempt paths for its sources, output, temporary files, home, and module caches.
When you run a recording helper, keep its writable input, output, and temporary paths inside its private attempt.
When AVFoundation exports an overlay, pass it the private attempt output path.
When a helper succeeds, copy its output to a parent-owned inode before publication.
When you publish an overlay, validate the parent-owned copy before the atomic rename.
When you wait for a copy, propagate the finalization deadline and the request cancellation signal.
When a copy ends, wait for its streams to close before you return.
When you submit a publication rename, check the deadline and request signal immediately before the rename.
When you snapshot a compiled executable, use its recorded parent-owned inode and verify the compiler output before publication.
When you stop a recording, do not cancel the host's shared validator preparation.

When an attempt ends, seal its work alias before you reclaim its private data.
When you close or reclaim an attempt, hold its process lock through the journal and pending-entry updates.
When you retry a close, read the current journal under that lock before you write it.
When a live owner's close journal or alias seal fails, retain that owner's exact retry authority.
When cancellation and cleanup fail together, keep the typed cancellation and its cleanup evidence.
When preparation retries or closes, retry each retained attempt with bounded cache-owner work.
When an exact attempt is closed, fenced, and removed from the pending queue, clear only its cleanup failure.
When another cleanup failure lacks that proof, retain that failure.
When private data is empty, create a fence candidate inside that data and record its identity before you link the candidate outside the data directory.
When the recorded fence is linked outside the data directory, remove the data directory and link the recorded fence at its path.
When a crash leaves an unrecorded candidate inside private data, remove it through the bounded private-data cleanup before you retry.
When an absent data directory has no recognized outside fence, recreate only that private data directory and retry its fence.
When an outside fence has no matching recorded identity, retain it and its pending record.
When another writer creates a replacement during that transition, retain the attempt and retry its exact cleanup.
When a parent crashes, reclaim an exact attempt only after you verify that the recorded parent no longer owns it.
When you reclaim an attempt, bound each pass and keep its record if cleanup is incomplete.
When a bounded pass does not reach an attempt, retry the exact attempt by its cache-owned identifier.
When an entry is a symbolic link, unlink the link without traversing it.
When you recover a publication sibling, derive its name from the current video path and the recorded attempt identity.
When you recover a publication sibling, remove it only if its file identity matches the attempt record.
When a record lacks an exact identity, retain the record and the unknown path.
When a descendant keeps an unlinked file open, retain the attempt record.
When an attempt is sealed, do not treat the seal as proof that a descendant exited.

When you assess an Xcode toolchain, verify its writable paths before you extend this contract.
When macOS framework or XPC behavior is not established, retain the separate unknown obligation.
When you inspect a completed export, do not use it as proof that a native, request-binding, or session owner settled.
