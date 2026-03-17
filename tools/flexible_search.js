import { z } from 'zod';
import { flexibleSearch } from '../hac.js';
import { withSession, getEnvironment, getTypeIndex, fuzzySearch, mcpLogStart, mcpLog, text, error } from './context.js';

function parseFlexSearchError(msg) {
  if (!msg?.includes('cannot search unknown field')) return null;
  const unknownField = msg.match(/TableField\(name='([^']+)'/)?.[1];
  const typeCode = msg.match(/within type (\w+)/)?.[1];
  const parseSection = str => str ? [...str.matchAll(/^\s{6}(\w+)\s*=/gm)].map(m => m[1]) : [];
  const core = parseSection(msg.match(/core fields\s*=\s*\n([\s\S]*?)(?=\n\s{3}\w+ fields)/)?.[1]);
  const unlocalized = parseSection(msg.match(/unlocalized fields\s*=\s*\n([\s\S]*?)(?=\n\s{3}\w+ fields)/)?.[1]);
  const localized = parseSection(msg.match(/localized fields\s*=\s*\n([\s\S]*?)(?=\n\))/)?.[1]);
  const allFields = [...core, ...unlocalized, ...localized];
  if (!typeCode || !allFields.length) return null;
  return { unknownField, typeCode, allFields };
}

function parseUnknownTypeError(msg) {
  if (!msg) return null;
  const m = msg.match(/unknown type[:\s]+'?(\w+)'?/i) || msg.match(/[Tt]he type '(\w+)' is unknown/);
  return m?.[1] ?? null;
}

async function fetchScalarFields(env, typeCode) {
  try {
    const typeResult = await withSession(env, s => flexibleSearch(s,
      `SELECT {pk} FROM {ComposedType} WHERE {code} = '${typeCode}'`
    ));
    const typePK = typeResult.resultList?.[0]?.[0];
    if (!typePK) return null;

    const attrResult = await withSession(env, s => flexibleSearch(s,
      `SELECT {qualifier}, {databasecolumn}, {attributetype}, {unique} FROM {AttributeDescriptor} WHERE {enclosingtype} = '${typePK}' ORDER BY {qualifier} ASC`,
      { maxCount: 300 }
    ));
    if (!attrResult.resultList?.length) return null;

    const scalar = attrResult.resultList.filter(([, dbCol]) => dbCol);
    const attrTypePKs = [...new Set(scalar.map(([,, attrTypePK]) => attrTypePK).filter(Boolean))];
    const refTypes = {};
    if (attrTypePKs.length) {
      const conds = attrTypePKs.map(p => `{pk} = '${p}'`).join(' OR ');
      const r = await withSession(env, s => flexibleSearch(s,
        `SELECT {pk}, {code} FROM {ComposedType} WHERE ${conds}`
      ));
      if (r.resultList) for (const [tpk, tcode] of r.resultList) refTypes[String(tpk)] = tcode;
    }

    const isTruthy = v => v === true || v === 'true' || v === 1 || v === '1';
    return scalar.map(([q,, attrTypePK, isUnique]) => {
      const refType = attrTypePK ? refTypes[String(attrTypePK)] : null;
      let s = q;
      if (isTruthy(isUnique)) s += ' [unique]';
      if (refType) s += ` → ${refType}`;
      return s;
    }).join(', ');
  } catch (_) { return null; }
}

export { fetchScalarFields };

export function register(mcp) {
  mcp.registerTool(
    'flexible_search',
    {
      description: 'Execute a FlexibleSearch query on a HAC environment. Call list_environments first to get valid IDs.',
      inputSchema: {
        environmentId: z.string().describe('Environment ID from list_environments'),
        query: z.string().describe('FlexibleSearch query, e.g. SELECT {pk}, {uid} FROM {User}'),
        maxCount: z.number().optional().describe('Max rows to return (default 200)'),
        locale: z.string().optional().describe('Locale (default en)'),
        dataSource: z.string().optional().describe('Data source (default master)'),
      },
    },
    async ({ environmentId, query, maxCount, locale, dataSource }) => {
      const env = await getEnvironment(environmentId);
      if (!env) {
        mcpLog('flexible_search', environmentId, 'Unknown environment', '', true);
        return error(`Environment "${environmentId}" not found.`);
      }
      if (!env.allowFlexSearch) {
        mcpLog('flexible_search', env.name, 'FlexSearch disabled', '', true);
        return error(`FlexibleSearch is disabled for environment "${env.name}".`);
      }

      const runId = mcpLogStart('flexible_search', env.name, `${query.slice(0, 60)}${query.length > 60 ? '…' : ''}`);

      let result;
      try {
        result = await withSession(env, s => flexibleSearch(s, query, { maxCount, locale, dataSource }));
      } catch (e) {
        mcpLog('flexible_search', env.name, `Error: ${e.message}`, e.stack || '', true, runId);
        return error(e.message);
      }

      if (result.exception) {
        const ex = result.exception;
        const msg = ex.message || ex.localizedMessage || JSON.stringify(ex);
        const causeMsg = ex.cause?.message;
        const rawDetail = causeMsg && causeMsg !== msg ? `${msg}\nCaused by: ${causeMsg}` : msg;

        const parsed = parseFlexSearchError(causeMsg) || parseFlexSearchError(msg);
        if (parsed) {
          const { unknownField, typeCode: parsedTypeCode } = parsed;
          let detail = `Unknown field "{${unknownField}}" on type ${parsedTypeCode}.`;
          const scalarFields = await fetchScalarFields(env, parsedTypeCode);
          if (scalarFields) {
            detail += `\n\nValid scalar fields for ${parsedTypeCode}:\n  ${scalarFields}\n\nFor relation/collection fields use get_type_info.`;
          } else {
            detail += `\n\nTip: use get_type_info with typeCode "${parsedTypeCode}" to see valid fields.`;
          }
          mcpLog('flexible_search', env.name, `Query error`, detail, true, runId);
          return error(`Query error: ${detail}`);
        }

        const unknownType = parseUnknownTypeError(causeMsg) || parseUnknownTypeError(msg);
        if (unknownType) {
          let detail = `Unknown type "${unknownType}".`;
          try {
            const types = await getTypeIndex(env);
            const suggestions = fuzzySearch(unknownType, types, { topN: 5 });
            if (suggestions.length) detail += ` Did you mean: ${suggestions.join(', ')}?`;
          } catch (_) {}
          mcpLog('flexible_search', env.name, `Query error`, detail, true, runId);
          return error(`Query error: ${detail}`);
        }

        mcpLog('flexible_search', env.name, `Query error`, rawDetail, true, runId);
        return error(`Query error: ${rawDetail}`);
      }

      const { headers, resultList, resultCount, executionTime } = result;
      let out = `**${env.name}** — ${resultCount} row(s) in ${executionTime}ms\n\n`;

      if (resultList?.length) {
        const csvCell = c => {
          if (c === null) return '';
          const s = String(c);
          return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        out += (headers || []).map(csvCell).join(',') + '\n';
        for (const row of resultList) out += row.map(csvCell).join(',') + '\n';
      } else {
        out += 'No results.\n';
      }

      mcpLog('flexible_search', env.name,
        `${resultCount} row(s) in ${executionTime}ms — ${query.slice(0, 60)}${query.length > 60 ? '…' : ''}`,
        `Query: ${query}\n\nResult:\n${out}`, false, runId
      );
      return text(out);
    }
  );
}
