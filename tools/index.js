import { register as registerListEnvironments } from './list_environments.js';
import { register as registerFlexibleSearch } from './flexible_search.js';
import { register as registerSearchType } from './search_type.js';
import { register as registerGetTypeInfo } from './get_type_info.js';
import { register as registerResolvePk } from './resolve_pk.js';
import { register as registerImpexImport } from './impex_import.js';
import { register as registerGroovyExecute } from './groovy_execute.js';
import { register as registerReadProperty } from './read_property.js';

export function registerAllTools(mcp) {
  registerListEnvironments(mcp);
  registerFlexibleSearch(mcp);
  registerSearchType(mcp);
  registerGetTypeInfo(mcp);
  registerResolvePk(mcp);
  registerImpexImport(mcp);
  registerGroovyExecute(mcp);
  registerReadProperty(mcp);
}
