import { z } from 'zod';
import { groovyExecute } from '../hac.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';

export function register(mcp) {
  mcp.registerTool(
    'groovy_execute',
    {
      description: 'Execute a Groovy script on a HAC environment. Call list_environments first to check groovy execution is allowed. IMPORTANT: Before calling this tool, you MUST show the user the script and a clear explanation of what data it will modify or delete and explicitly ask for their confirmation. Only proceed after the user approves.',
      inputSchema: {
        environmentId: z.string().describe('Environment ID from list_environments'),
        script: z.string().describe('Groovy script content'),
        commit: z.boolean().optional().describe('Whether to commit the transaction (default: false)'),
      },
    },
    async ({ environmentId, script, commit }) => {
      const env = await getEnvironment(environmentId);
      if (!env) {
        mcpLog('groovy_execute', environmentId, 'Unknown environment', '', true);
        return error(`Environment "${environmentId}" not found.`);
      }
      if (!env.allowGroovyExecution) {
        mcpLog('groovy_execute', env.name, 'Groovy disabled', '', true);
        return error(`Groovy execution is disabled for environment "${env.name}".`);
      }

      const scriptPreview = script.split('\n')[0].slice(0, 60);
      const runId = mcpLogStart('groovy_execute', env.name, `${scriptPreview}…`);

      let result;
      try {
        result = await withSession(env, s => groovyExecute(s, script, { commit }));
      } catch (e) {
        mcpLog('groovy_execute', env.name, `Error: ${e.message}`, e.stack || '', true, runId);
        return error(e.message);
      }

      const isErr = !!result.stacktraceText;
      let out = `**${env.name}** — ${isErr ? '❌ Error' : '✅ Success'}\n`;
      if (result.executionResult != null) out += `\n**Result:**\n\`\`\`\n${result.executionResult}\n\`\`\``;
      if (result.outputText) out += `\n**Output:**\n\`\`\`\n${result.outputText}\n\`\`\``;
      if (result.stacktraceText) out += `\n**Stacktrace:**\n\`\`\`\n${result.stacktraceText}\n\`\`\``;

      mcpLog('groovy_execute', env.name,
        `${isErr ? '❌' : '✅'} ${scriptPreview}…`,
        `Script:\n${script}\n\nResult: ${result.executionResult}\n\n${result.stacktraceText || ''}`,
        isErr, runId
      );
      return text(out);
    }
  );
}
