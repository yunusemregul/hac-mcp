import { z } from 'zod';
import { flexibleSearch, pkAnalyze } from '../hac.js';
import { withSession, getEnvironment, isTruthy, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'resolve_pk';

export const tool = {
  name: TOOL,
  description: 'Resolve a SAP Commerce PK to its type code and unique field values. Use this when a FlexibleSearch result contains an opaque PK and you need to know what item it refers to.',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    pk: z.string().describe('The PK value to resolve'),
  },
  handler: async ({ environmentId, pk }) => {
    const env = await getEnvironment(environmentId);
    if (!env) {
      mcpLog({ tool: TOOL, envName: environmentId, preview: 'Unknown environment', isError: true });
      return error(`Environment "${environmentId}" not found.`);
    }
    if (!env.allowFlexSearch) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'FlexSearch disabled', isError: true });
      return error(`FlexibleSearch is disabled for environment "${env.name}".`);
    }

    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview: `Resolving PK ${pk}…` });

    let analysis;
    try {
      analysis = await withSession(env, s => pkAnalyze(s, pk));
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, isError: true, runId });
      return error(`PK analysis failed: ${e.message}`);
    }

    if (analysis.possibleException) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Invalid PK ${pk}`, detail: analysis.possibleException, isError: true, runId });
      return error(`Invalid PK ${pk}: ${analysis.possibleException}`);
    }

    const typeCode = analysis.pkComposedTypeCode;
    let out = `PK ${pk} → **${typeCode}** (typeCode: ${analysis.pkTypeCode})\nCreated: ${analysis.pkCreationDate}\n`;

    if (typeCode && typeCode !== 'Item') {
      let uniqueFields = [];
      try {
        const typePKResult = await withSession(env, s => flexibleSearch(s,
          `SELECT {pk} FROM {ComposedType} WHERE {code} = '${typeCode}'`
        ));
        const typePK = typePKResult.resultList?.[0]?.[0];
        if (typePK) {
          const attrResult = await withSession(env, s => flexibleSearch(s,
            `SELECT {qualifier}, {unique} FROM {AttributeDescriptor} WHERE {enclosingtype} = '${typePK}'`,
            { maxCount: 200 }
          ));
          uniqueFields = (attrResult.resultList || [])
            .filter(([, isUnique]) => isTruthy(isUnique))
            .map(([q]) => q);
        }
      } catch (_) {}

      const fieldsToFetch = uniqueFields.length ? uniqueFields : ['pk'];
      try {
        const selectFields = fieldsToFetch.map(f => `{${f}}`).join(', ');
        const itemResult = await withSession(env, s => flexibleSearch(s,
          `SELECT ${selectFields} FROM {${typeCode}} WHERE {pk} = '${pk}'`
        ));
        if (itemResult.resultList?.[0]) {
          out += '\nUnique fields:\n';
          for (const [i, f] of fieldsToFetch.entries()) {
            out += `  ${f}: ${itemResult.resultList[0][i] ?? 'null'}\n`;
          }
        } else {
          out += '\n(Item not found — may have been deleted)\n';
        }
      } catch (e) {
        out += `\n(Could not fetch item details: ${e.message})\n`;
      }
    }

    mcpLog({ tool: TOOL, envName: env.name, preview: `PK ${pk} → ${typeCode}`, detail: out, runId });
    return text(out);
  },
};
