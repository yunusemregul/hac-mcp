#!/usr/bin/env node
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = createRequire(import.meta.url)(join(__dirname, '../package.json'));

// ─── Arg parsing ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}

function option(name, short) {
  const idx = args.findIndex(a => a === name || (short && a === short));
  if (idx === -1) return null;
  const val = args[idx + 1];
  if (!val || val.startsWith('-')) { console.error(`Missing value for ${name}`); process.exit(1); }
  return val;
}

if (flag('--help') || flag('-h')) {
  console.log(`
hac-mcp v${version}

  A local MCP server for SAP Commerce Cloud HAC (Hybris Administration Console).

Usage:
  hac-mcp [options]
  hac-mcp startup [options]

Commands:
  startup       Register hac-mcp as a startup service via PM2

Options:
  -p, --port    Port to listen on (default: 18432, env: PORT)
  -v, --version Print version
  -h, --help    Show this help
  `.trim());
  process.exit(0);
}

if (flag('--version') || flag('-v')) {
  console.log(version);
  process.exit(0);
}

const port = option('--port', '-p');
if (port) process.env.PORT = port;

// ─── Commands ─────────────────────────────────────────────────────────────────
const command = args.find(a => !a.startsWith('-') && args.indexOf(a) === args.findIndex(x => x === a));

if (command === 'startup') {
  const { execSync } = await import('child_process');

  try {
    execSync('pm2 --version', { stdio: 'ignore' });
  } catch {
    console.error('PM2 is not installed. Run: npm install -g pm2');
    process.exit(1);
  }

  const pm2Args = [
    'pm2 start hac-mcp --name hac-mcp',
    port ? `--env PORT=${port}` : '',
  ].filter(Boolean).join(' ');

  try {
    execSync(pm2Args, { stdio: 'inherit' });
    execSync('pm2 save', { stdio: 'inherit' });
    console.log('');
    const result = execSync('pm2 startup', { encoding: 'utf8' });
    console.log(result);
    console.log('Copy and run the command above to complete startup registration.');
  } catch (e) {
    console.error('Failed to set up PM2 startup:', e.message);
    process.exit(1);
  }
} else if (command !== undefined) {
  console.error(`Unknown command: ${command}`);
  console.error('Run hac-mcp --help for usage.');
  process.exit(1);
} else {
  await import('../server.js');
}
