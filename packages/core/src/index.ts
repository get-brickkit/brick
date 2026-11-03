// Service & resource plugins (e.g. `@brickkit/crud`).
export {
  defineServicePlugin,
  defineResourcePlugin,
  getPluginActionRoute,
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
} from "./plugin";
export {
  definePlugin,
  satisfiesRange,
  brickVersion,
  isPluginInstance,
} from "./define-plugin";
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
  PluginHooks,
  PluginTableBuilders,
  InstalledPlugin,
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
  resolveEndpointDb,
  createEndpointHandler,
  toOpenApiPath,
  endpointPaths,
} from "./endpoints";
export {
  compileRoutePlan,
  executeCompiledRoute,
  createActionHandler,
} from "./action-handler";
export { isBrickApp, requireBrickApp } from "./app-entry";
export {
  requestLoggingPlugin,
  type RequestLoggingOptions,
} from "./request-logger";
export { traceRoute } from "./telemetry";
export type { DashboardAuth, DashboardOptions } from "./dashboard";
export {
  scalarDocsHTML,
  swaggerDocsHTML,
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
  type HandlerFactory,
} from "./compiler";
export { emitHandlerFactory } from "./compiler/emit";
export { compilerRuntime } from "./compiler/runtime";

// Core Primitives
export { defineService, ServiceImpl } from "./service";
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
export { getActionAccess, setActionAccess, ACTION_ACCESS_KEY } from "./access";
export type { ActionAccessInfo } from "./access";
export {
  defineAction,
  defineError,
  errorsOf,
  buildErrorHelpers,
} from "./action";
export { defineResource, loadRecord } from "./resource";
export {
  getActionRoute,
  kebabCase,
  type ActionRoute,
  type ResourceActionInfo,
} from "./routes";
export {
  useService,
  type ServiceClient,
  type ServiceActionCaller,
  type UntypedServiceClient,
} from "./rpc";
export { port, useDeps, type Port, type Ports, type DepsOf } from "./deps";

export {
  defineListener,
  emitEvent,
  isEventRef,
  outboxTable,
  isOutboxTable,
  runInTransaction,
  onTransactionCommit,
  resolveWorkflowPaths,
  EventsHub,
  stopAllEvents,
  Dispatcher,
  type CrudEventPayload,
  type DispatchOptions,
  type EventCatalog,
  type EventRef,
  type EventRefs,
  type EventDelivery,
  type EventEnvelope,
  type EventListener,
  type ListenerFailure,
  type RetryDecision,
  type EventRecorder,
  type EventWorkflow,
  type EventsDefinition,
  type EventsOptions,
  type EventsWorld,
  type OutboxCounts,
  type OutboxStatus,
  type OutboxTable,
  type PostgresOutboxTable,
  type SQLiteOutboxTable,
  type ServiceEvents,
  type WorkflowEvent,
  type WorkflowsOptions,
} from "./events";

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
  ServiceRegistry,
  getGlobalRegistry,
  resetGlobalRegistry,
} from "./registry";

// TypeBox Schema Builders & Validators
export { Type, t, getCompiledCheck, validateWithSchema } from "./typebox";
export type { TSchema, Static } from "./typebox";

// OpenAPI 3.1 Specification Generation
export { generateOpenApiSpec, hoistAnchoredSchemas } from "./openapi";
export type { OpenApiGeneratorOptions } from "./openapi";

// Database Integration
export * from "./db";

// Types & Errors
export * from "./types";

// Secrets & Environment Variables
export {
  defineSecret,
  SecretRef,
  envSource,
  resolveSecrets,
  listSecrets,
  overrideSecret,
  overrideSecrets,
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
  McpOptions,
} from "./mcp";
export type { AuthOptions } from "./access";

export { toErrorResponse } from "./error-response";
export type { ErrorEnvelope } from "./error-response";
