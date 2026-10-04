/**
 * Typed view of policy.mjs for the pi extension. The implementation lives in policy.mjs because the
 * endpoint service runs under plain node and cannot load TypeScript; this file only supplies types
 * and re-exports. The two must move together.
 */
export { globMatch, idMatches, newestFirst, seriesPattern, versionCompare, versionParts } from "./policy.mjs";
