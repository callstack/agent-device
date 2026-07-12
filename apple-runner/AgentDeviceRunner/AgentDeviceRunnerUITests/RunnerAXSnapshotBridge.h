#import <Foundation/Foundation.h>
#import <XCTest/XCTest.h>

NS_ASSUME_NONNULL_BEGIN

@interface RunnerAXSnapshotBridge : NSObject

+ (NSDictionary<NSString *, id> *)snapshotTreeForApplication:(XCUIApplication *)application
                                                    maxDepth:(NSInteger)maxDepth
                                                    maxNodes:(NSInteger)maxNodes;

+ (NSInteger)processIdentifierForApplication:(XCUIApplication *)application;

@end

NS_ASSUME_NONNULL_END
