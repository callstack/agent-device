#pragma once
#import <UIKit/UIKit.h>

// Mirrors the App Tracking Transparency prompt's real button order: the affirmative button is
// last (#3627). The answer label records which button the app actually took, so a test asserts
// the app's answer instead of the command's own report. `--agent-device-alert-affirmative-only`
// shows the same alert with no decline button at all.
static inline UIAlertController *RunnerAlertDeclineChoiceFixture(BOOL affirmativeOnly, UILabel *answer) {
  UIAlertController *alert = [UIAlertController
    alertControllerWithTitle:@"“Runner” Would Like to Track Your Activity"
                     message:@"Track your activity across other companies' apps and websites."
              preferredStyle:UIAlertControllerStyleAlert];
  NSArray<NSArray *> *buttons = affirmativeOnly
      ? @[ @[@"Allow", @"Authorized"], @[@"OK", @"Authorized"] ]
      : @[ @[@"Ask App Not to Track", @"Declined"], @[@"Allow", @"Authorized"] ];
  for (NSArray *button in buttons) {
    [alert addAction:[UIAlertAction actionWithTitle:button[0]
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *action) {
                                              (void)action;
                                              answer.text = button[1];
                                            }]];
  }
  return alert;
}
