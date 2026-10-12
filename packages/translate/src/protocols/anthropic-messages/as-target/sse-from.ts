import { usageToIR } from './usage.ts';
import { createIRBuilder, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import type { IRSourceCitation, IRUsage } from '../../../ir/types.ts';
import { unwrapCustomToolInput } from '../../openai-responses/as-source/custom-tool-wrap.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const messagesCitationToIR = (citation: Record<string, any>): IRSourceCitation => ({
  type: 'source_citation',
  source_kind: citation.type === 'web_search_result_location' ? 'url' : citation.type === 'search_result_location' ? 'search_result' : 'document',
  ...(citation.url !== undefined ? { source: citation.url } : citation.source !== undefined ? { source: citation.source } : citation.file_id != null ? { source: citation.file_id } : {}),
  ...(citation.title != null || citation.document_title != null ? { source_label: citation.title ?? citation.document_title } : {}),
  source_text: { text: citation.cited_text, granularity: 'exact_quote' },
  ...(citation.type === 'page_location' ? { source_page_range: { start_one_based: citation.start_page_number, end_one_based_exclusive: citation.end_page_number } } : {}),
});

interface MessagesBlockState {
  readonly path?: IRPath;
  readonly type: string;
  readonly custom: boolean;
  wrappedInput: string;
}

export const irFromAnthropicMessages = async function* (
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>,
  options: { customToolNames?: ReadonlySet<string> } = {},
): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  const blocks = new Map<number, MessagesBlockState>();
  let started = false;
  let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' = 'stop';
  let finished = false;

  const assignUsage = (usage: Record<string, any>): void => {
    const converted: Partial<Record<keyof IRUsage, number>> = { ...usageToIR(usage) };
    if (b.state.usage === undefined) b.initialize(['usage'], {});
    const current = b.state.usage ?? {};
    if (converted.input_tokens_inclusive === undefined && (converted.cached_input_tokens !== undefined || converted.cache_creation_input_tokens !== undefined) && current.input_tokens_inclusive !== undefined) {
      const base = current.input_tokens_inclusive - (current.cached_input_tokens ?? 0) - (current.cache_creation_input_tokens ?? 0);
      converted.input_tokens_inclusive = base + (converted.cached_input_tokens ?? current.cached_input_tokens ?? 0) + (converted.cache_creation_input_tokens ?? current.cache_creation_input_tokens ?? 0);
    }
    for (const [key, value] of Object.entries(converted) as [keyof IRUsage, number][]) b.assign(['usage', key], value);
    const tier = usage.speed === 'fast' ? 'fast' : usage.service_tier;
    if (typeof tier === 'string') b.assign(['service_tier'], tier);
  };

  const openBlock = (index: number, block: Record<string, any>): void => {
    if (blocks.has(index)) throw new Error(`Duplicate Messages content_block_start at index ${index}`);
    let path: IRPath | undefined;
    let custom = false;
    let wrappedInput = '';
    if (block.type === 'fallback') {
      b.assign(['model'], block.to.model);
    } else if (block.type === 'text') {
      const item = b.item(0, { type: 'message', content: [] });
      path = ['choices', 0, 'items', item];
      const annotations = block.citations === undefined ? undefined : block.citations === null ? null : block.citations.map(messagesCitationToIR);
      b.initialize([...path, 'content', 0], { type: 'text', text: '', ...(annotations === undefined ? {} : { annotations }) });
      if (block.text !== '') b.append([...path, 'content', 0, 'text'], block.text);
    } else if (block.type === 'thinking') {
      const item = b.item(0, { type: 'reasoning', summary: [''], ...(block.signature === '' || block.signature === undefined ? {} : { encrypted_content: block.signature }) });
      path = ['choices', 0, 'items', item];
      if (block.thinking !== '') b.append([...path, 'summary', 0], block.thinking);
    } else if (block.type === 'redacted_thinking') {
      const item = b.item(0, { type: 'reasoning', encrypted_content: block.data });
      path = ['choices', 0, 'items', item];
    } else if (block.type === 'tool_use') {
      custom = options.customToolNames?.has(block.name) === true;
      const item = b.item(0, custom
        ? { type: 'custom_tool_call', call_id: block.id, name: block.name, input: '' }
        : { type: 'function_call', call_id: block.id, name: block.name, arguments: '' });
      path = ['choices', 0, 'items', item];
      const serialized = block.inputJson ?? (block.input !== undefined && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : '');
      if (custom) wrappedInput = serialized;
      else if (serialized !== '') {
        // TODO: Preserve the original SSE JSON text if object serialization fidelity becomes necessary.
        b.append([...path, 'arguments'], serialized);
      }
    } else if (!['server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result', 'code_execution_tool_result', 'bash_code_execution_tool_result', 'text_editor_code_execution_tool_result', 'tool_search_tool_result', 'container_upload'].includes(block.type)) {
      throw new TypeError(`Cannot translate Messages content block ${block.type}`);
    }
    blocks.set(index, { path, type: block.type, custom, wrappedInput });
  };

  for await (const frame of frames) {
    if (frame.type === 'done') throw new Error('Messages done arrived without message_stop');
    const e = frame.event as unknown as Record<string, any>;
    switch (e.type) {
    case 'message_start':
      if (started) throw new Error('Duplicate Messages message_start');
      b.choice(0);
      b.assign(['model'], e.message.model);
      assignUsage(e.message.usage);
      b.event({ type: 'start', id: e.message.id });
      started = true;
      break;
    case 'content_block_start':
      if (!started) throw new Error('Messages content_block_start arrived before message_start');
      openBlock(e.index, e.content_block);
      break;
    case 'content_block_delta': {
      const block = blocks.get(e.index);
      if (block === undefined) throw new Error('Messages delta arrived before content_block_start');
      const d = e.delta;
      if (block.path === undefined) break;
      switch (d.type) {
      case 'text_delta':
        if (d.text !== '') b.append([...block.path, 'content', 0, 'text'], d.text);
        break;
      case 'thinking_delta':
        if (d.thinking !== '') b.append([...block.path, 'summary', 0], d.thinking);
        break;
      case 'signature_delta':
        b.assign([...block.path, 'encrypted_content'], d.signature);
        break;
      case 'input_json_delta':
        if (block.custom) block.wrappedInput += d.partial_json;
        else if (d.partial_json !== '') b.append([...block.path, 'arguments'], d.partial_json);
        break;
      case 'citations_delta': {
        const annotationsPath = [...block.path, 'content', 0, 'annotations'];
        const annotation = messagesCitationToIR(d.citation);
        const annotations = b.collector.value<readonly IRSourceCitation[] | null>(annotationsPath);
        if (annotations == null) b.assign(annotationsPath, [annotation]);
        else b.assign([...annotationsPath, annotations.length], annotation);
        break;
      }
      default: throw new TypeError(`Cannot translate Messages delta ${d.type}`);
      }
      break;
    }
    case 'content_block_stop': {
      const block = blocks.get(e.index);
      if (block === undefined) throw new Error('Messages content_block_stop arrived before content_block_start');
      blocks.delete(e.index);
      if (block.path !== undefined) {
        if (block.custom) {
          const input = unwrapCustomToolInput(block.wrappedInput);
          if (input !== '') b.append([...block.path, 'input'], input);
        }
        const item = block.path[3] as number;
        if (block.type === 'text') b.event({ type: 'part_end', choice: 0, item, part: 0 });
        b.event({ type: 'item_end', choice: 0, item });
      }
      break;
    }
    case 'message_delta':
      if (!started) throw new Error('Messages message_delta arrived before message_start');
      assignUsage(e.usage);
      if (e.delta.stop_reason === 'compaction') throw new TypeError('Cannot translate Messages compaction stop');
      if (e.delta.stop_reason === 'refusal') b.assign(['choices', 0, 'refusal'], { category: e.delta.stop_details?.category ?? null, explanation: e.delta.stop_details?.explanation ?? null });
      if (e.delta.stop_reason != null) finishReason = e.delta.stop_reason === 'max_tokens' || e.delta.stop_reason === 'model_context_window_exceeded' ? 'length' : e.delta.stop_reason === 'tool_use' ? 'tool_calls' : e.delta.stop_reason === 'refusal' ? 'content_filter' : 'stop';
      break;
    case 'message_stop':
      if (!started) throw new Error('Messages message_stop arrived before message_start');
      if (blocks.size > 0) throw new Error('Messages message_stop arrived with open content blocks');
      b.event({ type: 'choice_end', choice: 0, finish_reason: finishReason });
      b.event({ type: 'finish', status: finishReason === 'length' ? 'incomplete' : 'completed' });
      finished = true;
      break;
    case 'error':
      b.event({ type: 'error', error: e.error });
      yield b.drain();
      return;
    case 'ping':
      b.event({ type: 'ping' });
      break;
    }
    yield b.drain();
    if (finished) return;
  }
  throw new Error('Messages stream ended without message_stop');
};
