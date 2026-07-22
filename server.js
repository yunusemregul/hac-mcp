import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config (HAC_MEDIA_HOST_URL/TOKEN, PORT, …) from project-root .env if present.
// Existing process env wins, so explicit exports still override the file.
{
  const envPath = join(__dirname, '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    const keys = readFileSync(envPath, 'utf8').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
      .map(l => l.split('=')[0].trim()).filter(Boolean);
    console.error(`[MCP] Loaded .env (${keys.length} var${keys.length === 1 ? '' : 's'}: ${keys.join(', ')})`);
  } else {
    console.error('[MCP] No .env file found, using process environment only');
  }
}

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { flexibleSearch, setHacLogger, setHttpTimeout, getHttpTimeout } from './hac.js';
import { listEnvironments, getEnvironment, createEnvironment, updateEnvironment, deleteEnvironment, getSettings, updateSettings } from './storage.js';
import { getIndex } from './type-index.js';
import { registerAllTools, tools as allTools } from './tools/index.js';
import { getSession, withSession, attachLogClient, detachLogClient, getMcpLogBuffer, mcpLogSystem } from './tools/context.js';
import { readdir, stat } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';

async function dirSize(path) {
  let total = 0, files = 0;
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const e of entries) {
      const full = join(path, e.name);
      if (e.isDirectory()) {
        const sub = await dirSize(full);
        total += sub.total; files += sub.files;
      } else if (e.isFile()) {
        const s = await stat(full);
        total += s.size; files += 1;
      }
    }
  } catch (_) {}
  return { total, files };
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

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
function createMcpInstance(getClientLabel) {
  const mcp = new McpServer({ name: 'hac-mcp', version: '1.0.0' }, { timeout: getHttpTimeout() });
  registerAllTools(mcp, getClientLabel);
  return mcp;
}

let clientCounter = 0;
function clientLabel(session) {
  const num = `Client #${session.clientNum}`;
  const v = session.clientInfo?.version;
  if (!v) return num;
  return `${num} · ${v.title || v.name} ${v.version}`;
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(join(__dirname, 'static')));
app.use('/', express.static(join(__dirname, 'static')));

// Mock OAuth endpoints - auto-approve everything, no user interaction required
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

// Settings API
app.get('/api/settings', async (_req, res) => res.json(await getSettings()));
app.put('/api/settings', async (req, res) => {
  try {
    const settings = await updateSettings(req.body);
    setHttpTimeout(settings.httpTimeoutMs);
    res.json(settings);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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
    description: 'SAP Commerce Cloud HAC - MCP Server',
    tools: allTools.map(t => ({
      name: t.name,
      category: t.category ?? 'utility',
      description: t.description,
      params: t.inputSchema
        ? Object.entries(t.inputSchema).map(([name, schema]) => ({
            name,
            description: schema.description ?? schema._def?.description ?? null,
            optional: schema.isOptional?.() === true,
          }))
        : [],
    })),
  });
});

// Status API
app.get('/api/status', async (_req, res) => {
  const environments = await listEnvironments();
  const sessions = [
    ...mcpSessions.values(),
    ...httpMcpSessions.values().filter(isHttpSessionActive),
  ];
  const clients = sessions.map(s => ({
    ...(s.clientInfo ?? {}),
    clientNum: s.clientNum,
    connectedAt: s.connectedAt,
    toolCalls: s.toolCalls,
  }));
  res.json({ environmentCount: environments.length, connectedClients: sessions.length, clients });
});

// ─── media-host proxy (for the UI dashboard) ─────────────────────────────────
// Token lives server-side only; the browser never sees it.
const MEDIA_HOST_URL = (process.env.HAC_MEDIA_HOST_URL || '').replace(/\/+$/, '');
const MEDIA_HOST_TOKEN = process.env.HAC_MEDIA_HOST_TOKEN || '';
const mediaHostAuth = { Authorization: `Bearer ${MEDIA_HOST_TOKEN}` };

app.get('/api/media-host/status', async (_req, res) => {
  if (!MEDIA_HOST_URL || !MEDIA_HOST_TOKEN) return res.json({ configured: false });
  try {
    const [health, listing] = await Promise.all([
      fetch(`${MEDIA_HOST_URL}/health`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${MEDIA_HOST_URL}/files`, { headers: mediaHostAuth }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    res.json({
      configured: true,
      url: MEDIA_HOST_URL,
      online: !!health,
      ttlHours: health?.ttlHours ?? listing?.ttlHours ?? null,
      count: listing?.count ?? 0,
      totalBytes: listing?.totalBytes ?? 0,
      files: listing?.files ?? [],
    });
  } catch (e) {
    res.json({ configured: true, url: MEDIA_HOST_URL, online: false, error: e.message, files: [] });
  }
});

app.delete('/api/media-host/files/:id', async (req, res) => {
  if (!MEDIA_HOST_URL || !MEDIA_HOST_TOKEN) return res.status(400).json({ error: 'media-host not configured' });
  try {
    const r = await fetch(`${MEDIA_HOST_URL}/f/${encodeURIComponent(req.params.id)}`, { method: 'DELETE', headers: mediaHostAuth });
    res.status(r.status).json(await r.json().catch(() => ({})));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// MCP Streamable HTTP (Codex and other current MCP clients)
const httpMcpSessions = new Map();
const HTTP_ACTIVITY_GRACE_MS = 30_000;
const HTTP_SESSION_MAX_IDLE_MS = 24 * 60 * 60 * 1000;

// Streamable HTTP sessions can outlive their network connection. In particular,
// clients are not required to send DELETE when their process exits, so keeping a
// session in the map does not mean that the client is still connected.
function isHttpSessionActive(session, now = Date.now()) {
  if (session.activeStreams > 0) return true;
  return !session.hasOpenedStream && now - session.lastSeenAt < HTTP_ACTIVITY_GRACE_MS;
}

// Keep dormant sessions around long enough for a client to reconnect, but do
// not retain abandoned transports forever.
const httpSessionReaper = setInterval(() => {
  const cutoff = Date.now() - HTTP_SESSION_MAX_IDLE_MS;
  for (const session of httpMcpSessions.values()) {
    if (session.activeStreams === 0 && session.lastSeenAt < cutoff) {
      void session.mcp.close().catch(e => console.error('[MCP HTTP] session cleanup error:', e));
    }
  }
}, 60_000);
httpSessionReaper.unref();

app.all('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let session = sessionId ? httpMcpSessions.get(sessionId) : null;
    if (!session && !sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      const clientNum = ++clientCounter;
      const now = Date.now();
      session = {
        mcp: null,
        transport: null,
        clientNum,
        clientInfo: null,
        connectedAt: now,
        lastSeenAt: now,
        activeStreams: 0,
        hasOpenedStream: false,
        toolCalls: 0,
      };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          httpMcpSessions.set(id, session);
          mcpLogSystem({ client: `Client #${clientNum}`, preview: 'connected via Streamable HTTP' });
        },
      });
      const mcp = createMcpInstance(id => {
        const s = httpMcpSessions.get(id) ?? session;
        if (s) { s.toolCalls++; return clientLabel(s); }
        return null;
      });
      session.mcp = mcp;
      session.transport = transport;
      mcp.server.oninitialized = () => {
        const version = mcp.server.getClientVersion() ?? null;
        const caps = mcp.server.getClientCapabilities() ?? null;
        session.clientInfo = { version, caps };
        mcpLogSystem({ client: clientLabel(session), preview: 'initialized' });
      };
      transport.onclose = () => {
        const id = transport.sessionId;
        mcpLogSystem({ client: clientLabel(session), preview: 'disconnected' });
        if (id) httpMcpSessions.delete(id);
      };
      await mcp.connect(transport);
    }
    if (!session) {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid MCP session ID' }, id: null });
    }
    session.lastSeenAt = Date.now();
    if (req.method === 'GET') {
      session.hasOpenedStream = true;
      session.activeStreams++;
      res.once('close', () => { session.activeStreams = Math.max(0, session.activeStreams - 1); });
    }
    await session.transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[MCP HTTP] error:', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

// MCP legacy SSE (kept for Claude and existing clients)
const mcpSessions = new Map();
app.get('/mcp/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/mcp/messages', res);
  const clientNum = ++clientCounter;
  const session = { mcp: null, transport, clientNum, clientInfo: null, connectedAt: Date.now(), toolCalls: 0 };
  const mcp = createMcpInstance(sessionId => {
    const s = mcpSessions.get(sessionId);
    if (s) { s.toolCalls++; return clientLabel(s); }
    return null;
  });
  session.mcp = mcp;
  mcpSessions.set(transport.sessionId, session);
  mcpLogSystem({ client: `Client #${clientNum}`, preview: 'connected via SSE' });
  mcp.server.oninitialized = () => {
    const version = mcp.server.getClientVersion() ?? null;
    const caps = mcp.server.getClientCapabilities() ?? null;
    session.clientInfo = { version, caps };
    mcpLogSystem({ client: clientLabel(session), preview: 'initialized' });
  };
  res.on('close', () => {
    mcpLogSystem({ client: clientLabel(session), preview: 'disconnected' });
    mcpSessions.delete(transport.sessionId);
    mcp.close();
  });
  await mcp.connect(transport);
});
app.post('/mcp/messages', async (req, res) => {
  const session = mcpSessions.get(req.query.sessionId);
  if (session) await session.transport.handlePostMessage(req, res, req.body);
  else res.status(400).send('Unknown session');
});

// Apply persisted settings before accepting requests
setHttpTimeout((await getSettings()).httpTimeoutMs);

// ─── Start ────────────────────────────────────────────────────────────────────
createServer(app).listen(PORT, async () => {
  const base = `http://localhost:${PORT}`;
  const hasColor = process.stdout.hasColors?.() ?? process.stdout.isTTY;
  const c = hasColor ? {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    green:  '\x1b[32m',
    blue:   '\x1b[34m',
  } : { reset: '', bold: '', dim: '', green: '', blue: '' };

  // helpers
  const label = s => `${c.dim}${s}${c.reset}`;
  const value = s => `${c.blue}${s}${c.reset}`;
  const heading = s => `${c.bold}${s}${c.reset}`;
  const code = s => `${c.green}${s}${c.reset}`;

  console.log('');
  console.log(`  ${c.bold}${c.green}HAC MCP is running${c.reset}`);
  console.log('');
  console.log(`  ${label('Web UI      ')}  ${value(base)}`);
  console.log(`  ${label('MCP HTTP    ')}  ${value(`${base}/mcp`)}`);
  console.log(`  ${label('MCP SSE     ')}  ${value(`${base}/mcp/sse`)}`);
  console.log(`  ${label('Config file ')}  ${value(join(homedir(), '.hac-mcp', 'environments.json'))}`);
  console.log('');
  console.log(`  ${label('Open the Web UI to add and manage your HAC environments.')}`);
  console.log('');

  const kinds = ['groovy', 'impex', 'flexsearch'];
  const sizes = await Promise.all(kinds.map(k => dirSize(join(__dirname, 'logs', k))));
  if (sizes.some(s => s.files > 0)) {
    console.log(`  ${heading('Logs')}`);
    for (let i = 0; i < kinds.length; i++) {
      const { total, files } = sizes[i];
      console.log(`  ${label(kinds[i].padEnd(12))}  ${value(`${humanSize(total)} (${files} file${files === 1 ? '' : 's'})`)}`);
    }
    console.log('');
  }
  console.log(`  ${heading('Codex')}`);
  console.log(`  ${label('Run this command to register:')}`);
  console.log('');
  console.log(`  ${code(`codex mcp add hac-mcp --url ${base}/mcp`)}`);
  console.log('');
  console.log(`  ${heading('Claude Code (legacy SSE)')}`);
  console.log(`  ${label('Run this command to register:')}`);
  console.log('');
  console.log(`  ${code(`claude mcp add --transport sse hac-mcp ${base}/mcp/sse`)}`);
  console.log('');
  console.log(`  ${heading('Other MCP Clients')}`);
  console.log(`  ${label('Add the following to your MCP client config:')}`);
  console.log('');
  console.log(`  ${code('{')}`);
  console.log(`  ${code('  "mcpServers": {')}`);
  console.log(`  ${code('    "hac-mcp": {')}`);
  console.log(`  ${code(`      "url": "${base}/mcp"`)}`);
  console.log(`  ${code('    }')}`);
  console.log(`  ${code('  }')}`);
  console.log(`  ${code('}')}`);

  console.log('');
});
