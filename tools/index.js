import { tool as listEnvironments } from './list_environments.js';
import { tool as flexibleSearch } from './flexible_search.js';
import { tool as searchType } from './search_type.js';
import { tool as getTypeInfo } from './get_type_info.js';
import { tool as resolvePk } from './resolve_pk.js';
import { tool as impexImport } from './impex_import.js';
import { tool as groovyExecute } from './groovy_execute.js';
import { tool as readProperty } from './read_property.js';

const tools = [
  listEnvironments,
  flexibleSearch,
  searchType,
  getTypeInfo,
  resolvePk,
  impexImport,
  groovyExecute,
  readProperty,
];

export function registerAllTools(mcp) {
  for (const { name, description, inputSchema, handler } of tools) {
    mcp.registerTool(name, { description, ...(inputSchema && { inputSchema }) }, handler);
  }
}
