// ─── endpoint label ───────────────────────────────────────────────────────────
document.getElementById('mcpEndpoint').textContent = location.origin + '/mcp/sse';

// ─── Environment management ───────────────────────────────────────────────────
let envs = [];
const connStatus = {}; // envId → 'unknown' | 'testing' | 'ok' | 'err'
const connError  = {}; // envId → error string

async function load() {
  envs = await fetch('/api/environments').then(r => r.json());
  render();
  envs.forEach(e => testConn(e.id));
}

function connBadge(id) {
  const s = connStatus[id] || 'unknown';
  const labels = { unknown: '—', testing: 'Testing…', ok: 'Connected', err: 'Failed' };
  const title = s === 'err' ? ` title="${esc(connError[id] || '')}"` : '';
  return `<span class="conn-status ${s}"${title}><span class="conn-dot"></span>${labels[s]}</span>`;
}

function render() {
  const el = document.getElementById('envList');
  if (!envs.length) {
    el.innerHTML = '<div class="empty">No environments yet.<br/>Add one using the form →</div>';
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
          <span class="badge ${e.allowFlexSearch ? 'on':'off'}">FLEX ${e.allowFlexSearch ? 'ON':'OFF'}</span>
          <span class="badge ${e.allowImpexImport ? 'on':'off'}">IMPEX ${e.allowImpexImport ? 'ON':'OFF'}</span>
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
  document.getElementById('formCard').style.display = '';
  document.getElementById('formTitle').textContent = e ? 'Edit Environment' : 'Add Environment';
  document.getElementById('editId').value = e?.id ?? '';
  document.getElementById('fName').value = e?.name ?? '';
  document.getElementById('fDesc').value = e?.description ?? '';
  document.getElementById('fUrl').value = e?.url ?? '';
  document.getElementById('fUser').value = e?.username ?? '';
  document.getElementById('fPass').value = e?.password ?? '';
  document.getElementById('fFlex').checked = e ? e.allowFlexSearch : true;
  document.getElementById('fImpex').checked = e ? e.allowImpexImport : true;
  document.getElementById('fName').focus();
}

function closeForm() { document.getElementById('formCard').style.display = 'none'; }

async function saveEnv() {
  const id = document.getElementById('editId').value;
  const data = {
    name: document.getElementById('fName').value.trim(),
    description: document.getElementById('fDesc').value.trim(),
    url: document.getElementById('fUrl').value.trim(),
    username: document.getElementById('fUser').value.trim(),
    password: document.getElementById('fPass').value,
    allowFlexSearch: document.getElementById('fFlex').checked,
    allowImpexImport: document.getElementById('fImpex').checked,
  };
  if (!data.name || !data.url || !data.username) { toast('Name, URL and username are required', 'err'); return; }
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
let hacLogStart = Date.now();

function clearLog(listId) {
  const el = document.getElementById(listId);
  el.innerHTML = `<div class="empty" style="padding:20px">Cleared.</div>`;
  if (listId === 'hacLogList') hacLogStart = Date.now();
}

const BADGE = { http: 'HTTP', info: 'INFO', ok: 'OK', error: 'ERR' };

function appendHacLog(entry) {
  const list = document.getElementById('hacLogList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  const elapsed = ((entry.ts - hacLogStart) / 1000).toFixed(2);
  const line = document.createElement('div');
  line.className = `hac-log-line ${entry.level}`;
  line.innerHTML =
    `<span class="hac-ts">+${elapsed}s</span>` +
    `<span class="hac-badge">[${BADGE[entry.level] || entry.level}]</span>` +
    `<span class="hac-msg">${esc(entry.msg)}</span>`;
  list.appendChild(line);
  list.scrollTop = list.scrollHeight;

  // cap at 200 lines
  const lines = list.querySelectorAll('.hac-log-line');
  if (lines.length > 200) lines[0].remove();
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


function appendLogEntry(entry) {
  const list = document.getElementById('logList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  const meta = TOOL_META[entry.tool] || { label: entry.tool?.toUpperCase() ?? '?', cls: 'list' };
  const isErr = entry.isError;
  const toolCls = isErr ? 'err' : meta.cls;
  const toolLabel = isErr ? 'ERR' : meta.label;

  const envName = entry.envName ? esc(entry.envName) : '';
  const preview = esc(entry.preview || '');
  const time = new Date(entry.ts).toLocaleTimeString();

  const id = 'log-' + entry.ts + '-' + Math.random().toString(36).slice(2);
  const item = document.createElement('div');
  item.className = 'log-entry';
  item.id = id;
  item.innerHTML = `
    <div class="log-summary" onclick="toggleLog('${id}')">
      <span class="log-chevron">▶</span>
      <span class="log-tool ${toolCls}">${toolLabel}</span>
      ${envName ? `<span class="log-env">${envName}</span>` : ''}
      <span class="log-preview">${preview}</span>
      <span class="log-time">${time}</span>
    </div>
    <div class="log-detail"><pre>${esc(entry.detail || '')}</pre></div>
  `;

  list.insertBefore(item, list.firstChild); // newest on top
  // Keep at most 50 entries
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

// ─── helpers ──────────────────────────────────────────────────────────────────
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  setTimeout(() => el.classList.remove('show'), 2500);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

load();
