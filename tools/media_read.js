import { z } from 'zod';
import { groovyExecute } from '../hac.js';
import { withSession, getEnvironment, mcpLogStart, mcpLog, text, error } from './context.js';

const TOOL = 'media_read';

const SCRIPT = (pk) => `
import de.hybris.platform.core.PK
import de.hybris.platform.servicelayer.media.MediaService

def mediaService = spring.getBean('mediaService')
def modelService = spring.getBean('modelService')

def media = modelService.get(PK.fromLong(${pk}L))
if (media.mime && media.mime != 'text/plain') {
  throw new RuntimeException("media_read only supports text/plain media, but this media has mime: \${media.mime}")
}
def stream = mediaService.getStreamFromMedia(media)
def bytes = stream.bytes
stream.close()
bytes.encodeBase64().toString()
`.trim();

function decodeTextBytes(bytes) {
  // UTF-16LE with real BOM (FF FE)
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return bytes.slice(2).toString('utf16le');
  }
  // UTF-16LE with mangled BOM (FF FE encoded as UTF-8 replacement chars: EF BF BD EF BF BD)
  if (bytes.length >= 8 &&
      bytes[0] === 0xEF && bytes[1] === 0xBF && bytes[2] === 0xBD &&
      bytes[3] === 0xEF && bytes[4] === 0xBF && bytes[5] === 0xBD &&
      bytes[7] === 0x00) {
    return bytes.slice(6).toString('utf16le');
  }
  // UTF-8 with BOM (EF BB BF)
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return bytes.slice(3).toString('utf-8');
  }
  return bytes.toString('utf-8');
}

export const tool = {
  name: TOOL,
  description: 'Read the text content of a SAP Commerce MediaModel by its PK. Only supports text/plain media.',
  inputSchema: {
    environmentId: z.string().describe('Environment ID from list_environments'),
    mediaPk: z.string().describe('PK of the MediaModel to read'),
  },
  handler: async ({ environmentId, mediaPk }) => {
    const env = await getEnvironment(environmentId);
    if (!env) {
      mcpLog({ tool: TOOL, envName: environmentId, preview: 'Unknown environment', isError: true });
      return error(`Environment "${environmentId}" not found.`);
    }
    if (!env.allowGroovyExecution) {
      mcpLog({ tool: TOOL, envName: env.name, preview: 'Groovy disabled', isError: true });
      return error(`Groovy execution is disabled for environment "${env.name}".`);
    }

    const runId = mcpLogStart({ tool: TOOL, envName: env.name, preview: `Reading media PK ${mediaPk}` });

    let result;
    try {
      result = await withSession(env, s => groovyExecute(s, SCRIPT(mediaPk)));
    } catch (e) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `Error: ${e.message}`, detail: e.stack || '', isError: true, runId });
      return error(e.message);
    }

    if (result.stacktraceText) {
      mcpLog({ tool: TOOL, envName: env.name, preview: `❌ PK ${mediaPk}`, detail: result.stacktraceText, isError: true, runId });
      let out = `**${env.name}** — ❌ Error reading media PK ${mediaPk}\n`;
      out += `\n**Stacktrace:**\n\`\`\`\n${result.stacktraceText}\n\`\`\``;
      return { content: [{ type: 'text', text: out }], isError: true };
    }

    const base64 = (result.executionResult || '').trim();
    const content = decodeTextBytes(Buffer.from(base64, 'base64'));

    mcpLog({ tool: TOOL, envName: env.name, preview: `✅ PK ${mediaPk} (${content.length} chars)`, runId });

    return text(`**${env.name}** — ✅ Media PK ${mediaPk}\n\n**Content:**\n\`\`\`\n${content}\n\`\`\``);
  },
};
