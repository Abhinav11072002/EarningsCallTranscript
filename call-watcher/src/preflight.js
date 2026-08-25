const { execFile } = require('child_process');

// Chrome only accepts these at launch, and the tool cannot add them itself. Both are silent
// killers when missing:
//
//   --remote-debugging-port      : loud (nothing can connect)
//   --auto-accept-this-tab-capture : SILENT - scraping, resolution and registration all work,
//                                    then a native consent bubble blocks every capture. The
//                                    bubble is not part of any page's DOM, so nothing in the
//                                    automation can see or dismiss it.
//
// After a reboot or a Chrome update it is easy to relaunch from the Dock or Start menu and
// lose both. Checking the actual command line at startup turns "lost the whole day" into
// "refused to start".
//
// Both platforms answer the same question - is there a Chrome process carrying our debugging
// port, and does its command line also carry the capture flag - they just read the process
// table differently. The interpretation below is shared, so the two can never drift.
const CAPTURE_FLAG = '--auto-accept-this-tab-capture';

// macOS: `ps` prints one line per process with the full command. Chrome spawns many helper
// processes that inherit some flags, so the match is on the debugging port, which only the
// browser process carries.
function macCommand(port) {
  return {
    file: '/bin/sh',
    args: [
      '-c',
      `ps -ax -o command= | grep -- '--remote-debugging-port=${port}' | grep -v grep | head -1`,
    ],
    interpret: (out) => {
      const line = (out || '').trim();
      if (!line) return { status: 'no-matching-chrome' };
      return line.includes(CAPTURE_FLAG) ? { status: 'ok' } : { status: 'missing-capture-flag' };
    },
  };
}

function windowsCommand(port) {
  const psCommand =
      `$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('remote-debugging-port=${port}') }; ` +
      `if (-not $procs) { Write-Output 'NO_MATCH'; exit 0 }; ` +
      `$cmd = ($procs | Select-Object -First 1).CommandLine; ` +
      `if ($cmd -like '*${CAPTURE_FLAG}*') { Write-Output 'HAS_FLAG' } else { Write-Output 'MISSING_FLAG' }`;

  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    interpret: (out) => {
      const text = (out || '').trim();
      if (text.includes('HAS_FLAG')) return { status: 'ok' };
      if (text.includes('MISSING_FLAG')) return { status: 'missing-capture-flag' };
      if (text.includes('NO_MATCH')) return { status: 'no-matching-chrome' };
      return { status: 'unknown', detail: text };
    },
  };
}

function checkChromeLaunchFlags(cdpUrl, timeoutMs = 15000, platform = process.platform) {
  return new Promise((resolve) => {
    const port = new URL(cdpUrl).port;
    const command = platform === 'darwin' ? macCommand(port) : windowsCommand(port);

    execFile(command.file, command.args, { timeout: timeoutMs }, (err, stdout) => {
      // grep exits 1 when it matches nothing, which is a real answer rather than a failure:
      // no Chrome is running on that port. Treated as such instead of as an unknown.
      if (err && platform === 'darwin' && err.code === 1 && !(stdout || '').trim()) {
        resolve({ status: 'no-matching-chrome' });
        return;
      }
      if (err) {
        // Never block startup on the check itself failing - report unknown and let the run
        // proceed, since a false alarm here would be worse than the thing it guards against.
        resolve({ status: 'unknown', detail: err.message });
        return;
      }
      resolve(command.interpret(stdout));
    });
  });
}

module.exports = { checkChromeLaunchFlags, macCommand, windowsCommand, CAPTURE_FLAG };
