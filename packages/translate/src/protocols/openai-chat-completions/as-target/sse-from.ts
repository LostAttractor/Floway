import { usageToIR } from './usage.ts';
import { createIRBuilder, reconcileIRValue, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import type { IRMessageItem } from '../../../ir/types.ts';
import { codePointRangeToIR } from '../../../shared/coordinates.ts';
import { unwrapCustomToolInput } from '../../openai-responses/as-source/custom-tool-wrap.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

interface OpenAIChatCompletionsToolState { item?: number; id?: string; name: string; arguments: string; hasArguments: boolean; argumentsPublished: boolean; custom: boolean; wrapped: boolean }
interface OpenAIChatCompletionsTextSpan { item: number; part: number; start: number; end: number }
type OpenAIChatCompletionsReasoningField = 'reasoning' | 'reasoning_text' | 'reasoning_content';

interface OpenAIChatCompletionsChoiceState {
  reasoningField?: OpenAIChatCompletionsReasoningField;
  message?: number;
  text?: number;
  refusal?: number;
  audio?: number;
  reasoning?: number;
  tools: Map<number, OpenAIChatCompletionsToolState>;
  currentTool?: OpenAIChatCompletionsToolState;
  annotations: Record<string, any>[];
  contentText: string;
  textSpans: OpenAIChatCompletionsTextSpan[];
  logprobPaths: Map<string, IRPath>;
  closed: Set<number>;
  ended: boolean;
  incomplete: boolean;
}

export const irFromOpenAIChatCompletions = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  options: { customToolNames?: ReadonlySet<string> } = {},
): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  const choices = new Map<number, OpenAIChatCompletionsChoiceState>();
  b.initialize(['extensions', 'openaiChatCompletions'], {});
  let started = false;
  const initializeItem = (index: number, value: Record<string, any>): number => {
    const position = b.state.choices[index].items.length;
    const path: IRPath = ['choices', index, 'items', position];
    b.initialize(path, value);
    b.assign([...path, 'type'], value.type);
    b.event({ type: 'item_start', choice: index, item: position });
    return position;
  };
  const syncAnnotations = (index: number, choice: OpenAIChatCompletionsChoiceState): void => {
    const citations = choice.annotations.map(annotation => ({ annotation, range: codePointRangeToIR(choice.contentText, annotation.url_citation.start_index, annotation.url_citation.end_index) }));
    for (const span of choice.textSpans) {
      const annotations = citations.flatMap(({ annotation, range }) => {
        const start = Math.max(range.start, span.start);
        const end = Math.min(range.end_exclusive, span.end);
        return start >= end ? [] : [{ type: 'source_citation', source_kind: 'url', source: annotation.url_citation.url, source_label: annotation.url_citation.title, output_text_range: { start: start - span.start, end_exclusive: end - span.start } }];
      });
      const part = (b.state.choices[index].items[span.item] as IRMessageItem).content[span.part];
      if (part.type !== 'text') throw new TypeError('ChatCompletions citation span requires a text part');
      if (annotations.length > 0 || part.annotations !== undefined) reconcileIRValue(b, ['choices', index, 'items', span.item, 'content', span.part, 'annotations'], part.annotations, annotations);
    }
  };
  const closeItem = (index: number, choice: OpenAIChatCompletionsChoiceState, item: number, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.closed.has(item)) return;
    const value = b.state.choices[index].items[item];
    if (value.type === 'message') for (let p = 0; p < value.content.length; p++) b.event({ type: 'part_end', choice: index, item, part: p });
    b.event({ type: 'item_end', choice: index, item, status });
    choice.closed.add(item);
  };
  const closeMessage = (index: number, choice: OpenAIChatCompletionsChoiceState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.message === undefined) return;
    if (choice.annotations.length > 0) syncAnnotations(index, choice);
    closeItem(index, choice, choice.message, status);
    choice.message = choice.text = choice.refusal = choice.audio = undefined;
  };
  const closeReasoning = (index: number, choice: OpenAIChatCompletionsChoiceState): void => {
    if (choice.reasoning === undefined) return;
    closeItem(index, choice, choice.reasoning);
    choice.reasoning = undefined;
  };
  const closeTool = (index: number, choice: OpenAIChatCompletionsChoiceState, tool: OpenAIChatCompletionsToolState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (tool.item === undefined) throw new TypeError('Completed tool calls require a name');
    if (tool.id === undefined) throw new TypeError('Completed tool calls require an id');
    if (choice.closed.has(tool.item)) return;
    if (tool.wrapped) b.assign(['choices', index, 'items', tool.item, 'input'], unwrapCustomToolInput(tool.arguments));
    closeItem(index, choice, tool.item, status);
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
    for (const [key, value] of Object.entries(chunk)) if (!['choices', 'usage', 'object', 'obfuscation'].includes(key)) b.assign(['extensions', 'openaiChatCompletions', key], value);
    if (chunk.usage != null) {
      const usage = usageToIR(chunk.usage);
      b.assign(['usage'], { ...b.state.usage, ...usage });
    }
    if (!started) { b.event({ type: 'start', id: chunk.id, model: chunk.model, created: chunk.created }); started = true; }
    for (const entry of chunk.choices) {
      const index = entry.index as number;
      b.choice(index);
      let choice = choices.get(index);
      if (choice === undefined) { choice = { tools: new Map(), annotations: [], contentText: '', textSpans: [], logprobPaths: new Map(), closed: new Set(), ended: false, incomplete: false }; choices.set(index, choice); }
      const delta = entry.delta as Record<string, any>;
      const part = (kind: 'text' | 'refusal' | 'audio'): IRPath => {
        closeReasoning(index, choice!);
        choice!.message ??= initializeItem(index, { type: 'message', content: [] });
        const item = b.state.choices[index].items[choice!.message] as IRMessageItem;
        if (choice![kind] === undefined) {
          choice![kind] = item.content.length;
          const path: IRPath = ['choices', index, 'items', choice!.message, 'content', choice![kind]!];
          b.initialize(path, kind === 'audio' ? { type: 'audio', audio: { data: '', transcript: '' } } : { type: kind, [kind]: '' });
          b.assign([...path, 'type'], kind);
          b.event({ type: 'part_start', choice: index, item: choice!.message, part: choice![kind]! });
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
        choice.reasoning ??= initializeItem(index, { type: 'reasoning', summary: [''] });
        b.append(['choices', index, 'items', choice.reasoning, 'summary', 0], reasoningText);
      }
      if (delta.reasoning_opaque != null) {
        choice.reasoning ??= initializeItem(index, { type: 'reasoning', summary: [''] });
        b.assign(['choices', index, 'items', choice.reasoning, 'encrypted_content'], delta.reasoning_opaque);
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        const path = part('text');
        const start = choice.contentText.length;
        choice.contentText += delta.content;
        b.append([...path, 'text'], delta.content);
        const span = choice.textSpans.at(-1);
        if (span?.item === path[3] && span.part === path[5]) span.end = choice.contentText.length;
        else choice.textSpans.push({ item: path[3] as number, part: path[5] as number, start, end: choice.contentText.length });
      }
      if (typeof delta.refusal === 'string' && delta.refusal !== '') b.append([...part('refusal'), 'refusal'], delta.refusal);
      if (delta.audio != null) {
        const path = [...part('audio'), 'audio'];
        for (const field of ['data', 'transcript']) if (delta.audio[field] !== undefined) b.append([...path, field], delta.audio[field]);
        const metadata = { ...delta.audio }; delete metadata.data; delete metadata.transcript;
        const extension = b.state.extensions!.openaiChatCompletions as Record<string, any>;
        if (extension.choices === undefined) b.initialize(['extensions', 'openaiChatCompletions', 'choices'], []);
        for (let position = (b.state.extensions!.openaiChatCompletions as Record<string, any>).choices.length; position <= index; position++) b.initialize(['extensions', 'openaiChatCompletions', 'choices', position], { message: { audio: {} } });
        for (const [field, value] of Object.entries(metadata)) b.assign(['extensions', 'openaiChatCompletions', 'choices', index, 'message', 'audio', field], value);
      }
      if (delta.annotations != null) { choice.annotations = delta.annotations; syncAnnotations(index, choice); }
      if (entry.logprobs != null) {
        if (b.state.choices[index].logprobs == null) b.initialize(['choices', index, 'logprobs'], []);
        for (const kind of ['content', 'refusal']) if (entry.logprobs[kind]?.length > 0) {
          const path = choice.logprobPaths.get(kind);
          if (path === undefined) throw new TypeError('ChatCompletions logprobs require a matching text part');
          const groups = b.state.choices[index].logprobs!;
          let group = groups.findIndex(g => g.scope === 'text_part' && g.item_index === path[3] && g.content_index === path[5]);
          if (group < 0) {
            group = groups.length;
            b.initialize(['choices', index, 'logprobs', group], { tokens: [] });
            b.assign(['choices', index, 'logprobs', group, 'scope'], 'text_part');
            b.assign(['choices', index, 'logprobs', group, 'item_index'], path[3]);
            b.assign(['choices', index, 'logprobs', group, 'content_index'], path[5]);
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
          tool = { name: '', arguments: '', hasArguments: false, argumentsPublished: false, custom: call.type === 'custom' || call.custom !== undefined, wrapped: false };
          choice.tools.set(call.index, tool);
          choice.currentTool = tool;
        }
        const fn = call.custom ?? call.function;
        if (call.id !== undefined) tool.id = call.id;
        if (call.index === -1) tool.id ??= `${chunk.id}_${index}_function`;
        if (fn?.name !== undefined) tool.name = fn.name;
        const argument = fn?.arguments ?? fn?.input ?? '';
        if (fn?.arguments !== undefined || fn?.input !== undefined) tool.hasArguments = true;
        tool.arguments += argument;
        tool.wrapped = !tool.custom && options.customToolNames?.has(tool.name) === true;
        if (tool.item === undefined && tool.name !== '') {
          const custom = tool.custom || tool.wrapped;
          tool.item = initializeItem(index, custom ? { type: 'custom_tool_call', name: '', input: '' } : { type: 'function_call', name: '', arguments: '' });
          const path: IRPath = ['choices', index, 'items', tool.item];
          b.assign([...path, 'name'], tool.name);
          if (tool.id !== undefined) b.assign([...path, 'call_id'], tool.id);
          if (tool.hasArguments && !tool.wrapped) { b.assign([...path, custom ? 'input' : 'arguments'], tool.arguments); tool.argumentsPublished = true; }
        } else if (tool.item !== undefined) {
          const path: IRPath = ['choices', index, 'items', tool.item];
          if (tool.id !== undefined) b.assign([...path, 'call_id'], tool.id);
          b.assign([...path, 'name'], tool.name);
          if (!tool.wrapped && tool.hasArguments) {
            const field = tool.custom ? 'input' : 'arguments';
            if (tool.argumentsPublished) reconcileIRValue(b, [...path, field], (b.state.choices[index].items[tool.item] as Record<string, any>)[field], tool.arguments);
            else { b.assign([...path, field], tool.arguments); tool.argumentsPublished = true; }
          }
        }
      }
      if (entry.finish_reason != null) {
        closeMessage(index, choice, entry.finish_reason === 'length' ? 'incomplete' : 'completed');
        for (const tool of choice.tools.values()) closeTool(index, choice, tool, entry.finish_reason === 'length' ? 'incomplete' : 'completed');
        for (let item = 0; item < b.state.choices[index].items.length; item++) closeItem(index, choice, item, entry.finish_reason === 'length' ? 'incomplete' : 'completed');
        b.event({ type: 'choice_end', choice: index, finish_reason: entry.finish_reason === 'function_call' ? 'tool_calls' : entry.finish_reason });
        choice.ended = true;
        choice.incomplete = entry.finish_reason === 'length';
      }
    }
    yield b.drain();
  }
  yield finish();
};
