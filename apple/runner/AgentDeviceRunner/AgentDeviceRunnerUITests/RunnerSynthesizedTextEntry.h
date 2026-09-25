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

// Characters per second the synthesized text-input records are typed at. Declared here, where the
// typing happens, so the delivery budget that bounds a burst is charged the same pace the app sees.
// The edit-acknowledge window that pace is sized for is a separate assumption about the app
// (TextEntryTiming.synthesizedAcknowledgeWindowSeconds), not a value derived from this one.
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
