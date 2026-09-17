import { z } from "zod";

import { AuthGrantedScope } from "./auth.js";
import { TrimmedNonEmptyString } from "./common.js";

export const EnvironmentRequestInvalidError = z.looseObject({
  _tag: z.literal("EnvironmentRequestInvalidError"),
  code: z.literal("invalid_request"),
  reason: z.enum(["invalid_scope", "scope_not_granted", "invalid_command"]),
  traceId: TrimmedNonEmptyString,
});
export type EnvironmentRequestInvalidError = z.infer<typeof EnvironmentRequestInvalidError>;

export const EnvironmentAuthInvalidError = z.looseObject({
  _tag: z.literal("EnvironmentAuthInvalidError"),
  code: z.literal("auth_invalid"),
  reason: z.enum(["missing_credential", "invalid_credential"]),
  dpopFailureReason: z
    .enum([
      "time_window",
      "key_mismatch",
      "request_mismatch",
      "token_mismatch",
      "replay",
      "invalid_proof",
    ])
    .optional(),
  traceId: TrimmedNonEmptyString,
});
export type EnvironmentAuthInvalidError = z.infer<typeof EnvironmentAuthInvalidError>;

export const EnvironmentScopeRequiredError = z.looseObject({
  _tag: z.literal("EnvironmentScopeRequiredError"),
  code: z.literal("insufficient_scope"),
  requiredScope: AuthGrantedScope,
  traceId: TrimmedNonEmptyString,
});
export type EnvironmentScopeRequiredError = z.infer<typeof EnvironmentScopeRequiredError>;

export const EnvironmentOperationForbiddenError = z.looseObject({
  _tag: z.literal("EnvironmentOperationForbiddenError"),
  code: z.literal("operation_forbidden"),
  reason: z.literal("current_session_revoke_not_allowed"),
  traceId: TrimmedNonEmptyString,
});
export type EnvironmentOperationForbiddenError = z.infer<typeof EnvironmentOperationForbiddenError>;

export const EnvironmentResourceNotFoundError = z.looseObject({
  _tag: z.literal("EnvironmentResourceNotFoundError"),
  code: z.literal("not_found"),
  reason: z.literal("thread_not_found"),
  traceId: TrimmedNonEmptyString,
});
export type EnvironmentResourceNotFoundError = z.infer<typeof EnvironmentResourceNotFoundError>;

export const EnvironmentInternalError = z.looseObject({
  _tag: z.literal("EnvironmentInternalError"),
  code: z.literal("internal_error"),
  reason: z.enum([
    "bootstrap_validation_failed",
    "browser_session_issuance_failed",
    "browser_session_cookie_failed",
    "access_token_issuance_failed",
    "websocket_ticket_issuance_failed",
    "pairing_credential_issuance_failed",
    "pairing_links_load_failed",
    "pairing_link_revoke_failed",
    "client_sessions_load_failed",
    "client_session_revoke_failed",
    "orchestration_snapshot_failed",
    "orchestration_thread_snapshot_failed",
    "orchestration_dispatch_failed",
    "internal_error",
  ]),
  traceId: TrimmedNonEmptyString,
});
export type EnvironmentInternalError = z.infer<typeof EnvironmentInternalError>;

export const EnvironmentHttpCommonError = z.discriminatedUnion("_tag", [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = z.infer<typeof EnvironmentHttpCommonError>;

export const McpRouteError = z.looseObject({
  error: z.enum([
    "invalid_external_mcp_registration",
    "auth_invalid",
    "insufficient_scope",
    "internal_error",
  ]),
  requiredScope: AuthGrantedScope.optional(),
});
export type McpRouteError = z.infer<typeof McpRouteError>;
