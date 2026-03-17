import { listEnvironments, mcpLogStart, mcpLog, text } from './context.js';

const TOOL = 'list_environments';

export const tool = {
  name: TOOL,
  description: 'List all configured HAC environments with their names, descriptions, and allowed operations.',
  handler: async () => {
    const runId = mcpLogStart({ tool: TOOL, envName: '', preview: 'Listing environments…' });
    const envs = await listEnvironments();
    if (!envs.length) {
      mcpLog({ tool: TOOL, envName: '', preview: 'No environments configured', detail: 'No environments found.', runId });
      return text('No environments configured. Add one via the management UI.');
    }
    const lines = envs.map(e =>
      `- **${e.name}** (id: \`${e.id}\`)\n` +
      `  ${e.description || 'No description'}\n` +
      `  DB: ${e.dbType || 'unknown'}  FlexSearch: ${e.allowFlexSearch ? '✅' : '❌'}  ImpEx Import: ${e.allowImpexImport ? '✅' : '❌'}  Groovy: ${e.allowGroovyExecution ? '✅' : '❌'}  Read Property: ${e.allowReadProperty !== false ? '✅' : '❌'}`
    );
    const out = `## HAC Environments\n\n${lines.join('\n\n')}`;
    mcpLog({ tool: TOOL, envName: '', preview: `${envs.length} environment(s)`, detail: out, runId });
    return text(out);
  },
};
