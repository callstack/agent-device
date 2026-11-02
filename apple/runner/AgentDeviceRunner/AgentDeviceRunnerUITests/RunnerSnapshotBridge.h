#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Serves the Simulator AX bridge reader (`apple/snapshot-bridge`) from the runner process, for hosts
/// that cannot start the guest bridge process, such as a remote Simulator. Each call returns one bridge
/// envelope: the reader's own response keys, plus `processStartTime` beside `pid` so the host can name
/// the app generation it read. A host that has no envelope to answer with gets a failure envelope, never
/// an exception.
///
/// `verb` is `target` or `describe`. `target` names the foreground process of `bundleId`. `describe` reads
/// that process's tree; with an expected pid and start time it refuses another process of the same
/// bundle as `stale_target`, and it refuses a capture whose process changed while it was read.
NSDictionary *RunnerSnapshotBridgeHandle(NSString *verb, NSString *bundleId, NSDictionary *request);

NS_ASSUME_NONNULL_END
