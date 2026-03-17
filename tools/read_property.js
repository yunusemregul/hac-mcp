import { z } from 'zod';
import { readProperties } from '../hac.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';

export function register(mcp) {
  mcp.registerTool(
    'read_property',
    {
      description: 'Search HAC configuration properties by key or value. Returns matching key-value pairs from the platform configuration page.',
      inputSchema: {
        environmentId: z.string().describe('Environment ID from list_environments'),
        search: z.string().describe('Search term — matches against property keys and values (case-insensitive substring)'),
      },
    },
    async ({ environmentId, search }) => {
      const env = await getEnvironment(environmentId);
      if (!env) {
        mcpLog('read_property', environmentId, 'Unknown environment', '', true);
        return error(`Environment "${environmentId}" not found.`);
      }
      if (env.allowReadProperty === false) {
        mcpLog('read_property', env.name, 'Read property disabled', '', true);
        return error(`Read property is disabled for environment "${env.name}".`);
      }

      const runId = mcpLogStart('read_property', env.name, `Searching "${search}"…`);

      let properties;
      try {
        properties = await withSession(env, s => readProperties(s));
      } catch (e) {
        mcpLog('read_property', env.name, `Error: ${e.message}`, '', true, runId);
        return error(e.message);
      }

      const term = search.toLowerCase();
      const matches = Object.entries(properties).filter(
        ([k, v]) => k.toLowerCase().includes(term) || v.toLowerCase().includes(term)
      );

      if (!matches.length) {
        mcpLog('read_property', env.name, `No properties matching "${search}"`, '', false, runId);
        return text(`No properties found matching "${search}".`);
      }

      const lines = matches.map(([k, v]) => `${k} = ${v}`).join('\n');
      const out = `**${env.name}** — ${matches.length} property match(es) for "${search}":\n\n\`\`\`\n${lines}\n\`\`\``;
      mcpLog('read_property', env.name, `${matches.length} match(es) for "${search}"`, out, false, runId);
      return text(out);
    }
  );
}
