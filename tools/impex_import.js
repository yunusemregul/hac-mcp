import { z } from 'zod';
import { flexibleSearch, impexImport } from '../hac.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';
import { fetchScalarFields } from './flexible_search.js';

function parseImpexHeaders(script) {
  const result = [];
  for (const line of script.split('\n')) {
    const m = line.trim().match(/^(INSERT_UPDATE|INSERT|UPDATE|REMOVE)\s+(\w+)/);
    if (!m) continue;
    const typeCode = m[2];
    const rest = line.trim().slice(m[0].length);
    const semiIdx = rest.indexOf(';');
    if (semiIdx === -1) continue;
    const cols = rest.slice(semiIdx + 1).split(';')
      .map(c => c.trim().match(/^(\w+)/)?.[1]).filter(Boolean);
    result.push({ typeCode, cols });
  }
  return result;
}

async function validateImpexScript(env, script) {
  const headers = parseImpexHeaders(script);
  if (!headers.length) return [];
  const uniqueTypes = [...new Set(headers.map(h => h.typeCode))];

  const typeChains = {};
  try {
    const conds = uniqueTypes.map(t => `{code} = '${t}'`).join(' OR ');
    const r = await withSession(env, s => flexibleSearch(s,
      `SELECT {pk}, {code}, {inheritancepathstring} FROM {ComposedType} WHERE ${conds}`
    ));
    if (r.resultList) {
      for (const [pk, code, inheritancePath] of r.resultList) {
        typeChains[code] = inheritancePath ? inheritancePath.split(',').filter(Boolean) : [String(pk)];
      }
    }
  } catch (_) { return []; }

  const allPKs = [...new Set(Object.values(typeChains).flat())];
  if (!allPKs.length) return [];

  const mandatoryByTypePK = {};
  const batchSize = 20;
  for (let i = 0; i < allPKs.length; i += batchSize) {
    const batch = allPKs.slice(i, i + batchSize);
    try {
      const encConds = batch.map(p => `{enclosingtype} = '${p}'`).join(' OR ');
      const r = await withSession(env, s => flexibleSearch(s,
        `SELECT {qualifier}, {enclosingtype} FROM {AttributeDescriptor} WHERE (${encConds}) AND {optional} = 0`,
        { maxCount: 500 }
      ));
      if (r.resultList) {
        for (const [qualifier, encPK] of r.resultList) {
          const key = String(encPK);
          if (!mandatoryByTypePK[key]) mandatoryByTypePK[key] = new Set();
          mandatoryByTypePK[key].add(qualifier);
        }
      }
    } catch (_) {}
  }

  const warnings = [];
  for (const { typeCode, cols } of headers) {
    const chain = typeChains[typeCode];
    if (!chain) continue;
    const allMandatory = [...new Set(chain.flatMap(pk => [...(mandatoryByTypePK[pk] || [])]))];
    const missing = allMandatory.filter(f => !cols.includes(f));
    if (missing.length) warnings.push(`**${typeCode}**: missing mandatory field(s): ${missing.join(', ')}`);
  }
  return warnings;
}

function formatImpexDetails(details) {
  if (!details) return null;
  return details.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    const semiIdx = trimmed.indexOf(';');
    if (semiIdx !== -1 && (trimmed.startsWith(',') || trimmed.length > 200)) {
      const errorPart = trimmed.slice(0, semiIdx).replace(/^,+/, '').trim();
      const dataCols = trimmed.slice(semiIdx + 1).split(';');
      if (errorPart) {
        return `ERROR: ${errorPart}\n  (row data: ${dataCols.length} column(s) omitted)`;
      }
    }
    if (trimmed.length > 300) return trimmed.slice(0, 300) + `… [truncated]`;
    return line;
  }).join('\n');
}

export function register(mcp) {
  mcp.registerTool(
    'impex_import',
    {
      description: 'Execute an ImpEx import script on a HAC environment. Call list_environments first to check import is allowed. IMPORTANT: Before calling this tool, you MUST show the user a summary of what data the script will insert, update, or remove and explicitly ask for their confirmation. Only proceed after the user approves.',
      inputSchema: {
        environmentId: z.string().describe('Environment ID from list_environments'),
        script: z.string().describe('ImpEx script content'),
        validationEnum: z.enum(['IMPORT_STRICT', 'IMPORT_RELAXED']).optional(),
        maxThreads: z.number().optional(),
        legacyMode: z.boolean().optional(),
        enableCodeExecution: z.boolean().optional(),
        distributedMode: z.boolean().optional(),
        sldEnabled: z.boolean().optional(),
      },
    },
    async ({ environmentId, script, validationEnum, maxThreads, legacyMode, enableCodeExecution, distributedMode, sldEnabled }) => {
      const env = await getEnvironment(environmentId);
      if (!env) {
        mcpLog('impex_import', environmentId, 'Unknown environment', '', true);
        return error(`Environment "${environmentId}" not found.`);
      }
      if (!env.allowImpexImport) {
        mcpLog('impex_import', env.name, 'ImpEx disabled', '', true);
        return error(`ImpEx import is disabled for environment "${env.name}".`);
      }

      const scriptPreview = script.split('\n')[0].slice(0, 60);
      const runId = mcpLogStart('impex_import', env.name, `${scriptPreview}…`);

      let validationWarnings = [];
      try {
        validationWarnings = await validateImpexScript(env, script);
      } catch (_) {}

      if (validationWarnings.length) {
        const warnOut = `**Pre-validation warnings** (import not executed):\n${validationWarnings.map(w => `- ${w}`).join('\n')}\n\nFix the script and retry.`;
        mcpLog('impex_import', env.name, `Pre-validation failed`, warnOut, true, runId);
        return error(warnOut);
      }

      let result;
      try {
        result = await withSession(env, s => impexImport(s, script, {
          validationEnum, maxThreads, legacyMode, enableCodeExecution, distributedMode, sldEnabled,
        }));
      } catch (e) {
        mcpLog('impex_import', env.name, `Error: ${e.message}`, e.stack || '', true, runId);
        return error(e.message);
      }

      const isErr = result.level === 'error';
      const icon = isErr ? '❌' : '✅';
      let out = `**${env.name}** — ${icon} ${result.result || 'Import complete'}\n`;
      if (result.details) out += `\n\`\`\`\n${formatImpexDetails(result.details)}\n\`\`\``;

      if (isErr && result.details) {
        const unknownAttrTypes = [...new Set(
          [...result.details.matchAll(/unknown attributes \[(\w+)\.\w+\]/g)].map(m => m[1])
        )];
        if (unknownAttrTypes.length) {
          const hints = [];
          for (const typeName of unknownAttrTypes) {
            const fields = await fetchScalarFields(env, typeName);
            if (fields) hints.push(`**${typeName}** valid scalar fields:\n  ${fields}`);
          }
          if (hints.length) out += `\n\n**Field hints** (use get_type_info for relation fields):\n${hints.join('\n\n')}`;
        }
      }

      mcpLog('impex_import', env.name,
        `${isErr ? '❌' : '✅'} ${result.result || 'Done'} — ${scriptPreview}…`,
        `Script:\n${script}\n\nResult: ${result.result}\n\n${result.details || ''}`,
        isErr, runId
      );
      return text(out);
    }
  );
}
