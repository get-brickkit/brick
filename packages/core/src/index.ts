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
export { SPAN, ATTR, GLOBAL_SYMBOL } from "./telemetry-names";
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
  type CompiledRoutePlan,
  type HandlerFactory,
} from "./compiler";
export { compilerRuntime, deny } from "./compiler/runtime";

// Core Primitives
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
export {
  defineAction,
  defineError,
  errorsOf,
  buildErrorHelpers,
} from "./action";
export { defineResource, loadRecord } from "./resource";
export {
  getActionRoute,
  getPluginActionRoute,
  actionOwners,
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
export { stepErrors, stepFailure, type StepErrorBuilder } from "./workflow";

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
export { resolveWorkflowPaths, WORKFLOW_BUNDLE } from "./events/workflows";
export {
  stopAllEvents,
  type EventsHub,
  type EventsDefinition,
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

// TypeBox Schema Builders & Validators
export { Type, t, validateWithSchema } from "./typebox";
export type { TSchema, Static } from "./typebox";

// OpenAPI 3.1 Specification Generation
export { generateOpenApiSpec } from "./openapi";
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
