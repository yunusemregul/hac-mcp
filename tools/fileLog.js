import { mkdir, writeFile, readdir, rm } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const LOG_DIR = join(ROOT, 'logs');

const pad = n => String(n).padStart(2, '0');
const safe = s => String(s ?? 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_');

const EXT_BY_KIND = {
  groovy: 'groovy',
  impex: 'impex',
  flexsearch: 'sql',
};

let retentionDays = 30;   // 0 = keep forever
let maxResultChars = 20_000; // 0 = no truncation

export function setLogRetentionDays(days) {
  const v = Number(days);
  if (Number.isFinite(v) && v >= 0) retentionDays = Math.round(v);
}

export function setLogMaxResultChars(chars) {
  const v = Number(chars);
  if (Number.isFinite(v) && v >= 0) maxResultChars = Math.round(v);
}

function clip(text) {
  const s = String(text ?? '');
  if (!maxResultChars || s.length <= maxResultChars) return s;
  return `${s.slice(0, maxResultChars)}\n// … truncated ${s.length - maxResultChars} of ${s.length} chars (logMaxResultChars=${maxResultChars})\n`;
}

export async function logScriptRun({ kind, envName, script, result, isError }) {
  try {
    const d = new Date();
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const dir = join(LOG_DIR, kind, date);
    await mkdir(dir, { recursive: true });
    const status = isError ? 'ERROR' : 'OK';
    const ext = EXT_BY_KIND[kind] ?? 'txt';
    const file = join(dir, `${safe(envName)}_${time}_${status}.${ext}`);
    const body =
      `// ${date} ${time.replace(/-/g, ':')} | env=${envName} | ${status}\n` +
      `// ===== script =====\n${script}\n` +
      `// ===== result =====\n${clip(result)}\n`;
    await writeFile(file, body, 'utf8');
  } catch (e) {
    console.error(`[MCP] fileLog failed: ${e.message}`);
  }
}

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

export async function pruneLogs() {
  if (!retentionDays) return 0;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - retentionDays);
  let removed = 0;
  try {
    for (const kind of await readdir(LOG_DIR, { withFileTypes: true })) {
      if (!kind.isDirectory()) continue;
      for (const day of await readdir(join(LOG_DIR, kind.name), { withFileTypes: true })) {
        if (!day.isDirectory() || !DATE_DIR.test(day.name)) continue;
        if (new Date(`${day.name}T00:00:00`) >= cutoff) continue;
        await rm(join(LOG_DIR, kind.name, day.name), { recursive: true, force: true });
        removed++;
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[MCP] log prune failed: ${e.message}`);
    return removed;
  }
  if (removed) console.error(`[MCP] Pruned ${removed} log folder(s) older than ${retentionDays} day(s)`);
  return removed;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function startLogPruner() {
  void pruneLogs();
  const timer = setInterval(() => void pruneLogs(), DAY_MS);
  timer.unref?.();
  return timer;
}
