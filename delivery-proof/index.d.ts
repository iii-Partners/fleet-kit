// Type declarations for @iii-partners/fleet-kit/delivery-proof (the implementation is index.js; keep both in step).
export const DEFAULT_BASE_URL: string;
export class DeliveryError extends Error {
  constructor(message: string, detail?: Record<string, unknown>);
  [key: string]: unknown;
}
export interface ConfigureOptions { apiKey?: string; serverId?: string; baseUrl?: string; fetch?: typeof fetch }
export function configure(opts?: ConfigureOptions): { serverId?: string; baseUrl: string; apiKey?: '(set)' };

export interface Address { email?: string; phone?: string; name?: string }
export interface MessageCode { value: string }
export interface MessageLink { href: string; text?: string }
export interface MessageBody { body?: string; links?: MessageLink[]; codes?: MessageCode[] }
/** A Mailosaur message (GET /api/messages/:id) with `bodyText` added by the kit. */
export interface Message {
  id: string;
  type?: 'Email' | 'SMS' | string;
  server?: string;
  from?: Address[];
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject?: string;
  received?: string;
  html?: MessageBody;
  text?: MessageBody;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
  bodyText: string;
  [key: string]: unknown;
}
export interface ServerOptions { apiKey?: string; serverId?: string; baseUrl?: string; fetch?: typeof fetch }
export interface WaitOptions extends ServerOptions { timeoutMs?: number; receivedAfter?: Date | string | number }
export interface SearchCriteria { sentTo?: string; sentFrom?: string; subject?: string; body?: string; match?: 'ALL' | 'ANY' }

export function generateEmail(prefix?: string, opts?: ServerOptions): string;
export function waitForMessage(criteria: SearchCriteria, opts?: WaitOptions): Promise<Message>;
export function waitForEmail(sentTo: string, opts?: WaitOptions & SearchCriteria): Promise<Message>;
export function waitForSms(phone?: string | null, opts?: WaitOptions & Pick<SearchCriteria, 'body' | 'match'>): Promise<Message>;

export function decodeEntities(s: unknown): string;
export function stripHtml(html: unknown): string;
export function textOf(input: Message | string | null | undefined): string;
export function extractLinks(input: Message | string | null | undefined): string[];
export function extractCode(input: Message | string | null | undefined, opts?: { length?: number }): string | null;

export interface PlaceholderPattern { name: string; re: RegExp; structural?: boolean }
export const PLACEHOLDER_PATTERNS: readonly PlaceholderPattern[];
export function assertNoPlaceholders(input: Message | string, opts?: { allow?: string[]; extra?: (RegExp | string)[] }): void;

export interface Hop { url: string; status: number }
/** Where a link ends up when followed with a per-host cookie jar: the final status and URL, every hop, and whether it looped. */
export interface FollowResult { status: number; final: string; redirected: boolean; hops: Hop[]; loop: boolean }
export function followLink(url: string, opts?: { fetch?: typeof fetch; timeoutMs?: number; maxHops?: number; headers?: Record<string, string> }): Promise<FollowResult>;
export interface LinkResult extends FollowResult { url: string; ok: boolean; attempts: number; reason?: string }
export interface LinksOptions { skip?: (RegExp | string)[]; timeoutMs?: number; fetch?: typeof fetch; concurrency?: number; errorPagePattern?: RegExp; allowStatus?: number[]; retries?: number; laterAttempts?: number; retryAfterCapMs?: number; maxHops?: number }
export function assertLinksResolve(input: Message | string, opts?: LinksOptions): Promise<LinkResult[]>;

export function assertSender(message: Message, expect?: { email?: string; name?: string; domain?: string }): void;
export function assertSubject(message: Message, includes: string | RegExp): void;
export function assertRecipient(message: Message, addr: string): void;
export function assertContains(message: Message, text: string | RegExp): void;

export function deleteMessage(id: string, opts?: ServerOptions): Promise<void>;
export function deleteAllMessages(opts?: ServerOptions): Promise<void>;
export function serverInfo(opts?: ServerOptions): Promise<Record<string, unknown>>;
export function listMessages(opts?: ServerOptions & { itemsPerPage?: number; receivedAfter?: Date | string }): Promise<Message[]>;
