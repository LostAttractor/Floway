import { Tag } from 'cbor-x';

import { THIN_TAGS, type AssistantTurnStateFor, type JSONReference, type ReferencePart, type Restoration, type TextReference, type ThinAssistantTurnFor, type ThinReference } from './assistant-turn.ts';
import type { IRJSONObject } from '../../ir/types.ts';
import { parseJSONObject, requireJSONObject } from '../../shared/json/object.ts';
import type { AssistantTurnByProtocol, AssistantTurnFor } from '../assistant-turn.ts';
import { hashRoundTripContent } from '../replay-check.ts';

const builderBrand: unique symbol = Symbol('ReferenceBuilder');
const fieldStateBrand: unique symbol = Symbol('FieldState');
const contentStateBrand: unique symbol = Symbol('ContentState');

export type PartId = number;
type ContentId = number;

export interface ReferenceBuilder { readonly [builderBrand]: true }

type OriginalFor<Kind extends Restoration> = Kind extends 'text' ? string : IRJSONObject;
type ThinReferenceFor<Kind extends Restoration> = Kind extends 'text' ? TextReference : JSONReference;

export interface FieldState<Kind extends Restoration = Restoration> {
  readonly [fieldStateBrand]: Kind;
}

export interface ContentState<Kind extends Restoration = Restoration> {
  readonly [contentStateBrand]: Kind;
}

export interface FieldStates {
  readonly text: FieldState<'text'>;
  readonly json: FieldState<'json'>;
}

export interface ContentStates {
  readonly text: ContentState<'text'>;
  readonly json: ContentState<'json'>;
}

interface Resolution {
  readonly contentId: ContentId;
  readonly start: number;
  readonly endExclusive: number;
}

interface FieldData {
  readonly restoration: Restoration;
  text: string;
  readonly partIds: PartId[];
}

interface ContentData {
  readonly restoration: Restoration;
  readonly contentId: ContentId;
  text: string;
}

interface BuilderState {
  readonly pieces: string[];
  readonly resolutions: Map<PartId, Resolution>;
  nextContentId: number;
}

const builderStates = new WeakMap<ReferenceBuilder, BuilderState>();
const fieldStates = new WeakMap<object, FieldData>();
const contentStates = new WeakMap<object, ContentData>();

const stateOf = (builder: ReferenceBuilder): BuilderState => {
  const state = builderStates.get(builder);
  if (state === undefined) throw new Error('Unknown ReferenceBuilder handle');
  return state;
};

export const createReferenceBuilder = (): ReferenceBuilder => {
  const builder: ReferenceBuilder = { [builderBrand]: true };
  builderStates.set(builder, { pieces: [], resolutions: new Map(), nextContentId: 0 });
  return builder;
};

const fieldData = (field: FieldState): FieldData => {
  const data = fieldStates.get(field);
  if (data === undefined) throw new Error('Unknown field state');
  return data;
};

const contentData = (content: ContentState): ContentData => {
  const data = contentStates.get(content);
  if (data === undefined) throw new Error('Unknown content state');
  return data;
};

export const createFieldState = <Kind extends Restoration>(restoration: Kind): FieldState<Kind> => {
  const field: FieldState<Kind> = { [fieldStateBrand]: restoration };
  fieldStates.set(field, { restoration, text: '', partIds: [] });
  return field;
};

export const appendField = (builder: ReferenceBuilder, field: FieldState, text: string): PartId => {
  const state = stateOf(builder);
  const data = fieldData(field);
  const partId = state.pieces.length;
  state.pieces.push(text);
  data.text += text;
  data.partIds.push(partId);
  return partId;
};

export const createContentState = <Kind extends Restoration>(builder: ReferenceBuilder, restoration: Kind): ContentState<Kind> => {
  const state = stateOf(builder);
  const content: ContentState<Kind> = { [contentStateBrand]: restoration };
  contentStates.set(content, { restoration, contentId: state.nextContentId++, text: '' });
  return content;
};

export const appendContent = (builder: ReferenceBuilder, content: ContentState, text: string, partId?: PartId): void => {
  const data = contentData(content);
  const start = data.text.length;
  data.text += text;
  if (partId === undefined) return;
  const state = stateOf(builder);
  if (state.resolutions.has(partId)) throw new Error(`ReferenceBuilder part ${partId} has multiple output occurrences`);
  state.resolutions.set(partId, { contentId: data.contentId, start, endExclusive: data.text.length });
};

const isFieldState = (value: unknown): value is FieldState =>
  typeof value === 'object' && value !== null && fieldStates.has(value);

const isContentState = (value: unknown): value is ContentState =>
  typeof value === 'object' && value !== null && contentStates.has(value);

const textView = (kind: Restoration, value: unknown): string | undefined => {
  if (kind === 'text') return typeof value === 'string' ? value : undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return JSON.stringify(value);
};

const pairedChildren = function* (value: unknown, state: unknown): Generator<readonly [unknown, unknown]> {
  if (Array.isArray(state)) {
    if (!Array.isArray(value)) throw new TypeError('ReferenceBuilder state array does not match its assistant turn');
    for (let index = 0; index < state.length; index++) {
      if (!Object.hasOwn(state, index)) continue;
      yield [value[index], state[index]];
    }
    return;
  }
  if (typeof state !== 'object' || state === null) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('ReferenceBuilder state object does not match its assistant turn');
  for (const [key, childState] of Object.entries(state)) yield [Reflect.get(value, key), childState];
};

export function collectContentViews(value: unknown, contentState: ContentState): Map<ContentId, string>;
export function collectContentViews<Protocol extends keyof AssistantTurnByProtocol>(
  turn: AssistantTurnFor<Protocol>,
  contentState: AssistantTurnStateFor<Protocol, ContentStates>,
): Map<ContentId, string>;
export function collectContentViews(turn: unknown, contentState: unknown): Map<ContentId, string> {
  const views = new Map<ContentId, string>();
  const visit = (value: unknown, state: unknown): void => {
    if (isContentState(state)) {
      const data = contentData(state);
      const view = textView(data.restoration, value);
      if (view === data.text) views.set(data.contentId, view);
      return;
    }
    for (const [childValue, childState] of pairedChildren(value, state)) visit(childValue, childState);
  };
  visit(turn, contentState);
  return views;
}

export const contentHashKey = (hash: Uint8Array): string => Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');

const restoresOriginal = <Kind extends Restoration>(field: FieldState<Kind>, original: OriginalFor<Kind>): boolean => {
  const data = fieldData(field);
  if (data.restoration === 'text') return typeof original === 'string' && data.text === original;
  if (typeof original !== 'object' || original === null || Array.isArray(original)) return false;
  try {
    return JSON.stringify(parseJSONObject(data.text)) === JSON.stringify(original);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
};

interface ReferenceSegment {
  readonly hashIndex: number;
  readonly start: number;
  endExclusive: number;
  readonly contentLength: number;
}

interface ResolvedSegment {
  readonly contentId: ContentId;
  readonly content: string;
  readonly start: number;
  readonly endExclusive: number;
}

interface FinalizationState {
  readonly referencedContents: Uint8Array[];
  readonly hashIndexByContentId: Map<ContentId, number>;
  readonly hashIndexByDigest: Map<string, number>;
  referencesProduced: number;
}

interface ReferenceFinalizer {
  readonly referencedContents: Uint8Array[];
  readonly hasReferences: () => boolean;
  finalizeField: <Kind extends Restoration>(
    original: OriginalFor<Kind>,
    field: FieldState<Kind>,
  ) => Promise<OriginalFor<Kind> | ThinReferenceFor<Kind>>;
}

export const createReferenceFinalizer = async (builder: ReferenceBuilder, contentViews: ReadonlyMap<ContentId, string>): Promise<ReferenceFinalizer> => {
  const builderState = stateOf(builder);
  const state: FinalizationState = {
    referencedContents: [],
    hashIndexByContentId: new Map(),
    hashIndexByDigest: new Map(),
    referencesProduced: 0,
  };

  const hashIndex = async (contentId: ContentId, content: string): Promise<number> => {
    const existing = state.hashIndexByContentId.get(contentId);
    if (existing !== undefined) return existing;
    const digest = await hashRoundTripContent(content);
    const key = contentHashKey(digest);
    let index = state.hashIndexByDigest.get(key);
    if (index === undefined) {
      index = state.referencedContents.length;
      state.referencedContents.push(digest);
      state.hashIndexByDigest.set(key, index);
    }
    state.hashIndexByContentId.set(contentId, index);
    return index;
  };

  const finalizeField = async <Kind extends Restoration>(
    original: OriginalFor<Kind>,
    field: FieldState<Kind>,
  ): Promise<OriginalFor<Kind> | ThinReferenceFor<Kind>> => {
    const fieldState = fieldData(field);
    if (fieldState.partIds.length === 0 || !restoresOriginal(field, original)) return original;
    const resolved: ResolvedSegment[] = [];
    for (const partId of fieldState.partIds) {
      const piece = builderState.pieces[partId];
      const resolution = builderState.resolutions.get(partId);
      if (piece === undefined || resolution === undefined) return original;
      const content = contentViews.get(resolution.contentId);
      if (content === undefined || content.slice(resolution.start, resolution.endExclusive) !== piece) return original;
      resolved.push({ contentId: resolution.contentId, content, start: resolution.start, endExclusive: resolution.endExclusive });
    }
    const segments: ReferenceSegment[] = [];
    for (const resolution of resolved) {
      const index = await hashIndex(resolution.contentId, resolution.content);
      const previous = segments.at(-1);
      if (previous?.hashIndex === index && previous.endExclusive === resolution.start) previous.endExclusive = resolution.endExclusive;
      else segments.push({ hashIndex: index, start: resolution.start, endExclusive: resolution.endExclusive, contentLength: resolution.content.length });
    }
    const payload: ReferencePart[] = segments.map(segment => segment.start === 0 && segment.endExclusive === segment.contentLength
      ? segment.hashIndex
      : [segment.hashIndex, segment.start, segment.endExclusive]);
    state.referencesProduced++;
    return new Tag(payload, fieldState.restoration === 'text' ? THIN_TAGS.text : THIN_TAGS.json) as ThinReferenceFor<Kind>;
  };

  for (const [contentId, content] of contentViews) await hashIndex(contentId, content);
  return { referencedContents: state.referencedContents, hasReferences: () => state.referencesProduced > 0, finalizeField };
};

interface FinalizedAssistantTurn<Turn> {
  readonly assistantTurn: Turn;
  readonly referencedContents?: Uint8Array[];
}

export const finalizeAssistantTurnReferences = async <Protocol extends keyof AssistantTurnByProtocol>(
  turn: AssistantTurnFor<Protocol>,
  fieldState: AssistantTurnStateFor<Protocol, FieldStates>,
  builder: ReferenceBuilder,
  contentViews: ReadonlyMap<ContentId, string>,
): Promise<FinalizedAssistantTurn<ThinAssistantTurnFor<Protocol, ThinReference>>> => {
  const finalizer = await createReferenceFinalizer(builder, contentViews);
  const visit = async (value: unknown, state: unknown): Promise<unknown> => {
    if (isFieldState(state)) {
      if (fieldData(state).restoration === 'text') {
        if (typeof value !== 'string') throw new TypeError('Text field state does not match its assistant turn');
        return await finalizer.finalizeField(value, state);
      }
      return await finalizer.finalizeField(requireJSONObject(value), state);
    }
    if (Array.isArray(state)) {
      if (!Array.isArray(value)) throw new TypeError('ReferenceBuilder state array does not match its assistant turn');
      const result = value.slice();
      for (let index = 0; index < state.length; index++) {
        if (!Object.hasOwn(state, index)) continue;
        result[index] = await visit(value[index], state[index]);
      }
      return result;
    }
    if (typeof state !== 'object' || state === null) return value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('ReferenceBuilder state object does not match its assistant turn');
    const result = { ...value };
    for (const [key, childState] of Object.entries(state)) Reflect.set(result, key, await visit(Reflect.get(value, key), childState));
    return result;
  };
  const assistantTurn = await visit(turn, fieldState) as ThinAssistantTurnFor<Protocol, ThinReference>;
  return {
    assistantTurn,
    ...(finalizer.hasReferences() ? { referencedContents: finalizer.referencedContents } : {}),
  };
};
