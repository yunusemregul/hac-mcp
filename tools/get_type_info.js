import { z } from 'zod';
import { flexibleSearch } from '../hac.js';
import { optionalLooseBool } from './zodLoose.js';
import { withSession, getEnvironment, isTruthy, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'get_type_info';

export const tool = {
  name: TOOL,
  category: 'read',
  description: 'Get metadata and queryable fields for a SAP Commerce type. Use this when a FlexibleSearch query fails with unknown field errors to discover the correct field qualifiers. The database is MSSQL — do NOT use LIMIT, TOP, or OFFSET in FlexibleSearch queries; use the maxCount parameter instead.',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    typeCode: z.string().optional().describe('Type code to look up, e.g. SolrFacetSearchConfig, Order, Product'),
    type: z.string().optional().describe('Alias for typeCode if the client sends this key instead'),
    includeInherited: optionalLooseBool().describe('Also include attributes inherited from supertypes (default false)'),
  },
  handler: async ({ environmentId, typeCode, type: typeArg, includeInherited }) => {
    const env = await getEnvironment(environmentId);
    if (!env) {
      mcpLog({ tool: TOOL, envName: environmentId, preview: 'Unknown environment', isError: true });
      return error(`Environment "${environmentId}" not found.`);
    }

    const resolvedType = typeCode ?? typeArg;
    if (!resolvedType) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Missing typeCode', isError: true });
      return error('Provide typeCode (or type) with the Commerce type code.');
    }

    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview: `Type info: ${resolvedType}` });

    let typeResult;
    try {
      typeResult = await withSession(env, s => flexibleSearch(s,
        `SELECT {pk}, {code}, {supertype}, {jaloclass}, {inheritancepathstring}, {extensionname}, {catalogitemtype}, {singleton} FROM {ComposedType} WHERE {code} = '${resolvedType}'`
      ));
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, isError: true, runId });
      return error(e.message);
    }

    if (typeResult.exception) {
      const ex = typeResult.exception;
      const msg = ex.message || ex.localizedMessage || JSON.stringify(ex);
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Query error', detail: msg, isError: true, runId });
      return error(msg);
    }

    if (!typeResult.resultList?.length) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Type not found: ${resolvedType}`, isError: true, runId });
      return error(`Type "${resolvedType}" not found. Check the type code (case-sensitive).`);
    }

    const [pk, code, supertypePK, , inheritancePath] = typeResult.resultList[0];

    const typePKs = includeInherited
      ? inheritancePath.split(',').filter(Boolean)
      : [String(pk)];

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
      } catch (_) {}
    }
    ancestorNames[String(pk)] = code;

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
      } catch (_) {}
    }

    let supertypeName = null;
    if (supertypePK) {
      try {
        const stResult = await withSession(env, s => flexibleSearch(s,
          `SELECT {code} FROM {ComposedType} WHERE {pk} = '${supertypePK}'`
        ));
        supertypeName = stResult.resultList?.[0]?.[0] || null;
      } catch (_) {}
    }

    const scalar = allAttrs.filter(([, dbCol]) => dbCol);
    const relations = allAttrs.filter(([, dbCol]) => !dbCol);

    const collTypePKs = [...new Set(relations.map(([,,,attrTypePK]) => attrTypePK).filter(Boolean))];
    const elementTypeMap = {};
    const composedTypeNames = {};
    const collCodeMap = {};
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
      } catch (_) {}
    }

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

    const scalarAttrTypePKs = [...new Set(scalar.map(([,,,attrTypePK]) => attrTypePK).filter(Boolean))];
    const scalarRefTypes = {};
    if (scalarAttrTypePKs.length) {
      try {
        const conds = scalarAttrTypePKs.map(p => `{pk} = '${p}'`).join(' OR ');
        const r = await withSession(env, s => flexibleSearch(s,
          `SELECT {pk}, {code} FROM {ComposedType} WHERE ${conds}`
        ));
        if (r.resultList) for (const [tpk, tcode] of r.resultList) scalarRefTypes[String(tpk)] = tcode;
      } catch (_) {}
    }

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

    mcpLog({ tool: TOOL, envName: env.name, preview: `Type info: ${code} (${allAttrs.length} attrs)`, detail: out, runId });
    return text(out);
  },
};
