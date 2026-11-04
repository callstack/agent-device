# Recording finalizer ownership

When you compile a recording helper, give the compiler private attempt paths for its sources, output, temporary files, home, and module caches.
When you run a recording helper, keep its writable input, output, and temporary paths inside its private attempt.
When AVFoundation exports an overlay, pass it the private attempt output path.
When a helper succeeds, copy its output to a parent-owned inode before publication.
When you publish an overlay, validate the parent-owned copy before the atomic rename.
When you wait for a copy, propagate the finalization deadline and the request cancellation signal.
When a copy ends, wait for its streams to close before you return.
When you stop a recording, do not cancel the host's shared validator preparation.

When an attempt ends, seal its work alias before you reclaim its private data.
When private data is empty, remove its directory and create the recorded data tombstone.
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
