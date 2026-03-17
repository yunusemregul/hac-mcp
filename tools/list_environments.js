import { listEnvironments, mcpLogStart, mcpLog, text } from './context.js';

export function register(mcp) {
  mcp.registerTool(
    'list_environments',
    { description: 'List all configured HAC environments with their names, descriptions, and allowed operations.' },
    async () => {
      const runId = mcpLogStart('list_environments', '', 'Listing environments…');
      const envs = await listEnvironments();
      if (!envs.length) {
        mcpLog('list_environments', '', 'No environments configured', 'No environments found.', false, runId);
        return text('No environments configured. Add one via the management UI.');
      }
      const lines = envs.map(e =>
        `- **${e.name}** (id: \`${e.id}\`)\n` +
        `  ${e.description || 'No description'}\n` +
        `  DB: ${e.dbType || 'unknown'}  FlexSearch: ${e.allowFlexSearch ? '✅' : '❌'}  ImpEx Import: ${e.allowImpexImport ? '✅' : '❌'}  Groovy: ${e.allowGroovyExecution ? '✅' : '❌'}  Read Property: ${e.allowReadProperty !== false ? '✅' : '❌'}`
      );
      const out = `## HAC Environments\n\n${lines.join('\n\n')}`;
      mcpLog('list_environments', '', `${envs.length} environment(s)`, out, false, runId);
      return text(out);
    }
  );
}
