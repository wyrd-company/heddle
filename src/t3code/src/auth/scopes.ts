import { T3AuthError } from "../errors.js";
import type { AuthEnvironmentScope, AuthGrantedScope } from "../schemas/auth.js";

export { AuthAdministrativeScopes, AuthStandardClientScopes } from "../schemas/auth.js";

export const AuthOrchestrationReadScope = "orchestration:read" as const;
export const AuthOrchestrationOperateScope = "orchestration:operate" as const;
export const AuthTerminalOperateScope = "terminal:operate" as const;
export const AuthReviewWriteScope = "review:write" as const;
export const AuthAccessReadScope = "access:read" as const;
export const AuthAccessWriteScope = "access:write" as const;
export const AuthRelayReadScope = "relay:read" as const;
export const AuthRelayWriteScope = "relay:write" as const;

/** `granted` is what the server reported and may hold scopes this client does not know. */
export function hasScope(
  granted: readonly AuthGrantedScope[] | undefined,
  required: AuthEnvironmentScope,
): boolean {
  return granted?.includes(required) ?? false;
}

export function ensureScopes(
  granted: readonly AuthGrantedScope[] | undefined,
  required: readonly AuthEnvironmentScope[],
  context = "operation",
): void {
  for (const scope of required) {
    if (!hasScope(granted, scope)) throw T3AuthError.insufficientScope(scope, context);
  }
}
