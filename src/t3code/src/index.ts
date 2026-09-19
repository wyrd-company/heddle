// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
/**
 * Public surface of Heddle's internal T3 Code client. Everything a consumer may
 * import comes from here; internal modules are not part of the contract.
 */
export { T3Client, type T3ClientOptions } from "./client.js";

export {
  T3Error,
  T3HttpError,
  T3AuthError,
  T3NotFoundError,
  T3RpcError,
  T3RpcDefectError,
  T3ConnectionError,
  T3DecodeError,
  T3PreconditionError,
  T3InterruptedError,
  T3TimeoutError,
  isT3Error,
  type T3ErrorCode,
  type T3ConnectionFailureReason,
  type T3HttpErrorDetails,
} from "./errors.js";

export {
  memoryCredentialStore,
  fileCredentialStore,
  type CredentialStore,
  type StoredCredentials,
} from "./auth/credential-store.js";
export { AuthClient, type ExchangePairingTokenOptions } from "./auth/auth-client.js";
export * from "./auth/scopes.js";
export { watchAccess } from "./auth/watch-access.js";

export { ProjectsApi } from "./api/projects.js";
export type {
  ProjectCreateInput,
  ProjectEnsureInput,
  ProjectFilesApi,
  ProjectMetaUpdate,
} from "./api/projects.js";
export { ThreadsApi } from "./api/threads.js";
export type {
  ThreadCreateInput,
  ThreadListOptions,
  ThreadMetaUpdate,
  WatchOptions,
} from "./api/threads.js";
export type { StartTurnInput, TurnHandle, TurnOutcome } from "./api/turns.js";
export { ShellApi, type ShellWatchItem, type ShellWatchOptions } from "./api/shell.js";
export { ServerApi } from "./api/server.js";
export type { WatchServerConfigOptions, WatchServerLifecycleOptions } from "./api/server.js";
export { McpApi } from "./api/mcp.js";
export { VcsApi } from "./api/vcs.js";
export { TerminalApi } from "./api/terminal.js";
export type { DecodedStreamItem } from "./api/stream-items.js";
export { CommandDispatcher } from "./api/dispatch.js";
export {
  applyThreadEvent,
  pendingRequests,
  settledTurnStateForSessionStatus,
  threadPhase,
  type PendingRequest,
  type ThreadPhase,
  type SettledTurnState,
} from "./api/thread-projection.js";
export {
  watchThread,
  type ThreadWatchItem,
  type ThreadWatchOptions,
  type ThreadDerivedItem,
} from "./api/thread-watch.js";

export { RpcClient, type RpcClientOptions, type StreamItem } from "./rpc/client.js";
export type { RpcStreamOptions } from "./transport/rpc-connection.js";
export { rpcMethods, type RpcMethodName, type RpcMethods } from "./rpc/registry.js";
export type {
  AuthEnvironmentScope,
  RpcMethodSpec,
  RpcMethodTable,
  RpcPayload,
  RpcSuccess,
  StreamMethodName,
  UnaryMethodName,
} from "./rpc/spec.js";

export type { Logger } from "./internal/logger.js";
export { consoleLogger } from "./internal/logger.js";
export type { WebSocketConstructor, WebSocketLike } from "./internal/websocket.js";

export * as schemas from "./schemas/index.js";
export type {
  ThreadId,
  ProjectId,
  CommandId,
  MessageId,
  TurnId,
  EventId,
  ApprovalRequestId,
  AuthSessionId,
  ProviderInstanceId,
} from "./schemas/common.js";
export {
  threadId,
  projectId,
  commandId,
  messageId,
  turnId,
  eventId,
  approvalRequestId,
  authSessionId,
  providerInstanceId,
} from "./schemas/common.js";
export type {
  OrchestrationThread,
  OrchestrationMessage,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadActivity,
  OrchestrationLatestTurn,
  OrchestrationSession,
} from "./schemas/orchestration/read-model.js";
export type {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  OrchestrationShellSnapshot,
} from "./schemas/orchestration/shell.js";
export type { OrchestrationEvent } from "./schemas/orchestration/events.js";
export type { ClientOrchestrationCommand } from "./schemas/orchestration/commands.js";
export type { DispatchResult } from "./schemas/orchestration/stream.js";
export type {
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  ProviderApprovalDecision,
  ChatAttachment,
} from "./schemas/orchestration/model.js";
export type {
  ApprovalRequestedPayload,
  UserInputRequestedPayload,
  UserInputQuestion,
} from "./schemas/orchestration/activities.js";
export type {
  ExternalMcpRegistration,
  ExternalMcpClear,
  ExternalMcpProviderSessionQuery,
} from "./schemas/mcp.js";
