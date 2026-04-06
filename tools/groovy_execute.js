import { z } from 'zod';
import { groovyExecute } from '../hac.js';
import { optionalLooseBool } from './zodLoose.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'groovy_execute';

export const tool = {
  name: TOOL,
  description: 'Execute a Groovy script on a HAC environment. Call list_environments first to check groovy execution is allowed. IMPORTANT: Before calling this tool, you MUST show the user the script and a clear explanation of what data it will modify or delete and explicitly ask for their confirmation. Only proceed after the user approves.',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    script: z.string().describe('Groovy script content'),
    commit: optionalLooseBool().describe('Whether to commit the transaction (default: false)'),
  },
  handler: async ({ environmentId, script, commit }) => {
    const env = await getEnvironment(environmentId);
    if (!env) {
      mcpLog({ tool: TOOL, envName: environmentId, preview: 'Unknown environment', isError: true });
      return error(`Environment "${environmentId}" not found.`);
    }
    if (!env.allowGroovyExecution) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Groovy disabled', isError: true });
      return error(`Groovy execution is disabled for environment "${env.name}".`);
    }
    if (commit && env.allowGroovyCommitMode === false) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Groovy commit mode disabled', isError: true });
      return error(`Groovy commit mode is disabled for environment "${env.name}".`);
    }

    const scriptPreview = script.split('\n')[0].slice(0, 60);
    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview: `${scriptPreview}…` });

    let result;
    try {
      result = await withSession(env, s => groovyExecute(s, script, { commit }));
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, detail: e.stack || '', isError: true, runId });
      return error(e.message);
    }

    const isErr = !!result.stacktraceText;
    let out = `**${env.name}** — ${isErr ? '❌ Error' : '✅ Success'}\n`;
    if (result.executionResult != null) out += `\n**Result:**\n\`\`\`\n${result.executionResult}\n\`\`\``;
    if (result.outputText) out += `\n**Output:**\n\`\`\`\n${result.outputText}\n\`\`\``;
    if (result.stacktraceText) out += `\n**Stacktrace:**\n\`\`\`\n${result.stacktraceText}\n\`\`\``;

    mcpLog({ tool: TOOL, envName: env.name,
      preview: `${isErr ? '❌' : '✅'} ${scriptPreview}…`,
      detail: `Script:\n${script}\n\nResult: ${result.executionResult}\n\n${result.stacktraceText || ''}`,
      isError: isErr, runId,
    });
    return text(out);
  },
};
