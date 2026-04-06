import { z } from 'zod';
import { tool as listEnvironments } from './list_environments.js';
import { tool as flexibleSearch } from './flexible_search.js';
import { tool as searchType } from './search_type.js';
import { tool as getTypeInfo } from './get_type_info.js';
import { tool as resolvePk } from './resolve_pk.js';
import { tool as impexImport } from './impex_import.js';
import { tool as groovyExecute } from './groovy_execute.js';
import { tool as readProperty } from './read_property.js';
import { tool as mediaRead } from './media_read.js';
import { tool as mediaWrite } from './media_write.js';
import { tool as runCronjob } from './run_cronjob.js';
import { tool as listCronjobs } from './list_cronjobs.js';

const tools = [
  listEnvironments,
  flexibleSearch,
  searchType,
  getTypeInfo,
  resolvePk,
  impexImport,
  groovyExecute,
  readProperty,
  mediaRead,
  mediaWrite,
  runCronjob,
  listCronjobs,
];

export function registerAllTools(mcp) {
  for (const { name, description, handler, inputSchema } of tools) {
    mcp.registerTool(name, { description, inputSchema: z.object(inputSchema ?? {}) }, handler);
  }
}
