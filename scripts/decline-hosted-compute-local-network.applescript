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
            if role of candidateElement is "AXStaticText" and value of candidateElement is "Allow “hosted-compute” to find devices on local networks?" then set headingMatches to true
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

if (system attribute "GITHUB_ACTIONS") is not "true" then error "This cleanup is only for GitHub Actions runners."
set declineButtons to matchingDeclineButtons()
if (count of declineButtons) is 0 then return "No hosted-compute local-network prompt."
if (count of declineButtons) is not 1 then error "Multiple hosted-compute local-network prompts are present."
tell application "System Events" to click item 1 of declineButtons
delay 0.25
if (count of matchingDeclineButtons()) is not 0 then error "The hosted-compute local-network prompt remained after declining."
return "Declined hosted-compute local-network access."
