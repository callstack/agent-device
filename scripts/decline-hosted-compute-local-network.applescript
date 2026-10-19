on matchingDeclineButtons()
  set matches to {}
  tell application "System Events"
    repeat with candidateProcess in (application processes whose bundle identifier is "com.apple.UserNotificationCenter")
      try
        set candidateWindows to windows of candidateProcess
      on error
        set candidateWindows to {}
      end try
      repeat with candidateWindow in candidateWindows
        try
          set elements to entire contents of candidateWindow
        on error
          set elements to {}
        end try
        set headingMatches to false
        set declineButtons to {}
        repeat with candidateElement in elements
          try
            if role of candidateElement is "AXStaticText" and value of candidateElement is "Allow “hosted-compute-” to find devices on local networks?" then set headingMatches to true
            if role of candidateElement is "AXButton" and name of candidateElement is in {"Don’t Allow", "Don't Allow"} then set end of declineButtons to contents of candidateElement
          end try
        end repeat
        if headingMatches then
          if (count of declineButtons) is not 1 then error "The hosted-compute local-network prompt has no unique decline button."
          set end of matches to item 1 of declineButtons
        end if
      end repeat
    end repeat
  end tell
  return matches
end matchingDeclineButtons

on describePrompts()
  tell application "System Events"
    set notificationProcesses to application processes whose bundle identifier is "com.apple.UserNotificationCenter"
    log "UserNotificationCenter processes: " & (count of notificationProcesses)
    repeat with candidateProcess in notificationProcesses
      set notificationWindows to windows of candidateProcess
      log "UserNotificationCenter windows: " & (count of notificationWindows)
      repeat with candidateWindow in notificationWindows
        set elements to entire contents of candidateWindow
        repeat with candidateElement in elements
          set fields to {}
          repeat with attributeName in {"AXRole", "AXTitle", "AXValue", "AXDescription"}
            try
              set attributeValue to value of attribute (contents of attributeName) of candidateElement
              if attributeValue is not missing value then set end of fields to (contents of attributeName) & "=" & (attributeValue as text)
            end try
          end repeat
          log fields
        end repeat
      end repeat
    end repeat
  end tell
end describePrompts

on run arguments
  if (system attribute "GITHUB_ACTIONS") is not "true" then error "This cleanup is only for GitHub Actions runners."
  try
    describePrompts()
  on error messageText
    log "Notification diagnostics failed: " & messageText
  end try
  if arguments is {"diagnose"} then return "Read-only hosted notification diagnostics."
  set declineButtons to matchingDeclineButtons()
  if (count of declineButtons) is 0 then return "No hosted-compute local-network prompt."
  if (count of declineButtons) is not 1 then error "Multiple hosted-compute local-network prompts are present."
  tell application "System Events" to click item 1 of declineButtons
  delay 0.25
  if (count of matchingDeclineButtons()) is not 0 then error "The hosted-compute local-network prompt remained after declining."
  return "Declined hosted-compute local-network access."
end run
