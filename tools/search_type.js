import { z } from 'zod';
import { getEnvironment, getTypeIndex, fuzzySearch, mcpLogStart, mcpLog, text, error } from './context.js';

export function register(mcp) {
  mcp.registerTool(
    'search_type',
    {
      description: 'Search for SAP Commerce type names by fuzzy match. Use this before get_type_info when you are unsure of the exact type code.',
      inputSchema: {
        environmentId: z.string().describe('Environment ID from list_environments'),
        query: z.string().describe('Type name to search for — fuzzy, e.g. "InboundProductLogs", "Solr", "Order"'),
      },
    },
    async ({ environmentId, query }) => {
      const env = await getEnvironment(environmentId);
      if (!env) return error(`Environment "${environmentId}" not found.`);

      const runId = mcpLogStart('search_type', env.name, `Searching "${query}"…`);

      let types;
      try {
        types = await getTypeIndex(env);
      } catch (e) {
        mcpLog('search_type', env.name, `Error: ${e.message}`, '', true, runId);
        return error(`Failed to load type index: ${e.message}`);
      }

      const matches = fuzzySearch(query, types, { topN: 20 });
      if (!matches.length) {
        mcpLog('search_type', env.name, `No types for "${query}"`, '', false, runId);
        return text(`No types found matching "${query}".`);
      }

      mcpLog('search_type', env.name, `${matches.length} type(s) for "${query}"`, matches.join('\n'), false, runId);
      return text(`Types matching "${query}":\n${matches.join('\n')}`);
    }
  );
}
