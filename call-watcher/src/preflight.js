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
// After a reboot or a Chrome update it is easy to relaunch from the Start menu and lose both.
// Checking the actual command line at startup turns "lost the whole day" into "refused to
// start". This inspects the same Win32_Process command line the shortcut injector already uses.
function checkChromeLaunchFlags(cdpUrl, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const port = new URL(cdpUrl).port;
    const psCommand =
      `$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('remote-debugging-port=${port}') }; ` +
      `if (-not $procs) { Write-Output 'NO_MATCH'; exit 0 }; ` +
      `$cmd = ($procs | Select-Object -First 1).CommandLine; ` +
      `if ($cmd -like '*--auto-accept-this-tab-capture*') { Write-Output 'HAS_FLAG' } else { Write-Output 'MISSING_FLAG' }`;

    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        // Never block startup on the check itself failing - report unknown and let the run
        // proceed, since a false alarm here would be worse than the thing it guards against.
        resolve({ status: 'unknown', detail: err.message });
        return;
      }
      const out = (stdout || '').trim();
      if (out.includes('HAS_FLAG')) resolve({ status: 'ok' });
      else if (out.includes('MISSING_FLAG')) resolve({ status: 'missing-capture-flag' });
      else if (out.includes('NO_MATCH')) resolve({ status: 'no-matching-chrome' });
      else resolve({ status: 'unknown', detail: out });
    });
  });
}

module.exports = { checkChromeLaunchFlags };
