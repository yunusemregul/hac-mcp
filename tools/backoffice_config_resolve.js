import { z } from 'zod';
import { groovyExecute } from '../hac.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'backoffice_config_resolve';

const MEDIA_CODE = 'cockpitng-config';
const DEFAULT_COMPONENT = 'editor-area';

const quoted = (s) => s ? `"${s.replace(/"/g, '\\"')}"` : 'null';

// Groovy: resolve the MERGED editor-area for a type by walking the real
// item-type supertype chain (via typeService) and merging every matching
// <context> block in that order, applying the cockpit merge semantics
// (match tabs/sections by name and attributes by qualifier; honor
// merge-mode=remove/replace; order by position). Every node is tagged with
// the module@type that contributes it, so you know where to override.
const SCRIPT = ({ type, component }) => `
import de.hybris.platform.servicelayer.media.MediaService
import de.hybris.platform.servicelayer.type.TypeService
import groovy.xml.XmlParser

def mediaService = spring.getBean('mediaService')
def typeService  = spring.getBean('typeService')

def media = mediaService.getMedia('${MEDIA_CODE}')
if (media == null) {
  throw new RuntimeException("Media with code '${MEDIA_CODE}' not found. Has the backoffice been initialized?")
}
def xml = new String(mediaService.getDataFromMedia(media), 'UTF-8')

def targetType = ${quoted(type)}
def component  = ${quoted(component)}

// --- 1. real supertype chain (root .. target), most-general first ---
def chain = []
try {
  def ct = typeService.getComposedTypeForCode(targetType)
  def stack = []
  def cur = ct
  while (cur != null) { stack << cur.code; cur = cur.superType }
  chain = stack.reverse()
} catch (e) {
  chain = [targetType]
}
def chainIndex = [:]
chain.eachWithIndex { c, i -> chainIndex[c] = i }

// --- 2. collect editor-area context blocks for types in the chain ---
def ctxPattern = ~/(?s)<context\\b([^>]*)>(.*?)<\\/context>/
def attrPattern = ~/([\\w-]+)\\s*=\\s*"([^"]*)"/
def parseAttrs = { String head ->
  def m = [:]
  attrPattern.matcher(head).each { full, k, v -> m[k] = v }
  return m
}

def blocks = []
int docIdx = 0
ctxPattern.matcher(xml).each { full, head, inner ->
  def attrs = parseAttrs(head)
  int di = docIdx++
  if (attrs.component != component) return
  if (attrs.type == null || !chainIndex.containsKey(attrs.type)) return
  blocks << [type: attrs.type, module: attrs.module ?: '-', doc: di, xml: full]
}
// general -> specific; within a type keep document (module) order
blocks.sort { a, b ->
  def c = (chainIndex[a.type] <=> chainIndex[b.type]); if (c != 0) return c
  a.doc <=> b.doc
}

// --- 3. merge model ---
// essentials: qualifier -> [q, meta, contributor]
// tabs: name -> [name, position, contributors:LinkedHashSet, sections: name -> section]
// section: [name, position, contributors, items: key -> [kind, key, meta, contributor, position]]
def essentials = [:]
def tabs = [:]

def parser = new XmlParser(false, false)
// non-namespace-aware parser keeps the prefix in the tag name (e.g. "ea:tab"); strip it
def ln = { node -> def s = node.name().toString(); s.contains(':') ? s.substring(s.indexOf(':') + 1) : s }
def posOf = { node ->
  def p = node.attribute('position')
  if (p == null || p.toString().trim().isEmpty()) return null
  try { return p.toInteger() } catch (e) { return null }
}
def modeOf = { node ->
  def m = node.attribute('merge-mode')
  m == null ? 'merge' : m.toString().toLowerCase()
}
def metaOf = { node ->
  def bits = []
  if (node.attribute('readonly') == 'true') bits << 'readonly'
  if (node.attribute('editor')) bits << "editor=\${node.attribute('editor')}"
  if (node.attribute('label')) bits << "label=\${node.attribute('label')}"
  if (node.attribute('spring-bean')) bits << "bean=\${node.attribute('spring-bean')}"
  bits.join(', ')
}

def mergeAttribute = { sectionItems, node, contributor, panelName ->
  def kind = ln(node)
  def key
  if (kind == 'attribute') key = 'attr:' + node.attribute('qualifier')
  else key = kind + ':' + (node.attribute('name') ?: node.attribute('spring-bean') ?: '')
  def mode = modeOf(node)
  if (mode == 'remove') { sectionItems.remove(key); return }
  def meta = metaOf(node)
  if (panelName) meta = (meta ? meta + ', ' : '') + 'in panel: ' + panelName
  def existing = sectionItems[key]
  def rec = [kind: kind, key: key, meta: meta, contributor: contributor, position: posOf(node)]
  if (existing == null || mode == 'replace') { sectionItems[key] = rec }
  else {
    // merge: keep order, update meta/contributor, keep first non-null position
    if (rec.meta) existing.meta = rec.meta
    existing.contributor = contributor
    if (existing.position == null) existing.position = rec.position
  }
}

def mergeSection = { tab, secNode, contributor ->
  def name = secNode.attribute('name') ?: '(unnamed)'
  def mode = modeOf(secNode)
  if (mode == 'remove') { tab.sections.remove(name); return }
  def sec = tab.sections[name]
  if (sec == null || mode == 'replace') {
    sec = [name: name, position: posOf(secNode), contributors: new LinkedHashSet(), items: [:]]
    tab.sections[name] = sec
  }
  sec.contributors << contributor
  if (sec.position == null) sec.position = posOf(secNode)
  // recurse into panels/customPanels so fields nested inside them are still listed
  def addItem
  addItem = { node, panelName ->
    def cn = ln(node)
    if (cn == 'section') return
    if (cn == 'panel' || cn == 'customPanel') {
      def elemKids = node.children().findAll { it instanceof Node }
      if (elemKids.isEmpty()) { mergeAttribute(sec.items, node, contributor, panelName); return }
      def pn = node.attribute('name') ?: node.attribute('spring-bean') ?: panelName
      elemKids.each { addItem(it, pn) }
      return
    }
    mergeAttribute(sec.items, node, contributor, panelName)
  }
  secNode.children().each { child ->
    if (child instanceof Node) addItem(child, null)
  }
}

def mergeTab = { tabNode, contributor ->
  def name = tabNode.attribute('name') ?: '(unnamed)'
  def mode = modeOf(tabNode)
  if (mode == 'remove') { tabs.remove(name); return }
  def tab = tabs[name]
  if (tab == null || mode == 'replace') {
    tab = [name: name, position: posOf(tabNode), contributors: new LinkedHashSet(), sections: [:]]
    tabs[name] = tab
  }
  tab.contributors << contributor
  if (posOf(tabNode) != null) tab.position = posOf(tabNode)
  tabNode.children().each { child ->
    if (!(child instanceof Node)) return
    def cn = ln(child)
    if (cn == 'section' || cn == 'customSection') mergeSection(tab, child, contributor)
  }
}

blocks.each { blk ->
  def contributor = "\${blk.module}@\${blk.type}"
  def ctx
  try { ctx = parser.parseText(blk.xml) } catch (e) { return }
  def ea = ctx.children().find { it instanceof Node && ln(it) == 'editorArea' }
  if (ea == null) return
  ea.children().each { child ->
    if (!(child instanceof Node)) return
    def cn = ln(child)
    if (cn == 'essentials') {
      child.children().each { esec ->
        if (!(esec instanceof Node)) return
        esec.children().each { a ->
          if (!(a instanceof Node) || ln(a) != 'attribute') return
          def q = a.attribute('qualifier')
          if (modeOf(a) == 'remove') { essentials.remove(q); return }
          essentials[q] = [q: q, meta: metaOf(a), contributor: contributor, position: posOf(a)]
        }
      }
    } else if (cn == 'tab' || cn == 'customTab') {
      mergeTab(child, contributor)
    }
  }
}

// --- 4. render ---
def out = new StringBuilder()
out << "Resolved '\${component}' for type: \${targetType}\\n"
out << "type chain (general -> specific): \${chain.join(' > ')}\\n"
out << "merged from \${blocks.size()} block(s)\\n"

def byPos = { a, b ->
  def pa = a.position; def pb = b.position
  if (pa == null && pb == null) return 0
  if (pa == null) return 1
  if (pb == null) return -1
  pa <=> pb
}

if (!essentials.isEmpty()) {
  out << "\\nESSENTIALS\\n"
  essentials.values().toList().sort(byPos).each { a ->
    out << "  - \${a.q}\${a.meta ? '  ('+a.meta+')' : ''}  [\${a.contributor}]\\n"
  }
}

out << "\\nTABS (by position)\\n"
tabs.values().toList().sort(byPos).each { tab ->
  def pos = tab.position != null ? tab.position : '-'
  out << "\\n  [pos \${pos}] \${tab.name}   contributors: \${tab.contributors.join(', ')}\\n"
  tab.sections.values().toList().sort(byPos).each { sec ->
    def sp = sec.position != null ? " pos=\${sec.position}" : ''
    out << "     section '\${sec.name}'\${sp}   (\${sec.contributors.join(', ')})\\n"
    sec.items.values().toList().sort(byPos).each { it2 ->
      def label = it2.kind == 'attribute' ? it2.key.replace('attr:', '') : it2.key
      out << "        - \${label}\${it2.meta ? '  ('+it2.meta+')' : ''}  [\${it2.contributor}]\\n"
    }
  }
}

return out.toString()
`.trim();

export const tool = {
  name: TOOL,
  category: 'read',
  description: 'Resolve the MERGED editor-area (or other type-based) Backoffice config for a type, the "live-ish" view of what tabs/sections/attributes actually render. Walks the real item-type supertype chain via typeService (e.g. Customer -> User -> Principal), merges every matching <context> block in that order applying cockpit merge semantics (tabs/sections matched by name, attributes by qualifier; merge-mode=remove/replace honored; ordered by position), and tags every node with the module@type that contributes it so you know exactly where to override. Use this to plan editor-area tab edits (add/move/remove attributes, reorder or remove tabs). For raw unmerged blocks or non-editor-area components, use backoffice_config_raw.',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    type: z.string().describe('Item type code to resolve, e.g. "Customer", "Product", "Order"'),
    component: z.string().optional().describe(`Cockpit component to resolve. Default "${DEFAULT_COMPONENT}". Merge model is tuned for editor-area (tabs/sections/attributes).`),
  },
  handler: async ({ environmentId, type, component }) => {
    const env = await getEnvironment(environmentId);
    if (!env) {
      mcpLog({ tool: TOOL, envName: environmentId, preview: 'Unknown environment', isError: true });
      return error(`Environment "${environmentId}" not found.`);
    }
    if (!env.allowGroovyExecution) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Groovy disabled', isError: true });
      return error(`Groovy execution is disabled for environment "${env.name}".`);
    }

    const comp = component || DEFAULT_COMPONENT;
    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview: `Resolving ${comp} for type=${type}` });

    let result;
    try {
      result = await withSession(env, s => groovyExecute(s, SCRIPT({ type, component: comp }), { commit: false }));
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, detail: e.stack || '', isError: true, runId });
      return error(e.message);
    }

    if (result.stacktraceText) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `❌ ${comp} type=${type}`, detail: result.stacktraceText, isError: true, runId });
      let out = `**${env.name}** - ❌ Error resolving ${comp} for type=${type}\n`;
      out += `\n**Stacktrace:**\n\`\`\`\n${result.stacktraceText}\n\`\`\``;
      return { content: [{ type: 'text', text: out }], isError: true };
    }

    const out = (result.executionResult ?? '').toString();
    mcpLog({ tool: TOOL, envName: env.name, preview: `✅ ${comp} type=${type} (${out.length} chars)`, detail: out, runId });
    return text(`**${env.name}** - resolved ${comp} for type=${type}\n\n\`\`\`\n${out}\n\`\`\``);
  },
};
