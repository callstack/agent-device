#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, RunnerSynthesizedTextEntryStatus) {
  RunnerSynthesizedTextEntryStatusSucceeded,
  RunnerSynthesizedTextEntryStatusUnavailable,
  RunnerSynthesizedTextEntryStatusFailed,
};

@interface RunnerSynthesizedTextEntryResult : NSObject

@property(nonatomic, readonly) RunnerSynthesizedTextEntryStatus status;
@property(nonatomic, readonly, nullable) NSString *message;

@end

@interface RunnerSynthesizedTextEntry : NSObject

// Synthesizes keyboard input for the current first responder without resolving an
// XCUIElement or serializing the application's accessibility tree.
+ (RunnerSynthesizedTextEntryResult *)synthesizeTextWithApplication:(id)application
                                                               text:(NSString *)text;

// Replaces the current first responder's contents using one synthesized
// Command-A, Delete, and text-input event sequence.
+ (RunnerSynthesizedTextEntryResult *)replaceTextWithApplication:(id)application
                                                           text:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
