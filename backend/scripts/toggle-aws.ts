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

const action = process.argv[2]?.toLowerCase() || 'status';

if (action === 'status') {
  const content = getEnvContent();
  const match = content.match(/^AWS_ENABLED=(true|false)/m);
  const status = match ? match[1] : 'true (default)';
  console.log(`\nAWS Integration is currently: ${status.toUpperCase()}\n`);
} else if (action === 'enable') {
  let content = getEnvContent();
  if (/^AWS_ENABLED=/m.test(content)) {
    content = content.replace(/^AWS_ENABLED=(true|false)/m, 'AWS_ENABLED=true');
  } else {
    // Insert before AWS_SIMULATION if possible, or append at the end
    if (/^AWS_SIMULATION=/m.test(content)) {
      content = content.replace(/^AWS_SIMULATION=/m, 'AWS_ENABLED=true\nAWS_SIMULATION=');
    } else {
      content += '\nAWS_ENABLED=true\n';
    }
  }
  writeEnvContent(content);
  console.log('\nAWS Integration has been ENABLED.\n');
} else if (action === 'disable') {
  let content = getEnvContent();
  if (/^AWS_ENABLED=/m.test(content)) {
    content = content.replace(/^AWS_ENABLED=(true|false)/m, 'AWS_ENABLED=false');
  } else {
    // Insert before AWS_SIMULATION if possible, or append at the end
    if (/^AWS_SIMULATION=/m.test(content)) {
      content = content.replace(/^AWS_SIMULATION=/m, 'AWS_ENABLED=false\nAWS_SIMULATION=');
    } else {
      content += '\nAWS_ENABLED=false\n';
    }
  }
  writeEnvContent(content);
  console.log('\nAWS Integration has been DISABLED. AWS will show as "Coming Soon" on the frontend.\n');
} else {
  console.log('\nUsage: npx ts-node scripts/toggle-aws.ts [enable|disable|status]\n');
}
