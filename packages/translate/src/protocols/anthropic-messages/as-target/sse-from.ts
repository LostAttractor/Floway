import { type AnthropicMessagesInputCounts, usageToIR } from './usage.ts';
import { createIRBuilder, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import type { IRSourceCitation } from '../../../ir/types.ts';
import { unwrapCustomToolInput } from '../../openai-responses/common/custom-tool-wrap.ts';
import type {
  AnthropicMessagesAssistantContentBlock,
  AnthropicMessagesStreamEventEx,
  AnthropicMessagesTextCitation,
  AnthropicMessagesUsageDeltaEx,
} from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const messagesCitationToIR = (citation: AnthropicMessagesTextCitation): IRSourceCitation | undefined => {
  const isSearchLocation = citation.type === 'web_search_result_location' || citation.type === 'search_result_location';
  const source = citation.type === 'web_search_result_location' ? citation.url
    : citation.type === 'search_result_location' ? citation.source : citation.file_id ?? undefined;
  const label = isSearchLocation ? citation.title : citation.document_title;
  const citedText = typeof citation.cited_text === 'string' && citation.cited_text !== '' ? citation.cited_text : undefined;
  if (source === undefined && citedText === undefined) return undefined;
  return {
    type: 'source_citation',
    source_kind: citation.type === 'web_search_result_location' ? 'url' : citation.type === 'search_result_location' ? 'search_result' : 'document',
    ...(source === undefined ? {} : { source }),
    ...(label == null ? {} : { source_label: label }),
    ...(citedText === undefined ? {} : {
      source_text: { text: citedText, granularity: 'exact_quote' as const },
    }),
    ...(citation.type === 'page_location'
      ? { source_page_range: { start_one_based: citation.start_page_number, end_one_based_exclusive: citation.end_page_number } }
      : {}),
  } as IRSourceCitation;
};

// Blocks that open no IR item; their content is not translated.
const UNTRANSLATED_BLOCK_TYPES: readonly string[] = [
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'container_upload',
];

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
  const ir = createIRBuilder();
  const blocks = new Map<number, MessagesBlockState>();
  let started = false;
  let finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' = 'stop';
  let finished = false;

  const inputCounts: AnthropicMessagesInputCounts = {};
  const assignUsage = (usage: Partial<AnthropicMessagesUsageDeltaEx>): void => {
    ir.usage(usageToIR(usage, inputCounts));
    const tier = usage.speed === 'fast' ? 'fast' : usage.service_tier;
    if (typeof tier === 'string') ir.assign(['service_tier'], tier);
  };

  const openBlock = (index: number, block: AnthropicMessagesAssistantContentBlock): void => {
    if (blocks.has(index)) throw new Error(`Duplicate Messages content_block_start at index ${index}`);
    let path: IRPath | undefined;
    let custom = false;
    if (block.type === 'fallback') {
      ir.assign(['model'], block.to.model);
    } else if (block.type === 'text') {
      const item = ir.item(0, { type: 'message', content: [] });
      path = ['choices', 0, 'items', item];
      const annotations = block.citations === undefined ? undefined : block.citations === null ? null : block.citations.flatMap(citation => {
        const converted = messagesCitationToIR(citation);
        return converted === undefined ? [] : [converted];
      });
      ir.initialize([...path, 'content', 0], { type: 'text', text: '', ...(annotations === undefined ? {} : { annotations }) });
      if (block.text !== '') ir.append([...path, 'content', 0, 'text'], block.text);
    } else if (block.type === 'thinking') {
      const item = ir.item(0, {
        type: 'reasoning',
        summary: [''],
        ...(block.signature === '' || block.signature === undefined ? {} : { encrypted_content: block.signature }),
      });
      path = ['choices', 0, 'items', item];
      if (block.thinking !== '') ir.append([...path, 'summary', 0], block.thinking);
    } else if (block.type === 'redacted_thinking') {
      const item = ir.item(0, { type: 'reasoning', encrypted_content: block.data });
      path = ['choices', 0, 'items', item];
    } else if (block.type === 'tool_use') {
      custom = options.customToolNames?.has(block.name) === true;
      const item = ir.item(0, custom
        ? { type: 'custom_tool_call', call_id: block.id, name: block.name, input: '' }
        : { type: 'function_call', call_id: block.id, name: block.name, arguments: '' });
      path = ['choices', 0, 'items', item];
    } else if (!UNTRANSLATED_BLOCK_TYPES.includes(block.type)) {
      throw new TypeError(`Cannot translate Messages content block ${block.type}`);
    }
    blocks.set(index, { path, type: block.type, custom, wrappedInput: '' });
  };

  for await (const frame of frames) {
    if (frame.type === 'done') throw new Error('Messages done arrived without message_stop');
    const e = frame.event;
    switch (e.type) {
    case 'message_start':
      if (started) throw new Error('Duplicate Messages message_start');
      if (typeof e.message.id !== 'string') throw new TypeError('Messages message_start requires an id');
      if (typeof e.message.model !== 'string') throw new TypeError('Messages message_start requires a model');
      ir.choice(0);
      ir.assign(['model'], e.message.model);
      assignUsage(e.message.usage);
      ir.event({ type: 'start', id: e.message.id });
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
        if (d.text !== '') ir.append([...block.path, 'content', 0, 'text'], d.text);
        break;
      case 'thinking_delta':
        if (d.thinking !== '') ir.append([...block.path, 'summary', 0], d.thinking);
        break;
      case 'signature_delta':
        ir.assign([...block.path, 'encrypted_content'], d.signature);
        break;
      case 'input_json_delta':
        if (block.custom) block.wrappedInput += d.partial_json;
        else if (d.partial_json !== '') ir.append([...block.path, 'arguments'], d.partial_json);
        break;
      case 'citations_delta': {
        const annotationsPath = [...block.path, 'content', 0, 'annotations'];
        const text = ir.collector.value<string>([...block.path, 'content', 0, 'text']);
        if (text === undefined) throw new TypeError('Messages citation requires a text block');
        const annotation = messagesCitationToIR(d.citation);
        if (annotation === undefined) break;
        const annotations = ir.collector.value<readonly IRSourceCitation[] | null>(annotationsPath);
        if (annotations == null) ir.assign(annotationsPath, [annotation]);
        else ir.assign([...annotationsPath, annotations.length], annotation);
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
          if (input !== '') ir.append([...block.path, 'input'], input);
        }
        const item = block.path[3] as number;
        if (block.type === 'text') ir.event({ type: 'part_end', choice: 0, item, part: 0 });
        ir.event({ type: 'item_end', choice: 0, item });
      }
      break;
    }
    case 'message_delta':
      if (!started) throw new Error('Messages message_delta arrived before message_start');
      assignUsage(e.usage);
      if (e.delta.stop_reason === 'compaction') throw new TypeError('Cannot translate Messages compaction stop');
      if (e.delta.stop_reason === 'refusal') {
        ir.assign(['choices', 0, 'refusal'], {
          category: e.delta.stop_details?.category ?? null,
          explanation: e.delta.stop_details?.explanation ?? null,
        });
      }
      if (e.delta.stop_reason != null) {
        const stopReason = e.delta.stop_reason;
        finishReason = stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded' ? 'length'
          : stopReason === 'tool_use' ? 'tool_calls'
            : stopReason === 'refusal' ? 'content_filter' : 'stop';
      }
      break;
    case 'message_stop':
      if (!started) throw new Error('Messages message_stop arrived before message_start');
      if (blocks.size > 0) throw new Error('Messages message_stop arrived with open content blocks');
      ir.event({ type: 'choice_end', choice: 0, finish_reason: finishReason });
      ir.event({ type: 'finish', status: finishReason === 'length' ? 'incomplete' : 'completed' });
      finished = true;
      break;
    case 'error':
      ir.event({ type: 'error', error: e.error });
      yield ir.drain();
      return;
    case 'ping':
      ir.event({ type: 'ping' });
      break;
    }
    yield ir.drain();
    if (finished) return;
  }
  throw new Error('Messages stream ended without message_stop');
};
