// Service & resource plugins (e.g. `@brickkit/crud`).
export {
  defineServicePlugin,
  defineResourcePlugin,
  getPluginEndpoints,
} from "./plugin";
export type {
  ServicePlugin,
  ResourcePlugin,
  ServicePluginContext,
  ResourcePluginContext,
  ResourcePluginTypes,
  ResourcePluginAPI,
  PluginRouteRegistrar,
  PluginRoutes,
  PluginRouteScope,
  PluginRouteMethod,
  PluginEndpointContext,
  InstalledPlugin,
} from "./plugin-types";
export { definePlugin } from "./define-plugin";
export {
  getHostHooks,
  type HostHooks,
  type PluginHooks,
  type PluginHookArgs,
} from "./plugin-hooks";
export type { PluginTableBuilders } from "./plugin-tables";
export type {
  PluginManifest,
  PluginFactory,
  PluginInstance,
  PluginInfo,
  PluginInstallOptions,
  PluginContext,
  PluginServiceContext,
  PluginSetupContext,
  PluginAppContext,
  PluginLifecycleContext,
} from "./define-plugin";
// HTTP Runtime (Elysia app): bundled to user apps, never the CLI.
export { brick, type CreateServerOptions } from "./server";
export type { CorsOptions, CorsOrigin } from "./cors";
export {
  type BrickApp,
  type EndpointContext,
  type EndpointDefinition,
  type EndpointLogger,
  type EndpointMethod,
} from "./endpoints";
export { createActionHandler } from "./action-handler";
export { isBrickApp, requireBrickApp } from "./app-entry";
export {
  requestLoggingPlugin,
  type RequestLoggingOptions,
} from "./request-logger";
export { traceRoute } from "./telemetry";
export { SPAN, ATTR, GLOBAL_SYMBOL } from "./telemetry-names";
export type { DashboardAuth, DashboardOptions } from "./dashboard";
export {
  scalarDocsHTML,
  referencePlugin,
  registerReferenceRoute,
  type ApiDocument,
  type DocumentationOptions,
  type OpenApiDocument,
  type ReferenceDocument,
  type ReferenceOptions,
} from "./docs";
export {
  compileBrickApplication,
  bindCompiledApplication,
  loadCompiledBrickApp,
  type BrickIR,
  type RouteIR,
  type RouteMethod,
  type CompiledApplication,
  type CompiledRoute,
  type CompiledHandler,
  type CompiledRoutePlan,
  type HandlerFactory,
} from "./compiler";
export { deny } from "./compiler/runtime";

export { defineService } from "./service";
export type {
  BrickSocketConfig,
  BrickSocketHandle,
  BrickSocketSchema,
  BrickSocketSender,
  SocketBroker,
  SocketBrokerMessage,
  SocketEmitArgs,
  SocketEmitOptions,
  SocketEventArgs,
  SocketReplay,
  SocketPayloads,
  SocketSchemas,
} from "./socket-types";
export { serializeSocketSchema } from "./socket-schema";
export { redisBroker, type RedisBrokerOptions } from "./socket-redis";
export { getActionAccess, setActionAccess } from "./access";
export type { ActionAccessInfo } from "./access";
export type { HttpMethod } from "./http";
export { defineAction, errorsOf, buildErrorHelpers } from "./action";
export { defineResource, idSchema, loadRecord } from "./resource";
export {
  getActionRoute,
  getPluginActionRoute,
  actionOwners,
  type ActionRoute,
  type ResourceActionInfo,
} from "./routes";
export { kebabCase } from "./kebab";
export {
  useService,
  type ServiceClient,
  type ServiceActionCaller,
  type UntypedServiceClient,
} from "./rpc";
export { port, useDeps, type Port, type Ports, type DepsOf } from "./deps";
export {
  defineError,
  stepErrors,
  stepFailure,
  type StepErrorBuilder,
} from "./workflow";

export { defineListener } from "./events/listener";
export { emitEvent } from "./events/emit";
export {
  crudEventName,
  crudEventSource,
  isCrudEvent,
  type CrudEventOperation,
  type EventCatalog,
  type EventRef,
  type EventRefs,
} from "./events/catalog";
export {
  outboxTable,
  type OutboxStatus,
  type OutboxTable,
  type PostgresOutboxTable,
  type SQLiteOutboxTable,
} from "./events/outbox";
export { runInTransaction, onTransactionCommit } from "./events/transaction";
export {
  defineSchedule,
  type Schedule,
  type ScheduleConfig,
  type ScheduleRun,
  type ScheduleWorkflow,
  type ScheduleWorkflowRun,
} from "./schedules/schedule";
export {
  scheduleTable,
  type ScheduleRunRecord,
  type ScheduleTable,
  type PostgresScheduleTable,
  type SQLiteScheduleTable,
} from "./schedules/table";
export type { ScheduleState } from "./schedules/scheduler";
export { resolveWorkflowPaths, WORKFLOW_BUNDLE } from "./events/workflows";
export {
  stopAllEvents,
  type EventsHub,
  type EventsDefinition,
  type ScheduleControl,
} from "./events/hub";
export { Dispatcher, type OutboxCounts } from "./events/dispatcher";
export type {
  CrudEventPayload,
  DispatchOptions,
  EventDelivery,
  EventEnvelope,
  EventListener,
  ListenerFailure,
  RetryDecision,
  EventRecorder,
  EventWorkflow,
  EventsOptions,
  EventsWorld,
  ServiceEvents,
  WorkflowEvent,
  WorkflowsOptions,
} from "./events/types";

// Typed HTTP Client (also importable as `@brickkit/core/client` for frontends)
export {
  createBrickClient,
  BrickTransportError,
  BrickServerError,
  isBrickTransportError,
  isBrickServerError,
} from "./client";
export type {
  BrickClient,
  BrickClientOptions,
  BrickClientAction,
  BrickServices,
  BrickCallOptions,
  BrickActionCaller,
  InferActionInput,
  InferActionOutput,
  InferActionErrorCodes,
  InferActionFailure,
} from "./client";
export {
  type ServiceRegistry,
  getGlobalRegistry,
  resetGlobalRegistry,
} from "./registry";

export { Type, t, validateWithSchema } from "./typebox";
export type { TSchema, Static } from "./typebox";

export { generateOpenApiSpec } from "./openapi";
export type { OpenApiGeneratorOptions } from "./openapi";

export * from "./db";

export * from "./types";

export {
  defineSecret,
  SecretRef,
  envSource,
  resolveSecrets,
  listSecrets,
  overrideSecret,
  resetSecrets,
} from "./secrets";
export type { SecretSource, SecretOptions } from "./secrets";

export { defineTool, isTool } from "./tool";
export { createMcpRegistry, createMcpHandler, UnknownToolError } from "./mcp";
export type {
  McpToolDefinition,
  McpRegistry,
  McpRegistryOptions,
  McpHandlerOptions,
} from "./mcp";

export type { ErrorEnvelope } from "./error-response";
