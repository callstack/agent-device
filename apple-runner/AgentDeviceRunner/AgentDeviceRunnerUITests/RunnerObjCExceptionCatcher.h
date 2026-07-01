#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface RunnerObjCExceptionCatcher : NSObject

+ (NSString * _Nullable)catchException:(NS_NOESCAPE dispatch_block_t)tryBlock;

@end

NS_ASSUME_NONNULL_END
