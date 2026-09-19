/**
 * The RPC envelope protocol the T3 server speaks over its WebSocket (Effect's
 * `RpcMessage` with JSON serialization). Client envelopes are plain records;
 * server envelopes are zod-validated at the edge. Unknown envelope tags are
 * skipped with a warning so a newer server never breaks this client; a known
 * tag that does not match its shape is a protocol failure, because silently
 * dropping it would leave its request waiting forever.
 */
import { z } from "zod";
import { T3ConnectionError } from "../errors.js";
import { noopLogger, type Logger } from "../internal/logger.js";

export type RequestId = string;

export interface RequestEnvelope {
  readonly _tag: "Request";
  readonly id: RequestId;
  readonly tag: string;
  readonly payload: unknown;
  /** Required by the server; omitting it makes the server close the socket. */
  readonly headers: readonly (readonly [string, string])[];
}
export interface AckEnvelope {
  readonly _tag: "Ack";
  readonly requestId: RequestId;
}
export interface InterruptEnvelope {
  readonly _tag: "Interrupt";
  readonly requestId: RequestId;
}
export interface PingEnvelope {
  readonly _tag: "Ping";
}
export interface EofEnvelope {
  readonly _tag: "Eof";
}
export type ClientEnvelope =
  RequestEnvelope | AckEnvelope | InterruptEnvelope | PingEnvelope | EofEnvelope;

/** The server echoes the id we sent; it may be a number when another client chose one. */
const WireRequestId = z.union([z.string(), z.number()]).transform((id) => String(id));

/** `value`, `error`, and `defect` may be absent: JSON drops an `undefined` (for example a `Stream<void>` exit). */
export const FailCause = z.looseObject({ _tag: z.literal("Fail"), error: z.unknown().optional() });
export const DieCause = z.looseObject({ _tag: z.literal("Die"), defect: z.unknown().optional() });
export const InterruptCause = z.looseObject({
  _tag: z.literal("Interrupt"),
  fiberId: z.number().nullish(),
});
export const CauseEntry = z.discriminatedUnion("_tag", [FailCause, DieCause, InterruptCause]);
export type CauseEntry = z.infer<typeof CauseEntry>;

export const ExitEncoded = z.discriminatedUnion("_tag", [
  z.looseObject({ _tag: z.literal("Success"), value: z.unknown().optional() }),
  z.looseObject({ _tag: z.literal("Failure"), cause: z.array(CauseEntry) }),
]);
export type ExitEncoded = z.infer<typeof ExitEncoded>;

export const ChunkEnvelope = z.looseObject({
  _tag: z.literal("Chunk"),
  requestId: WireRequestId,
  values: z.array(z.unknown()),
});
export type ChunkEnvelope = z.infer<typeof ChunkEnvelope>;

export const ExitEnvelope = z.looseObject({
  _tag: z.literal("Exit"),
  requestId: WireRequestId,
  exit: ExitEncoded,
});
export type ExitEnvelope = z.infer<typeof ExitEnvelope>;

/** A connection-level failure: every request in flight is lost. */
export const DefectEnvelope = z.looseObject({
  _tag: z.literal("Defect"),
  defect: z.unknown().optional(),
});
export type DefectEnvelope = z.infer<typeof DefectEnvelope>;

export const PongEnvelope = z.looseObject({ _tag: z.literal("Pong") });
export type PongEnvelope = z.infer<typeof PongEnvelope>;

export const ServerEnvelope = z.discriminatedUnion("_tag", [
  ChunkEnvelope,
  ExitEnvelope,
  DefectEnvelope,
  PongEnvelope,
]);
export type ServerEnvelope = z.infer<typeof ServerEnvelope>;

const TaggedRecord = z.looseObject({ _tag: z.string() });
const KNOWN_SERVER_TAGS: ReadonlySet<string> = new Set(
  ServerEnvelope.options.map((option) => option.shape._tag.value),
);

/**
 * Decodes one WebSocket text frame: a single envelope or an array of them.
 * Invalid JSON, or a known tag whose shape is wrong, is a protocol failure
 * (`T3ConnectionError("protocol")`); an envelope with an unfamiliar tag is
 * skipped with a warning.
 */
export function decodeServerFrame(text: string, logger: Logger = noopLogger): ServerEnvelope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new T3ConnectionError("protocol", "The server sent a frame that is not JSON.", { cause });
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out: ServerEnvelope[] = [];
  for (const item of items) {
    const result = ServerEnvelope.safeParse(item);
    if (result.success) {
      out.push(result.data);
      continue;
    }
    const tagged = TaggedRecord.safeParse(item);
    const tag = tagged.success ? tagged.data._tag : undefined;
    const issues = result.error.issues.slice(0, 3).map((issue) => issue.message);
    if (tag !== undefined && KNOWN_SERVER_TAGS.has(tag)) {
      throw new T3ConnectionError(
        "protocol",
        `The server sent a malformed ${tag} envelope: ${issues.join("; ")}`,
        { cause: result.error },
      );
    }
    logger.warn("Skipping a server envelope this client does not understand.", { tag, issues });
  }
  return out;
}

export function encodeClientEnvelope(envelope: ClientEnvelope): string {
  return JSON.stringify(envelope);
}

export function requestEnvelope(id: RequestId, tag: string, payload: unknown): RequestEnvelope {
  return { _tag: "Request", id, tag, payload, headers: [] };
}
