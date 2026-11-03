#import "AgentDeviceTextEntryFields.h"

#if TARGET_OS_IOS && defined(AGENT_DEVICE_RUNNER_UNIT_TESTS)
@implementation AgentDeviceMaskedTextField
- (NSString *)accessibilityValue {
  NSUInteger length = self.text.length;
  if (length == 0) {
    return [super accessibilityValue];
  }
  NSUInteger bullets = MAX((NSUInteger)1, length / 2);
  return [@"" stringByPaddingToLength:bullets withString:@"\u2022" startingAtIndex:0];
}
@end

static NSUInteger AgentDeviceTextEntryValueReads = 0;

@implementation AgentDeviceValueReadCountingTextField
- (NSString *)accessibilityValue {
  AgentDeviceTextEntryValueReads += 1;
  return [super accessibilityValue];
}
@end

@implementation AgentDeviceValueReadCountLabel
- (NSString *)accessibilityLabel {
  if ([self.countedField isKindOfClass:[AgentDeviceTextEntryWitnessField class]]) {
    return self.countedField.accessibilityHint;
  }
  return [NSString stringWithFormat:@"%lu", (unsigned long)AgentDeviceTextEntryValueReads];
}

- (NSString *)accessibilityValue {
  return self.countedField.text;
}

@end

@interface AgentDeviceTextEntryWitnessField ()
@property(nonatomic, assign) NSUInteger taps;
@property(nonatomic, assign) NSUInteger selections;
@property(nonatomic, assign) NSUInteger rejectedEdits;
@end

@implementation AgentDeviceTextEntryWitnessField
- (instancetype)init {
  self = [super init];
  if (self) {
    self.delegate = self;
    self.autocorrectionType = UITextAutocorrectionTypeNo;
    self.autocapitalizationType = UITextAutocapitalizationTypeNone;
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--agent-device-text-entry-witness-prefill"]) {
      self.text = @"seedvalue";
    }
  }
  return self;
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  self.taps += 1;
  [super touchesEnded:touches withEvent:event];
}

- (void)selectAll:(id)sender {
  self.selections += 1;
  [super selectAll:sender];
}

- (BOOL)textField:(UITextField *)textField shouldChangeCharactersInRange:(NSRange)range replacementString:(NSString *)string {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  if ([arguments containsObject:@"--agent-device-text-entry-witness-refuse-edits"] ||
      ([arguments containsObject:@"--agent-device-text-entry-witness-refuse-selection"] && range.length > 1 && string.length == 0)) {
    self.rejectedEdits += 1;
    UITextPosition *start = textField.beginningOfDocument;
    textField.selectedTextRange = [textField textRangeFromPosition:start toPosition:start];
    return NO;
  }
  return YES;
}

- (NSString *)accessibilityHint {
  return [NSString stringWithFormat:@"taps=%lu selections=%lu rejected=%lu",
                   (unsigned long)self.taps, (unsigned long)self.selections, (unsigned long)self.rejectedEdits];
}
@end
#endif
