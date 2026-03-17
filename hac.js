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
function log(level, msg, envName) {
  const prefix = envName ? `[${envName}] ` : '';
  _log({ level, msg: prefix + msg, ts: Date.now() });
}

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
        const envTag = options._envName ? `[${options._envName}] ` : '';
        log('http', `${envTag}${options.method} ${options.path} → ${res.statusCode} (${Date.now() - t0}ms)`);
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', err => {
      const envTag = options._envName ? `[${options._envName}] ` : '';
      log('error', `${envTag}${options.method} ${options.path} → ${err.message}`);
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

function htmlDecode(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#034;/g, '"').replace(/&#39;/g, "'").replace(/&#039;/g, "'");
}

function opts(session, path, method, extra = {}) {
  return {
    hostname: session.ip,
    servername: session.host,
    port: session.port,
    path,
    method,
    agent: session.agent,
    _envName: session.envName,
    headers: {
      Host: session.host,
      'User-Agent': 'hac-mcp/1.0',
      Cookie: cookieStr(session.cookies),
      ...extra,
    },
  };
}

export async function login(baseUrl, username, password, envName) {
  const url = new URL(baseUrl);
  const host = url.hostname;
  const port = parseInt(url.port) || 443;
  const ctx = url.pathname.replace(/\/+$/, '');

  log('info', `Logging in to ${host}${ctx || '/'} as ${username}`, envName);

  const ip = await resolveHost(host);
  const agent = getAgent(host);
  const proto = { host, ip, port, ctx, agent, cookies: {}, envName };

  log('info', `Fetching login page — getting CSRF token + session cookie`, envName);
  const loginPage = await httpRequest(opts(proto, ctx + '/login', 'GET'));
  const cookies = extractCookies(loginPage.headers);
  const csrf = extractCsrf(loginPage.body);
  if (!csrf) throw new Error('Could not extract CSRF token from login page');
  log('info', `Got CSRF token: ${csrf.slice(0, 16)}…`, envName);

  log('info', `Submitting credentials for ${username}`, envName);
  const body = new URLSearchParams({ j_username: username, j_password: password, _csrf: csrf }).toString();
  const loginRes = await httpRequest(opts({ ...proto, cookies }, ctx + '/j_spring_security_check', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
    Referer: `https://${host}${ctx}/login`,
  }), body);

  const sessionCookies = { ...cookies, ...extractCookies(loginRes.headers) };
  const session = { host, ip, port, ctx, agent, cookies: sessionCookies, envName };

  const redirectPath = loginRes.headers.location || (ctx + '/');
  log('info', `Following redirect → ${redirectPath}`, envName);
  const home = await httpRequest(opts(session, redirectPath, 'GET'));

  const loggedIn = home.body.includes("You're Administrator") || home.body.includes('logout');
  if (!loggedIn) throw new Error('Login failed — check credentials');
  log('ok', `Login successful for ${username}@${host}`, envName);

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
  const { ctx, host, envName } = session;

  log('info', `Fetching FlexSearch page for CSRF token`, envName);
  const flexPage = await httpRequest(opts(session, ctx + '/console/flexsearch', 'GET'));
  assertNotLoginPage(flexPage);
  const csrf = extractCsrf(flexPage.body);
  if (!csrf) throw new Error('Could not extract CSRF token from flexsearch page');
  log('info', `Got CSRF token: ${csrf.slice(0, 16)}…`, envName);

  log('info', `Executing query (maxCount=${maxCount}, dataSource=${dataSource}): ${query.slice(0, 80)}${query.length > 80 ? '…' : ''}`, envName);
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
  if (result.resultList) result.resultList = result.resultList.map(row => row.map(htmlDecode));
  if (result.exception) {
    log('error', `Query failed: ${result.exception}`, envName);
  } else {
    log('ok', `Query returned ${result.resultCount} row(s) in ${result.executionTime}ms`, envName);
  }
  return result;
}

export async function impexImport(session, scriptContent, {
  validationEnum = 'IMPORT_STRICT', maxThreads = 20, encoding = 'UTF-8',
  legacyMode = false, enableCodeExecution = false, distributedMode = false, sldEnabled = false,
} = {}) {
  const { ctx, host, envName } = session;

  log('info', `Fetching ImpEx page for CSRF token`, envName);
  const impexPage = await httpRequest(opts(session, ctx + '/console/impex/import', 'GET'));
  assertNotLoginPage(impexPage);
  const csrf = extractCsrf(impexPage.body);
  if (!csrf) throw new Error('Could not extract CSRF token from impex page');
  log('info', `Got CSRF token: ${csrf.slice(0, 16)}…`, envName);

  log('info', `Submitting ImpEx script (${scriptContent.length} chars, validation=${validationEnum}, threads=${maxThreads})`, envName);
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
  const decode = s => s != null ? htmlDecode(s).trim() : null;

  const result = {
    level: levelM?.[1] ?? null,
    result: resultM?.[1] ?? null,
    details: decode(preM?.[1] ?? null),
  };

  if (result.level === 'error') {
    log('error', `Import failed: ${result.result}`, envName);
  } else {
    log('ok', `Import complete: ${result.result || 'done'}`, envName);
  }
  return result;
}

export async function groovyExecute(session, script, { commit = false } = {}) {
  const { ctx, host, envName } = session;

  log('info', `Fetching scripting page for CSRF token`, envName);
  const page = await httpRequest(opts(session, ctx + '/console/scripting', 'GET'));
  assertNotLoginPage(page);
  const csrf = extractCsrf(page.body);
  if (!csrf) throw new Error('Could not extract CSRF token from scripting page');
  log('info', `Got CSRF token: ${csrf.slice(0, 16)}…`, envName);

  log('info', `Executing Groovy script (${script.length} chars, commit=${commit})`, envName);
  const body = new URLSearchParams({
    script, scriptType: 'groovy', commit: commit ? 'true' : 'false',
  }).toString();

  const res = await httpRequest(opts(session, ctx + '/console/scripting/execute', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
    'X-CSRF-TOKEN': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json',
    Referer: `https://${host}${ctx}/console/scripting`,
  }), body);

  assertNotLoginPage(res);
  const result = JSON.parse(res.body);

  if (result.stacktraceText) {
    log('error', `Groovy execution failed: ${result.stacktraceText.split('\n')[0]}`, envName);
  } else {
    log('ok', `Groovy executed. Result: ${String(result.executionResult).slice(0, 80)}`, envName);
  }
  return result;
}

export async function pkAnalyze(session, pk) {
  const { ctx, host, envName } = session;
  log('info', `Fetching PK analyzer page for CSRF token`, envName);
  const page = await httpRequest(opts(session, ctx + '/platform/pkanalyzer', 'GET'));
  assertNotLoginPage(page);
  const csrf = extractCsrf(page.body);
  if (!csrf) throw new Error('Could not extract CSRF token from pkanalyzer page');
  log('info', `Analyzing PK: ${pk}`, envName);
  const body = new URLSearchParams({ pkString: String(pk) }).toString();
  const res = await httpRequest(opts(session, ctx + '/platform/pkanalyzer/analyze', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
    'X-CSRF-TOKEN': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json',
    Referer: `https://${host}${ctx}/platform/pkanalyzer`,
  }), body);
  assertNotLoginPage(res);
  return JSON.parse(res.body);
}
