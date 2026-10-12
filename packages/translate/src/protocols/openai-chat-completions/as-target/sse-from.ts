import { usageToIR } from './usage.ts';
import { irItemPath, irPartPath } from '../../../ir/operation-paths.ts';
import { createIRBuilder, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import { IRNone, type IRErrorPayload, type IRMessageItem, type IRReasoningItem, type IRSourceCitation } from '../../../ir/types.ts';
import { codePointRangeToIR } from '../../../shared/coordinates.ts';
import { unwrapCustomToolInput } from '../../openai-responses/common/custom-tool-wrap.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  OpenAIChatCompletionsAnnotation,
  OpenAIChatCompletionsAssistantDeltaEx,
  OpenAIChatCompletionsLogprobs,
  OpenAIChatCompletionsStreamEvent,
  OpenAIChatCompletionsToolCallDeltaEx,
  OpenAIChatCompletionsUsageEx,
} from '@floway-dev/protocols/openai-chat-completions';

interface ChatToolState {
  item?: number;
  id?: string;
  name: string;
  pendingInput: string;
  custom: boolean;
  wrapped: boolean;
}

type ChatDelta = OpenAIChatCompletionsAssistantDeltaEx;
type ChatToolCall = OpenAIChatCompletionsToolCallDeltaEx;
type ChatChoiceEvent = Omit<OpenAIChatCompletionsStreamEvent['choices'][number], 'delta'> & {
  // Azure sends choices without a delta, and malformed upstreams send a non-object; both are checked at runtime.
  delta?: unknown;
};
type ChatChunk = Omit<OpenAIChatCompletionsStreamEvent, 'choices'> & { choices: ChatChoiceEvent[]; error?: IRErrorPayload };

const isDelta = (value: unknown): value is ChatDelta => value !== null && typeof value === 'object' && !Array.isArray(value);

type ChatReasoningField = 'reasoning' | 'reasoning_text' | 'reasoning_content';

const chatReasoningField = (delta: ChatDelta): ChatReasoningField | undefined =>
  typeof delta.reasoning === 'string' ? 'reasoning'
    : typeof delta.reasoning_text === 'string' ? 'reasoning_text'
      : typeof delta.reasoning_content === 'string' ? 'reasoning_content' : undefined;

// Tool calls and the legacy `function_call` delta share one shape check; the latter carries name and arguments directly.
interface ToolFragment { name?: string; arguments?: string; input?: string }
interface ToolCallFields extends ToolFragment {
  id?: string;
  custom?: ToolFragment;
  function?: ToolFragment;
}

const hasToolCallContent = (call: ToolCallFields): boolean => {
  const fn = call.custom ?? call.function ?? call;
  return typeof call.id === 'string' && call.id !== ''
    || typeof fn?.name === 'string' && fn.name !== ''
    || typeof fn?.arguments === 'string' && fn.arguments !== ''
    || typeof fn?.input === 'string' && fn.input !== '';
};

const hasDeltaContent = (delta: ChatDelta): boolean => {
  const calls = delta.tool_calls;
  const reasoningField = chatReasoningField(delta);
  return reasoningField !== undefined && delta[reasoningField] !== ''
    || delta.reasoning_opaque != null
    || typeof delta.content === 'string' && delta.content !== ''
    || typeof delta.refusal === 'string' && delta.refusal !== ''
    || delta.audio != null
    || Array.isArray(delta.annotations) && delta.annotations.length > 0
    || Array.isArray(calls) && calls.some(hasToolCallContent)
    || delta.function_call !== undefined && hasToolCallContent(delta.function_call);
};

const hasLogprobContent = (entry: ChatChoiceEvent): boolean =>
  (entry.logprobs?.content?.length ?? 0) > 0 || (entry.logprobs?.refusal?.length ?? 0) > 0;

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
  ended: boolean;
  incomplete: boolean;
}

export const irFromOpenAIChatCompletions = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  options: { customToolNames?: ReadonlySet<string>; maxChoices?: number } = {},
): AsyncGenerator<IRFrame> {
  const ir = createIRBuilder(options.maxChoices ?? 1);
  const choices = new Map<number, ChatChoiceState>();
  let started = false;

  const choiceState = (index: number): ChatChoiceState => {
    let choice = choices.get(index);
    if (choice === undefined) {
      choice = { tools: new Map(), logprobPaths: new Map(), logprobGroups: new Map(), ended: false, incomplete: false };
      choices.set(index, choice);
    }
    return choice;
  };

  const start = (chunk: ChatChunk): void => {
    if (started) return;
    ir.event({
      type: 'start',
      ...(typeof chunk.id === 'string' && chunk.id !== '' ? { id: chunk.id } : {}),
      ...(typeof chunk.created === 'number' ? { created: chunk.created } : {}),
    });
    started = true;
  };

  const startForContent = (chunk: ChatChunk): void => {
    if (started) return;
    if (ir.state.model === undefined) throw new TypeError('ChatCompletions content arrived before a non-empty model');
    start(chunk);
  };

  const assignUsage = (usage: OpenAIChatCompletionsUsageEx): void => {
    const converted = usageToIR(usage);
    if (!started && ir.state.model === undefined) throw new TypeError('ChatCompletions usage arrived before a non-empty model');
    ir.usage(converted);
  };

  const closeItem = (choiceIndex: number, item: number, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (!ir.collector.isOpen(irItemPath(choiceIndex, item))) return;
    const value = ir.state.choices[choiceIndex].items[item];
    if (value.type === 'message') for (let part = 0; part < value.content.length; part++) ir.event({ type: 'part_end', choice: choiceIndex, item, part });
    ir.event({ type: 'item_end', choice: choiceIndex, item, status });
  };

  const applyAnnotations = (choiceIndex: number, annotations: readonly OpenAIChatCompletionsAnnotation[]): void => {
    const choice = ir.state.choices[choiceIndex];
    const state = choices.get(choiceIndex)!;
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
    const availableCodePoints = [...content].length;
    const citations = annotations.map(annotation => {
      const native = annotation.url_citation;
      if (!Number.isInteger(native.start_index) || !Number.isInteger(native.end_index) || native.start_index < 0 || native.end_index < native.start_index) {
        throw new RangeError('Invalid code-point range');
      }
      const start = Math.min(native.start_index, availableCodePoints);
      const end = Math.min(native.end_index, availableCodePoints);
      return { annotation, range: codePointRangeToIR(content, start, end), exceedsAvailableText: native.end_index > availableCodePoints };
    });
    const openSegments = segments.filter(segment => segment.item === state.message && ir.collector.isOpen(irItemPath(choiceIndex, segment.item)));
    for (const segment of openSegments) {
      const converted: IRSourceCitation[] = citations.flatMap(({ annotation, range }) => {
        const start = Math.max(range.start, segment.start);
        const end = Math.min(range.end_exclusive, segment.end);
        if (start >= end) return [];
        return [{
          type: 'source_citation',
          source_kind: 'url',
          source: annotation.url_citation.url,
          source_label: annotation.url_citation.title,
          output_text_range: { start: start - segment.start, end_exclusive: end - segment.start },
        }];
      });
      const path: IRPath = ['choices', choiceIndex, 'items', segment.item, 'content', segment.part, 'annotations'];
      if (converted.length > 0 || ir.collector.value(path) !== undefined) ir.assign(path, converted);
    }
    for (const { annotation, range, exceedsAvailableText } of citations) {
      const retained = openSegments.reduce(
        (length, segment) => length + Math.max(0, Math.min(range.end_exclusive, segment.end) - Math.max(range.start, segment.start)),
        0,
      );
      if (retained === range.end_exclusive - range.start && !exceedsAvailableText) continue;
      const message = retained === 0 ? 'Dropping ChatCompletions citation outside open text' : 'Clamping ChatCompletions citation to open text';
      console.warn(message, { choice: choiceIndex, citation: annotation });
    }
  };

  const closeMessage = (choiceIndex: number, choice: ChatChoiceState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.message === undefined) return;
    closeItem(choiceIndex, choice.message, status);
    choice.message = choice.text = choice.refusal = choice.audio = undefined;
  };

  const closeReasoning = (choiceIndex: number, choice: ChatChoiceState): void => {
    if (choice.reasoning === undefined) return;
    closeItem(choiceIndex, choice.reasoning);
    choice.reasoning = undefined;
  };

  const closeTool = (choiceIndex: number, tool: ChatToolState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (tool.item === undefined) throw new TypeError('Completed tool calls require a name');
    if (!ir.collector.isOpen(irItemPath(choiceIndex, tool.item))) return;
    if (tool.wrapped) {
      const input = unwrapCustomToolInput(tool.pendingInput);
      if (input !== '') ir.append([...irItemPath(choiceIndex, tool.item), 'input'], input);
    }
    closeItem(choiceIndex, tool.item, status);
  };

  const finish = (): IRFrame => {
    if (!started) throw new Error('ChatCompletions stream ended without a response');
    for (const [index, choice] of choices) if (!choice.ended) throw new Error(`ChatCompletions choice ${index} ended without finish_reason`);
    ir.event({ type: 'finish', status: [...choices.values()].some(choice => choice.incomplete) ? 'incomplete' : 'completed' });
    return ir.drain();
  };

  // The open part of this kind in the choice's message, created on first use.
  const messagePart = (index: number, choice: ChatChoiceState, kind: 'text' | 'refusal' | 'audio'): IRPath => {
    closeReasoning(index, choice);
    choice.message ??= ir.item(index, { type: 'message', content: [] });
    if (choice[kind] === undefined) {
      const message = ir.state.choices[index].items[choice.message] as IRMessageItem;
      choice[kind] = message.content.length;
      ir.initialize(irPartPath(index, choice.message, choice[kind]!), kind === 'audio' ? { type: 'audio', audio: {} } : { type: kind, [kind]: '' });
    }
    const path = irPartPath(index, choice.message, choice[kind]!);
    if (kind !== 'audio') choice.logprobPaths.set(kind === 'text' ? 'content' : 'refusal', path);
    return path;
  };

  const readReasoning = (index: number, choice: ChatChoiceState, delta: ChatDelta): void => {
    const text = choice.reasoningField === undefined ? undefined : delta[choice.reasoningField];
    if (typeof text === 'string' && text !== '') {
      closeMessage(index, choice);
      if (choice.reasoning === undefined) choice.reasoning = ir.item(index, { type: 'reasoning', summary: [''] });
      else if ((ir.state.choices[index].items[choice.reasoning] as IRReasoningItem).summary === undefined) {
        ir.initialize([...irItemPath(index, choice.reasoning), 'summary'], ['']);
      }
      ir.append([...irItemPath(index, choice.reasoning), 'summary', 0], text);
    }
    if (delta.reasoning_opaque != null) {
      choice.reasoning ??= ir.item(index, { type: 'reasoning' });
      ir.assign([...irItemPath(index, choice.reasoning), 'encrypted_content'], delta.reasoning_opaque);
    }
  };

  const readMessage = (index: number, choice: ChatChoiceState, delta: ChatDelta): void => {
    if (typeof delta.content === 'string' && delta.content !== '') ir.append([...messagePart(index, choice, 'text'), 'text'], delta.content);
    if (typeof delta.refusal === 'string' && delta.refusal !== '') ir.append([...messagePart(index, choice, 'refusal'), 'refusal'], delta.refusal);
    if (delta.audio != null) {
      const path = [...messagePart(index, choice, 'audio'), 'audio'];
      for (const field of ['data', 'transcript'] as const) {
        if (delta.audio[field] === undefined) continue;
        if (ir.collector.value([...path, field]) === undefined) ir.initialize([...path, field], '');
        if (delta.audio[field] !== '') ir.append([...path, field], delta.audio[field]);
      }
    }
    if (delta.annotations != null) applyAnnotations(index, delta.annotations);
  };

  const readLogprobs = (index: number, choice: ChatChoiceState, logprobs: OpenAIChatCompletionsLogprobs): void => {
    if (ir.state.choices[index].logprobs == null) ir.initialize(['choices', index, 'logprobs'], []);
    for (const kind of ['content', 'refusal'] as const) {
      const tokens = logprobs[kind];
      if (tokens == null || tokens.length === 0) continue;
      const path = choice.logprobPaths.get(kind);
      if (path === undefined) throw new TypeError('ChatCompletions logprobs require a matching text part');
      const owner = `${path[3]}/${path[5]}`;
      let group = choice.logprobGroups.get(owner);
      if (group === undefined) {
        group = ir.state.choices[index].logprobs!.length;
        ir.initialize(['choices', index, 'logprobs', group], { scope: 'text_part', item_index: path[3], content_index: path[5], tokens: [] });
        choice.logprobGroups.set(owner, group);
      }
      let length = ir.state.choices[index].logprobs![group].tokens.length;
      for (const token of tokens) ir.assign(['choices', index, 'logprobs', group, 'tokens', length++], token);
    }
  };

  const readToolCall = (index: number, choice: ChatChoiceState, call: ChatToolCall): void => {
    let tool = choice.tools.get(call.index);
    if (tool?.item !== undefined && !ir.collector.isOpen(irItemPath(index, tool.item))) {
      console.warn('Ignoring ChatCompletions update for a closed tool call', { choice: index, tool: call.index });
      return;
    }
    if (tool === undefined) {
      // ChatCompletions has no per-call completion frame. Infer function completion
      // from the next tool index; custom input remains open until choice completion.
      // A syntactically closed JSON prefix is not an end marker: completed calls have
      // contained malformed concatenated objects.
      // https://github.com/openai/openai-node/blob/2b12eabd29733c8de495bb183b41632e091b4994/src/lib/ChatCompletionStream.ts#L1457-L1475
      // https://github.com/openai/openai-node/blob/2b12eabd29733c8de495bb183b41632e091b4994/src/lib/ChatCompletionStream.ts#L1564-L1575
      // https://github.com/openai/openai-node/issues/265
      if (choice.currentTool !== undefined && !choice.currentTool.custom) closeTool(index, choice.currentTool);
      closeMessage(index, choice);
      closeReasoning(index, choice);
      tool = { name: '', pendingInput: '', custom: call.type === 'custom' || call.custom !== undefined, wrapped: false };
      choice.tools.set(call.index, tool);
      choice.currentTool = tool;
    }
    const fn: ToolFragment | undefined = call.custom ?? call.function;
    if (call.id !== undefined) tool.id = call.id;
    if (fn?.name !== undefined) tool.name = fn.name;
    const fragment = fn?.arguments ?? fn?.input;
    tool.wrapped = !tool.custom && options.customToolNames?.has(tool.name) === true;
    if (tool.item === undefined && fragment !== undefined) tool.pendingInput += fragment;

    if (tool.item === undefined && tool.name !== '') {
      // Waiting here delays no supported target: Messages and Responses need the name when
      // the structure opens, while GenerateContent emits only complete calls. Planned
      // Interactions support has the same step.start requirement:
      // https://ai.google.dev/gemini-api/docs/streaming
      // The official ChatCompletions SDK tolerates a late name:
      // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/lib/ChatCompletionStream.ts#L2059-L2107
      // Clients such as the Vercel AI SDK reject a first tool delta without one:
      // https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/provider-utils/src/streaming-tool-call-tracker.ts#L356-L395
      const custom = tool.custom || tool.wrapped;
      const callId = call.index === -1 ? IRNone : tool.id;
      tool.item = ir.item(index, custom
        ? { type: 'custom_tool_call', ...(callId === undefined ? {} : { call_id: callId }), name: tool.name, input: '' }
        : { type: 'function_call', ...(callId === undefined ? {} : { call_id: callId }), name: tool.name, arguments: '' });
      if (!tool.wrapped && tool.pendingInput !== '') {
        ir.append([...irItemPath(index, tool.item), custom ? 'input' : 'arguments'], tool.pendingInput);
        tool.pendingInput = '';
      }
    } else if (tool.item !== undefined) {
      const path = irItemPath(index, tool.item);
      const item = ir.state.choices[index].items[tool.item];
      if (item.type !== 'function_call' && item.type !== 'custom_tool_call') throw new TypeError('ChatCompletions tool state points to a non-tool item');
      if (tool.id !== undefined && item.call_id === undefined) ir.assign([...path, 'call_id'], tool.id);
      if (tool.name !== item.name) ir.assign([...path, 'name'], tool.name);
      if (fragment !== undefined && fragment !== '' && !tool.wrapped) ir.append([...path, tool.custom ? 'input' : 'arguments'], fragment);
      if (fragment !== undefined && tool.wrapped) tool.pendingInput += fragment;
    }
  };

  const endChoice = (index: number, choice: ChatChoiceState, finishReason: string): void => {
    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    closeMessage(index, choice, status);
    for (const tool of choice.tools.values()) closeTool(index, tool, status);
    for (let item = 0; item < ir.state.choices[index].items.length; item++) closeItem(index, item, status);
    ir.event({
      type: 'choice_end',
      choice: index,
      finish_reason: finishReason === 'function_call' ? 'tool_calls' : finishReason as 'stop' | 'length' | 'tool_calls' | 'content_filter',
    });
    choice.ended = true;
    choice.incomplete = finishReason === 'length';
  };

  const readChoice = (chunk: ChatChunk, entry: ChatChoiceEvent): void => {
    const index = entry.index as number;
    const nativeDelta = entry.delta;
    const deltaIsObject = isDelta(nativeDelta);
    const delta: ChatDelta = deltaIsObject ? nativeDelta : {};
    const hasContent = hasDeltaContent(delta) || hasLogprobContent(entry);
    if (choices.get(index)?.ended) {
      if (hasContent) console.warn('Ignoring ChatCompletions content for a closed choice', { choice: index });
      return;
    }
    if (nativeDelta != null && !deltaIsObject) throw new TypeError('ChatCompletions choice delta must be an object');

    const choice = choiceState(index);
    // Scalar reasoning fields are aliases; keep the first observed field for the choice.
    // https://github.com/OpenRouterTeam/docs/blob/8593a3e9d21db4ca3d4a2d92cc80ab989430e38e/guides/best-practices/reasoning-tokens.mdx#L495-L499
    choice.reasoningField ??= chatReasoningField(delta);
    if (!hasContent && entry.finish_reason == null) return;

    startForContent(chunk);
    ir.choice(index);
    readReasoning(index, choice, delta);
    readMessage(index, choice, delta);
    if (entry.logprobs != null) readLogprobs(index, choice, entry.logprobs);
    const calls = [
      ...(delta.tool_calls ?? []),
      ...(delta.function_call === undefined ? [] : [{ index: -1, type: 'function' as const, function: delta.function_call }]),
    ];
    for (const call of calls) readToolCall(index, choice, call);
    if (entry.finish_reason != null) endChoice(index, choice, entry.finish_reason);
  };

  for await (const frame of frames) {
    if (frame.type === 'done') { yield finish(); return; }
    const chunk: ChatChunk = frame.event;
    if (chunk.error !== undefined) { ir.event({ type: 'error', error: chunk.error }); yield ir.drain(); return; }
    const model = typeof chunk.model === 'string' && chunk.model !== '' ? chunk.model : undefined;
    if (model !== undefined) ir.assign(['model'], model);
    if (typeof chunk.service_tier === 'string') ir.assign(['service_tier'], chunk.service_tier);
    if (chunk.usage != null) assignUsage(chunk.usage);
    if (!started && model !== undefined) start(chunk);

    // OpenAI specifies stable id/created, a fixed object discriminator, and a delta on each choice.
    // Azure sends blank-identity prompt/filter frames and choices without delta:
    // https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/content-streaming
    // https://github.com/dotnet/extensions/issues/7812
    // https://github.com/dotnet/extensions/issues/7790
    // Copilot omits object, varies created, and begins with an empty-id prompt frame; redacted probe evidence:
    // https://github.com/Menci/Floway/pull/594#issuecomment-6129531836
    for (const entry of chunk.choices) readChoice(chunk, entry);
    yield ir.drain();
  }
  yield finish();
};
