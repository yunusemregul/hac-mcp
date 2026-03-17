import express from 'express';
import { createServer } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { login, flexibleSearch, impexImport, groovyExecute, pkAnalyze, SessionExpiredError, setHacLogger } from './hac.js';
import { listEnvironments, getEnvironment, createEnvironment, updateEnvironment, deleteEnvironment } from './storage.js';
import { getIndex, invalidateIndex, fuzzySearch } from './type-index.js';

const PORT = process.env.PORT || 3333;

// ─── HAC session manager ──────────────────────────────────────────────────────
// One session per environment. A pending login promise acts as a mutex so
// concurrent MCP requests never trigger multiple simultaneous logins.
const sessions  = new Map(); // envId → session
const loginLock = new Map(); // envId → Promise<session>  (in-flight login)

async function getSession(env) {
  // Already have a live session
  if (sessions.has(env.id)) return sessions.get(env.id);
  // Login already in progress — wait for it instead of starting another
  if (loginLock.has(env.id)) return loginLock.get(env.id);
  // Start a new login and register the promise so concurrent callers wait on it
  const promise = login(env.url, env.username, env.password, env.name)
    .then(session => { sessions.set(env.id, session); return session; })
    .finally(() => loginLock.delete(env.id));
  loginLock.set(env.id, promise);
  return promise;
}

function invalidateSession(envId) {
  sessions.delete(envId);
  invalidateIndex(envId);
}

// Execute fn(session). If the session has expired, invalidate, re-login once, retry.
async function withSession(env, fn) {
  const session = await getSession(env);
  try {
    return await fn(session);
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      console.error(`[MCP] Session expired for "${env.name}", re-logging in…`);
      invalidateSession(env.id);
      const fresh = await getSession(env);
      return fn(fresh); // retry once — if it fails again, propagate
    }
    throw e;
  }
}

// ─── HAC request log → SSE broadcast ─────────────────────────────────────────
const hacLogClients = new Set();
const hacLogBuffer = [];
setHacLogger(entry => {
  hacLogBuffer.push(entry);
  if (hacLogBuffer.length > 50) hacLogBuffer.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of hacLogClients) res.write(data);
});

// ─── MCP activity log → SSE broadcast ────────────────────────────────────────
const logClients = new Set();
const mcpLogBuffer = [];

function broadcastLog(entry) {
  mcpLogBuffer.push(entry);
  if (mcpLogBuffer.length > 50) mcpLogBuffer.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logClients) res.write(data);
}

function mcpLogStart(tool, envName, preview) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  broadcastLog({ id, tool, envName, preview, status: 'running', ts: Date.now() });
  return id;
}

function mcpLog(tool, envName, preview, detail, isError = false, runId = null) {
  broadcastLog({ id: runId, tool, envName, preview, detail, isError, status: 'done', ts: Date.now() });
  console.error(`[MCP] ${tool}${envName ? ' / ' + envName : ''} — ${preview}`);
}

// ─── Type index helpers ───────────────────────────────────────────────────────
async function getTypeIndex(env) {
  return getIndex(env.id, (query, opts) => withSession(env, s => flexibleSearch(s, query, opts)));
}

// ─── FlexibleSearch error parser ──────────────────────────────────────────────
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
  // "unknown type 'Foo'" or "The type 'Foo' is unknown"
  const m = msg.match(/unknown type[:\s]+'?(\w+)'?/i) || msg.match(/[Tt]he type '(\w+)' is unknown/);
  return m?.[1] ?? null;
}

// ─── Auto-resolve scalar fields for inline error enrichment ──────────────────
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

// ─── ImpEx helpers ────────────────────────────────────────────────────────────
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

  // Get type PKs + full inheritance paths so we check parent mandatory fields too
  const typeChains = {}; // typeCode → [pk, ...ancestorPKs]
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

  // Fetch mandatory (optional = 0) attributes for all PKs in the inheritance chains
  // Using integer 0 — SAP Commerce stores booleans as 0/1 in the DB
  const mandatoryByTypePK = {}; // typePK → Set<qualifier>
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
    // HAC error lines mixing error message + row data look like:
    //   ,,,,error message here;data col1;data col2;...
    // Split on first semicolon when line starts with commas or is clearly error+data
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

// ─── MCP server factory ───────────────────────────────────────────────────────
function createMcpInstance() {
  const mcp = new McpServer({ name: 'hac-mcp', version: '1.0.0' }, { timeout: 30000 });

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
        `  DB: ${e.dbType || 'unknown'}  FlexSearch: ${e.allowFlexSearch ? '✅' : '❌'}  ImpEx Import: ${e.allowImpexImport ? '✅' : '❌'}  Groovy: ${e.allowGroovyExecution ? '✅' : '❌'}`
      );
      const out = `## HAC Environments\n\n${lines.join('\n\n')}`;
      mcpLog('list_environments', '', `${envs.length} environment(s)`, out, false, runId);
      return text(out);
    }
  );

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

  mcp.registerTool(
    'search_type',
    {
      description: 'Search for SAP Commerce type names by fuzzy match. Use this before get_type_info when you are unsure of the exact type code.',
      inputSchema: {
        environmentId: z.string().describe('Environment ID from list_environments'),
        query: z.string().describe('Type name to search for — fuzzy, e.g. "InboundProductLogs", "Solr", "Order"'),
      },
    },
    async ({ environmentId, query }) => {
      const env = await getEnvironment(environmentId);
      if (!env) return error(`Environment "${environmentId}" not found.`);

      const runId = mcpLogStart('search_type', env.name, `Searching "${query}"…`);

      let types;
      try {
        types = await getTypeIndex(env);
      } catch (e) {
        mcpLog('search_type', env.name, `Error: ${e.message}`, '', true, runId);
        return error(`Failed to load type index: ${e.message}`);
      }

      const matches = fuzzySearch(query, types, { topN: 20 });
      if (!matches.length) {
        mcpLog('search_type', env.name, `No types for "${query}"`, '', false, runId);
        return text(`No types found matching "${query}".`);
      }

      mcpLog('search_type', env.name, `${matches.length} type(s) for "${query}"`, matches.join('\n'), false, runId);
      return text(`Types matching "${query}":\n${matches.join('\n')}`);
    }
  );

  mcp.registerTool(
    'get_type_info',
    {
      description: 'Get metadata and queryable fields for a SAP Commerce type. Use this when a FlexibleSearch query fails with unknown field errors to discover the correct field qualifiers.',
      inputSchema: {
        environmentId: z.string().describe('Environment ID from list_environments'),
        typeCode: z.string().describe('Type code to look up, e.g. SolrFacetSearchConfig, Order, Product'),
        includeInherited: z.boolean().optional().describe('Also include attributes inherited from supertypes (default false)'),
      },
    },
    async ({ environmentId, typeCode, includeInherited }) => {
      const env = await getEnvironment(environmentId);
      if (!env) return error(`Environment "${environmentId}" not found.`);

      const runId = mcpLogStart('get_type_info', env.name, `Type info: ${typeCode}`);

      // 1. Find the ComposedType
      let typeResult;
      try {
        typeResult = await withSession(env, s => flexibleSearch(s,
          `SELECT {pk}, {code}, {supertype}, {jaloclass}, {inheritancepathstring}, {extensionname}, {catalogitemtype}, {singleton} FROM {ComposedType} WHERE {code} = '${typeCode}'`
        ));
      } catch (e) {
        mcpLog('get_type_info', env.name, `Error: ${e.message}`, '', true, runId);
        return error(e.message);
      }

      if (typeResult.exception) {
        const ex = typeResult.exception;
        const msg = ex.message || ex.localizedMessage || JSON.stringify(ex);
        mcpLog('get_type_info', env.name, `Query error`, msg, true, runId);
        return error(msg);
      }

      if (!typeResult.resultList?.length) {
        mcpLog('get_type_info', env.name, `Type not found: ${typeCode}`, '', true, runId);
        return error(`Type "${typeCode}" not found. Check the type code (case-sensitive).`);
      }

      const [pk, code, supertypePK, , inheritancePath] = typeResult.resultList[0];

      // 2. Collect type PKs to query attributes for
      const typePKs = includeInherited
        ? inheritancePath.split(',').filter(Boolean)
        : [String(pk)];

      // 3. Get ancestor codes for labelling (only needed when includeInherited)
      let ancestorNames = {};
      if (includeInherited && typePKs.length > 1) {
        try {
          const ancestorPKConditions = typePKs.map(p => `{pk} = '${p}'`).join(' OR ');
          const ancestorResult = await withSession(env, s => flexibleSearch(s,
            `SELECT {pk}, {code} FROM {ComposedType} WHERE ${ancestorPKConditions}`
          ));
          if (ancestorResult.resultList) {
            for (const [apk, acode] of ancestorResult.resultList) ancestorNames[String(apk)] = acode;
          }
        } catch (_) { /* best effort */ }
      }
      ancestorNames[String(pk)] = code;

      // 4. Get all attributes — query each type PK separately (FlexibleSearch doesn't support multi-value IN)
      const allAttrs = [];
      for (const typePK of typePKs) {
        try {
          const attrResult = await withSession(env, s => flexibleSearch(s,
            `SELECT {qualifier}, {databasecolumn}, {enclosingtype}, {attributetype}, {unique} FROM {AttributeDescriptor} WHERE {enclosingtype} = '${typePK}' ORDER BY {qualifier} ASC`,
            { maxCount: 300 }
          ));
          if (attrResult.resultList) {
            for (const row of attrResult.resultList) allAttrs.push(row);
          }
        } catch (_) { /* skip */ }
      }

      // 5. Resolve supertype name
      let supertypeName = null;
      if (supertypePK) {
        try {
          const stResult = await withSession(env, s => flexibleSearch(s,
            `SELECT {code} FROM {ComposedType} WHERE {pk} = '${supertypePK}'`
          ));
          supertypeName = stResult.resultList?.[0]?.[0] || null;
        } catch (_) { /* best effort */ }
      }

      // 6. Split attributes into scalar vs relation
      // allAttrs row: [qualifier, databasecolumn, enclosingtype, attributetype]
      const scalar = allAttrs.filter(([, dbCol]) => dbCol);
      const relations = allAttrs.filter(([, dbCol]) => !dbCol);

      // 7. Resolve element types for relation fields via CollectionType
      const collTypePKs = [...new Set(relations.map(([,,,attrTypePK]) => attrTypePK).filter(Boolean))];
      const elementTypeMap = {}; // collTypePK → elementTypePK
      const composedTypeNames = {}; // composedTypePK → code
      const collCodeMap = {}; // collTypePK → collectionType code
      if (collTypePKs.length) {
        try {
          const pkConditions = collTypePKs.map(p => `{pk} = '${p}'`).join(' OR ');
          const collResult = await withSession(env, s => flexibleSearch(s,
            `SELECT {pk}, {elementtype}, {code} FROM {CollectionType} WHERE ${pkConditions}`
          ));
          if (collResult.resultList) {
            for (const [cpk, eltPK, collCode] of collResult.resultList) {
              elementTypeMap[String(cpk)] = eltPK;
              collCodeMap[String(cpk)] = collCode;
            }
          }
          const eltPKs = [...new Set(Object.values(elementTypeMap).filter(Boolean))];
          if (eltPKs.length) {
            const eltConditions = eltPKs.map(p => `{pk} = '${p}'`).join(' OR ');
            const eltResult = await withSession(env, s => flexibleSearch(s,
              `SELECT {pk}, {code} FROM {ComposedType} WHERE ${eltConditions}`
            ));
            if (eltResult.resultList) {
              for (const [epk, ecode] of eltResult.resultList) composedTypeNames[String(epk)] = ecode;
            }
          }
        } catch (_) { /* best effort */ }
      }

      // Build qualifier → { targetType, linkTable } map
      const relationInfo = {};
      for (const [qualifier,, , attrTypePK] of relations) {
        const attrTypePKStr = String(attrTypePK);
        const eltPK = elementTypeMap[attrTypePKStr];
        const collCode = collCodeMap?.[attrTypePKStr];
        const targetType = eltPK ? (composedTypeNames[String(eltPK)] || null) : null;
        const suffix = `${qualifier}Coll`;
        const linkTable = collCode?.endsWith(suffix) ? collCode.slice(0, -suffix.length) : null;
        relationInfo[qualifier] = { targetType, linkTable };
      }

      // 8. Resolve scalar FK reference types via ComposedType
      // allAttrs row: [qualifier, databasecolumn, enclosingtype, attributetype, unique]
      const scalarAttrTypePKs = [...new Set(scalar.map(([,,,attrTypePK]) => attrTypePK).filter(Boolean))];
      const scalarRefTypes = {}; // attrTypePK → typeCode
      if (scalarAttrTypePKs.length) {
        try {
          const conds = scalarAttrTypePKs.map(p => `{pk} = '${p}'`).join(' OR ');
          const r = await withSession(env, s => flexibleSearch(s,
            `SELECT {pk}, {code} FROM {ComposedType} WHERE ${conds}`
          ));
          if (r.resultList) for (const [tpk, tcode] of r.resultList) scalarRefTypes[String(tpk)] = tcode;
        } catch (_) {}
      }

      const isTruthy = v => v === true || v === 'true' || v === 1 || v === '1';

      let out = `Type: ${code}`;
      if (supertypeName) out += ` (extends ${supertypeName})`;
      out += '\n\n';

      out += `Scalar fields — use directly in SELECT / WHERE / ORDER BY:\n`;
      for (const [q, , encPK, attrTypePK, isUnique] of scalar) {
        const inherited = includeInherited && ancestorNames[String(encPK)] && ancestorNames[String(encPK)] !== code
          ? ` (from ${ancestorNames[String(encPK)]})` : '';
        const refType = attrTypePK ? scalarRefTypes[String(attrTypePK)] : null;
        let line = `  ${q}`;
        if (isTruthy(isUnique)) line += ' [unique]';
        if (refType) line += ` → ${refType}`;
        if (inherited) line += inherited;
        out += line + '\n';
      }

      out += '\nRelation/collection fields — require JOIN to query:\n';
      for (const [q,,encPK] of relations) {
        const { targetType, linkTable } = relationInfo[q] || {};
        const inherited = includeInherited && ancestorNames[String(encPK)] && ancestorNames[String(encPK)] !== code ? ` (from ${ancestorNames[String(encPK)]})` : '';
        if (targetType && linkTable) {
          const alias = code.charAt(0).toLowerCase();
          const tAlias = targetType.charAt(0).toLowerCase() + '2';
          out += `  ${q}${inherited}: Collection<${targetType}>\n`;
          out += `    JOIN: {${code} AS ${alias} JOIN ${linkTable} AS lnk ON {lnk:source}={${alias}:pk} JOIN ${targetType} AS ${tAlias} ON {lnk:target}={${tAlias}:pk}}\n`;
        } else if (targetType) {
          out += `  ${q}${inherited}: Collection<${targetType}>\n`;
        } else {
          out += `  ${q}${inherited}\n`;
        }
      }

      mcpLog('get_type_info', env.name, `Type info: ${code} (${allAttrs.length} attrs)`, out, false, runId);
      return text(out);
    }
  );

  mcp.registerTool(
    'resolve_pk',
    {
      description: 'Resolve a SAP Commerce PK to its type code and unique field values. Use this when a FlexibleSearch result contains an opaque PK and you need to know what item it refers to.',
      inputSchema: {
        environmentId: z.string().describe('Environment ID from list_environments'),
        pk: z.string().describe('The PK value to resolve'),
      },
    },
    async ({ environmentId, pk }) => {
      const env = await getEnvironment(environmentId);
      if (!env) return error(`Environment "${environmentId}" not found.`);
      if (!env.allowFlexSearch) return error(`FlexibleSearch is disabled for environment "${env.name}".`);

      const runId = mcpLogStart('resolve_pk', env.name, `Resolving PK ${pk}…`);

      let analysis;
      try {
        analysis = await withSession(env, s => pkAnalyze(s, pk));
      } catch (e) {
        mcpLog('resolve_pk', env.name, `Error: ${e.message}`, '', true, runId);
        return error(`PK analysis failed: ${e.message}`);
      }

      if (analysis.possibleException) {
        return error(`Invalid PK ${pk}: ${analysis.possibleException}`);
      }

      const typeCode = analysis.pkComposedTypeCode;
      let out = `PK ${pk} → **${typeCode}** (typeCode: ${analysis.pkTypeCode})\nCreated: ${analysis.pkCreationDate}\n`;

      if (typeCode && typeCode !== 'Item') {
        // Find unique fields for this type
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
            const isTruthy = v => v === true || v === 'true' || v === 1 || v === '1';
            uniqueFields = (attrResult.resultList || [])
              .filter(([, isUnique]) => isTruthy(isUnique))
              .map(([q]) => q);
          }
        } catch (_) {}

        // Fetch item with unique fields
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

      mcpLog('resolve_pk', env.name, `PK ${pk} → ${typeCode}`, out, false, runId);
      return text(out);
    }
  );

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

      // Pre-validate mandatory fields
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

      // On error, extract "unknown attributes [TypeName.field]" patterns and inline valid fields
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

  return mcp;
}

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function error(msg) { return { content: [{ type: 'text', text: `**Error:** ${msg}` }], isError: true }; }

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/static', express.static('static'));
app.get('/', (_req, res) => res.sendFile('static/index.html', { root: '.' }));

// Environments API
app.get('/api/environments', async (_req, res) => res.json(await listEnvironments()));
app.post('/api/environments', async (req, res) => {
  try { res.json(await createEnvironment(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/environments/:id', async (req, res) => {
  try { res.json(await updateEnvironment(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/environments/:id', async (req, res) => {
  try { await deleteEnvironment(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/environments/:id/refresh-index', async (req, res) => {
  const env = await getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ ok: false, error: 'Environment not found' });
  try {
    const types = await getTypeIndex(env);
    res.json({ ok: true, count: types.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/environments/:id/test', async (req, res) => {
  const env = await getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ ok: false, error: 'Environment not found' });
  try {
    await getSession(env); // reuses existing session if alive, logs in fresh if not
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// HAC request log SSE
app.get('/api/hac-log', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  for (const entry of hacLogBuffer) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  hacLogClients.add(res);
  req.on('close', () => hacLogClients.delete(res));
});

// MCP activity log SSE
app.get('/api/mcp-log', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  for (const entry of mcpLogBuffer) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

// MCP SSE
const mcpSessions = new Map();
app.get('/mcp/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/mcp/messages', res);
  const mcp = createMcpInstance();
  mcpSessions.set(transport.sessionId, { mcp, transport });
  res.on('close', () => { mcpSessions.delete(transport.sessionId); mcp.close(); });
  await mcp.connect(transport);
});
app.post('/mcp/messages', async (req, res) => {
  const session = mcpSessions.get(req.query.sessionId);
  if (session) await session.transport.handlePostMessage(req, res, req.body);
  else res.status(400).send('Unknown session');
});

// ─── Start ────────────────────────────────────────────────────────────────────
createServer(app).listen(PORT, () => {
  console.log(`HAC MCP running at http://localhost:${PORT}`);
  console.log(`MCP SSE endpoint: http://localhost:${PORT}/mcp/sse`);
});
