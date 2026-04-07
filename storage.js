import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';

const DATA_DIR = join(homedir(), '.hac-mcp');
const FILE = join(DATA_DIR, 'environments.json');

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
