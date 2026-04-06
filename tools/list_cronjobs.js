import { z } from 'zod';
import { flexibleSearch } from '../hac.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'list_cronjobs';

export const tool = {
  name: TOOL,
  description: 'List CronJobs on a SAP Commerce environment. Optionally filter by code (partial match). Returns pk, code, type, status, result, and last start/end times.',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    code: z.string().optional().describe('Filter by code (case-insensitive partial match)'),
  },
  handler: async ({ environmentId, code }) => {
    const env = await getEnvironment(environmentId);
    if (!env) {
      mcpLog({ tool: TOOL, envName: environmentId, preview: 'Unknown environment', isError: true });
      return error(`Environment "${environmentId}" not found.`);
    }
    if (!env.allowFlexSearch) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'FlexSearch disabled', isError: true });
      return error(`FlexibleSearch is disabled for environment "${env.name}".`);
    }

    const where = code ? ` WHERE {cj:code} LIKE '%${code.replace(/'/g, "''")}%'` : '';
    const query = `SELECT {cj:pk}, {cj:code}, {t:code}, {s:code}, {r:code}, {cj:startTime}, {cj:endTime} FROM {CronJob AS cj LEFT JOIN EnumerationValue AS s ON {cj:status} = {s:pk} LEFT JOIN EnumerationValue AS r ON {cj:result} = {r:pk} LEFT JOIN ComposedType AS t ON {cj:itemtype} = {t:pk}}${where} ORDER BY {cj:code} ASC`;

    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview: code ? `Listing CronJobs matching "${code}"` : 'Listing all CronJobs' });

    let result;
    try {
      result = await withSession(env, s => flexibleSearch(s, query, { maxCount: 500 }));
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, detail: e.stack || '', isError: true, runId });
      return error(e.message);
    }

    if (result.exception) {
      const msg = result.exception.message || JSON.stringify(result.exception);
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Query error', detail: msg, isError: true, runId });
      return error(`Query error: ${msg}`);
    }

    let { resultList, resultCount, executionTime } = result;
    mcpLog({ tool: TOOL, envName: env.name, preview: `✅ ${resultCount} CronJob(s) in ${executionTime}ms`, runId });

    if (code && resultList?.length) {
      const q = code.toLowerCase();
      const score = (row) => {
        const c = (row[1] || '').toLowerCase();
        if (c === q) return 0;
        if (c.startsWith(q)) return 1;
        return 2;
      };
      resultList = [...resultList].sort((a, b) => score(a) - score(b) || a[1].localeCompare(b[1]));
    }

    let out = `**${env.name}** — ${resultCount} CronJob(s) in ${executionTime}ms\n\n`;
    if (resultList?.length) {
      out += 'pk,code,type,status,result,startTime,endTime\n';
      const csvCell = c => {
        if (c === null) return '';
        const s = String(c);
        return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      for (const row of resultList) out += row.map(csvCell).join(',') + '\n';
    } else {
      out += 'No CronJobs found.\n';
    }

    return text(out);
  },
};
