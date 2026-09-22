import { check, copy } from './data.mjs';
import { reviewMessages, REVIEW_POLICY_VERSION } from './review.mjs';

/** Connect existing one-shot planning/validation and a chosen host's completion API.
 * These are trusted code callbacks, not names/commands emitted by the model.
 * complete receives messages and AbortSignal and must NOT retry/fallback internally.
 */
export function createDirectorAdapter({ name, version, planName, validateName, complete }) {
  for (const fn of [planName, validateName, complete]) check(typeof fn === 'function', 'ADAPTER_METHOD_MISSING');
  return Object.freeze({
    protocol: 'manga-director-adapter/v1', contract: 'name-plan/v2', mode: 'live',
    name, version: `${version}/${REVIEW_POLICY_VERSION}`,
    plan: (request, options) => planName(request, options),
    validatePlan: (request, options) => validateName(request, options),
    async review(request, options) {
      const response = await complete(reviewMessages(request), options);
      if (typeof response === 'string') check(Buffer.byteLength(response) <= 8 * 1024 * 1024, 'PAYLOAD_LIMIT');
      // No code-fence extraction or speculative JSON repair, and no second request.
      return copy(typeof response === 'string' ? JSON.parse(response) : response);
    },
  });
}
