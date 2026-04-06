import { z } from 'zod';
import { groovyExecute } from '../hac.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'run_cronjob';

const SCRIPT = (cronJobPk) => `
import de.hybris.platform.core.PK

def cronJobService = spring.getBean('cronJobService')
def modelService = spring.getBean('modelService')

def cronJob = modelService.get(PK.fromLong(${cronJobPk}L))
cronJobService.performCronJob(cronJob, true)

modelService.refresh(cronJob)
def status = cronJob.status?.code
def result = cronJob.result?.code
def startTime = cronJob.startTime
def endTime = cronJob.endTime
"status=\${status}, result=\${result}, startTime=\${startTime}, endTime=\${endTime}"
`.trim();

export const tool = {
  name: TOOL,
  description: 'Run a SAP Commerce CronJob synchronously by its PK and wait for it to finish. Returns the final status and result.',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    cronJobPk: z.string().describe('PK of the CronJob to run'),
  },
  handler: async ({ environmentId, cronJobPk }) => {
    const env = await getEnvironment(environmentId);
    if (!env) {
      mcpLog({ tool: TOOL, envName: environmentId, preview: 'Unknown environment', isError: true });
      return error(`Environment "${environmentId}" not found.`);
    }
    if (!env.allowGroovyExecution) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Groovy disabled', isError: true });
      return error(`Groovy execution is disabled for environment "${env.name}".`);
    }
    if (env.allowGroovyCommitMode === false) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Groovy commit mode disabled', isError: true });
      return error(`Groovy commit mode is disabled for environment "${env.name}".`);
    }

    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview: `Running CronJob PK ${cronJobPk}` });

    let result;
    try {
      result = await withSession(env, s => groovyExecute(s, SCRIPT(cronJobPk), { commit: true }));
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, detail: e.stack || '', isError: true, runId });
      return error(e.message);
    }

    const isErr = !!result.stacktraceText;
    const preview = isErr ? `❌ CronJob PK ${cronJobPk}` : `✅ ${result.executionResult}`;
    mcpLog({ tool: TOOL, envName: env.name, preview, detail: result.stacktraceText || '', isError: isErr, runId });

    let out = `**${env.name}** — ${isErr ? '❌ Error' : '✅ CronJob finished'}\n`;
    if (result.executionResult) out += `\n**Result:**\n\`\`\`\n${result.executionResult}\n\`\`\``;
    if (result.outputText) out += `\n**Output:**\n\`\`\`\n${result.outputText}\n\`\`\``;
    if (result.stacktraceText) out += `\n**Stacktrace:**\n\`\`\`\n${result.stacktraceText}\n\`\`\``;
    return isErr ? { content: [{ type: 'text', text: out }], isError: true } : text(out);
  },
};
