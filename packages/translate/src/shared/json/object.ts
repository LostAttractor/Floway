import { rawJSON } from './clone.ts';

export const parseJSON = (text: string): unknown => JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return rawJSON.rawJSON(context!.source);
  return value;
});

export const parseJSONObject = (text: string, parser: (text: string) => unknown = parseJSON): Record<string, any> => {
  const value = parser(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value) || rawJSON.isRawJSON(value)) throw new TypeError('Tool arguments require a JSON object');
  return value as Record<string, any>;
};

export const isCompleteJSONObject = (text: string): boolean => {
  try {
    const value = parseJSON(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !rawJSON.isRawJSON(value);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
};

export const createJSONObjectDraft = () => {
  let text = '';
  let depth = 0;
  let started = false;
  let quoted = false;
  let escaped = false;
  let invalid = false;
  const append = (delta: string): boolean => {
    text += delta;
    for (const char of delta) {
      if (!started) {
        if (/\s/u.test(char)) continue;
        started = true;
        if (char !== '{') invalid = true;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') depth--;
      else if (depth === 0 && !/\s/u.test(char)) invalid = true;
    }
    return started && !invalid && depth === 0 && !quoted && isCompleteJSONObject(text);
  };
  return { append };
};
