import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { flexibleSearch, setHacLogger } from './hac.js';
import { listEnvironments, getEnvironment, createEnvironment, updateEnvironment, deleteEnvironment } from './storage.js';
import { getIndex } from './type-index.js';
import { registerAllTools, tools as allTools } from './tools/index.js';
import { getSession, withSession, attachLogClient, detachLogClient, getMcpLogBuffer } from './tools/context.js';

const PORT = process.env.PORT || 18432;

// ─── HAC request log → SSE broadcast ─────────────────────────────────────────
const hacLogClients = new Set();
const hacLogBuffer = [];
setHacLogger(entry => {
  hacLogBuffer.push(entry);
  if (hacLogBuffer.length > 50) hacLogBuffer.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of hacLogClients) res.write(data);
});

// ─── MCP server factory ───────────────────────────────────────────────────────
function createMcpInstance() {
  const mcp = new McpServer({ name: 'hac-mcp', version: '1.0.0' }, { timeout: 60000 });
  registerAllTools(mcp);
  return mcp;
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(join(__dirname, 'static')));

// Mock OAuth endpoints — auto-approve everything, no user interaction required
const BASE_URL = `http://localhost:${PORT}`;

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
  });
});

app.post('/register', (req, res) => {
  const body = req.body ?? {};
  res.json({
    client_id: 'mock-client',
    client_secret: 'mock-secret',
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris ?? [],
    grant_types: body.grant_types ?? ['authorization_code'],
    response_types: body.response_types ?? ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
  });
});

app.get('/authorize', (req, res) => {
  const { redirect_uri, state } = req.query;
  const code = `mock-code-${Date.now()}`;
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.post('/token', (_req, res) => {
  res.json({
    access_token: 'mock-access-token',
    token_type: 'bearer',
    expires_in: 86400,
  });
});
app.get('/', (_req, res) => res.sendFile(join(__dirname, 'static', 'index.html')));

// Environments API
app.get('/api/environments', async (_req, res) => res.json(await listEnvironments()));
app.post('/api/environments', async (req, res) => {
  try { res.json(await createEnvironment(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/environments/:id', async (req, res) => {
  try { res.json(await updateEnvironment(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/environments/:id', async (req, res) => {
  try { await deleteEnvironment(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/environments/:id/refresh-index', async (req, res) => {
  const env = await getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ ok: false, error: 'Environment not found' });
  try {
    const types = await getIndex(env.id, (query, opts) => withSession(env, s => flexibleSearch(s, query, opts)));
    res.json({ ok: true, count: types.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/test-connection', async (req, res) => {
  let { url, username, password } = req.body;
  if (!url || !username || !password) return res.json({ ok: false, error: 'URL, username and password are required' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    await getSession({ id: '__probe__', url, username, password, name: url });
    res.json({ ok: true });
  } catch (e) {
    const msg = e.message || '';
    console.error('[test-connection] error:', e);
    const type = e.code === 'ERR_INVALID_URL' ? 'invalid_url'
      : (msg.includes('Login failed') || msg.includes('CSRF token') || msg.includes('credentials')) ? 'auth'
      : 'network';
    res.json({ ok: false, error: msg, type });
  }
});

app.post('/api/environments/:id/test', async (req, res) => {
  const env = await getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ ok: false, error: 'Environment not found' });
  try {
    await getSession(env);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// HAC request log SSE
app.get('/api/hac-log', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  for (const entry of hacLogBuffer) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  hacLogClients.add(res);
  req.on('close', () => hacLogClients.delete(res));
});

// MCP activity log SSE
app.get('/api/mcp-log', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  for (const entry of getMcpLogBuffer()) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  attachLogClient(res);
  req.on('close', () => detachLogClient(res));
});

// Manifest API
app.get('/api/manifest', (_req, res) => {
  res.json({
    name: 'hac-mcp',
    version: '1.0.0',
    description: 'SAP Commerce Cloud HAC — MCP Server',
    tools: allTools.map(t => ({
      name: t.name,
      category: t.category ?? 'utility',
      description: t.description,
      params: t.inputSchema ? Object.keys(t.inputSchema) : [],
    })),
  });
});

// Status API
app.get('/api/status', async (_req, res) => {
  const environments = await listEnvironments();
  res.json({ environmentCount: environments.length, connectedClients: mcpSessions.size });
});

// MCP SSE
const mcpSessions = new Map();
app.get('/mcp/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/mcp/messages', res);
  const mcp = createMcpInstance();
  mcpSessions.set(transport.sessionId, { mcp, transport });
  res.on('close', () => { mcpSessions.delete(transport.sessionId); mcp.close(); });
  await mcp.connect(transport);
});
app.post('/mcp/messages', async (req, res) => {
  const session = mcpSessions.get(req.query.sessionId);
  if (session) await session.transport.handlePostMessage(req, res, req.body);
  else res.status(400).send('Unknown session');
});

// ─── Start ────────────────────────────────────────────────────────────────────
createServer(app).listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  const hasColor = process.stdout.hasColors?.() ?? process.stdout.isTTY;
  const c = hasColor ? {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    green:  '\x1b[32m',
    cyan:   '\x1b[36m',
    white:  '\x1b[97m',
  } : { reset: '', bold: '', dim: '', green: '', cyan: '', white: '' };

  // helpers
  const label = s => `${c.dim}${s}${c.reset}`;
  const value = s => `${c.cyan}${s}${c.reset}`;
  const heading = s => `${c.bold}${c.white}${s}${c.reset}`;
  const code = s => `${c.green}${s}${c.reset}`;

  console.log('');
  console.log(`  ${c.bold}${c.green}HAC MCP is running${c.reset}`);
  console.log('');
  console.log(`  ${label('Web UI      ')}  ${value(base)}`);
  console.log(`  ${label('MCP endpoint')}  ${value(`${base}/mcp/sse`)}`);
  console.log(`  ${label('Config file ')}  ${value(join(homedir(), '.hac-mcp', 'environments.json'))}`);
  console.log('');
  console.log(`  ${label('Open the Web UI to add and manage your HAC environments.')}`);
  console.log('');
  console.log(`  ${heading('Claude Code')}`);
  console.log(`  ${label('Run this command to register:')}`);
  console.log('');
  console.log(`  ${code(`claude mcp add --transport sse hac-mcp ${base}/mcp/sse`)}`);
  console.log('');
  console.log(`  ${heading('Other MCP Clients')}`);
  console.log(`  ${label('Add the following to your MCP client config:')}`);
  console.log('');
  console.log(`  ${c.cyan}{${c.reset}`);
  console.log(`  ${c.cyan}  "mcpServers": {${c.reset}`);
  console.log(`  ${code('    "hac-mcp": {')}`);
  console.log(`  ${code(`      "url": "${base}/mcp/sse"`)}`);
  console.log(`  ${code('    }')}`);
  console.log(`  ${c.cyan}  }${c.reset}`);
  console.log(`  ${c.cyan}}${c.reset}`);
  console.log('');
});
