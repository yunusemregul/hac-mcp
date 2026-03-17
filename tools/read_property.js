import { z } from 'zod';
import { readProperties } from '../hac.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'read_property';

export const tool = {
  name: TOOL,
  description: 'Search HAC configuration properties by key or value. Returns matching key-value pairs from the platform configuration page.',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    search: z.string().describe('Search term — matches against property keys and values (case-insensitive substring)'),
  },
  handler: async ({ environmentId, search }) => {
    const env = await getEnvironment(environmentId);
    if (!env) {
      mcpLog({ tool: TOOL, envName: environmentId, preview: 'Unknown environment', isError: true });
      return error(`Environment "${environmentId}" not found.`);
    }
    if (env.allowReadProperty === false) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Read property disabled', isError: true });
      return error(`Read property is disabled for environment "${env.name}".`);
    }

    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview: `Searching "${search}"…` });

    let properties;
    try {
      properties = await withSession(env, s => readProperties(s));
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, isError: true, runId });
      return error(e.message);
    }

    const term = search.toLowerCase();
    const matches = Object.entries(properties).filter(
      ([k, v]) => k.toLowerCase().includes(term) || v.toLowerCase().includes(term)
    );

    if (!matches.length) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `No properties matching "${search}"`, runId });
      return text(`No properties found matching "${search}".`);
    }

    const lines = matches.map(([k, v]) => `${k} = ${v}`).join('\n');
    const out = `**${env.name}** — ${matches.length} property match(es) for "${search}":\n\n\`\`\`\n${lines}\n\`\`\``;
    mcpLog({ tool: TOOL, envName: env.name, preview: `${matches.length} match(es) for "${search}"`, detail: out, runId });
    return text(out);
  },
};
