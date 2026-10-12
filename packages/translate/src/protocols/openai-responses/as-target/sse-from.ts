import { usageToIR } from './usage.ts';
import { createIRBuilder, type IRFrame, type IRPath } from '../../../ir/stream.ts';
import type { IRSourceCitation, IRTokenLogprob, IRUsage } from '../../../ir/types.ts';
import { codePointRangeToIR } from '../../../shared/coordinates.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

interface ResponsesItemState {
  readonly outputIndex: number;
  readonly type: string;
  readonly id: string;
  readonly path?: IRPath;
  readonly content: Map<number, number>;
  readonly logprobs: Map<number, number>;
}

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  const leftEntries = Object.entries(left);
  const rightObject = right as Record<string, unknown>;
  return leftEntries.length === Object.keys(rightObject).length && leftEntries.every(([key, value]) => Object.hasOwn(rightObject, key) && deepEqual(value, rightObject[key]));
};

const annotationToIR = (partText: string, annotation: Record<string, any>): IRSourceCitation | undefined => {
  if (annotation.type === 'url_citation') return { type: 'source_citation', source_kind: 'url', source: annotation.url, source_label: annotation.title, output_text_range: codePointRangeToIR(partText, annotation.start_index, annotation.end_index) };
  if (annotation.type === 'file_citation') return { type: 'source_citation', source_kind: 'document', source: annotation.file_id, source_label: annotation.filename };
  if (annotation.type === 'container_file_citation') return { type: 'source_citation', source_kind: 'document', source: annotation.file_id, source_label: annotation.filename, output_text_range: codePointRangeToIR(partText, annotation.start_index, annotation.end_index) };
  if (annotation.type === 'file_path') return { type: 'source_citation', source_kind: 'document', source: annotation.file_id };
  return undefined;
};

const isTranslatedItem = (type: string): boolean => ['message', 'reasoning', 'function_call', 'custom_tool_call', 'image_generation_call'].includes(type);

export const irFromOpenAIResponses = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
): AsyncGenerator<IRFrame> {
  const b = createIRBuilder();
  const open = new Map<number, ResponsesItemState>();
  const announced = new Set<number>();
  let started = false;
  let finished = false;
  let audioItem: number | undefined;
  const audioDone = new Set<'data' | 'transcript'>();

  const assignUsage = (usage: Record<string, any>): void => {
    const converted = usageToIR(usage);
    if (b.state.usage === undefined) b.initialize(['usage'], {});
    for (const [key, value] of Object.entries(converted) as [keyof IRUsage, number][]) b.assign(['usage', key], value);
  };

  const responseMetadata = (response: Record<string, any>): void => {
    if (typeof response.model === 'string') b.assign(['model'], response.model);
    if (typeof response.service_tier === 'string') b.assign(['service_tier'], response.service_tier);
    if (response.usage != null) assignUsage(response.usage);
  };

  const openItem = (outputIndex: number, item: Record<string, any>): ResponsesItemState => {
    if (open.has(outputIndex) || announced.has(outputIndex)) throw new Error(`Duplicate Responses output_item.added at index ${outputIndex}`);
    if (typeof item.id !== 'string') throw new TypeError('Responses output items require an id');
    announced.add(outputIndex);
    let path: IRPath | undefined;
    if (isTranslatedItem(item.type)) {
      let value: Record<string, any>;
      if (item.type === 'message' || item.type === 'image_generation_call') value = { type: 'message', content: [] };
      else if (item.type === 'reasoning') value = { type: 'reasoning', id: item.id };
      else if (item.type === 'function_call') value = { type: 'function_call', ...(item.call_id === undefined ? {} : { call_id: item.call_id }), name: item.name, arguments: '' };
      else value = { type: 'custom_tool_call', ...(item.call_id === undefined ? {} : { call_id: item.call_id }), name: item.name, input: '' };
      const position = b.item(0, value);
      path = ['choices', 0, 'items', position];
    }
    const state = { outputIndex, type: item.type, id: item.id, path, content: new Map(), logprobs: new Map() };
    open.set(outputIndex, state);
    return state;
  };

  const requireItem = (outputIndex: number): ResponsesItemState => {
    const item = open.get(outputIndex);
    if (item === undefined) throw new Error(`Responses event arrived before its output item at index ${outputIndex}`);
    return item;
  };

  const validateSnapshotIdentity = (state: ResponsesItemState, item: Record<string, any>): void => {
    if (item.type !== state.type) throw new TypeError(`Responses output item type changed from ${state.type} to ${item.type}`);
    if (item.id !== state.id) throw new TypeError(`Responses output item id changed from ${state.id} to ${String(item.id)}`);
  };

  const reconcileAppend = (path: IRPath, snapshot: string | undefined): void => {
    const current = b.collector.value<string>(path);
    // Responses done events are final snapshots in the official SDK. We append a
    // missing suffix, including Azure's done-only reasoning summaries.
    // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/internal/responses/response-accumulator.ts#L836-L858
    // https://github.com/langchain-ai/langchain/issues/37625
    // Codex can send an empty done snapshot after streaming the actual text; an
    // empty snapshot therefore carries no replacement value.
    // https://github.com/can1357/oh-my-pi/issues/5146
    // https://github.com/can1357/oh-my-pi/pull/5149
    if ((snapshot === undefined || snapshot === '') && current !== undefined && current !== '') return;
    if (snapshot === undefined || current === snapshot) return;
    if (current === undefined) {
      b.initialize(path, '');
      if (snapshot !== '') b.append(path, snapshot);
      return;
    }
    if (!snapshot.startsWith(current)) throw new TypeError(`Responses snapshot cannot replace streamed text at ${JSON.stringify(path)}`);
    const suffix = snapshot.slice(current.length);
    if (suffix !== '') b.append(path, suffix);
  };

  const reconcileAssign = (path: IRPath, snapshot: unknown): void => {
    if (snapshot === undefined) return;
    const current = b.collector.value(path);
    if (current === undefined) b.assign(path, snapshot);
    else if (!deepEqual(current, snapshot)) throw new TypeError(`Responses snapshot conflicts with streamed value at ${JSON.stringify(path)}`);
  };

  const ensureReasoningText = (state: ResponsesItemState, field: 'summary' | 'content', index: number): IRPath => {
    if (state.path === undefined || state.type !== 'reasoning') throw new TypeError('Responses reasoning text requires a reasoning item');
    const arrayPath = [...state.path, field];
    if (b.collector.value(arrayPath) === undefined) b.initialize(arrayPath, []);
    const array = b.collector.value<readonly string[]>(arrayPath)!;
    if (index > array.length) throw new TypeError(`Responses ${field} index is not contiguous`);
    if (index === array.length) b.initialize([...arrayPath, index], '');
    return [...arrayPath, index];
  };

  const ensureMessagePart = (state: ResponsesItemState, contentIndex: number, part: Record<string, any>): IRPath => {
    if (state.path === undefined || state.type !== 'message') throw new TypeError('Responses content part requires a message item');
    let partIndex = state.content.get(contentIndex);
    if (partIndex === undefined) {
      const item = b.collector.value<any>(state.path)!;
      const nextPart = item.content.length as number;
      if (contentIndex !== state.content.size) throw new TypeError('Responses content indexes must be contiguous');
      if (part.type === 'output_text') b.initialize([...state.path, 'content', nextPart], { type: 'text', text: '', ...(part.annotations === undefined ? {} : { annotations: [] }) });
      else if (part.type === 'refusal') b.initialize([...state.path, 'content', nextPart], { type: 'refusal', refusal: '' });
      else throw new TypeError(`Responses message cannot contain ${part.type}`);
      state.content.set(contentIndex, nextPart);
      partIndex = nextPart;
    }
    return [...state.path, 'content', partIndex];
  };

  const ensureLogprobGroup = (state: ResponsesItemState, contentIndex: number, partPath: IRPath): number => {
    let group = state.logprobs.get(contentIndex);
    if (group !== undefined) return group;
    if (b.state.choices[0].logprobs === undefined) b.initialize(['choices', 0, 'logprobs'], []);
    group = b.state.choices[0].logprobs!.length;
    b.initialize(['choices', 0, 'logprobs', group], { scope: 'text_part', item_index: state.path![3], content_index: partPath[5], tokens: [] });
    state.logprobs.set(contentIndex, group);
    return group;
  };

  const reconcileLogprobs = (state: ResponsesItemState, contentIndex: number, partPath: IRPath, tokens: readonly IRTokenLogprob[] | undefined): void => {
    if (tokens === undefined || tokens.length === 0) return;
    const group = ensureLogprobGroup(state, contentIndex, partPath);
    const target = ['choices', 0, 'logprobs', group, 'tokens'] as const;
    const current = b.collector.value<readonly IRTokenLogprob[]>(target)!;
    tokens.forEach((token, index) => reconcileAssign([...target, index], token));
    if (tokens.length < current.length) return;
  };

  const reconcileAnnotations = (path: IRPath, text: string, annotations: readonly (Record<string, any> | null)[] | undefined): void => {
    if (annotations === undefined) return;
    const target = [...path, 'annotations'];
    if (b.collector.value(target) === undefined) b.assign(target, []);
    const converted = annotations.flatMap(annotation => {
      if (annotation === null) return [];
      const value = annotationToIR(text, annotation);
      return value === undefined ? [] : [value];
    });
    converted.forEach((annotation, index) => reconcileAssign([...target, index], annotation));
  };

  const reconcilePart = (state: ResponsesItemState, contentIndex: number, part: Record<string, any>): void => {
    if (state.type === 'message') {
      const path = ensureMessagePart(state, contentIndex, part);
      if (part.type === 'output_text') {
        reconcileAppend([...path, 'text'], part.text);
        reconcileAnnotations(path, part.text, part.annotations);
        reconcileLogprobs(state, contentIndex, path, part.logprobs);
      } else reconcileAppend([...path, 'refusal'], part.refusal);
    } else if (state.type === 'reasoning') {
      if (part.type !== 'reasoning_text') throw new TypeError(`Responses reasoning cannot contain ${part.type}`);
      reconcileAppend(ensureReasoningText(state, 'content', contentIndex), part.text);
    }
  };

  const reconcileItem = (state: ResponsesItemState, item: Record<string, any>, includeEncrypted: boolean): void => {
    validateSnapshotIdentity(state, item);
    if (state.path === undefined) return;
    if (item.type === 'message') item.content?.forEach((part: Record<string, any>, index: number) => reconcilePart(state, index, part));
    else if (item.type === 'reasoning') {
      item.summary?.forEach((part: Record<string, any>, index: number) => reconcileAppend(ensureReasoningText(state, 'summary', index), part.text));
      item.content?.forEach((part: Record<string, any>, index: number) => reconcileAppend(ensureReasoningText(state, 'content', index), part.text));
      if (includeEncrypted) reconcileAssign([...state.path, 'encrypted_content'], item.encrypted_content);
    } else if (item.type === 'function_call') {
      reconcileAssign([...state.path, 'call_id'], item.call_id);
      reconcileAssign([...state.path, 'name'], item.name);
      reconcileAppend([...state.path, 'arguments'], item.arguments);
    } else if (item.type === 'custom_tool_call') {
      reconcileAssign([...state.path, 'call_id'], item.call_id);
      reconcileAssign([...state.path, 'name'], item.name);
      reconcileAppend([...state.path, 'input'], item.input);
    } else if (item.type === 'image_generation_call' && item.result != null) {
      const message = b.collector.value<any>(state.path)!;
      if (message.content.length === 0) {
        b.initialize([...state.path, 'content', 0], { type: 'image', image: { data: item.result, ...(item.output_format == null ? {} : { mime_type: `image/${item.output_format}` }) } });
      } else {
        reconcileAssign([...state.path, 'content', 0, 'image', 'data'], item.result);
        if (item.output_format != null) reconcileAssign([...state.path, 'content', 0, 'image', 'mime_type'], `image/${item.output_format}`);
      }
    }
  };

  const closeItem = (state: ResponsesItemState, status?: string): void => {
    if (state.path !== undefined) {
      const item = b.collector.value<any>(state.path)!;
      if (item.type === 'message') for (let part = 0; part < item.content.length; part++) if (b.collector.isOpen([...state.path, 'content', part])) b.event({ type: 'part_end', choice: 0, item: state.path[3] as number, part });
      b.event({ type: 'item_end', choice: 0, item: state.path[3] as number, ...(status === 'incomplete' ? { status: 'incomplete' as const } : {}) });
    }
    open.delete(state.outputIndex);
  };

  for await (const frame of frames) {
    if (frame.type === 'done') throw new Error('Responses done arrived without a terminal response');
    const e = frame.event as unknown as Record<string, any>;
    if (e.type === 'error') { b.event({ type: 'error', error: e.error ?? e }); yield b.drain(); return; }
    if (e.type === 'response.failed' && e.response.error?.code !== 'bio_policy' && e.response.error?.code !== 'cyber_policy') {
      b.event({ type: 'error', error: e.response.error });
      yield b.drain();
      return;
    }

    if (e.response !== undefined) {
      const response = e.response as Record<string, any>;
      responseMetadata(response);
      if (!started) {
        b.choice(0);
        b.event({ type: 'start', id: response.id, ...(response.created_at === undefined ? {} : { created: response.created_at }) });
        started = true;
      }
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type)) {
        for (let outputIndex = 0; outputIndex < (response.output?.length ?? 0); outputIndex++) {
          const item = response.output[outputIndex];
          let state = open.get(outputIndex);
          if (state === undefined && !announced.has(outputIndex)) state = openItem(outputIndex, item);
          if (state !== undefined) { reconcileItem(state, item, true); closeItem(state, item.status); }
        }
        for (const state of [...open.values()]) closeItem(state);
        if (audioItem !== undefined) {
          const item = b.state.choices[0].items[audioItem];
          if (item.type !== 'message' || item.content[0].type !== 'audio') throw new TypeError('Responses audio state is invalid');
          for (const field of ['data', 'transcript'] as const) if (item.content[0].audio[field] !== undefined && !audioDone.has(field)) throw new Error('Responses audio stream ended without its done event');
          b.event({ type: 'part_end', choice: 0, item: audioItem, part: 0 });
          b.event({ type: 'item_end', choice: 0, item: audioItem });
        }
        const policy = response.error?.code === 'cyber_policy' ? 'cyber' : response.error?.code === 'bio_policy' ? 'bio' : undefined;
        if (policy !== undefined) b.assign(['choices', 0, 'refusal'], { category: policy, explanation: response.error.message });
        const tools = b.state.choices[0].items.some(item => item.type === 'function_call' || item.type === 'custom_tool_call');
        b.event({ type: 'choice_end', choice: 0, finish_reason: policy !== undefined ? 'content_filter' : e.type === 'response.incomplete' ? response.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length' : tools ? 'tool_calls' : 'stop' });
        b.event({ type: 'finish', status: e.type === 'response.incomplete' ? 'incomplete' : 'completed' });
        finished = true;
      }
    } else if (e.type === 'response.output_item.added') {
      const state = openItem(e.output_index, e.item);
      reconcileItem(state, e.item, false);
    } else if (e.type === 'response.output_item.done') {
      const state = requireItem(e.output_index);
      reconcileItem(state, e.item, true);
      closeItem(state, e.item.status);
    } else if (e.type === 'response.audio.delta' || e.type === 'response.audio.transcript.delta') {
      const field = e.type === 'response.audio.delta' ? 'data' : 'transcript';
      if (audioItem === undefined) {
        audioItem = b.item(0, { type: 'message', content: [] });
        b.initialize(['choices', 0, 'items', audioItem, 'content', 0], { type: 'audio', audio: {} });
      }
      const path: IRPath = ['choices', 0, 'items', audioItem, 'content', 0, 'audio', field];
      if (b.collector.value(path) === undefined) b.initialize(path, '');
      if (e.delta !== '') b.append(path, e.delta);
    } else if (e.type === 'response.audio.done' || e.type === 'response.audio.transcript.done') {
      audioDone.add(e.type === 'response.audio.done' ? 'data' : 'transcript');
    } else if (e.output_index !== undefined) {
      const state = requireItem(e.output_index);
      if (state.path !== undefined) {
        if (e.type === 'response.content_part.added' || e.type === 'response.content_part.done') {
          reconcilePart(state, e.content_index, e.part);
          if (e.type === 'response.content_part.done' && state.type === 'message') {
            const part = state.content.get(e.content_index)!;
            b.event({ type: 'part_end', choice: 0, item: state.path[3] as number, part });
          }
        } else if (e.type === 'response.reasoning_summary_part.added' || e.type === 'response.reasoning_summary_part.done') {
          reconcileAppend(ensureReasoningText(state, 'summary', e.summary_index), e.part.text);
        } else if (e.type === 'response.output_text.delta' || e.type === 'response.refusal.delta') {
          const part = ensureMessagePart(state, e.content_index, { type: e.type === 'response.refusal.delta' ? 'refusal' : 'output_text', annotations: [] });
          const field = e.type === 'response.refusal.delta' ? 'refusal' : 'text';
          if (e.delta !== '') b.append([...part, field], e.delta);
          if (e.logprobs !== undefined) reconcileLogprobs(state, e.content_index, part, e.logprobs);
        } else if (e.type === 'response.output_text.done' || e.type === 'response.refusal.done') {
          const part = ensureMessagePart(state, e.content_index, { type: e.type === 'response.refusal.done' ? 'refusal' : 'output_text', annotations: [] });
          reconcileAppend([...part, e.type === 'response.refusal.done' ? 'refusal' : 'text'], e.type === 'response.refusal.done' ? e.refusal : e.text);
          if (e.logprobs !== undefined) reconcileLogprobs(state, e.content_index, part, e.logprobs);
        } else if (e.type === 'response.output_text.annotation.added') {
          if (e.annotation !== null) {
            const partIndex = state.content.get(e.content_index);
            if (partIndex === undefined) throw new TypeError('Responses annotation requires a content part');
            const partPath = [...state.path, 'content', partIndex];
            const text = b.collector.value<string>([...partPath, 'text'])!;
            const annotation = annotationToIR(text, e.annotation);
            if (annotation !== undefined) {
              const target = [...partPath, 'annotations'];
              if (b.collector.value(target) === undefined) b.assign(target, []);
              reconcileAssign([...target, e.annotation_index], annotation);
            }
          }
        } else if (e.type === 'response.function_call_arguments.delta' || e.type === 'response.custom_tool_call_input.delta') {
          if (e.delta !== '') b.append([...state.path, e.type.includes('arguments') ? 'arguments' : 'input'], e.delta);
        } else if (e.type === 'response.function_call_arguments.done' || e.type === 'response.custom_tool_call_input.done') {
          reconcileAppend([...state.path, e.type.includes('arguments') ? 'arguments' : 'input'], e.type.includes('arguments') ? e.arguments : e.input);
        } else if (e.type === 'response.reasoning_summary_text.delta' || e.type === 'response.reasoning_text.delta' || e.type === 'response.reasoning.delta') {
          const summary = e.type.includes('summary');
          const index = summary ? e.summary_index : e.content_index;
          const path = ensureReasoningText(state, summary ? 'summary' : 'content', index);
          if (e.delta !== '') b.append(path, e.delta);
        } else if (e.type === 'response.reasoning_summary_text.done' || e.type === 'response.reasoning_text.done' || e.type === 'response.reasoning.done') {
          const summary = e.type.includes('summary');
          const index = summary ? e.summary_index : e.content_index;
          reconcileAppend(ensureReasoningText(state, summary ? 'summary' : 'content', index), e.text);
        }
      }
    }
    yield b.drain();
    if (finished) return;
  }
  throw new Error('Responses stream ended without a terminal response');
};
