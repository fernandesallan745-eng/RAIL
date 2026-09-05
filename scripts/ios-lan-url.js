import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The port is not hardcoded: `.env` sets it (5050 for the demo) and src/server.js
// auto-increments on EADDRINUSE, so the startup banner is the final authority.
// Only the PORT line is read out of .env — nothing else in that file is touched.
function resolvePort() {
  if (process.env.PORT) return process.env.PORT;
  try {
    const line = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')
      .split('\n')
      .find((l) => /^\s*PORT\s*=/.test(l));
    const value = line?.split('=')[1]?.trim();
    if (value) return value;
  } catch {
    // No .env — fall through to the documented demo default.
  }
  return '5050';
}

// mDNS name, e.g. "MacBook-Air" -> http://MacBook-Air.local:5050.
// This is the address worth typing: it survives DHCP handing this Mac a new IP,
// which a literal 192.168.x.y does not. iOS resolves .local natively.
function resolveLocalHostname() {
  try {
    const name = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return name || null;
  } catch {
    return null; // Not macOS, or scutil unavailable.
  }
}

const port = resolvePort();

const addresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((entry) => (
    entry
    && entry.family === 'IPv4'
    && !entry.internal
    // 169.254.x.x is a link-local self-assignment: the interface is up but has no
    // DHCP lease, so the phone cannot reach it.
    && !entry.address.startsWith('169.254.')
  ))
  .map((entry) => entry.address);

const hostname = resolveLocalHostname();

if (addresses.length === 0 && !hostname) {
  console.error('No active LAN IPv4 address found. Connect this Mac and iPhone to the same Wi-Fi network.');
  process.exitCode = 1;
} else {
  console.log('Enter one of these addresses in the GATI iPhone app:');
  if (hostname) {
    console.log(`  http://${hostname}.local:${port}   <- preferred (survives an IP change)`);
  }
  for (const address of addresses) {
    console.log(`  http://${address}:${port}`);
  }
  console.log('');
  console.log(`Both devices must be on the same Wi-Fi. If the port differs, read the`);
  console.log(`startup banner from \`npm run dev\` — server.js auto-increments a busy port.`);
}
