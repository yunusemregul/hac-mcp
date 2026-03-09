import https from 'https';
import dns from 'dns';
import { URL } from 'url';

const dnsLookup = dns.promises.lookup;

// Per-hostname: resolved IP + keepalive agent (avoids repeated mDNS lookups)
const dnsCache = {};
const agentCache = {};

// Logger — server.js sets this to broadcast to SSE clients
let _log = () => {};
export function setHacLogger(fn) { _log = fn; }
function log(level, msg) { _log({ level, msg, ts: Date.now() }); }

async function resolveHost(hostname) {
  if (!dnsCache[hostname]) {
    try {
      const r = await dnsLookup(hostname, { family: 4 });
      dnsCache[hostname] = r.address;
      log('info', `Resolved ${hostname} → ${r.address}`);
    } catch {
      dnsCache[hostname] = hostname;
    }
  }
  return dnsCache[hostname];
}

function getAgent(hostname) {
  if (!agentCache[hostname]) {
    agentCache[hostname] = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  }
  return agentCache[hostname];
}

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        log('http', `${options.method} ${options.path} → ${res.statusCode} (${Date.now() - t0}ms)`);
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', err => {
      log('error', `${options.method} ${options.path} → ${err.message}`);
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

function extractCsrf(html) {
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/) ||
            html.match(/<meta name="_csrf" content="([^"]+)"/);
  return m?.[1] ?? null;
}

function extractCookies(headers) {
  const cookies = {};
  for (const c of (headers['set-cookie'] || [])) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq !== -1) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

function cookieStr(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function opts(session, path, method, extra = {}) {
  return {
    hostname: session.ip,
    servername: session.host,
    port: session.port,
    path,
    method,
    agent: session.agent,
    headers: {
      Host: session.host,
      'User-Agent': 'hac-mcp/1.0',
      Cookie: cookieStr(session.cookies),
      ...extra,
    },
  };
}

export async function login(baseUrl, username, password) {
  const url = new URL(baseUrl);
  const host = url.hostname;
  const port = parseInt(url.port) || 443;
  const ctx = url.pathname.replace(/\/+$/, '');

  log('info', `Logging in to ${host}${ctx || '/'} as ${username}`);

  const ip = await resolveHost(host);
  const agent = getAgent(host);
  const proto = { host, ip, port, ctx, agent, cookies: {} };

  log('info', `Fetching login page — getting CSRF token + session cookie`);
  const loginPage = await httpRequest(opts(proto, ctx + '/login', 'GET'));
  const cookies = extractCookies(loginPage.headers);
  const csrf = extractCsrf(loginPage.body);
  if (!csrf) throw new Error('Could not extract CSRF token from login page');
  log('info', `Got CSRF token: ${csrf.slice(0, 16)}…`);

  log('info', `Submitting credentials for ${username}`);
  const body = new URLSearchParams({ j_username: username, j_password: password, _csrf: csrf }).toString();
  const loginRes = await httpRequest(opts({ ...proto, cookies }, ctx + '/j_spring_security_check', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
    Referer: `https://${host}${ctx}/login`,
  }), body);

  const sessionCookies = { ...cookies, ...extractCookies(loginRes.headers) };
  const session = { host, ip, port, ctx, agent, cookies: sessionCookies };

  const redirectPath = loginRes.headers.location || (ctx + '/');
  log('info', `Following redirect → ${redirectPath}`);
  const home = await httpRequest(opts(session, redirectPath, 'GET'));

  const loggedIn = home.body.includes("You're Administrator") || home.body.includes('logout');
  if (!loggedIn) throw new Error('Login failed — check credentials');
  log('ok', `Login successful for ${username}@${host}`);

  return session;
}

export class SessionExpiredError extends Error {
  constructor() { super('Session expired — HAC redirected to login page'); this.name = 'SessionExpiredError'; }
}

function assertNotLoginPage(res) {
  const location = res.headers.location || '';
  if (res.status === 302 && location.includes('/login')) throw new SessionExpiredError();
  if (res.status === 200 && res.body.includes('j_spring_security_check')) throw new SessionExpiredError();
}

export async function flexibleSearch(session, query, {
  maxCount = 200, user = 'admin', locale = 'en', dataSource = 'master',
} = {}) {
  const { ctx, host } = session;

  log('info', `Fetching FlexSearch page for CSRF token`);
  const flexPage = await httpRequest(opts(session, ctx + '/console/flexsearch', 'GET'));
  assertNotLoginPage(flexPage);
  const csrf = extractCsrf(flexPage.body);
  if (!csrf) throw new Error('Could not extract CSRF token from flexsearch page');
  log('info', `Got CSRF token: ${csrf.slice(0, 16)}…`);

  log('info', `Executing query (maxCount=${maxCount}, dataSource=${dataSource}): ${query.slice(0, 80)}${query.length > 80 ? '…' : ''}`);
  const body = new URLSearchParams({
    flexibleSearchQuery: query, sqlQuery: '', maxCount: String(maxCount),
    user, locale, dataSource, commit: 'false',
  }).toString();

  const res = await httpRequest(opts(session, ctx + '/console/flexsearch/execute', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
    'X-CSRF-TOKEN': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json',
    Referer: `https://${host}${ctx}/console/flexsearch`,
  }), body);

  const result = JSON.parse(res.body);
  if (result.exception) {
    log('error', `Query failed: ${result.exception}`);
  } else {
    log('ok', `Query returned ${result.resultCount} row(s) in ${result.executionTime}ms`);
  }
  return result;
}

export async function impexImport(session, scriptContent, {
  validationEnum = 'IMPORT_STRICT', maxThreads = 20, encoding = 'UTF-8',
  legacyMode = false, enableCodeExecution = false, distributedMode = false, sldEnabled = false,
} = {}) {
  const { ctx, host } = session;

  log('info', `Fetching ImpEx page for CSRF token`);
  const impexPage = await httpRequest(opts(session, ctx + '/console/impex/import', 'GET'));
  assertNotLoginPage(impexPage);
  const csrf = extractCsrf(impexPage.body);
  if (!csrf) throw new Error('Could not extract CSRF token from impex page');
  log('info', `Got CSRF token: ${csrf.slice(0, 16)}…`);

  log('info', `Submitting ImpEx script (${scriptContent.length} chars, validation=${validationEnum}, threads=${maxThreads})`);
  const params = new URLSearchParams({
    scriptContent, validationEnum, maxThreads: String(maxThreads), encoding,
    _legacyMode: 'on', _enableCodeExecution: 'on', _distributedMode: 'on', _sldEnabled: 'on',
    _csrf: csrf,
  });
  if (legacyMode) params.set('legacyMode', 'true');
  if (enableCodeExecution) params.set('enableCodeExecution', 'true');
  if (distributedMode) params.set('distributedMode', 'true');
  if (sldEnabled) params.set('sldEnabled', 'true');

  const body = params.toString();
  const res = await httpRequest(opts(session, ctx + '/console/impex/import', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
    Referer: `https://${host}${ctx}/console/impex/import`,
  }), body);

  const levelM = res.body.match(/id="impexResult"[^>]*data-level="([^"]+)"/);
  const resultM = res.body.match(/id="impexResult"[^>]*data-result="([^"]+)"/);
  const preM = res.body.match(/<pre>([\s\S]*?)<\/pre>/);
  const decode = s => s?.replace(/&#034;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim() ?? null;

  const result = {
    level: levelM?.[1] ?? null,
    result: resultM?.[1] ?? null,
    details: decode(preM?.[1] ?? null),
  };

  if (result.level === 'error') {
    log('error', `Import failed: ${result.result}`);
  } else {
    log('ok', `Import complete: ${result.result || 'done'}`);
  }
  return result;
}
