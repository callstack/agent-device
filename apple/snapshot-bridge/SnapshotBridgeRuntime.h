#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

extern NSString *const kProtocolVersionKey;
extern NSString *const kSourceVersionKey;
extern NSString *const kRequestIdKey;
extern NSString *const kSourceVersion;
extern const NSUInteger kProtocolVersion;
extern const uint32_t kMaximumFrameBytes;
extern const NSUInteger kMaximumDepth;
extern const NSUInteger kMaximumNodes;

NSDictionary *failureResponse(NSString *requestId,
                              NSString *kind,
                              NSString *code,
                              NSString *message);

@interface BridgeRuntime : NSObject
- (nullable instancetype)initWithError:(NSString *_Nullable *_Nullable)error;
- (nullable NSDictionary *)snapshotForProcess:(pid_t)pid
                                    maxDepth:(NSUInteger)maxDepth
                                    maxNodes:(NSUInteger)maxNodes
                                  requestId:(NSString *)requestId
                                      error:(NSDictionary *_Nullable *_Nonnull)error;
@end

BridgeRuntime *_Nullable sharedRuntime(NSString *_Nullable *_Nullable error);

NS_ASSUME_NONNULL_END
