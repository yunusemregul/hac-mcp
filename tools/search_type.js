import { z } from 'zod';
import { getEnvironment, getTypeIndex, fuzzySearch, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'search_type';

export const tool = {
  name: TOOL,
  description: 'Search for SAP Commerce type names by fuzzy match. Use this before get_type_info when you are unsure of the exact type code.',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    query: z.string().describe('Type name to search for — fuzzy, e.g. "InboundProductLogs", "Solr", "Order"'),
  },
  handler: async ({ environmentId, query }) => {
    const env = await getEnvironment(environmentId);
    if (!env) {
      mcpLog({ tool: TOOL, envName: environmentId, preview: 'Unknown environment', isError: true });
      return error(`Environment "${environmentId}" not found.`);
    }

    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview: `Searching "${query}"…` });

    let types;
    try {
      types = await getTypeIndex(env);
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, isError: true, runId });
      return error(`Failed to load type index: ${e.message}`);
    }

    const matches = fuzzySearch(query, types, { topN: 20 });
    if (!matches.length) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `No types for "${query}"`, runId });
      return text(`No types found matching "${query}".`);
    }

    mcpLog({ tool: TOOL, envName: env.name, preview: `${matches.length} type(s) for "${query}"`, detail: matches.join('\n'), runId });
    return text(`Types matching "${query}":\n${matches.join('\n')}`);
  },
};
