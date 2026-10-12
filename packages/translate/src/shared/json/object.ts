import { rawJSON } from './raw-json.ts';

const parseJSON = (text: string): unknown => JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
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
