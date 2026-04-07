// Shared runtime context injected into every tool registration.
// server.js creates one instance and passes it to each tool's register().

import { AsyncLocalStorage } from 'async_hooks';
import { login, SessionExpiredError } from '../hac.js';
import { getEnvironment, listEnvironments } from '../storage.js';
import { getIndex, invalidateIndex, fuzzySearch } from '../type-index.js';
import { flexibleSearch } from '../hac.js';

// ─── HAC session manager ──────────────────────────────────────────────────────
const sessions  = new Map(); // envId → session
const loginLock = new Map(); // envId → Promise<session>

async function getSession(env) {
  if (sessions.has(env.id)) return sessions.get(env.id);
  if (loginLock.has(env.id)) return loginLock.get(env.id);
  const promise = login(env.url, env.username, env.password, env.name)
    .then(session => { sessions.set(env.id, session); return session; })
    .finally(() => loginLock.delete(env.id));
  loginLock.set(env.id, promise);
  return promise;
}

function invalidateSession(envId) {
  sessions.delete(envId);
  invalidateIndex(envId);
}

async function withSession(env, fn) {
  const session = await getSession(env);
  try {
    return await fn(session);
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      console.error(`[MCP] Session expired for "${env.name}", re-logging in…`);
      invalidateSession(env.id);
      const fresh = await getSession(env);
      return fn(fresh);
    }
    throw e;
  }
}

// ─── MCP activity log ─────────────────────────────────────────────────────────
const logClients = new Set();
const mcpLogBuffer = [];
const callCtx = new AsyncLocalStorage();

function broadcastLog(entry) {
  const ctx = callCtx.getStore();
  const enriched = ctx ? { ...entry, client: ctx.client } : entry;
  mcpLogBuffer.push(enriched);
  if (mcpLogBuffer.length > 50) mcpLogBuffer.shift();
  const data = `data: ${JSON.stringify(enriched)}\n\n`;
  for (const res of logClients) res.write(data);
}

function mcpLogSystem({ client, preview, detail = '' }) {
  broadcastLog({ id: null, tool: null, client, preview, detail, status: 'system', ts: Date.now() });
}

function mcpLogStart({ tool, envName, preview }) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  broadcastLog({ id, tool, envName, preview, status: 'running', ts: Date.now() });
  return id;
}

function mcpLog({ tool, envName, preview, detail = '', isError = false, runId = null }) {
  broadcastLog({ id: runId, tool, envName, preview, detail, isError, status: 'done', ts: Date.now() });
  console.error(`[MCP] ${tool}${envName ? ' / ' + envName : ''} - ${preview}`);
}

function attachLogClient(res) { logClients.add(res); }
function detachLogClient(res) { logClients.delete(res); }
function getMcpLogBuffer() { return mcpLogBuffer; }

// ─── Type index ───────────────────────────────────────────────────────────────
async function getTypeIndex(env) {
  return getIndex(env.id, (query, opts) => withSession(env, s => flexibleSearch(s, query, opts)));
}

// ─── Shared utilities ─────────────────────────────────────────────────────────
// FlexibleSearch returns booleans as true/false, 1/0, or 'true'/'false' strings
const isTruthy = v => v === true || v === 'true' || v === 1 || v === '1';

// ─── Response helpers ─────────────────────────────────────────────────────────
function text(t) { return { content: [{ type: 'text', text: t }] }; }
function error(msg) { return { content: [{ type: 'text', text: `**Error:** ${msg}` }], isError: true }; }

export {
  callCtx,
  isTruthy,
  getSession,
  withSession,
  getEnvironment,
  listEnvironments,
  fuzzySearch,
  getTypeIndex,
  mcpLogStart,
  mcpLog,
  attachLogClient,
  detachLogClient,
  getMcpLogBuffer,
  mcpLogSystem,
  text,
  error,
};
