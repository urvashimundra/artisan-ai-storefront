import { MAX_TRACE_ITEMS, MAX_TRACE_ITEM_LENGTH } from '../domain/enquiryRules.js';

/** @returns {object[]} The tool_use blocks of a model response. */
export const toolUseBlocks = (response) => (Array.isArray(response?.content) ? response.content : []).filter((block) => block?.type === 'tool_use');

/** Re-sends only the block fields the API needs, never anything else the response happened to carry. */
export const echoBlocks = (response) =>
  (Array.isArray(response?.content) ? response.content : []).flatMap((block) => {
    if (block?.type === 'text') return [{ type: 'text', text: String(block.text ?? '') }];
    if (block?.type === 'tool_use') return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} }];
    return [];
  });

/** @returns {string[]} The trace the tools built, clipped to the stored limits. */
export const finishTrace = (state) => state.tools.trace.slice(0, MAX_TRACE_ITEMS).map((item) => Array.from(item).slice(0, MAX_TRACE_ITEM_LENGTH).join(''));

/** Runs the model's tool calls (not the final one) and returns the tool_result blocks. */
export async function runTools(blocks, tools) {
  const results = [];
  for (const block of blocks) {
    const { content, isError } = await tools.run(block.name, block.input);
    results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(content), ...(isError ? { is_error: true } : {}) });
  }
  return results;
}
