import express from 'express';
import { createServer } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { login, flexibleSearch, impexImport, SessionExpiredError, setHacLogger } from './hac.js';
import { listEnvironments, getEnvironment, createEnvironment, updateEnvironment, deleteEnvironment } from './storage.js';

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
  const promise = login(env.url, env.username, env.password)
    .then(session => { sessions.set(env.id, session); return session; })
    .finally(() => loginLock.delete(env.id));
  loginLock.set(env.id, promise);
  return promise;
}

function invalidateSession(envId) {
  sessions.delete(envId);
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
setHacLogger(entry => {
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of hacLogClients) res.write(data);
});

// ─── MCP activity log → SSE broadcast ────────────────────────────────────────
const logClients = new Set();

function broadcastLog(entry) {
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logClients) res.write(data);
}

function mcpLog(tool, envName, preview, detail, isError = false) {
  broadcastLog({ tool, envName, preview, detail, isError, ts: Date.now() });
  console.error(`[MCP] ${tool}${envName ? ' / ' + envName : ''} — ${preview}`);
}

// ─── FlexibleSearch error parser ──────────────────────────────────────────────
function parseFlexSearchError(msg) {
  if (!msg?.includes('cannot search unknown field')) return null;
  const unknownField = msg.match(/TableField\(name='([^']+)'/)?.[1];
  const typeName = msg.match(/within type (\w+)/)?.[1];
  const parseSection = str => str ? [...str.matchAll(/^\s{6}(\w+)\s*=/gm)].map(m => m[1]) : [];
  const core = parseSection(msg.match(/core fields\s*=\s*\n([\s\S]*?)(?=\n\s{3}\w+ fields)/)?.[1]);
  const unlocalized = parseSection(msg.match(/unlocalized fields\s*=\s*\n([\s\S]*?)(?=\n\s{3}\w+ fields)/)?.[1]);
  const localized = parseSection(msg.match(/localized fields\s*=\s*\n([\s\S]*?)(?=\n\))/)?.[1]);
  const allFields = [...core, ...unlocalized, ...localized];
  if (!typeName || !allFields.length) return null;
  return { unknownField, typeName, allFields };
}

// ─── MCP server factory ───────────────────────────────────────────────────────
function createMcpInstance() {
  const mcp = new McpServer({ name: 'hac-mcp', version: '1.0.0' });

  mcp.registerTool(
    'list_environments',
    { description: 'List all configured HAC environments with their names, descriptions, and allowed operations.' },
    async () => {
      const envs = await listEnvironments();
      if (!envs.length) {
        mcpLog('list_environments', '', 'No environments configured', 'No environments found.');
        return text('No environments configured. Add one via the management UI.');
      }
      const lines = envs.map(e =>
        `- **${e.name}** (id: \`${e.id}\`)\n` +
        `  ${e.description || 'No description'}\n` +
        `  FlexSearch: ${e.allowFlexSearch ? '✅' : '❌'}  ImpEx Import: ${e.allowImpexImport ? '✅' : '❌'}`
      );
      const out = `## HAC Environments\n\n${lines.join('\n\n')}`;
      mcpLog('list_environments', '', `${envs.length} environment(s)`, out);
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

      let result;
      try {
        result = await withSession(env, s => flexibleSearch(s, query, { maxCount, locale, dataSource }));
      } catch (e) {
        mcpLog('flexible_search', env.name, `Error: ${e.message}`, e.stack || '', true);
        return error(e.message);
      }

      if (result.exception) {
        const ex = result.exception;
        const msg = ex.message || ex.localizedMessage || JSON.stringify(ex);
        const causeMsg = ex.cause?.message;
        const rawDetail = causeMsg && causeMsg !== msg ? `${msg}\nCaused by: ${causeMsg}` : msg;

        const parsed = parseFlexSearchError(causeMsg) || parseFlexSearchError(msg);
        if (parsed) {
          const { unknownField, typeName, allFields } = parsed;
          const detail = `Unknown field "{${unknownField}}" on type ${typeName}. Valid fields are: ${allFields.join(', ')}`;
          mcpLog('flexible_search', env.name, `Query error`, detail, true);
          return error(`Query error: ${detail}`);
        }

        mcpLog('flexible_search', env.name, `Query error`, rawDetail, true);
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
        `Query: ${query}\n\nResult:\n${out}`
      );
      return text(out);
    }
  );

  mcp.registerTool(
    'search_type',
    {
      description: 'Search for SAP Commerce type names by partial match. Use this before get_type_info when you are unsure of the exact type code.',
      inputSchema: {
        environmentId: z.string().describe('Environment ID from list_environments'),
        query: z.string().describe('Partial type name to search for, e.g. "Solr", "Order", "Product"'),
      },
    },
    async ({ environmentId, query }) => {
      const env = await getEnvironment(environmentId);
      if (!env) return error(`Environment "${environmentId}" not found.`);

      let result;
      try {
        result = await withSession(env, s => flexibleSearch(s,
          `SELECT {code} FROM {ComposedType} WHERE {code} LIKE '%${query}%' ORDER BY {code} ASC`,
          { maxCount: 50 }
        ));
      } catch (e) {
        return error(e.message);
      }

      if (result.exception) {
        const ex = result.exception;
        return error(ex.message || ex.localizedMessage || JSON.stringify(ex));
      }

      if (!result.resultList?.length) {
        return text(`No types found matching "${query}".`);
      }

      const types = result.resultList.map(([code]) => code).join('\n');
      mcpLog('search_type', env.name, `${result.resultList.length} type(s) for "${query}"`, types);
      return text(`Types matching "${query}":\n${types}`);
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

      // 1. Find the ComposedType
      let typeResult;
      try {
        typeResult = await withSession(env, s => flexibleSearch(s,
          `SELECT {pk}, {code}, {supertype}, {jaloclass}, {inheritancepathstring}, {extensionname}, {catalogitemtype}, {singleton} FROM {ComposedType} WHERE {code} = '${typeCode}'`
        ));
      } catch (e) {
        return error(e.message);
      }

      if (typeResult.exception) {
        const ex = typeResult.exception;
        return error(ex.message || ex.localizedMessage || JSON.stringify(ex));
      }

      if (!typeResult.resultList?.length) {
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
            `SELECT {qualifier}, {databasecolumn}, {enclosingtype}, {attributetype} FROM {AttributeDescriptor} WHERE {enclosingtype} = '${typePK}' ORDER BY {qualifier} ASC`,
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
        // Derive link table name: collCode ends with "${qualifier}Coll", strip that suffix
        const suffix = `${qualifier}Coll`;
        const linkTable = collCode?.endsWith(suffix) ? collCode.slice(0, -suffix.length) : null;
        relationInfo[qualifier] = { targetType, linkTable };
      }

      let out = `Type: ${code}`;
      if (supertypeName) out += ` (extends ${supertypeName})`;
      out += '\n\n';

      out += `Scalar fields — use directly in SELECT / WHERE / ORDER BY:\n`;
      if (includeInherited) {
        out += scalar.map(([q,,encPK]) => `${q}${ancestorNames[String(encPK)] && ancestorNames[String(encPK)] !== code ? ` (from ${ancestorNames[String(encPK)]})` : ''}`).join(', ');
      } else {
        out += scalar.map(([q]) => q).join(', ');
      }

      out += '\n\nRelation/collection fields — require JOIN to query:\n';
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

      mcpLog('get_type_info', env.name, `Type info: ${code} (${allAttrs.length} attrs)`, out);
      return text(out);
    }
  );

  mcp.registerTool(
    'impex_import',
    {
      description: 'Execute an ImpEx import script on a HAC environment. Call list_environments first to check import is allowed.',
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

      let result;
      try {
        result = await withSession(env, s => impexImport(s, script, {
          validationEnum, maxThreads, legacyMode, enableCodeExecution, distributedMode, sldEnabled,
        }));
      } catch (e) {
        mcpLog('impex_import', env.name, `Error: ${e.message}`, e.stack || '', true);
        return error(e.message);
      }

      const isErr = result.level === 'error';
      const icon = isErr ? '❌' : '✅';
      let out = `**${env.name}** — ${icon} ${result.result || 'Import complete'}\n`;
      if (result.details) out += `\n\`\`\`\n${result.details}\n\`\`\``;

      const scriptPreview = script.split('\n')[0].slice(0, 60);
      mcpLog('impex_import', env.name,
        `${isErr ? '❌' : '✅'} ${result.result || 'Done'} — ${scriptPreview}…`,
        `Script:\n${script}\n\nResult: ${result.result}\n\n${result.details || ''}`,
        isErr
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
  hacLogClients.add(res);
  req.on('close', () => hacLogClients.delete(res));
});

// MCP activity log SSE
app.get('/api/mcp-log', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
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
