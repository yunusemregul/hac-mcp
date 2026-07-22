import { z } from 'zod';
import { groovyExecute } from '../hac.js';
import { optionalLooseBool, optionalLooseNumber } from './zodLoose.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'backoffice_config_raw';

const MEDIA_CODE = 'cockpitng-config';
const DEFAULT_MAX_CHARS = 20000;

const quoted = (s) => s ? `"${s.replace(/"/g, '\\"')}"` : 'null';

// Groovy: load merged cockpit-config media, optionally filter <context> blocks
// by type/component/module, and return either a summary or full block XML capped at maxChars.
const SCRIPT = ({ type, component, module, body, maxChars }) => {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  return `
import de.hybris.platform.servicelayer.media.MediaService

def mediaService = spring.getBean('mediaService')
def media = mediaService.getMedia('${MEDIA_CODE}')
if (media == null) {
  throw new RuntimeException("Media with code '${MEDIA_CODE}' not found. Has the backoffice been initialized?")
}
def xml = new String(mediaService.getDataFromMedia(media), 'UTF-8')

def filterType = ${quoted(type)}
def filterComponent = ${quoted(component)}
def filterModule = ${quoted(module)}
def wantBody = ${body ? 'true' : 'false'}
def maxChars = ${cap}

// Match <context ...>...</context> blocks (top-level, non-nested in cockpit-config).
def ctxPattern = ~/(?s)<context\\b([^>]*)>(.*?)<\\/context>/

def attrPattern = ~/(\\w[\\w-]*)\\s*=\\s*"([^"]*)"/
def parseAttrs = { String head ->
    def m = [:]
    attrPattern.matcher(head).each { full, k, v -> m[k] = v }
    return m
}

def matches = []
ctxPattern.matcher(xml).each { full, head, body ->
    def attrs = parseAttrs(head)
    if (filterType != null && attrs.type != filterType) return
    if (filterComponent != null && attrs.component != filterComponent) return
    if (filterModule != null && attrs.module != filterModule) return
    matches << [attrs: attrs, full: full]
}

def out = new StringBuilder()
out << "media-pk: \${media.pk}\\n"
out << "media-modified: \${media.modifiedtime}\\n"
out << "media-size: \${media.size}\\n"
out << "match-count: \${matches.size()}\\n"

if (!wantBody) {
    def counts = [:]
    if (filterType == null && filterComponent == null && filterModule == null) {
        out << "summary (distinct components):\\n"
        matches.each { m ->
            def key = m.attrs.component ?: '-'
            counts[key] = (counts[key] ?: 0) + 1
        }
        counts.sort { it.key }.each { k, c -> out << "  component=\${k} blocks=\${c}\\n" }
        out << "\\nHint: pass component=... and/or type=... and/or module=... to drill down. Pass body=true to fetch raw <context> XML.\\n"
    } else {
        // Always show modules in the summary breakdown when any filter is active.
        // The remaining axes are surfaced in the key.
        def axes = []
        if (filterType == null) axes << 'type'
        if (filterComponent == null) axes << 'component'
        if (filterModule == null) axes << 'module'
        if (axes.isEmpty()) axes << 'module'  // all three filtered: degenerate case, just count

        def label = axes.collect { it }.join(' x ')
        def filterLabel = []
        if (filterType != null) filterLabel << "type=\${filterType}"
        if (filterComponent != null) filterLabel << "component=\${filterComponent}"
        if (filterModule != null) filterLabel << "module=\${filterModule}"
        out << "summary (\${label} for \${filterLabel.join(', ')}):\\n"

        matches.each { m ->
            def key = axes.collect { axis -> m.attrs[axis] ?: '-' }
            counts[key] = (counts[key] ?: 0) + 1
        }
        counts.sort { a, b ->
            for (int i = 0; i < a.key.size(); i++) {
                def cmp = a.key[i] <=> b.key[i]
                if (cmp != 0) return cmp
            }
            0
        }.each { k, c ->
            def parts = []
            axes.eachWithIndex { axis, i -> parts << "\${axis}=\${k[i]}" }
            out << "  \${parts.join(' ')} blocks=\${c}\\n"
        }
        out << "\\nHint: pass body=true to fetch the raw <context> XML for these matches.\\n"
    }
} else {
    // Body mode: emit blocks until maxChars budget is exhausted.
    def usedChars = 0
    def emitted = 0
    matches.eachWithIndex { m, i ->
        if (usedChars >= maxChars) return
        def header = "\\n----- block \${i + 1} (module=\${m.attrs.module ?: '-'}) -----\\n"
        def chunk = header + m.full + "\\n"
        if (usedChars + chunk.length() > maxChars) {
            def remaining = maxChars - usedChars
            if (remaining > header.length() + 200) {
                out << header
                out << m.full.take(remaining - header.length() - 100)
                out << "\\n…[truncated]\\n"
                usedChars = maxChars
                emitted++
            }
            return
        }
        out << chunk
        usedChars += chunk.length()
        emitted++
    }
    if (emitted < matches.size()) {
        out << "\\n[\${matches.size() - emitted} more block(s) omitted - raise maxChars or filter further]\\n"
    }
}

return out.toString()
`.trim();
};

export const tool = {
  name: TOOL,
  category: 'read',
  description: 'Inspect the RAW Backoffice cockpit configuration blocks (Media code "cockpitng-config"). Returns the stored <context> blocks verbatim, filtered by type/component/module, or a discovery summary (counts grouped by component / type / module). Does NOT merge or follow the type parent chain: asking type=Customer returns only blocks literally tagged type="Customer", not tabs inherited from User/Principal. Works for ANY component (editor-area, listview, advanced-search, explorer-tree, etc.). For a merged/resolved editor-area tab tree with contributor attribution, use backoffice_config_resolve instead. Set body=true for raw XML (capped at maxChars, default 20000).',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    type: z.string().optional().describe('Filter by context type attribute, e.g. "Order", "AbstractOrder", "Customer"'),
    component: z.string().optional().describe('Filter by context component attribute, e.g. "editor-area", "advanced-search", "listview"'),
    module: z.string().optional().describe('Filter by source module attribute, e.g. "vakkobackoffice", "basecommercebackoffice"'),
    body: optionalLooseBool().describe('Return raw <context> block XML instead of a summary. Default false. Output is capped at maxChars.'),
    maxChars: optionalLooseNumber().describe(`Hard cap on returned characters when body=true (default ${DEFAULT_MAX_CHARS}). Excess blocks are truncated.`),
  },
  handler: async ({ environmentId, type, component, module, body, maxChars }) => {
    const env = await getEnvironment(environmentId);
    if (!env) {
      mcpLog({ tool: TOOL, envName: environmentId, preview: 'Unknown environment', isError: true });
      return error(`Environment "${environmentId}" not found.`);
    }
    if (!env.allowGroovyExecution) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Groovy disabled', isError: true });
      return error(`Groovy execution is disabled for environment "${env.name}".`);
    }

    const filterDesc = [
      type ? `type=${type}` : null,
      component ? `component=${component}` : null,
      module ? `module=${module}` : null,
      body ? 'body' : 'summary',
    ].filter(Boolean).join(' ');

    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview: `Reading cockpitng-config (${filterDesc})` });

    let result;
    try {
      result = await withSession(env, s => groovyExecute(s, SCRIPT({ type, component, module, body, maxChars }), { commit: false }));
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, detail: e.stack || '', isError: true, runId });
      return error(e.message);
    }

    if (result.stacktraceText) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `❌ ${filterDesc}`, detail: result.stacktraceText, isError: true, runId });
      let out = `**${env.name}** - ❌ Error reading cockpitng-config\n`;
      out += `\n**Stacktrace:**\n\`\`\`\n${result.stacktraceText}\n\`\`\``;
      return { content: [{ type: 'text', text: out }], isError: true };
    }

    const out = (result.executionResult ?? '').toString();
    mcpLog({
      tool: TOOL,
      envName: env.name,
      preview: `✅ ${filterDesc} (${out.length} chars)`,
      detail: out,
      runId,
    });

    return text(`**${env.name}** - cockpitng-config (${filterDesc})\n\n\`\`\`\n${out}\n\`\`\``);
  },
};
