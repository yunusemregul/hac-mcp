import express from 'express';
import { createServer } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { flexibleSearch, setHacLogger } from './hac.js';
import { listEnvironments, getEnvironment, createEnvironment, updateEnvironment, deleteEnvironment } from './storage.js';
import { getIndex } from './type-index.js';
import { registerAllTools } from './tools/index.js';
import { getSession, withSession, attachLogClient, detachLogClient, getMcpLogBuffer } from './tools/context.js';

const PORT = process.env.PORT || 3333;

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
app.use('/static', express.static('static'));
app.get('/', (_req, res) => res.sendFile('static/index.html', { root: '.' }));

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
  console.log(`HAC MCP running at http://localhost:${PORT}`);
  console.log(`MCP SSE endpoint: http://localhost:${PORT}/mcp/sse`);
});
