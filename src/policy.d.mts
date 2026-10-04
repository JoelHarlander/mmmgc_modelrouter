/** Types for policy.mjs. A .d.mts is what NodeNext pairs with an .mjs file. */
export function versionParts(id: string): number[];
export function versionCompare(a: string, b: string): number;
export function newestFirst(a: string, b: string): number;
export function globMatch(pattern: string, value: string): boolean;
export function seriesPattern(series: string): RegExp;
export function idMatches(id: string, series: string): boolean;
