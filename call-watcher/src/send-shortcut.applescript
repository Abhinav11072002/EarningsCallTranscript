-- RUNTIME CODE - NOT A TEST SCRIPT. DO NOT DELETE.
--
-- The macOS counterpart of send-shortcut.ps1. src/extensionTrigger.js runs one or the other
-- depending on the platform, and every capture depends on it: this is what puts Chrome in the
-- foreground and delivers the keystroke that opens the extension popup.
--
-- Why this is twenty lines where the Windows version is 262: Windows actively refuses to let a
-- background process take the foreground, so that script has to attach input threads, retry,
-- and tap ALT to become eligible. macOS simply honours `activate`.
--
-- What both share is the requirement that made the Windows one hard-won. The keystroke must be
-- injected at the same level as real hardware. On Windows, SendKeys - which posts window
-- messages - focused the right window and yet the extension command never fired at all; only
-- SendInput worked. AppleScript's `keystroke` goes through the same path as physical input,
-- which is why it works here. Verified live on a Mac mini: this opens the popup with nobody
-- touching the keyboard, and the resulting capture produces a real transcript.
--
-- Arguments (positional, all required except the last):
--   1  key character, lowercase            e.g. "y"
--   2  control  "1" or "0"
--   3  shift    "1" or "0"
--   4  option   "1" or "0"
--   5  title hint (optional) - substring of the target tab's title, used to raise the right
--      window when more than one Chrome window is open
--
-- Exit codes match send-shortcut.ps1 so extensionTrigger.js can treat both identically:
--   0  keystroke delivered
--   2  could not put Chrome in the foreground
--   3  Chrome is not running, or accessibility permission is missing

on run argv
	if (count of argv) < 4 then
		log "usage: send-shortcut.applescript <key> <ctrl 1|0> <shift 1|0> <option 1|0> [titleHint]"
		error number 3
	end if

	set keyChar to item 1 of argv
	set wantControl to (item 2 of argv is "1")
	set wantShift to (item 3 of argv is "1")
	set wantOption to (item 4 of argv is "1")
	set titleHint to ""
	if (count of argv) > 4 then set titleHint to item 5 of argv

	-- Chrome must already be running. Launching it here would start it WITHOUT the debugging
	-- and capture flags, which fails later in a way that looks like an unrelated problem.
	tell application "System Events"
		if not (exists process "Google Chrome") then
			log "Google Chrome is not running - start it with the required flags first"
			error number 3
		end if
	end tell

	-- Raise the window whose active tab matches the hint BEFORE activating, so the right window
	-- is frontmost when the keystroke lands. With a single Chrome window this is a no-op; it
	-- matters when a machine has more than one open and the popup would otherwise attach to
	-- whichever happened to be in front.
	tell application "Google Chrome"
		if titleHint is not "" then
			repeat with w in windows
				try
					if (title of active tab of w) contains titleHint then
						set index of w to 1
						exit repeat
					end if
				end try
			end repeat
		end if
		activate
	end tell

	-- Confirm the foreground actually changed rather than assuming it did. A keystroke sent to
	-- the wrong application is silently lost, and the only symptom downstream is the popup
	-- never appearing - which reads as a broken extension rather than a focus problem.
	delay 0.3
	tell application "System Events"
		set frontApp to name of first application process whose frontmost is true
	end tell
	if frontApp is not "Google Chrome" then
		log "Could not bring Chrome to the foreground - frontmost app is " & frontApp
		error number 2
	end if

	set mods to {}
	if wantControl then set end of mods to control down
	if wantOption then set end of mods to option down
	if wantShift then set end of mods to shift down

	-- Fails with a permissions error if this process lacks Accessibility rights, which is the
	-- single most common reason a fresh machine does nothing at all.
	tell application "System Events"
		keystroke keyChar using mods
	end tell

	log "Focused Google Chrome and injected the shortcut"
	return 0
end run
