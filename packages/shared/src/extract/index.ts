// Extractor DSL (features/04 §3) and canonical hashing (features/05 §Logic 1). Browser-safe;
// the Node adapters (`nodeSha256`, `re2Engine`) live in apps/api/src/extract/adapters.ts.
export * from './spec.js';
export * from './extract.js';
export * from './canonical.js';
export {
  coerce,
  parseDate,
  parseDateTime,
  parseHttpUrl,
  parseNumber,
  type FieldValue,
  type Scalar,
  type Value,
} from './coerce.js';
export { compileTransform, type CompiledTransform, type TransformContext } from './transforms.js';
export {
  analyzeRegex,
  checkRegexPattern,
  nativeRegexEngine,
  NATIVE_MIN_INPUT,
  NATIVE_STEP_BUDGET,
  nativeInputCap,
  nativeSteps,
  REGEX_INPUT_MAX,
  REGEX_MAX_LENGTH,
  type CompiledRegex,
  type RegexAnalysis,
  type RegexEngine,
} from './regex.js';
