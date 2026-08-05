/**
 * Browser-safe entry point.
 *
 * The main barrel pulls in `ddl.ts`, which needs node's crypto for DDL hashing.
 * The renderer only ever needs route matching, so it imports this instead.
 */

export type { JsonSchema, JsonSchemaType } from './json-schema';
export type { HttpMethod, OperationKind, RouteDescriptor } from './types';
export type { CompiledRoute } from './routes';
export {
  ALL_ROUTES,
  compileRoute,
  compileRoutes,
  ENGINE_ROUTES,
  OFFLINE_OPERATION_IDS,
  ROUTES,
  ROUTES_BY_OPERATION,
  routeFor,
} from './routes';
export { CONTRACT_VERSION, LOCAL_SCHEMA_VERSION } from './manifest-constants';
