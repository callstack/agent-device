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
//
// `charactersPerSecond` is XCTest's `typingSpeed:` argument. The caller declares it because the
// same number is what the caller's delivery budget charges a burst (#2955): a pace owned here and
// read back from Swift would let a call site type at a speed its own budget never charged.
+ (RunnerSynthesizedTextEntryResult *)synthesizeTextWithApplication:(id)application
                                                               text:(NSString *)text
                                                  charactersPerSecond:(NSUInteger)charactersPerSecond;

// Replaces the current first responder's contents with one synthesized Command-A record
// followed by a text-input record, typed at the pace the caller declares.
+ (RunnerSynthesizedTextEntryResult *)replaceTextWithApplication:(id)application
                                                           text:(NSString *)text
                                              charactersPerSecond:(NSUInteger)charactersPerSecond;

@end

NS_ASSUME_NONNULL_END
