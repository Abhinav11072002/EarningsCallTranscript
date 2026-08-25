// Parses the shortcut from config once, so each platform's injector can render it its own way.
//
// `extensionShortcutSendKeys` is written in Windows SendKeys notation - "^+y" meaning
// Ctrl+Shift+Y - because that is what the PowerShell injector consumes directly. macOS needs
// the same combination expressed as AppleScript modifier constants instead.
//
// This lives on its own, away from either injector, for one practical reason: it is the only
// part of the cross-platform work that can be tested on a machine that is not a Mac. Getting
// the modifier translation wrong produces a keystroke nothing is listening for, which looks
// exactly like the injection having failed - and that is a genuinely expensive thing to debug
// remotely. Everything else in the macOS path needs a Mac to verify; this does not.

const MODIFIER_CHARS = {
  '^': 'ctrl',
  '+': 'shift',
  '%': 'alt',
};

// SendKeys puts modifiers before the key, and the key is the final character: "^+y" is
// Ctrl+Shift+Y. Anything longer than a single trailing character (function keys, "{ENTER}")
// is deliberately rejected rather than guessed at - the extension shortcut is always a letter.
function parseSendKeys(sequence) {
  const raw = String(sequence == null ? '' : sequence).trim();
  if (!raw) throw new Error('Shortcut is empty - set extensionShortcutSendKeys in config.json (e.g. "^+y")');

  const parsed = { ctrl: false, shift: false, alt: false, key: null };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const modifier = MODIFIER_CHARS[ch];
    if (modifier) {
      parsed[modifier] = true;
      continue;
    }
    // The first non-modifier character must be the last character overall.
    if (i !== raw.length - 1) {
      throw new Error(
        `Shortcut "${raw}" is not a simple modifier sequence plus one key. ` +
          'Expected SendKeys notation like "^+y" (^ = Ctrl, + = Shift, % = Alt).'
      );
    }
    parsed.key = ch.toLowerCase();
  }

  if (!parsed.key) throw new Error(`Shortcut "${raw}" has modifiers but no key.`);
  if (!parsed.ctrl && !parsed.shift && !parsed.alt) {
    // A bare letter would type into the page rather than invoking the extension.
    throw new Error(`Shortcut "${raw}" has no modifiers - a plain key cannot trigger an extension command.`);
  }
  return parsed;
}

// AppleScript modifier constants, in the order `keystroke ... using {}` conventionally lists
// them. Note what is NOT here: Command. Chrome maps a manifest "Ctrl+Shift+Y" to the literal
// Control key on macOS, not to Command - confirmed live on the Mac minis, where pressing
// Ctrl+Shift+Y opens the popup. Translating Ctrl to Command would send a combination the
// extension is not listening for, and the failure would be indistinguishable from the
// keystroke never arriving.
function toAppleScriptModifiers(parsed) {
  const mods = [];
  if (parsed.ctrl) mods.push('control down');
  if (parsed.alt) mods.push('option down');
  if (parsed.shift) mods.push('shift down');
  return mods;
}

// The AppleScript injector takes its modifiers as separate 1/0 arguments rather than a string:
// AppleScript cannot turn "control down, shift down" back into the list of constants it needs,
// so the script builds that list itself from these flags.
function toAppleScriptArgs(parsed) {
  return [parsed.key, parsed.ctrl ? '1' : '0', parsed.shift ? '1' : '0', parsed.alt ? '1' : '0'];
}

// For logs and error messages, in the form a person would recognise.
function describeShortcut(parsed) {
  const parts = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.shift) parts.push('Shift');
  if (parsed.alt) parts.push('Alt');
  parts.push(parsed.key.toUpperCase());
  return parts.join('+');
}

module.exports = { parseSendKeys, toAppleScriptModifiers, toAppleScriptArgs, describeShortcut };
