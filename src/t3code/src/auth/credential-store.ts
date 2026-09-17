import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import { T3ConnectionError, T3DecodeError, T3Error } from "../errors.js";
import {
  AuthGrantedScope,
  ServerAuthSessionMethod,
  type AuthGrantedScope as AuthGrantedScopeType,
  type ServerAuthSessionMethod as ServerAuthSessionMethodType,
} from "../schemas/auth.js";
import { IsoDateTime } from "../schemas/common.js";

export interface StoredCredentials {
  accessToken?: string;
  /** As granted by the server; may include a scope this client does not know. */
  scopes?: AuthGrantedScopeType[];
  expiresAt?: string;
  sessionMethod?: ServerAuthSessionMethodType;
}

export interface CredentialStore {
  load(): Promise<StoredCredentials>;
  save(credentials: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
}

const StoredCredentialsSchema = z.looseObject({
  accessToken: z.string().min(1).optional(),
  scopes: z.array(AuthGrantedScope).optional(),
  expiresAt: IsoDateTime.optional(),
  sessionMethod: ServerAuthSessionMethod.optional(),
});

export function memoryCredentialStore(initial: StoredCredentials = {}): CredentialStore {
  let current = clone(initial);
  return {
    async load() {
      return clone(current);
    },
    async save(credentials) {
      current = clone(credentials);
    },
    async clear() {
      current = {};
    },
  };
}

export function fileCredentialStore(path: string): CredentialStore {
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (cause) {
        if (isMissing(cause)) return {};
        throw storageError("read", path, cause);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch (cause) {
        const result = StoredCredentialsSchema.safeParse(text);
        if (!result.success) throw new T3DecodeError(`credential file ${path}`, result.error, text);
        throw storageError("parse", path, cause);
      }
      const result = StoredCredentialsSchema.safeParse(raw);
      if (!result.success) throw new T3DecodeError(`credential file ${path}`, result.error, raw);
      return clone(result.data);
    },
    async save(credentials) {
      const result = StoredCredentialsSchema.safeParse(credentials);
      if (!result.success) {
        throw new T3DecodeError(`credentials for ${path}`, result.error, credentials);
      }
      const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, `${JSON.stringify(result.data, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporaryPath, path);
      } catch (cause) {
        await unlink(temporaryPath).catch(() => undefined);
        if (cause instanceof T3Error) throw cause;
        throw storageError("write", path, cause);
      }
    },
    async clear() {
      try {
        await unlink(path);
      } catch (cause) {
        if (!isMissing(cause)) throw storageError("clear", path, cause);
      }
    },
  };
}

function clone(credentials: {
  accessToken?: string | undefined;
  scopes?: AuthGrantedScopeType[] | undefined;
  expiresAt?: string | undefined;
  sessionMethod?: ServerAuthSessionMethodType | undefined;
}): StoredCredentials {
  return {
    ...(credentials.accessToken === undefined ? {} : { accessToken: credentials.accessToken }),
    ...(credentials.scopes === undefined ? {} : { scopes: [...credentials.scopes] }),
    ...(credentials.expiresAt === undefined ? {} : { expiresAt: credentials.expiresAt }),
    ...(credentials.sessionMethod === undefined
      ? {}
      : { sessionMethod: credentials.sessionMethod }),
  };
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

function storageError(action: string, path: string, cause: unknown): T3ConnectionError {
  return new T3ConnectionError("open_failed", `Could not ${action} credential file ${path}.`, {
    cause,
  });
}
