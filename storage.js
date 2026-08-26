import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.hac-mcp');
const FILE = join(DATA_DIR, 'environments.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = { httpTimeoutMs: 60_000, logRetentionDays: 30, logMaxResultChars: 20_000 };

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function load() {
  if (!existsSync(FILE)) return [];
  return JSON.parse(await readFile(FILE, 'utf8'));
}

async function save(envs) {
  await ensureDataDir();
  await writeFile(FILE, JSON.stringify(envs, null, 2));
}

export async function listEnvironments() {
  return load();
}

export async function getEnvironment(id) {
  return (await load()).find(e => e.id === id) ?? null;
}

export async function createEnvironment(data) {
  const envs = await load();
  let id;
  do { id = randomBytes(4).toString('hex'); } while (envs.some(e => e.id === id));
  const env = { id, ...data };
  envs.push(env);
  await save(envs);
  return env;
}

export async function updateEnvironment(id, data) {
  const envs = await load();
  const i = envs.findIndex(e => e.id === id);
  if (i === -1) throw new Error('Environment not found');
  envs[i] = { ...envs[i], ...data };
  await save(envs);
  return envs[i];
}

export async function deleteEnvironment(id) {
  const envs = await load();
  await save(envs.filter(e => e.id !== id));
}

export async function getSettings() {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function updateSettings(data) {
  const current = await getSettings();
  const next = { ...current };
  if (data.httpTimeoutMs != null) {
    const ms = Number(data.httpTimeoutMs);
    if (!Number.isFinite(ms) || ms < 1000 || ms > 600_000) {
      throw new Error('httpTimeoutMs must be between 1000 and 600000');
    }
    next.httpTimeoutMs = Math.round(ms);
  }
  if (data.logRetentionDays != null) {
    const days = Number(data.logRetentionDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) {
      throw new Error('logRetentionDays must be an integer between 0 (keep forever) and 3650');
    }
    next.logRetentionDays = days;
  }
  if (data.logMaxResultChars != null) {
    const chars = Number(data.logMaxResultChars);
    if (!Number.isInteger(chars) || chars < 0 || chars > 10_000_000) {
      throw new Error('logMaxResultChars must be an integer between 0 (no truncation) and 10000000');
    }
    next.logMaxResultChars = chars;
  }
  await ensureDataDir();
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}
