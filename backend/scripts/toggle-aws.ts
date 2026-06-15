import fs from 'fs';
import path from 'path';

// Locate the .env file in the backend directory
const envPath = path.resolve(__dirname, '../.env');

function getEnvContent(): string {
  if (!fs.existsSync(envPath)) {
    console.error(`Error: .env file not found at ${envPath}`);
    process.exit(1);
  }
  return fs.readFileSync(envPath, 'utf8');
}

function writeEnvContent(content: string) {
  fs.writeFileSync(envPath, content, 'utf8');
}

/** Raw AWS_ENABLED value from the .env, or null if the key is absent. */
function readFlag(content: string): string | null {
  // `[^\r\n]*` so the captured value never swallows the line ending (keeps CRLF intact).
  const match = content.match(/^AWS_ENABLED=([^\r\n]*)/m);
  // Drop an inline `# comment` (dotenv ignores it) so status matches what the app parses.
  return match ? match[1].replace(/\s+#.*$/, '').trim() : null;
}

/**
 * Set AWS_ENABLED to `value`, replacing the existing line (whatever its current
 * value) or inserting one. The replace matches the whole value — not just
 * `true|false` — so a stray `AWS_ENABLED=False`, an empty value, or a value with a
 * trailing comment is corrected instead of silently left in place (which would
 * make `disable` a no-op, since config.aws.isEnabled treats anything but the exact
 * string "false" as enabled).
 */
function setFlag(content: string, value: 'true' | 'false'): string {
  if (/^AWS_ENABLED=/m.test(content)) {
    return content.replace(/^AWS_ENABLED=[^\r\n]*/m, `AWS_ENABLED=${value}`);
  }
  // No existing key: insert just before AWS_SIMULATION if present, else append.
  // Match the file's dominant line ending so a CRLF .env stays all-CRLF.
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  if (/^AWS_SIMULATION=/m.test(content)) {
    return content.replace(/^AWS_SIMULATION=/m, `AWS_ENABLED=${value}${eol}AWS_SIMULATION=`);
  }
  const sep = content === '' || content.endsWith('\n') ? '' : eol;
  return `${content}${sep}AWS_ENABLED=${value}${eol}`;
}

const RESTART_NOTE =
  'Restart the backend (npm run dev) for this to take effect — .env is read once at startup.';

const action = process.argv[2]?.toLowerCase() || 'status';

if (action === 'status') {
  const value = readFlag(getEnvContent());
  // Mirror config.aws.isEnabled: anything other than the exact string "false" is enabled.
  const detail =
    value === null
      ? 'ENABLED (default — AWS_ENABLED not set)'
      : value === 'false'
        ? 'DISABLED (AWS_ENABLED=false)'
        : `ENABLED (AWS_ENABLED=${value})`;
  console.log(`\nAWS Integration is currently: ${detail}\n`);
} else if (action === 'enable') {
  writeEnvContent(setFlag(getEnvContent(), 'true'));
  console.log(`\nAWS Integration has been ENABLED.\n${RESTART_NOTE}\n`);
} else if (action === 'disable') {
  writeEnvContent(setFlag(getEnvContent(), 'false'));
  console.log(
    '\nAWS Integration has been DISABLED. AWS will show as "Coming Soon" on the' +
      ` frontend and will no longer appear in Admin Management.\n${RESTART_NOTE}\n`,
  );
} else {
  console.log('\nUsage: npx ts-node scripts/toggle-aws.ts [enable|disable|status]\n');
}
