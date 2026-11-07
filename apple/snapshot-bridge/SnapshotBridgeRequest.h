#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Validates one `describe` request and reads the tree it names. The guest server and the XCTest
/// runner both answer through this function, so a request means the same thing on either transport.
NSDictionary *SnapshotBridgeHandleRequest(NSDictionary *request);

NS_ASSUME_NONNULL_END
