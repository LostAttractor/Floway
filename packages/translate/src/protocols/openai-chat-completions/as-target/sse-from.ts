import { usageToIR } from './usage.ts';
import { createIRBuilder, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import { IRNone, type IRMessageItem, type IRSourceCitation, type IRUsage } from '../../../ir/types.ts';
import { codePointRangeToIR } from '../../../shared/coordinates.ts';
import { unwrapCustomToolInput } from '../../openai-responses/as-source/custom-tool-wrap.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

interface ChatToolState {
  item?: number;
  id?: string;
  name: string;
  pendingInput: string;
  custom: boolean;
  wrapped: boolean;
}

type ChatReasoningField = 'reasoning' | 'reasoning_text' | 'reasoning_content';

interface ChatChoiceState {
  reasoningField?: ChatReasoningField;
  message?: number;
  text?: number;
  refusal?: number;
  audio?: number;
  reasoning?: number;
  readonly tools: Map<number, ChatToolState>;
  currentTool?: ChatToolState;
  readonly logprobPaths: Map<string, IRPath>;
  readonly logprobGroups: Map<string, number>;
  readonly closed: Set<number>;
  ended: boolean;
  incomplete: boolean;
}

export const irFromOpenAIChatCompletions = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  options: { customToolNames?: ReadonlySet<string> } = {},
): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  const choices = new Map<number, ChatChoiceState>();
  let started = false;

  const assignUsage = (usage: Record<string, any>): void => {
    const converted = usageToIR(usage);
    if (b.state.usage === undefined) b.initialize(['usage'], {});
    for (const [key, value] of Object.entries(converted) as [keyof IRUsage, number][]) b.assign(['usage', key], value);
  };

  const initializeItem = (choice: number, value: Record<string, any>): number => b.item(choice, value);

  const closeItem = (choiceIndex: number, choice: ChatChoiceState, item: number, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.closed.has(item)) return;
    const value = b.state.choices[choiceIndex].items[item];
    if (value.type === 'message') for (let part = 0; part < value.content.length; part++) b.event({ type: 'part_end', choice: choiceIndex, item, part });
    b.event({ type: 'item_end', choice: choiceIndex, item, status });
    choice.closed.add(item);
  };

  const applyAnnotations = (choiceIndex: number, annotations: readonly Record<string, any>[]): void => {
    const choice = b.state.choices[choiceIndex];
    const segments: { item: number; part: number; text: string; start: number; end: number }[] = [];
    let content = '';
    choice.items.forEach((item, itemIndex) => {
      if (item.type !== 'message') return;
      item.content.forEach((part, partIndex) => {
        if (part.type !== 'text') return;
        const start = content.length;
        content += part.text;
        segments.push({ item: itemIndex, part: partIndex, text: part.text, start, end: content.length });
      });
    });
    const citations = annotations.map(annotation => ({ annotation, range: codePointRangeToIR(content, annotation.url_citation.start_index, annotation.url_citation.end_index) }));
    for (const segment of segments) {
      const converted: IRSourceCitation[] = citations.flatMap(({ annotation, range }) => {
        const start = Math.max(range.start, segment.start);
        const end = Math.min(range.end_exclusive, segment.end);
        return start >= end ? [] : [{ type: 'source_citation', source_kind: 'url', source: annotation.url_citation.url, source_label: annotation.url_citation.title, output_text_range: { start: start - segment.start, end_exclusive: end - segment.start } }];
      });
      const path: IRPath = ['choices', choiceIndex, 'items', segment.item, 'content', segment.part, 'annotations'];
      if (converted.length > 0 || b.collector.value(path) !== undefined) b.assign(path, converted);
    }
  };

  const closeMessage = (choiceIndex: number, choice: ChatChoiceState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.message === undefined) return;
    closeItem(choiceIndex, choice, choice.message, status);
    choice.message = choice.text = choice.refusal = choice.audio = undefined;
  };

  const closeReasoning = (choiceIndex: number, choice: ChatChoiceState): void => {
    if (choice.reasoning === undefined) return;
    closeItem(choiceIndex, choice, choice.reasoning);
    choice.reasoning = undefined;
  };

  const closeTool = (choiceIndex: number, choice: ChatChoiceState, tool: ChatToolState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (tool.item === undefined) throw new TypeError('Completed tool calls require a name');
    if (choice.closed.has(tool.item)) return;
    if (tool.wrapped) {
      const input = unwrapCustomToolInput(tool.pendingInput);
      if (input !== '') b.append(['choices', choiceIndex, 'items', tool.item, 'input'], input);
    }
    closeItem(choiceIndex, choice, tool.item, status);
  };

  const finish = (): IRFrame => {
    if (!started) throw new Error('ChatCompletions stream ended without a response');
    for (const [index, choice] of choices) if (!choice.ended) throw new Error(`ChatCompletions choice ${index} ended without finish_reason`);
    b.event({ type: 'finish', status: [...choices.values()].some(choice => choice.incomplete) ? 'incomplete' : 'completed' });
    return b.drain();
  };

  for await (const frame of frames) {
    if (frame.type === 'done') { yield finish(); return; }
    const chunk = frame.event as unknown as Record<string, any>;
    if (chunk.error !== undefined) { b.event({ type: 'error', error: chunk.error }); yield b.drain(); return; }
    if (typeof chunk.model === 'string') b.assign(['model'], chunk.model);
    if (typeof chunk.service_tier === 'string') b.assign(['service_tier'], chunk.service_tier);
    if (chunk.usage != null) assignUsage(chunk.usage);
    if (!started) {
      if (typeof chunk.id !== 'string') throw new TypeError('ChatCompletions first chunk requires an id');
      b.event({ type: 'start', id: chunk.id, ...(chunk.created === undefined ? {} : { created: chunk.created }) });
      started = true;
    }

    for (const entry of chunk.choices) {
      const index = entry.index as number;
      b.choice(index);
      let choice = choices.get(index);
      if (choice === undefined) {
        choice = { tools: new Map(), logprobPaths: new Map(), logprobGroups: new Map(), closed: new Set(), ended: false, incomplete: false };
        choices.set(index, choice);
      }
      const delta = entry.delta as Record<string, any>;
      const part = (kind: 'text' | 'refusal' | 'audio'): IRPath => {
        closeReasoning(index, choice!);
        choice!.message ??= initializeItem(index, { type: 'message', content: [] });
        const item = b.state.choices[index].items[choice!.message] as IRMessageItem;
        if (choice![kind] === undefined) {
          choice![kind] = item.content.length;
          const path: IRPath = ['choices', index, 'items', choice!.message, 'content', choice![kind]!];
          b.initialize(path, kind === 'audio' ? { type: 'audio', audio: {} } : { type: kind, [kind]: '' });
        }
        const path: IRPath = ['choices', index, 'items', choice!.message, 'content', choice![kind]!];
        if (kind !== 'audio') choice!.logprobPaths.set(kind === 'text' ? 'content' : 'refusal', path);
        return path;
      };

      // Scalar fields are aliases; keep the first observed field for the choice.
      // https://github.com/OpenRouterTeam/docs/blob/8593a3e9d21db4ca3d4a2d92cc80ab989430e38e/guides/best-practices/reasoning-tokens.mdx#L495-L499
      choice.reasoningField ??= (['reasoning', 'reasoning_text', 'reasoning_content'] as const).find(key => typeof delta[key] === 'string');
      const reasoningText = choice.reasoningField === undefined ? undefined : delta[choice.reasoningField];
      if (typeof reasoningText === 'string' && reasoningText !== '') {
        closeMessage(index, choice);
        if (choice.reasoning === undefined) choice.reasoning = initializeItem(index, { type: 'reasoning', summary: [''] });
        else if ((b.state.choices[index].items[choice.reasoning] as any).summary === undefined) b.initialize(['choices', index, 'items', choice.reasoning, 'summary'], ['']);
        b.append(['choices', index, 'items', choice.reasoning, 'summary', 0], reasoningText);
      }
      if (delta.reasoning_opaque != null) {
        choice.reasoning ??= initializeItem(index, { type: 'reasoning' });
        b.assign(['choices', index, 'items', choice.reasoning, 'encrypted_content'], delta.reasoning_opaque);
      }
      if (typeof delta.content === 'string' && delta.content !== '') b.append([...part('text'), 'text'], delta.content);
      if (typeof delta.refusal === 'string' && delta.refusal !== '') b.append([...part('refusal'), 'refusal'], delta.refusal);
      if (delta.audio != null) {
        const path = [...part('audio'), 'audio'];
        for (const field of ['data', 'transcript'] as const) if (delta.audio[field] !== undefined) {
          if (b.collector.value([...path, field]) === undefined) b.initialize([...path, field], '');
          if (delta.audio[field] !== '') b.append([...path, field], delta.audio[field]);
        }
      }
      if (delta.annotations != null) applyAnnotations(index, delta.annotations);

      if (entry.logprobs != null) {
        if (b.state.choices[index].logprobs == null) b.initialize(['choices', index, 'logprobs'], []);
        for (const kind of ['content', 'refusal']) if (entry.logprobs[kind]?.length > 0) {
          const path = choice.logprobPaths.get(kind);
          if (path === undefined) throw new TypeError('ChatCompletions logprobs require a matching text part');
          const groups = b.state.choices[index].logprobs!;
          const owner = `${path[3]}/${path[5]}`;
          let group = choice.logprobGroups.get(owner);
          if (group === undefined) {
            group = groups.length;
            b.initialize(['choices', index, 'logprobs', group], { scope: 'text_part', item_index: path[3], content_index: path[5], tokens: [] });
            choice.logprobGroups.set(owner, group);
          }
          let length = b.state.choices[index].logprobs![group].tokens.length;
          for (const token of entry.logprobs[kind]) b.assign(['choices', index, 'logprobs', group, 'tokens', length++], token);
        }
      }

      const calls = [...(delta.tool_calls ?? []), ...(delta.function_call === undefined ? [] : [{ index: -1, type: 'function', function: delta.function_call }])];
      for (const call of calls) {
        let tool = choice.tools.get(call.index);
        if (tool?.item !== undefined && choice.closed.has(tool.item)) {
          console.warn('Ignoring ChatCompletions update for a closed tool call', { choice: index, tool: call.index });
          continue;
        }
        if (tool === undefined) {
          // ChatCompletions has no per-call completion frame. Infer function completion
          // from the next tool index; custom input remains open until choice completion.
          // A closed JSON object is not an end marker: malformed arguments may continue.
          // https://github.com/openai/openai-node/blob/2b12eabd29733c8de495bb183b41632e091b4994/src/lib/ChatCompletionStream.ts#L1457-L1475
          // https://github.com/openai/openai-node/blob/2b12eabd29733c8de495bb183b41632e091b4994/src/lib/ChatCompletionStream.ts#L1564-L1575
          // https://github.com/openai/openai-node/issues/265
          if (choice.currentTool !== undefined && !choice.currentTool.custom) closeTool(index, choice, choice.currentTool);
          closeMessage(index, choice);
          closeReasoning(index, choice);
          tool = { name: '', pendingInput: '', custom: call.type === 'custom' || call.custom !== undefined, wrapped: false };
          choice.tools.set(call.index, tool);
          choice.currentTool = tool;
        }
        const fn = call.custom ?? call.function;
        if (call.id !== undefined) tool.id = call.id;
        if (fn?.name !== undefined) tool.name = fn.name;
        const fragment = fn?.arguments ?? fn?.input;
        tool.wrapped = !tool.custom && options.customToolNames?.has(tool.name) === true;
        if (tool.item === undefined && fragment !== undefined) tool.pendingInput += fragment;

        if (tool.item === undefined && tool.name !== '') {
          // Every target needs the tool name before it can open the native structure.
          // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/lib/ChatCompletionStream.ts#L2059-L2107
          // https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/provider-utils/src/streaming-tool-call-tracker.ts#L356-L395
          const custom = tool.custom || tool.wrapped;
          const callId = call.index === -1 ? IRNone : tool.id;
          tool.item = initializeItem(index, custom
            ? { type: 'custom_tool_call', ...(callId === undefined ? {} : { call_id: callId }), name: tool.name, input: '' }
            : { type: 'function_call', ...(callId === undefined ? {} : { call_id: callId }), name: tool.name, arguments: '' });
          if (!tool.wrapped && tool.pendingInput !== '') {
            b.append(['choices', index, 'items', tool.item, custom ? 'input' : 'arguments'], tool.pendingInput);
            tool.pendingInput = '';
          }
        } else if (tool.item !== undefined) {
          const path: IRPath = ['choices', index, 'items', tool.item];
          const item = b.state.choices[index].items[tool.item];
          if (item.type !== 'function_call' && item.type !== 'custom_tool_call') throw new TypeError('ChatCompletions tool state points to a non-tool item');
          if (tool.id !== undefined && item.call_id === undefined) b.assign([...path, 'call_id'], tool.id);
          if (tool.name !== item.name) b.assign([...path, 'name'], tool.name);
          if (fragment !== undefined && fragment !== '' && !tool.wrapped) b.append([...path, tool.custom ? 'input' : 'arguments'], fragment);
          if (fragment !== undefined && tool.wrapped) tool.pendingInput += fragment;
        }
      }

      if (entry.finish_reason != null) {
        const status = entry.finish_reason === 'length' ? 'incomplete' : 'completed';
        closeMessage(index, choice, status);
        for (const tool of choice.tools.values()) closeTool(index, choice, tool, status);
        for (let item = 0; item < b.state.choices[index].items.length; item++) closeItem(index, choice, item, status);
        b.event({ type: 'choice_end', choice: index, finish_reason: entry.finish_reason === 'function_call' ? 'tool_calls' : entry.finish_reason });
        choice.ended = true;
        choice.incomplete = entry.finish_reason === 'length';
      }
    }
    yield b.drain();
  }
  yield finish();
};
