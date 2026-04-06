import { z } from 'zod';
import { groovyExecute } from '../hac.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'media_write';

const SCRIPT_OVERWRITE = (mediaPk, base64, realFileName) => `
import de.hybris.platform.core.PK

def mediaService = spring.getBean('mediaService')
def modelService = spring.getBean('modelService')

def media = modelService.get(PK.fromLong(${mediaPk}L))
def bytes = "${base64}".decodeBase64()
mediaService.setStreamForMedia(media, new java.io.ByteArrayInputStream(bytes), ${realFileName ? `"${realFileName}"` : 'media.realFileName ?: media.code'}, "text/plain")
"OK — wrote \${bytes.length} bytes to media \${media.pk}"
`.trim();

const SCRIPT_CREATE = (targetPk, targetField, base64, realFileName, mediaCode, catalogVersionPk) => `
import de.hybris.platform.core.PK

def mediaService = spring.getBean('mediaService')
def modelService = spring.getBean('modelService')
def typeService = spring.getBean('typeService')

def target = modelService.get(PK.fromLong(${targetPk}L))
def typecode = target.itemtype
def attrDesc = typeService.getAttributeDescriptor(typecode, "${targetField}")
def mediaTypecode = attrDesc.attributeType.code

def media = modelService.create(mediaTypecode)
media.code = ${mediaCode ? `"${mediaCode}"` : `"media_" + System.currentTimeMillis()`}

// assign catalog version only for catalog-aware media types (where catalogVersion is mandatory)
def needsCatalogVersion = false
try {
  def cvAttr = typeService.getAttributeDescriptor(typeService.getComposedTypeForCode(mediaTypecode), 'catalogVersion')
  needsCatalogVersion = !cvAttr.optional
} catch (Exception e) { /* no catalogVersion attribute */ }
if (needsCatalogVersion) {
  ${catalogVersionPk
    ? `media.catalogVersion = modelService.get(PK.fromLong(${catalogVersionPk}L))`
    : `if (target.hasProperty('catalogVersion') && target.catalogVersion != null) {
    media.catalogVersion = target.catalogVersion
  } else {
    throw new RuntimeException("Media type '\${mediaTypecode}' requires a catalog version but none could be inferred from the target item. Provide catalogVersionPk explicitly.")
  }`
  }
}

modelService.save(media)

def bytes = "${base64}".decodeBase64()
mediaService.setStreamForMedia(media, new java.io.ByteArrayInputStream(bytes), ${realFileName ? `"${realFileName}"` : `media.code + ".txt"`}, "text/plain")

target."${targetField}" = media
modelService.save(target)

"OK — created media \${media.pk} (\${mediaTypecode}, code=\${media.code}), wrote \${bytes.length} bytes, assigned to \${typecode}.\${target.pk}.${targetField}"
`.trim();

export const tool = {
  name: TOOL,
  description: 'Write text/plain content to a SAP Commerce MediaModel. If mediaPk is provided, overwrites the existing media stream. Otherwise creates a new media by inspecting the target item\'s field type, sets the stream, and assigns it back to the field. IMPORTANT: Before calling this tool, show the user what will be written and ask for confirmation.',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    content: z.string().describe('Text content to write (UTF-8)'),
    mediaPk: z.string().optional().describe('PK of an existing MediaModel to overwrite. If provided, targetPk/targetField are ignored.'),
    targetPk: z.string().optional().describe('PK of the item that owns the media field. Required when mediaPk is not provided.'),
    targetField: z.string().optional().describe('Attribute name on the target item (e.g. "content"). Used to determine media type and assign after creation.'),
    realFileName: z.string().optional().describe('Filename for the media (e.g. "import.txt")'),
    mediaCode: z.string().optional().describe('Code for the new media item. Auto-generated if not provided.'),
    catalogVersionPk: z.string().optional().describe('PK of the CatalogVersion to assign to the new media. Only needed for catalog-aware media types. If absent, inferred from the target item.'),
  },
  handler: async ({ environmentId, content: contentStr, mediaPk, targetPk, targetField, realFileName, mediaCode, catalogVersionPk }) => {
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
    if (!mediaPk && (!targetPk || !targetField)) {
      return error('Either mediaPk or both targetPk and targetField must be provided.');
    }

    const base64 = Buffer.from(contentStr, 'utf-8').toString('base64');
    const preview = mediaPk ? `Overwriting media PK ${mediaPk}` : `Creating media for ${targetField} on PK ${targetPk}`;
    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview });

    const script = mediaPk
      ? SCRIPT_OVERWRITE(mediaPk, base64, realFileName)
      : SCRIPT_CREATE(targetPk, targetField, base64, realFileName, mediaCode, catalogVersionPk);

    let result;
    try {
      result = await withSession(env, s => groovyExecute(s, script, { commit: true }));
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, detail: e.stack || '', isError: true, runId });
      return error(e.message);
    }

    const isErr = !!result.stacktraceText;
    mcpLog({ tool: TOOL, envName: env.name, preview: `${isErr ? '❌' : '✅'} ${preview}`, detail: result.stacktraceText || result.executionResult || '', isError: isErr, runId });

    let out = `**${env.name}** — ${isErr ? '❌ Error' : '✅ Success'}\n`;
    if (result.executionResult) out += `\n**Result:**\n\`\`\`\n${result.executionResult}\n\`\`\``;
    if (result.stacktraceText) out += `\n**Stacktrace:**\n\`\`\`\n${result.stacktraceText}\n\`\`\``;
    return isErr ? { content: [{ type: 'text', text: out }], isError: true } : text(out);
  },
};
