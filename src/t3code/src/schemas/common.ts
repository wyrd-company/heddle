/**
 * Shared schema building blocks. Mirrors `packages/contracts/src/baseSchemas.ts`
 * in the T3 fork, plus the forward-compatibility helpers every other schema
 * file uses.
 *
 * Rules:
 * - Objects are `z.looseObject` so unknown keys from newer servers pass through.
 * - Literal sets that grow over time decode unknown members instead of failing.
 * - Discriminated unions that grow decode unknown members into an `unknown` variant.
 */
import { z } from "zod";

export const TrimmedNonEmptyString = z.string().trim().min(1);
export const NonNegativeInt = z.number().int().min(0);
export const PositiveInt = z.number().int().min(1);
export const IsoDateTime = z.string();
export type IsoDateTime = z.infer<typeof IsoDateTime>;

function entityId<Brand extends string>(_brand: Brand) {
  return TrimmedNonEmptyString.brand<Brand>();
}

export const ThreadId = entityId("ThreadId");
export type ThreadId = z.infer<typeof ThreadId>;
export const ProjectId = entityId("ProjectId");
export type ProjectId = z.infer<typeof ProjectId>;
export const EnvironmentId = entityId("EnvironmentId");
export type EnvironmentId = z.infer<typeof EnvironmentId>;
export const CommandId = entityId("CommandId");
export type CommandId = z.infer<typeof CommandId>;
export const EventId = entityId("EventId");
export type EventId = z.infer<typeof EventId>;
export const MessageId = entityId("MessageId");
export type MessageId = z.infer<typeof MessageId>;
export const TurnId = entityId("TurnId");
export type TurnId = z.infer<typeof TurnId>;
export const AuthSessionId = entityId("AuthSessionId");
export type AuthSessionId = z.infer<typeof AuthSessionId>;
export const ApprovalRequestId = entityId("ApprovalRequestId");
export type ApprovalRequestId = z.infer<typeof ApprovalRequestId>;
export const CheckpointRef = entityId("CheckpointRef");
export type CheckpointRef = z.infer<typeof CheckpointRef>;
export const ProviderItemId = entityId("ProviderItemId");
export type ProviderItemId = z.infer<typeof ProviderItemId>;
/** Open slug: letters, digits, `-`, `_`; starts with a letter; at most 64 chars. */
const providerSlug = TrimmedNonEmptyString.max(64).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
export const ProviderInstanceId = providerSlug.brand<"ProviderInstanceId">();
export type ProviderInstanceId = z.infer<typeof ProviderInstanceId>;
export const ProviderDriverKind = providerSlug.brand<"ProviderDriverKind">();
export type ProviderDriverKind = z.infer<typeof ProviderDriverKind>;

/** Brand a trusted string without validation. Use for ids this process generated or already decoded. */
export const threadId = (value: string): ThreadId => value as ThreadId;
export const projectId = (value: string): ProjectId => value as ProjectId;
export const commandId = (value: string): CommandId => value as CommandId;
export const messageId = (value: string): MessageId => value as MessageId;
export const turnId = (value: string): TurnId => value as TurnId;
export const eventId = (value: string): EventId => value as EventId;
export const approvalRequestId = (value: string): ApprovalRequestId => value as ApprovalRequestId;
export const authSessionId = (value: string): AuthSessionId => value as AuthSessionId;
export const providerInstanceId = (value: string): ProviderInstanceId =>
  value as ProviderInstanceId;

export const ClientSurface = z.enum(["web", "desktop", "mobile", "cli"]);
export type ClientSurface = z.infer<typeof ClientSurface>;

/**
 * A literal set the server may extend. Known members keep their literal type;
 * anything else decodes as a plain string so a newer server never breaks the
 * client. `KnownOr<T>` keeps autocomplete for the known members.
 */
export type KnownOr<T extends string> = T | (string & {});

export function forwardCompatibleLiteral<const T extends readonly [string, ...string[]]>(
  _known: T,
): z.ZodType<KnownOr<T[number]>> {
  return z.string() as unknown as z.ZodType<KnownOr<T[number]>>;
}

export function isKnownLiteral<const T extends readonly string[]>(
  known: T,
  value: string,
): value is T[number] {
  return (known as readonly string[]).includes(value);
}

/** The shape every unrecognised member of a growing tagged union decodes to. */
export interface UnknownVariant<Discriminator extends string> {
  readonly unknown: true;
  readonly raw: Record<string, unknown> & { readonly [K in Discriminator]: string };
}

/**
 * A discriminated union the server may extend. A member whose discriminator
 * value is not recognised decodes as `{ unknown: true, raw }` instead of
 * failing the whole payload. Members that are recognised but malformed still
 * fail, so schema drift on a known member is visible.
 */
export function taggedUnionWithUnknown<
  const D extends string,
  const Members extends readonly [z.ZodObject, ...z.ZodObject[]],
>(discriminator: D, members: Members): z.ZodType<z.infer<Members[number]> | UnknownVariant<D>> {
  const known = z.discriminatedUnion(discriminator, members as never) as unknown as z.ZodType<
    z.infer<Members[number]>
  >;
  const knownValues = new Set<string>();
  for (const member of members) {
    const shape = (member as z.ZodObject).shape as Record<string, z.ZodType>;
    const field = shape[discriminator];
    const values = field ? literalValues(field) : [];
    for (const value of values) knownValues.add(value);
  }
  const unknownVariant = z
    .looseObject({ [discriminator]: z.string() })
    .transform((raw) => ({ unknown: true as const, raw }) as UnknownVariant<D>);
  return z.union([known, unknownVariant]).superRefine((value, ctx) => {
    if (isUnknownVariant<D>(value)) {
      const tag = value.raw[discriminator];
      if (knownValues.has(tag)) {
        ctx.addIssue({
          code: "custom",
          message: `${discriminator}=${tag} is a known member but did not match its schema`,
        });
      }
    }
  }) as unknown as z.ZodType<z.infer<Members[number]> | UnknownVariant<D>>;
}

function literalValues(schema: z.ZodType): string[] {
  const def = (schema as { def?: { type?: string; values?: unknown; entries?: unknown } }).def;
  if (!def) return [];
  if (def.type === "literal" && Array.isArray(def.values)) {
    return def.values.filter((v): v is string => typeof v === "string");
  }
  if (def.type === "enum" && def.entries && typeof def.entries === "object") {
    return Object.values(def.entries as Record<string, unknown>).filter(
      (v): v is string => typeof v === "string",
    );
  }
  return [];
}

export function isUnknownVariant<D extends string>(value: object): value is UnknownVariant<D> {
  return (value as { unknown?: unknown }).unknown === true;
}

/**
 * Decode an array element by element, dropping elements that fail. Mirrors the
 * contracts package's `ForwardCompatibleArray`: a client must keep decoding a
 * list sent by a newer server even when one element is unfamiliar.
 */
export function forwardCompatibleArray<T extends z.ZodType>(element: T): z.ZodType<z.infer<T>[]> {
  return z.array(z.unknown()).transform((values) => {
    const out: z.infer<T>[] = [];
    for (const value of values) {
      const result = element.safeParse(value);
      if (result.success) out.push(result.data as z.infer<T>);
    }
    return out;
  });
}

/** `T | null`, decoding a missing key or unknown value as `null`. */
export function forwardCompatibleNullable<T extends z.ZodType>(
  value: T,
): z.ZodType<z.infer<T> | null> {
  return z.unknown().transform((raw) => {
    if (raw === null || raw === undefined) return null;
    const result = value.safeParse(raw);
    return result.success ? (result.data as z.infer<T>) : null;
  });
}

/** Trim surrounding whitespace while allowing an empty value. */
export const TrimmedString = z.string().trim();
export type TrimmedString = z.infer<typeof TrimmedString>;
