// ---
// relationships:
//   implements: heddle
// ---

/**
 * Reasoning effort is a provider option, not a Heddle concept. Heddle carries
 * the provider's own vocabulary: the option **id** the driver publishes and the
 * value tokens that option offers. It never maps those onto a scale of its own.
 *
 * The id is not the same across drivers — the Codex and Grok catalogs publish
 * `reasoningEffort` while the Claude catalog publishes `effort` — so the id a
 * session dispatches with is read from the selected model's own capability
 * metadata rather than assumed.
 */

/**
 * Option ids a driver uses for its reasoning-effort select, most preferred
 * first. A model that publishes none of them has no reasoning effort to set.
 */
export const wellKnownReasoningEffortOptionIds: readonly string[] = [
  "reasoningEffort",
  "effort",
];

/** One select choice a provider option offers, as T3 publishes it. */
export type ModelOptionChoice = {
  readonly id: string;
  readonly isDefault?: boolean;
  readonly label?: string;
};

/** One provider option descriptor, as T3 publishes it per model. */
export type ModelOptionDescriptor = {
  readonly id: string;
  readonly options?: readonly ModelOptionChoice[];
  readonly type: string;
};

/** The reasoning-effort option one model offers, if it offers one. */
export type ModelReasoningEffortCapability = {
  readonly offeredValues: readonly string[];
  readonly optionId: string;
};

export class ReasoningEffortUnsupportedError extends Error {
  public readonly reason = "reasoning-effort-unsupported" as const;

  public constructor(message: string) {
    super(message);
    this.name = "ReasoningEffortUnsupportedError";
  }
}

/**
 * The reasoning-effort option a model publishes, or `undefined` when it
 * publishes none.
 */
export const modelReasoningEffortCapability = (
  optionDescriptors: readonly ModelOptionDescriptor[] | undefined,
): ModelReasoningEffortCapability | undefined => {
  if (optionDescriptors === undefined) return undefined;
  for (const optionId of wellKnownReasoningEffortOptionIds) {
    const descriptor = optionDescriptors.find(
      (candidate) => candidate.id === optionId && candidate.type === "select",
    );
    if (descriptor === undefined) continue;
    return {
      offeredValues: (descriptor.options ?? []).map(({ id }) => id),
      optionId: descriptor.id,
    };
  }
  return undefined;
};

/**
 * Reject an effort the model does not offer, naming the model and the values it
 * does offer. `modelSlug` names the model in the message; `origin` names the
 * layer the value came from so the operator can find it.
 */
export const assertModelOffersReasoningEffort = (input: {
  readonly modelSlug: string;
  readonly optionDescriptors: readonly ModelOptionDescriptor[] | undefined;
  readonly origin: string;
  readonly reasoningEffort: string;
}): ModelReasoningEffortCapability => {
  const capability = modelReasoningEffortCapability(input.optionDescriptors);
  if (capability === undefined) {
    // A driver publishing its reasoning select under an id this build does not
    // know looks identical to a model with no reasoning option, so name the
    // select options the model does publish: that is the difference.
    const published = (input.optionDescriptors ?? [])
      .filter(({ type }) => type === "select")
      .map(({ id }) => id);
    throw new ReasoningEffortUnsupportedError(
      `${input.origin} sets reasoning effort '${input.reasoningEffort}', but model '${input.modelSlug}' offers no reasoning effort option; it publishes ${published.length === 0 ? "no select options" : `select options '${published.join("', '")}'`}, and this build reads reasoning effort from '${wellKnownReasoningEffortOptionIds.join("' or '")}'`,
    );
  }
  if (!capability.offeredValues.includes(input.reasoningEffort)) {
    throw new ReasoningEffortUnsupportedError(
      `${input.origin} sets reasoning effort '${input.reasoningEffort}', but model '${input.modelSlug}' offers '${capability.offeredValues.join("', '")}'`,
    );
  }
  return capability;
};

/**
 * The provider option selection one session dispatches with, or an empty list
 * when no layer set an effort. An empty list is omitted from the dispatch so a
 * session with no configured effort runs exactly as it does today.
 */
export const reasoningEffortOptionSelections = (
  reasoningEffort: string | undefined,
  reasoningEffortOptionId: string | undefined,
): readonly { readonly id: string; readonly value: string }[] =>
  reasoningEffort === undefined || reasoningEffortOptionId === undefined
    ? []
    : [{ id: reasoningEffortOptionId, value: reasoningEffort }];

/** A configured or authored effort token: non-empty, with no leading or trailing whitespace. */
export const isReasoningEffort = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.trim() === value;
