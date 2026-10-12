// All
export type IRJSONValue = null | boolean | number | string | readonly IRJSONValue[] | IRJSONObject;

// All
export type IRJSONObject = { readonly [key: string]: IRJSONValue };

// All
export const IRNone: unique symbol = Symbol('IRNone');

// All
export type IRNone = typeof IRNone;

// All
export type IRValue = IRNone | null | boolean | number | string | readonly IRValue[] | IRObject;

// All
export type IRObject = { readonly [key: string]: IRValue };

// All
export interface IR {
  readonly choices: readonly IRChoice[]; // All
  readonly model?: string; // All
  readonly service_tier?: string; // All
  readonly usage?: IRUsage; // All
}

// All
interface IRChoice {
  readonly items: readonly IRItem[]; // All
  readonly refusal?: IRClassifierRefusal; // All
  readonly logprobs?: readonly IRLogprobGroup[] | null; // ChatCompletions, Responses, GenerateContent
}

// All
interface IRClassifierRefusal {
  readonly category: string | null; // Messages, Responses
  readonly explanation: string | null; // All
}

// All
export type IRItem = IRMessageItem | IRReasoningItem | IRFunctionCallItem | IRCustomToolCallItem;

// All
export interface IRMessageItem {
  readonly type: 'message'; // All
  readonly content: readonly IRContentPart[]; // All
}

// All
export type IRContentPart = IRTextPart | IRRefusalPart | IRImagePart | IRAudioPart;

// All
interface IRTextPart {
  readonly type: 'text'; // All
  readonly text: string; // All
  readonly annotations?: readonly IRSourceCitation[] | null; // All
}

// All
interface IRRefusalPart {
  readonly type: 'refusal'; // All
  readonly refusal: string; // All
}

// All
interface IRReasoningItem {
  readonly type: 'reasoning'; // All
  readonly id?: string; // ChatCompletions, Responses, Messages
  readonly summary?: readonly string[]; // All
  readonly content?: readonly string[]; // All
  readonly encrypted_content?: string | null; // All
}

// All
interface IRFunctionCallItem {
  readonly type: 'function_call'; // All
  readonly call_id?: string | IRNone; // All
  readonly name: string; // All
  readonly arguments: string; // All
}

// ChatCompletions, Responses, Messages
interface IRCustomToolCallItem {
  readonly type: 'custom_tool_call'; // ChatCompletions, Responses, Messages
  readonly call_id?: string | IRNone; // ChatCompletions, Responses, Messages
  readonly name: string; // ChatCompletions, Responses, Messages
  readonly input: string; // ChatCompletions, Responses, Messages
}

// Responses, GenerateContent
interface IRImagePart {
  readonly type: 'image'; // Responses, GenerateContent
  readonly image: IRImage; // Responses, GenerateContent
}

// Responses, GenerateContent
interface IRImage {
  readonly data: string; // Responses, GenerateContent
  readonly mime_type?: string; // Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
export interface IRAudioPart {
  readonly type: 'audio'; // ChatCompletions, Responses, GenerateContent
  readonly audio: IRAudio; // ChatCompletions, Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
interface IRAudio {
  readonly data?: string; // ChatCompletions, Responses, GenerateContent
  readonly transcript?: string; // ChatCompletions, Responses, GenerateContent
  readonly mime_type?: string; // ChatCompletions, GenerateContent
}

// All
export type IRSourceCitation = {
  readonly type: 'source_citation'; // All
  readonly source_label?: string | null; // All
  readonly source_text?: IRSourceText; // Messages, GenerateContent
  readonly source_page_range?: IRSourcePageRange; // Messages, GenerateContent
  readonly output_text_range?: IRUTF16TextRange; // ChatCompletions, Responses, GenerateContent
} & (
  | {
    readonly source_kind: 'url' | 'document' | 'search_result'; // All
    readonly source: string; // All
  }
  | {
    readonly source_kind: 'document' | 'search_result'; // Messages, GenerateContent
    readonly source?: null; // Messages, GenerateContent
    readonly source_text: IRSourceText; // Messages, GenerateContent
  }
);

// Messages, GenerateContent
interface IRSourceText {
  readonly text: string; // Messages, GenerateContent
  readonly granularity: 'exact_quote' | 'retrieved_passage'; // Messages, GenerateContent
}

// Messages, GenerateContent
interface IRSourcePageRange {
  readonly start_one_based: number; // Messages, GenerateContent
  readonly end_one_based_exclusive: number; // Messages
}

// ChatCompletions, Responses, GenerateContent
export interface IRUTF16TextRange {
  readonly start: number; // ChatCompletions, Responses, GenerateContent
  readonly end_exclusive: number; // ChatCompletions, Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
export type IRLogprobGroup = IRChoiceLogprobs | IRTextPartLogprobs;

// ChatCompletions, GenerateContent
interface IRChoiceLogprobs {
  readonly scope: 'choice'; // ChatCompletions, GenerateContent
  readonly tokens: readonly IRTokenLogprob[]; // ChatCompletions, GenerateContent
}

// ChatCompletions, Responses
interface IRTextPartLogprobs {
  readonly scope: 'text_part'; // ChatCompletions, Responses
  readonly item_index: number; // ChatCompletions, Responses
  readonly content_index: number; // ChatCompletions, Responses
  readonly tokens: readonly IRTokenLogprob[]; // ChatCompletions, Responses
}

// ChatCompletions, Responses, GenerateContent
export interface IRTokenLogprob {
  readonly token: string; // ChatCompletions, Responses, GenerateContent
  readonly logprob: number; // ChatCompletions, Responses, GenerateContent
  readonly bytes?: readonly number[] | null; // ChatCompletions, Responses
  readonly top_logprobs?: readonly IRTokenLogprobAlternative[]; // ChatCompletions, Responses, GenerateContent
}

// ChatCompletions, Responses, GenerateContent
interface IRTokenLogprobAlternative {
  readonly token: string; // ChatCompletions, Responses, GenerateContent
  readonly logprob: number; // ChatCompletions, Responses, GenerateContent
  readonly bytes?: readonly number[] | null; // ChatCompletions, Responses
}

// All
export interface IRUsage {
  readonly input_tokens_inclusive?: number; // All
  readonly output_tokens_inclusive?: number; // All
  readonly total_tokens?: number; // ChatCompletions, Responses, GenerateContent
  readonly cached_input_tokens?: number; // All
  readonly cache_creation_input_tokens?: number; // ChatCompletions, Responses, Messages
  readonly reasoning_tokens?: number; // All
  readonly input_audio_tokens?: number; // ChatCompletions, GenerateContent
  readonly input_image_tokens?: number; // ChatCompletions, GenerateContent
  readonly input_text_tokens?: number; // ChatCompletions, GenerateContent
  readonly output_audio_tokens?: number; // ChatCompletions, GenerateContent
  readonly output_text_tokens?: number; // ChatCompletions, GenerateContent
}
