#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface RunnerSynthesizedTextEntry : NSObject

// Synthesizes keyboard input for the current first responder without resolving an
// XCUIElement or serializing the application's accessibility tree.
+ (NSString * _Nullable)synthesizeTextWithApplication:(id)application
                                                    text:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
