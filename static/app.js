// ─── Global tooltip ───────────────────────────────────────────────────────────
const _gtt = document.getElementById('globalTooltip');
document.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-tooltip]');
  if (!el) { _gtt.style.opacity = '0'; return; }
  _gtt.textContent = el.dataset.tooltip;
  _gtt.style.opacity = '1';
});
document.addEventListener('mousemove', e => {
  if (_gtt.style.opacity !== '1') return;
  const w = _gtt.offsetWidth, pad = 8;
  const x = Math.min(Math.max(e.clientX - w / 2, pad), window.innerWidth - w - pad);
  _gtt.style.left = x + 'px';
  _gtt.style.top  = (e.clientY - _gtt.offsetHeight - 10) + 'px';
});
document.addEventListener('mouseout', e => {
  if (!e.relatedTarget?.closest('[data-tooltip]')) _gtt.style.opacity = '0';
});

// ─── Theme ────────────────────────────────────────────────────────────────────
const MOON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SUN  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById('btnTheme').innerHTML = theme === 'light' ? MOON : SUN;
  localStorage.setItem('hac-mcp-theme', theme);
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
}
applyTheme(localStorage.getItem('hac-mcp-theme') || 'dark');

// ─── endpoint label + info card ───────────────────────────────────────────────
const mcpEndpoint = location.origin + '/mcp/sse';
const claudeCmd = `claude mcp add --transport sse hac-mcp ${mcpEndpoint}`;
const configJson =
`{
  "mcpServers": {
    "hac-mcp": {
      "url": "${mcpEndpoint}"
    }
  }
}`;

document.getElementById('infoEndpoint').textContent = mcpEndpoint;
document.getElementById('infoClaudeCmd').textContent = claudeCmd;
document.getElementById('infoJson').textContent = configJson;
document.getElementById('modalClaudeCmd').textContent = claudeCmd;
document.getElementById('modalJson').textContent = configJson;

// ─── Manifest modal ───────────────────────────────────────────────────────────
const CATEGORY_META = {
  read:    { label: 'Read',    cls: 'cat-read' },
  write:   { label: 'Write',   cls: 'cat-write' },
  utility: { label: 'Utility', cls: 'cat-util' },
};

async function showManifest() {
  document.getElementById('manifestOverlay').classList.add('visible');
  const el = document.getElementById('manifestTools');
  if (el.dataset.loaded === '1') return;
  el.innerHTML = '<div class="empty" style="padding:20px 0">Loading…</div>';
  const manifest = await fetch('/api/manifest').then(r => r.json());
  document.getElementById('manifestTitle').textContent = manifest.name;
  document.getElementById('manifestSubtitle').textContent = manifest.description + ' · v' + manifest.version;

  const byCategory = {};
  for (const t of manifest.tools) {
    (byCategory[t.category] = byCategory[t.category] || []).push(t);
  }

  const order = ['utility', 'read', 'write'];
  const sections = order.filter(c => byCategory[c]).map(cat => {
    const meta = CATEGORY_META[cat] || { label: cat, cls: 'cat-util' };
    const items = byCategory[cat].map(t => `
      <div class="manifest-tool">
        <div class="manifest-tool-header">
          <code class="manifest-tool-name">${esc(t.name)}</code>
          <span class="manifest-cat ${meta.cls}">${meta.label}</span>
        </div>
        <p class="manifest-tool-desc">${esc(t.description)}</p>
        ${t.params.length ? `<div class="manifest-params">${t.params.map(p => `
          <span class="manifest-param${p.optional ? ' optional' : ''}">
            <span class="manifest-param-name">${esc(p.name)}</span>
            ${p.description ? `<span class="manifest-param-desc">${esc(p.description)}</span>` : ''}
          </span>`).join('')}</div>` : ''}
      </div>
    `).join('');
    return `<div class="manifest-section">
      <div class="manifest-section-title">${meta.label} Tools</div>
      ${items}
    </div>`;
  }).join('');

  el.innerHTML = sections;
  el.dataset.loaded = '1';
}

function closeManifest() { document.getElementById('manifestOverlay').classList.remove('visible'); }
function closeManifestModal(e) { if (e.target === document.getElementById('manifestOverlay')) closeManifest(); }

// ─── Onboarding modal ─────────────────────────────────────────────────────────
function showModal() { document.getElementById('modalOverlay').classList.add('visible'); }
function dismissModal() {
  document.getElementById('modalOverlay').classList.remove('visible');
  localStorage.setItem('hac-mcp-onboarded', '1');
}
function closeModal(e) { if (e.target === document.getElementById('modalOverlay')) dismissModal(); }

if (!localStorage.getItem('hac-mcp-onboarded')) showModal();

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function pollStatus() {
  try {
    const { environmentCount, connectedClients, clients } = await fetch('/api/status').then(r => r.json());
    document.getElementById('pillEnvsLabel').textContent =
      environmentCount === 1 ? '1 environment' : `${environmentCount} environments`;
    document.getElementById('pillClientsLabel').textContent =
      connectedClients === 1 ? '1 client connected' : `${connectedClients} clients connected`;
    document.getElementById('clientDot').className = `status-dot ${connectedClients > 0 ? 'active' : 'inactive'}`;
    document.getElementById('pillEnvs').className = `status-pill ${environmentCount > 0 ? 'active' : ''}`;
    document.getElementById('pillClients').className = `status-pill ${connectedClients > 0 ? 'active' : ''}`;
    document.getElementById('infoSetup').style.display = connectedClients > 0 ? 'none' : '';
    const clientList = document.getElementById('clientList');
    if (clients && clients.length > 0) {
      clientList.style.display = 'flex';
      clientList.innerHTML = clients.map((c, i) => {
        const num = `<span class="client-num">Client #${i + 1}</span>`;
        if (!c?.version) {
          const since = c?.connectedAt ? `<span class="client-since">Connected ${timeAgo(c.connectedAt)}</span>` : '';
          const calls = c?.toolCalls > 0 ? `<span class="client-calls" data-tooltip="Number of tool calls made by this client since connecting">${c.toolCalls} call${c.toolCalls !== 1 ? 's' : ''}</span>` : '';
          return `<div class="client-card">
            <div class="client-card-meta">${num}${since}</div>
            <div class="client-card-header"><span class="client-name" style="color:var(--text3)">Client connected but information could not be gathered. Try restarting the client.</span></div>
            ${calls ? `<div class="client-caps">${calls}</div>` : ''}
          </div>`;
        }
        const v = c.version;
        const desc = v.description ? `<div class="client-desc">${v.description}</div>` : '';
        const link = v.websiteUrl ? `<a class="client-link" href="${v.websiteUrl}" target="_blank" rel="noopener">${v.websiteUrl}</a>` : '';
        const since = c.connectedAt ? `<span class="client-since">Connected ${timeAgo(c.connectedAt)}</span>` : '';
        const calls = c.toolCalls > 0 ? `<span class="client-calls" data-tooltip="Number of tool calls made by this client since connecting">${c.toolCalls} call${c.toolCalls !== 1 ? 's' : ''}</span>` : '';
        return `<div class="client-card">
          <div class="client-card-meta">${num}${since}</div>
          <div class="client-card-header">
            <span class="client-name">${v.title || v.name}</span>
            <span class="client-version">v${v.version}</span>
          </div>
          ${desc}
          ${link}
          ${calls ? `<div class="client-caps">${calls}</div>` : ''}
        </div>`;
      }).join('');
    } else {
      clientList.style.display = 'none';
      clientList.innerHTML = '';
    }
  } catch {}
}
pollStatus();
setInterval(pollStatus, 5000);

// ─── Environment management ───────────────────────────────────────────────────
let envs = [];
const connStatus = {}; // envId → 'unknown' | 'testing' | 'ok' | 'err'
const connError  = {}; // envId → error string

async function load() {
  envs = await fetch('/api/environments').then(r => r.json());
  render();
  pollStatus();
  envs.forEach(e => testConn(e.id));
}

function connBadge(id) {
  const s = connStatus[id] || 'unknown';
  const labels = { unknown: 'Unknown', testing: 'Testing…', ok: 'Connected', err: 'Failed' };
  const tooltips = {
    unknown: 'Connection not yet tested',
    testing: 'Testing connection to this environment',
    ok: 'Successfully authenticated with HAC',
    err: connError[id] || 'Failed to connect to this environment',
  };
  return `<span class="conn-status ${s}" data-tooltip="${esc(tooltips[s])}" style="cursor:help;user-select:none"><span class="conn-dot"></span>${labels[s]}</span>`;
}

function render() {
  const el = document.getElementById('envList');
  document.getElementById('btnAddEnv').classList.toggle('btn-pulse', !envs.length);
  if (!envs.length) {
    el.innerHTML = '<div class="empty">No environments configured yet.<br/>Click <strong>+ Add Environment</strong> to connect your first HAC instance.</div>';
    return;
  }
  el.innerHTML = envs.map(e => `
    <div class="env-item" id="env-${e.id}">
      <div class="env-dot ${connStatus[e.id] === 'ok' ? 'active' : connStatus[e.id] === 'testing' ? 'testing' : 'inactive'}" id="dot-${e.id}"></div>
      <div class="env-info">
        <div class="env-name">${esc(e.name)}</div>
        <div class="env-url">${esc(e.url)}</div>
        ${e.description ? `<div class="env-desc">${esc(e.description)}</div>` : ''}
        <div class="env-badges">
          ${e.dbType ? `<span class="badge db" data-tooltip="Database type used by this environment" style="cursor:help;user-select:none"><svg width="9" height="9" viewBox="0 0 9 9" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;margin-right:3px;margin-top:-1px"><ellipse cx="4.5" cy="2" rx="3.5" ry="1.3" stroke="currentColor" stroke-width="1"/><path d="M1 2v5c0 .72 1.57 1.3 3.5 1.3S8 7.72 8 7V2" stroke="currentColor" stroke-width="1"/><path d="M1 4.5c0 .72 1.57 1.3 3.5 1.3S8 5.22 8 4.5" stroke="currentColor" stroke-width="1"/></svg>${esc(e.dbType)}</span>` : ''}
          <span class="badge ${e.allowFlexSearch ? 'on':'off'}" data-tooltip="FlexibleSearch queries ${e.allowFlexSearch ? 'are allowed' : 'are disabled'} on this environment" style="cursor:help;user-select:none">FLEX ${e.allowFlexSearch ? 'ON':'OFF'}</span>
          <span class="badge ${e.allowImpexImport ? 'on':'off'}" data-tooltip="ImpEx import ${e.allowImpexImport ? 'is allowed' : 'is disabled'} on this environment" style="cursor:help;user-select:none">IMPEX ${e.allowImpexImport ? 'ON':'OFF'}</span>
          <span class="badge ${e.allowGroovyExecution ? 'on':'off'}" data-tooltip="Groovy script execution ${e.allowGroovyExecution ? 'is allowed' : 'is disabled'} on this environment" style="cursor:help;user-select:none">GROOVY ${e.allowGroovyExecution ? 'ON':'OFF'}</span>
          <span class="badge ${e.allowGroovyCommitMode !== false ? 'on':'off'}" data-tooltip="Groovy commit mode ${e.allowGroovyCommitMode !== false ? 'is allowed' : 'is disabled'} - when enabled scripts can persist database changes" style="cursor:help;user-select:none">COMMIT ${e.allowGroovyCommitMode !== false ? 'ON':'OFF'}</span>
          <span class="badge ${e.allowReadProperty !== false ? 'on':'off'}" data-tooltip="Reading HAC properties ${e.allowReadProperty !== false ? 'is allowed' : 'is disabled'} on this environment" style="cursor:help;user-select:none">PROPS ${e.allowReadProperty !== false ? 'ON':'OFF'}</span>
        </div>
      </div>
      <div class="env-actions">
        ${connBadge(e.id)}
        <button class="btn-edit btn-sm" onclick="testConn('${e.id}')" id="testbtn-${e.id}" ${connStatus[e.id] === 'ok' || connStatus[e.id] === 'testing' ? 'disabled' : ''}>Test</button>
        <button class="btn-edit btn-sm" onclick="openForm('${e.id}')">Edit</button>
        <button class="btn-del btn-sm" onclick="del('${e.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function updateConnBadge(id) {
  const item = document.getElementById('env-' + id);
  if (!item) return;
  const badge = item.querySelector('.conn-status');
  if (badge) badge.outerHTML = connBadge(id);
  const dot = document.getElementById('dot-' + id);
  if (dot) {
    const s = connStatus[id];
    dot.className = `env-dot ${s === 'ok' ? 'active' : s === 'testing' ? 'testing' : 'inactive'}`;
  }
  const btn = document.getElementById('testbtn-' + id);
  if (btn) btn.disabled = connStatus[id] === 'ok' || connStatus[id] === 'testing';
}

async function testConn(id) {
  connStatus[id] = 'testing';
  updateConnBadge(id);
  const res = await fetch(`/api/environments/${id}/test`, { method: 'POST' });
  const data = await res.json();
  connStatus[id] = data.ok ? 'ok' : 'err';
  connError[id] = data.error || '';
  updateConnBadge(id);
}

function openForm(id) {
  const e = id ? envs.find(x => x.id === id) : null;
  document.getElementById('formOverlay').classList.add('visible');
  if (!e) typewriter.start(); else typewriter.stop();
  updateSaveBtn();
  document.getElementById('formTitle').textContent = e ? 'Edit Environment' : 'Add Environment';
  document.getElementById('editId').value = e?.id ?? '';
  document.getElementById('fName').value = e?.name ?? '';
  document.getElementById('fDesc').value = e?.description ?? '';
  document.getElementById('fUrl').value = e?.url ?? '';
  document.getElementById('fUser').value = e?.username ?? '';
  document.getElementById('fPass').value = e?.password ?? '';
  document.getElementById('fFlex').checked = e ? e.allowFlexSearch : true;
  document.getElementById('fImpex').checked = e ? e.allowImpexImport : false;
  document.getElementById('fGroovy').checked = e ? e.allowGroovyExecution : false;
  document.getElementById('fGroovyCommit').checked = e ? e.allowGroovyCommitMode !== false : false;
  toggleGroovyCommit(document.getElementById('fGroovy').checked);
  document.getElementById('fReadProperty').checked = e ? e.allowReadProperty !== false : true;
  document.getElementById('fDbType').value = e?.dbType ?? 'MSSQL';
}

// ─── Auto URL test ────────────────────────────────────────────────────────────
let urlTestTimer;
function scheduleUrlTest() {
  clearTimeout(urlTestTimer);
  const url  = document.getElementById('fUrl').value.trim();
  const user = document.getElementById('fUser').value.trim();
  const pass = document.getElementById('fPass').value;
  const el   = document.getElementById('urlTestStatus');
  const urlInput = document.getElementById('fUrl');
  if (!url) { el.style.display = 'none'; urlInput.style.borderRadius = ''; return; }
  urlInput.style.borderRadius = '6px 6px 0 0';
  if (!user || !pass) {
    el.style.display = '';
    el.className = 'url-status hint';
    el.textContent = 'Enter username and password to test connection';
    return;
  }
  el.style.display = '';
  el.className = 'url-status testing';
  el.textContent = 'Testing connection…';
  urlTestTimer = setTimeout(async () => {
    try {
      const res  = await fetch('/api/test-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, username: user, password: pass }) });
      const data = await res.json();
      if (data.ok) {
        el.className = 'url-status ok';
        el.textContent = '✓ Connected successfully';
      } else if (data.type === 'auth') {
        el.className = 'url-status warn';
        el.textContent = '⚠ URL reachable but credentials are wrong';
      } else {
        el.className = 'url-status err';
        const msg = data.error || '';
        const friendly = msg.includes('ENOTFOUND') ? '✗ Host not found - check the URL'
          : msg.includes('ECONNREFUSED') ? '✗ Connection refused - server may be down'
          : msg.includes('ETIMEDOUT') || msg.includes('ESOCKETTIMEDOUT') ? '✗ Connection timed out'
          : msg.includes('ECONNRESET') ? '✗ Connection reset by server'
          : msg.includes('certificate') || msg.includes('SSL') || msg.includes('TLS') ? '✗ SSL/TLS error - try http:// instead'
          : '✗ Could not reach server';
        el.textContent = friendly;
      }
    } catch {
      el.className = 'url-status err';
      el.textContent = '✗ Could not reach server';
    }
  }, 1200);
}

['fUrl','fUser','fPass'].forEach(id => document.getElementById(id).addEventListener('input', scheduleUrlTest));

function toggleGroovyCommit(enabled) {
  const cb = document.getElementById('fGroovyCommit');
  cb.disabled = !enabled;
  document.getElementById('groovyCommitRow').classList.toggle('disabled', !enabled);
  if (!enabled) { cb.checked = false; updateGroovyNote(); }
  else updateGroovyNote();
}

function updateGroovyNote() {
  const groovyOn = document.getElementById('fGroovy').checked;
  const commitOn = document.getElementById('fGroovyCommit').checked;
  document.getElementById('groovyNote').style.display = groovyOn && !commitOn ? '' : 'none';
}

function closeForm() {
  document.getElementById('formOverlay').classList.remove('visible');
  typewriter.stop();
  clearFieldErrors();
}
function closeFormModal(e) {
  if (e.target === document.getElementById('formOverlay')) closeForm();
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('formOverlay').classList.contains('visible')) closeForm();
  else if (document.getElementById('manifestOverlay').classList.contains('visible')) closeManifest();
  else if (document.getElementById('modalOverlay').classList.contains('visible')) dismissModal();
});

function setFieldError(id, msg) {
  const el = document.getElementById(id);
  const input = el.previousElementSibling.tagName === 'DIV' ? el.previousElementSibling.previousElementSibling : el.previousElementSibling;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
  input?.classList.toggle('input-err', !!msg);
}

function clearFieldErrors() {
  ['errName','errUrl','errUser','errPass'].forEach(id => setFieldError(id, ''));
}

function updateSaveBtn() {
  const ok = document.getElementById('fName').value.trim()
          && document.getElementById('fUrl').value.trim()
          && document.getElementById('fUser').value.trim()
          && document.getElementById('fPass').value;
  document.getElementById('btnSave').disabled = !ok;
}

['fName','fUrl','fUser','fPass'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const errMap = { fName:'errName', fUrl:'errUrl', fUser:'errUser', fPass:'errPass' };
    setFieldError(errMap[id], '');
    updateSaveBtn();
  });
});

async function saveEnv() {
  const id = document.getElementById('editId').value;
  const name     = document.getElementById('fName').value.trim();
  const rawUrl   = document.getElementById('fUrl').value.trim();
  const username = document.getElementById('fUser').value.trim();
  const password = document.getElementById('fPass').value;

  clearFieldErrors();
  let valid = true;
  if (!name)     { setFieldError('errName', 'Name is required');     valid = false; }
  if (!rawUrl)   { setFieldError('errUrl',  'HAC URL is required');  valid = false; }
  if (!username) { setFieldError('errUser', 'Username is required'); valid = false; }
  if (!password) { setFieldError('errPass', 'Password is required'); valid = false; }
  if (!valid) return;

  const data = {
    name,
    description: document.getElementById('fDesc').value.trim(),
    url: /^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl,
    username,
    password,
    allowFlexSearch: document.getElementById('fFlex').checked,
    allowImpexImport: document.getElementById('fImpex').checked,
    allowGroovyExecution: document.getElementById('fGroovy').checked,
    allowGroovyCommitMode: document.getElementById('fGroovyCommit').checked,
    allowReadProperty: document.getElementById('fReadProperty').checked,
    dbType: document.getElementById('fDbType').value || null,
  };
  const res = await fetch(id ? `/api/environments/${id}` : '/api/environments', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (res.ok) {
    const saved = await res.json();
    toast(id ? 'Saved' : 'Environment added', 'ok');
    closeForm();
    await load();
    testConn(saved.id); // auto-test in background, don't await
  } else { const e = await res.json(); toast(e.error || 'Error saving', 'err'); }
}

async function del(id) {
  const e = envs.find(x => x.id === id);
  if (!confirm(`Delete "${e?.name}"?`)) return;
  await fetch(`/api/environments/${id}`, { method: 'DELETE' });
  toast('Deleted', 'ok');
  load();
}

// ─── HAC request log (SSE) ───────────────────────────────────────────────────
function clearLog(listId) {
  const el = document.getElementById(listId);
  el.innerHTML = `<div class="empty" style="padding:20px">Cleared.</div>`;
}

const BADGE = { http: 'HTTP', info: 'INFO', ok: 'OK', error: 'ERR' };

function appendHacLog(entry) {
  const list = document.getElementById('hacLogList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  const time = new Date(entry.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const line = document.createElement('div');
  line.className = `hac-log-line ${entry.level}`;
  line.innerHTML =
    `<span class="hac-ts">${time}</span>` +
    `<span class="hac-badge">[${BADGE[entry.level] || entry.level}]</span>` +
    `<span class="hac-msg">${esc(entry.msg)}</span>`;
  list.appendChild(line);
  list.scrollTop = list.scrollHeight;

  // cap at 50 lines
  const lines = list.querySelectorAll('.hac-log-line');
  if (lines.length > 50) lines[0].remove();
}

const hacEs = new EventSource('/api/hac-log');
hacEs.onopen = () => document.getElementById('hacLogDot').classList.add('connected');
hacEs.onerror = () => document.getElementById('hacLogDot').classList.remove('connected');
hacEs.onmessage = e => appendHacLog(JSON.parse(e.data));

// ─── MCP activity log (SSE) ───────────────────────────────────────────────────
const TOOL_META = {

  flexible_search: { label: 'FLEX',   cls: 'flex' },
  impex_import:    { label: 'IMPEX',  cls: 'impex' },
  list_environments: { label: 'LIST', cls: 'list' },
};


const runningEntries = new Map(); // server runId → DOM element id

function appendLogEntry(entry) {
  const list = document.getElementById('logList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  const time = new Date(entry.ts).toLocaleTimeString();
  const domId = 'log-' + entry.ts + '-' + Math.random().toString(36).slice(2);
  const item = document.createElement('div');

  if (entry.status === 'system') {
    item.className = 'log-entry log-system';
    item.id = domId;
    item.innerHTML = `
      <div class="log-summary log-summary-system">
        <span class="log-sys-dot"></span>
        <span class="log-client">${esc(entry.client || '?')}</span>
        <span class="log-preview">${esc(entry.preview || '')}</span>
        <span class="log-time">${time}</span>
      </div>
    `;
    list.insertBefore(item, list.firstChild);
    const items = list.querySelectorAll('.log-entry');
    if (items.length > 50) items[items.length - 1].remove();
    return;
  }

  const isRunning = entry.status === 'running';
  const meta = TOOL_META[entry.tool] || { label: entry.tool?.toUpperCase() ?? '?', cls: 'list' };
  const isErr = entry.isError;
  const toolCls = isErr ? 'err' : meta.cls;
  const toolLabel = isErr ? 'ERR' : meta.label;
  const envName = entry.envName ? esc(entry.envName) : '';
  const preview = esc(entry.preview || '');
  const client = entry.client ? esc(entry.client) : '';

  // If this is a completion event for a running entry, update it in place
  if (!isRunning && entry.id && runningEntries.has(entry.id)) {
    const domId = runningEntries.get(entry.id);
    runningEntries.delete(entry.id);
    const existing = document.getElementById(domId);
    if (existing) {
      existing.classList.remove('running');
      if (isErr) existing.classList.add('error');
      existing.querySelector('.log-tool').className = `log-tool ${toolCls}`;
      existing.querySelector('.log-tool').textContent = toolLabel;
      existing.querySelector('.log-preview').textContent = entry.preview || '';
      existing.querySelector('.log-time').textContent = time;
      existing.querySelector('.log-detail pre').textContent = entry.detail || '';
      return;
    }
  }

  item.className = 'log-entry' + (isRunning ? ' running' : '') + (isErr ? ' error' : '');
  item.id = domId;
  item.innerHTML = `
    <div class="log-summary" onclick="toggleLog('${domId}')">
      <span class="log-chevron">▶</span>
      ${client ? `<span class="log-client">${client}</span>` : ''}
      <span class="log-tool ${toolCls}">${toolLabel}</span>
      ${envName ? `<span class="log-env">${envName}</span>` : ''}
      <span class="log-preview">${preview}</span>
      <span class="log-time">${time}</span>
    </div>
    <div class="log-detail"><pre>${esc(entry.detail || '')}</pre></div>
  `;

  if (isRunning && entry.id) runningEntries.set(entry.id, domId);

  list.insertBefore(item, list.firstChild);
  const items = list.querySelectorAll('.log-entry');
  if (items.length > 50) items[items.length - 1].remove();
}

function toggleLog(id) {
  document.getElementById(id)?.classList.toggle('open');
}

const es = new EventSource('/api/mcp-log');
es.onopen = () => document.getElementById('logDot').classList.add('connected');
es.onerror = () => document.getElementById('logDot').classList.remove('connected');
es.onmessage = e => appendLogEntry(JSON.parse(e.data));

// ─── Typewriter placeholders ──────────────────────────────────────────────────
const scenarios = [
  {
    name: 'Production',
    desc: 'Live environment - never run Groovy with commit here',
    url:  'https://commerce.example.com:9002',
  },
  {
    name: 'Local DEV',
    desc: 'Local dev instance, safe to experiment freely',
    url:  'https://localhost:9002',
  },
  {
    name: 'Staging S1',
    desc: 'S1 staging - shared with QA, handle ImpEx with care',
    url:  'https://staging.example.com:9002',
  },
  {
    name: 'QA Environment',
    desc: 'QA instance - owned by the testing team, ask before importing',
    url:  'https://qa.commerce.internal:9002',
  },
  {
    name: 'Pre-production',
    desc: 'Pre-prod mirror - always validate here before pushing live',
    url:  'https://preprod.example.com:9002',
  },
];

function charTypewriter(inputs, getValues) {
  let si = 0, ci = 0, deleting = false;
  let timer, paused = true;

  function tick() {
    if (paused) return;
    const values = getValues(si);
    const longest = Math.max(...values.map(v => v.length));

    if (!deleting) {
      ci++;
      inputs.forEach((input, i) => { input.placeholder = values[i].slice(0, ci); });
      if (ci >= longest) { timer = setTimeout(() => { deleting = true; tick(); }, 1600); return; }
      timer = setTimeout(tick, 30 + Math.random() * 25);
    } else {
      ci--;
      inputs.forEach((input, i) => { input.placeholder = values[i].slice(0, ci); });
      if (ci === 0) { deleting = false; si = (si + 1) % scenarios.length; timer = setTimeout(tick, 300); return; }
      timer = setTimeout(tick, 18);
    }
  }

  inputs.forEach(input => {
    input.addEventListener('blur', () => { if (!input.value && !paused) { ci = 0; deleting = false; tick(); } });
  });

  return {
    start() { paused = false; ci = 0; deleting = false; clearTimeout(timer); tick(); },
    stop()  { paused = true; clearTimeout(timer); inputs.forEach(i => { i.placeholder = ''; }); },
  };
}

const fName = document.getElementById('fName');
const fDesc = document.getElementById('fDesc');
const fUrl  = document.getElementById('fUrl');

const typewriter = charTypewriter([fName, fDesc, fUrl], i => [
  scenarios[i].name,
  scenarios[i].desc,
  scenarios[i].url,
]);

// ─── helpers ──────────────────────────────────────────────────────────────────
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  setTimeout(() => el.classList.remove('show'), 2500);
}

async function copyEl(id) {
  const el = document.getElementById(id);
  await navigator.clipboard.writeText(el.textContent);
  const btn = el.closest('.copyable').querySelector('.copy-btn');
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 1500);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

load();
