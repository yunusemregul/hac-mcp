import { mkdir, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const pad = n => String(n).padStart(2, '0');
const safe = s => String(s ?? 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_');

const EXT_BY_KIND = {
  groovy: 'groovy',
  impex: 'impex',
  flexsearch: 'sql',
};

export async function logScriptRun({ kind, envName, script, result, isError }) {
  try {
    const d = new Date();
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const dir = join(ROOT, 'logs', kind, date);
    await mkdir(dir, { recursive: true });
    const status = isError ? 'ERROR' : 'OK';
    const ext = EXT_BY_KIND[kind] ?? 'txt';
    const file = join(dir, `${safe(envName)}_${time}_${status}.${ext}`);
    const body =
      `// ${date} ${time.replace(/-/g, ':')} | env=${envName} | ${status}\n` +
      `// ===== script =====\n${script}\n` +
      `// ===== result =====\n${result ?? ''}\n`;
    await writeFile(file, body, 'utf8');
  } catch (e) {
    console.error(`[MCP] fileLog failed: ${e.message}`);
  }
}
