export {
  CONNECTION_ROUTE_ERROR_CODES,
  ConnectionRouteError,
  connectionErrorDetails,
  connectionErrorResponse,
  createConnectionRouteHandler,
  withConnectionErrorMapping,
  type ConnectionErrorDetails,
  type ConnectionRouteErrorCode,
  type ConnectionRouteFailure,
  type CreateConnectionRouteHandlerOptions,
} from "../../../shared/oauth/connection-routes";
export {
  CONNECTION_STATUS_V2_MEDIA_TYPE,
  acceptsConnectionStatusV2,
  connectionStatusV1,
  githubOAuthCompatibilityStatus,
  googleOAuthCompatibilityStatus,
  negotiatedConnectionStatus,
  negotiatedRefreshResult,
} from "../../../shared/oauth/connection-status";
export { ConnectionLifecycle } from "../../../shared/oauth/connection-lifecycle";
export type {
  ConnectionStatus,
  ConnectionStatusV1,
  ConnectionStatusV2,
  LifecycleErrorCategory,
  RefreshConnectionResult,
} from "../../../shared/oauth/connection-types";
