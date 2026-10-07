// Type declarations for @iii-partners/fleet-kit/telemetry (the implementation is index.js; keep both in step).
export const VERSION: string;
export const SCHEMA: 'iii-telemetry-v1';
export const DEFAULT_HOST: string;
export const CLASSES: readonly ['product', 'agent', 'error', 'health'];
export const ACTOR_TYPES: readonly ['human', 'agent'];
export const ENVS: readonly ['production', 'preview', 'development', 'test'];
export const REQUIRED_PROPS: readonly ['venture_id', 'pillar', 'actor_type', 'actor_id', 'run_id', 'ticket', 'executor', 'env', 'class'];
export const STRING_PROPS: readonly string[];
export const AGENT_PROPS: readonly ['model', 'provider', 'tokens_in', 'tokens_out', 'cost_usd', 'duration_ms'];
export const AGENT_NUMERIC_PROPS: readonly ['tokens_in', 'tokens_out', 'cost_usd', 'duration_ms'];
export const FORBIDDEN_KEY_PATTERNS: readonly RegExp[];
export const FORBIDDEN_VALUE_PATTERNS: readonly { name: string; re: RegExp }[];

export type EventClass = 'product' | 'agent' | 'error' | 'health';
export type ActorType = 'human' | 'agent';
export type EnvName = 'production' | 'preview' | 'development' | 'test';

/** The common properties of the Fleet Telemetry Standard (section 2). Defaults fill what a caller leaves out. */
export interface CommonProps {
  venture_id: string;
  pillar: string;
  actor_type: ActorType;
  actor_id: string;
  run_id: string;
  ticket: string;
  executor: string;
  env: EnvName | string;
  class: EventClass;
}
/** The six agent properties, required when `class` is `agent`. */
export interface AgentProps {
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
}
export type EventProps = Partial<CommonProps> & Partial<AgentProps> & Record<string, unknown>;

export class SchemaError extends Error {
  constructor(message: string, detail?: Record<string, unknown>);
  [key: string]: unknown;
}
export class PrivacyError extends SchemaError {}

export interface PrivacyViolation { path: string; reason: string }
export function findPrivacyViolations(obj: unknown, path?: string, depth?: number): PrivacyViolation[];
export function redact(str: unknown): string;
export interface ValidateOptions { defaults?: Partial<CommonProps> & Record<string, unknown>; events?: Record<string, EventClass> }
export function validate(event: string, props?: EventProps, options?: ValidateOptions): CommonProps & Record<string, unknown>;

export interface StackFrame { platform: string; filename: string; function: string; lineno: number; colno: number; in_app: boolean }
export function parseStack(stack: string | undefined | null, opts?: { platform?: string; max?: number }): StackFrame[];

export interface Rate { input_per_million: number; output_per_million: number }
/** Dollars for a call at the provider's public list price (USD per million tokens), rounded to 6 decimals. */
export function costUsd(tokensIn: number, tokensOut: number, rate: Rate): number;

export interface QueuedEvent { uuid: string; event: string; distinct_id: string; properties: Record<string, unknown>; timestamp: string }
export type Transport = (batch: QueuedEvent[]) => Promise<unknown>;
export interface TransportOptions { key: string; host?: string; path?: string; fetch?: typeof fetch; timeoutMs?: number; retries?: number }
export function postHogTransport(opts: TransportOptions): Transport;

export interface TelemetryOptions {
  key?: string;
  host?: string;
  defaults?: Partial<CommonProps> & Record<string, unknown>;
  events?: Record<string, EventClass>;
  transport?: Transport;
  dryRun?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  personProfiles?: boolean;
  distinctId?: string | ((event: string, props: CommonProps & Record<string, unknown>) => string);
  onError?: (error: unknown, batch: QueuedEvent[]) => void;
  now?: () => Date;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
export interface CaptureResult { ok: boolean; item?: QueuedEvent; error?: unknown }
export interface FlushResult { sent: number; failed: number; error?: unknown }
export interface Telemetry {
  capture(event: string, props?: EventProps): Promise<QueuedEvent>;
  safeCapture(event: string, props?: EventProps): Promise<CaptureResult>;
  captureError(err: unknown, props?: EventProps & { error_kind?: string; handled?: boolean }): Promise<CaptureResult>;
  flush(): Promise<FlushResult>;
  close(): Promise<FlushResult>;
  pending(): number;
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly VERSION: string;
  readonly SCHEMA: string;
}
export function createTelemetry(options?: TelemetryOptions): Telemetry;
