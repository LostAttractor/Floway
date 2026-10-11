// Raw JSON primitives preserve numeric tokens outside the finite or safe-integer range.
// https://tc39.es/proposal-json-parse-with-source/#sec-json.rawjson
export const rawJSON = JSON as typeof JSON & {
  isRawJSON: (value: unknown) => boolean;
  rawJSON: (text: string) => { readonly rawJSON: string };
};

export const cloneJSON = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || rawJSON.isRawJSON(value)) return value;
  if (Array.isArray(value)) return value.map(cloneJSON) as T;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJSON(child)])) as T;
};
