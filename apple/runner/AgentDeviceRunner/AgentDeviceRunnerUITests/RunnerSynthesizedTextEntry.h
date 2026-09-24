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

// Characters per second the synthesized text-input records are typed at. The delivery budget and
// the app-acknowledge window a burst has to fit inside are both derived from it, so it is declared
// once, here, where the typing happens.
+ (NSUInteger)typingSpeedCharactersPerSecond;

// Synthesizes keyboard input for the current first responder without resolving an
// XCUIElement or serializing the application's accessibility tree.
+ (RunnerSynthesizedTextEntryResult *)synthesizeTextWithApplication:(id)application
                                                               text:(NSString *)text;

// Replaces the current first responder's contents with one synthesized Command-A record
// followed by a text-input record, typed at the bounded pace declared in the implementation.
+ (RunnerSynthesizedTextEntryResult *)replaceTextWithApplication:(id)application
                                                           text:(NSString *)text;

@end

NS_ASSUME_NONNULL_END
