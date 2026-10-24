export type Protocol = 'openai' | 'responses' | 'anthropic' | 'gemini';
export type Fingerprint = 'passthrough' | 'codex' | 'claude-code';
export interface Channel {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  apiKeys?: string[];
  hasApiKey?: boolean;
  keyCount?: number;
  enabled: boolean;
  protocol: Protocol | 'auto';
  protocols: Protocol[];
  fingerprint: Fingerprint;
  headers: Record<string, string>;
  models: string[];
  modelMap: Record<string, string>;
  timeoutMs: number;
  priority: number;
  isDemo?: boolean;
  createdAt?: string;
  updatedAt?: string;
}
export interface Settings {
  defaultChannelId: string;
  defaultFingerprint: Fingerprint;
  heartbeatMs: number;
  streamTimeoutMs: number;
  logRetention: number;
}
export interface UpstreamDiagnostics {
  upstreamCode?: string;
  upstreamMessage?: string;
  retryAfterSeconds?: number;
}
export interface RequestLog extends UpstreamDiagnostics {
  id: string;
  time: string;
  channelId: string;
  channelName: string;
  model: string;
  incomingProtocol: Protocol;
  upstreamProtocol: Protocol;
  fingerprint: Fingerprint;
  stream: boolean;
  status: number;
  durationMs: number;
  firstByteMs: number | null;
  outcome: 'ok' | 'error' | 'cancelled';
  error?: string;
  errorMessage?: string;
  conversionWarnings?: string[];
  attempts: number;
  keyIndex: number | null;
  keyCount: number;
}
export interface KeyPolicy {
  channelId: string | null;
  models: string[] | null;
}
export interface ChannelKeySelection {
  apiKey: string | undefined;
  keyIndex: number | null;
  keyCount: number;
}
export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ENV?: string;
  ALLOW_LOCAL_UPSTREAM?: string;
  ALLOW_UNAUTHENTICATED_PUBLIC?: string;
  AUTH_ENABLED?: string;
}
