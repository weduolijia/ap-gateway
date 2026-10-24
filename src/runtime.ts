import type { Bindings } from './types';

/**
 * Cloudflare 免费套餐的公开上限，仅用于面板里的参考刻度。
 * Workers 请求数、CPU 用量与 D1 读/写行数属于账号级指标，只有带 Analytics 读取权限的
 * API 令牌才能查询；未配置或不具备权限时面板明确显示“未配置”，不做估算。
 */
export const PLAN_LIMITS = {
  workerRequestsPerDay: 100_000,
  workerCpuMsPerRequest: 10,
  workerMemoryMb: 128,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  d1DatabaseBytes: 10 * 1024 * 1024 * 1024,
} as const;

export interface TableStat { name: string; rows: number | null; payloadBytes: number | null }

export interface D1Status {
  name: string;
  reachable: boolean;
  sizeBytes: number | null;
  sizeSource: 'metadata-api' | 'unavailable';
  storagePercent: number | null;
  tables: TableStat[];
  totalRows: number | null;
  requestLogRows: number | null;
  logWindow: { oldest: string | null; newest: string | null };
  warnings: string[];
}

export interface WorkersStatus {
  requestsToday: number | null;
  errorsToday: number | null;
  averageDurationMs: number | null;
  maxDurationMs: number | null;
  source: 'request-log' | 'unavailable';
  planLimits: typeof PLAN_LIMITS;
  accountUsage: {
    available: boolean;
    requests: number | null;
    errors: number | null;
    cpuTimeP50Ms: number | null;
    cpuTimeP99Ms: number | null;
    period: 'today' | null;
    note: string;
  };
}

export interface D1AccountUsage {
  available: boolean;
  rowsRead: number | null;
  rowsWritten: number | null;
  note: string;
}

export interface RuntimeView {
  generatedAt: string;
  d1: D1Status;
  workers: WorkersStatus;
  d1AccountUsage: D1AccountUsage;
  tokenConfigured: boolean;
}

type Env = Pick<Bindings, 'CF_ACCOUNT_ID' | 'CF_D1_DATABASE_ID' | 'CF_API_TOKEN' | 'CF_ANALYTICS_TOKEN'>;

// Account-level analytics and D1 metadata need different scopes, so the panel accepts two tokens.
function analyticsToken(env: Env): string | undefined { return env.CF_ANALYTICS_TOKEN || env.CF_API_TOKEN; }

const TABLE_NAME = /^[A-Za-z0-9_]+$/;

async function tableStats(db: D1Database, warnings: string[]): Promise<TableStat[]> {
  let names: string[] = [];
  try {
    const listed = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>();
    names = listed.results.map(row => row.name);
  } catch {
    warnings.push('Could not list tables');
    return [];
  }
  const stats: TableStat[] = [];
  for (const name of names) {
    if (!TABLE_NAME.test(name)) continue;
    try {
      // config 是 JSON 文本列；没有该列的表回退为只统计行数。
      const row = await db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(config)),0) AS payload FROM "${name}"`).first<{ rows: number; payload: number }>();
      stats.push({ name, rows: row?.rows ?? 0, payloadBytes: row?.payload ?? 0 });
    } catch {
      try {
        const row = await db.prepare(`SELECT COUNT(*) AS rows FROM "${name}"`).first<{ rows: number }>();
        stats.push({ name, rows: row?.rows ?? 0, payloadBytes: null });
      } catch {
        stats.push({ name, rows: null, payloadBytes: null });
        warnings.push(`Could not count table ${name}`);
      }
    }
  }
  return stats;
}

async function d1MetadataSize(env: Env): Promise<{ size: number | null; note: string }> {
  // A dedicated metadata token wins; otherwise reuse the analytics token, which may already carry D1 read.
  const token = env.CF_API_TOKEN || analyticsToken(env);
  if (!token) return { size: null, note: 'Neither CF_API_TOKEN nor CF_ANALYTICS_TOKEN is set; Cloudflare metadata is unavailable' };
  if (!env.CF_ACCOUNT_ID || !env.CF_D1_DATABASE_ID) return { size: null, note: 'CF_ACCOUNT_ID or CF_D1_DATABASE_ID is missing' };
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/d1/database/${encodeURIComponent(env.CF_D1_DATABASE_ID)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) { await response.body?.cancel(); return { size: null, note: `Metadata API returned HTTP ${response.status}` }; }
    const payload: any = await response.json();
    const size = payload?.result?.file_size;
    return typeof size === 'number' ? { size, note: '' } : { size: null, note: 'Metadata API returned no file_size' };
  } catch {
    return { size: null, note: 'Metadata API request failed' };
  }
}

async function graphql(env: Env, query: string): Promise<any | null> {
  const token = analyticsToken(env);
  if (!token || !env.CF_ACCOUNT_ID) return null;
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const payload: any = await response.json();
    if (payload?.errors?.length) return null;
    return payload;
  } catch { return null; }
}

export async function d1Status(db: D1Database, env: Env): Promise<D1Status> {
  const warnings: string[] = [];
  let reachable = true;
  try { await db.prepare('SELECT 1 AS ok').first(); } catch { reachable = false; }
  if (!reachable) {
    return { name: 'database', reachable, sizeBytes: null, sizeSource: 'unavailable', storagePercent: null, tables: [], totalRows: null, requestLogRows: null, logWindow: { oldest: null, newest: null }, warnings: ['D1 connection failed'] };
  }
  const tables = await tableStats(db, warnings);
  const meta = await d1MetadataSize(env);
  if (meta.note) warnings.push(meta.note);
  const totalRows = tables.every(table => table.rows !== null) ? tables.reduce((sum, table) => sum + (table.rows ?? 0), 0) : null;
  let logWindow: D1Status['logWindow'] = { oldest: null, newest: null };
  try {
    const row = await db.prepare('SELECT MIN(time) AS oldest, MAX(time) AS newest FROM request_logs').first<{ oldest: string | null; newest: string | null }>();
    logWindow = { oldest: row?.oldest ?? null, newest: row?.newest ?? null };
  } catch { warnings.push('Could not read the log time range'); }
  return {
    name: env.CF_D1_DATABASE_ID ? 'ap-gateway-cloud-db' : 'ap-gateway-db',
    reachable,
    sizeBytes: meta.size,
    sizeSource: meta.size !== null ? 'metadata-api' : 'unavailable',
    storagePercent: meta.size !== null ? Math.round(meta.size / PLAN_LIMITS.d1DatabaseBytes * 10000) / 100 : null,
    tables,
    totalRows,
    requestLogRows: tables.find(table => table.name === 'request_logs')?.rows ?? null,
    logWindow,
    warnings,
  };
}

export async function workersStatus(db: D1Database, env: Env): Promise<WorkersStatus> {
  const accountUsage: WorkersStatus['accountUsage'] = { available: false, requests: null, errors: null, cpuTimeP50Ms: null, cpuTimeP99Ms: null, period: null, note: '' };
  let requestsToday: number | null = null;
  let errorsToday: number | null = null;
  let averageDurationMs: number | null = null;
  let maxDurationMs: number | null = null;
  let source: WorkersStatus['source'] = 'unavailable';
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  try {
    const row = await db.prepare('SELECT COUNT(*) AS requests, SUM(CASE WHEN status>=500 THEN 1 ELSE 0 END) AS errors, AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms FROM request_logs WHERE time>=?')
      .bind(dayStart.toISOString()).first<{ requests: number; errors: number | null; avg_ms: number | null; max_ms: number | null }>();
    requestsToday = row?.requests ?? 0;
    errorsToday = row?.errors ?? 0;
    averageDurationMs = row?.avg_ms !== null && row?.avg_ms !== undefined ? Math.round(row.avg_ms) : null;
    maxDurationMs = row?.max_ms ?? null;
    source = 'request-log';
  } catch { /* 面板显示不可用 */ }

  if (!analyticsToken(env)) {
    accountUsage.note = 'CF_ANALYTICS_TOKEN is not set; account-level Workers usage and CPU quota are unavailable.';
  } else {
    // date_geq/date_leq 使用 UTC 日期；只统计本 Worker 的脚本名。
    const today = dayStart.toISOString().slice(0, 10);
    const payload = await graphql(env, `{ viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { workersInvocationsAdaptive(limit: 20, filter: {date_geq: "${today}", date_leq: "${today}"}) { sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { scriptName } } } } }`);
    const rows = payload?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    const own = Array.isArray(rows) ? rows.find((row: any) => row?.dimensions?.scriptName === 'ap-gateway') : undefined;
    if (own) {
      accountUsage.available = true;
      accountUsage.requests = own.sum?.requests ?? 0;
      accountUsage.errors = own.sum?.errors ?? 0;
      accountUsage.cpuTimeP50Ms = typeof own.quantiles?.cpuTimeP50 === 'number' ? Math.round(own.quantiles.cpuTimeP50 / 10) / 100 : null;
      accountUsage.cpuTimeP99Ms = typeof own.quantiles?.cpuTimeP99 === 'number' ? Math.round(own.quantiles.cpuTimeP99 / 10) / 100 : null;
      accountUsage.period = 'today';
      accountUsage.note = 'From Cloudflare GraphQL Analytics (UTC day, ap-gateway script only).';
    } else {
      accountUsage.note = 'The token cannot read GraphQL Analytics, or there is no data for today yet.';
    }
  }

  return { requestsToday, errorsToday, averageDurationMs, maxDurationMs, source, planLimits: PLAN_LIMITS, accountUsage };
}

export async function d1AccountUsage(env: Env): Promise<D1AccountUsage> {
  if (!analyticsToken(env)) return { available: false, rowsRead: null, rowsWritten: null, note: 'CF_ANALYTICS_TOKEN is not set; account-level D1 rows read/written are unavailable.' };
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const today = dayStart.toISOString().slice(0, 10);
  const payload = await graphql(env, `{ viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { d1AnalyticsAdaptiveGroups(limit: 50, filter: {date_geq: "${today}", date_leq: "${today}"}) { sum { readQueries writeQueries rowsRead rowsWritten } dimensions { databaseId } } } } }`);
  const rows = payload?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  const own = Array.isArray(rows) ? rows.find((row: any) => row?.dimensions?.databaseId === env.CF_D1_DATABASE_ID) : undefined;
  if (!own) return { available: false, rowsRead: null, rowsWritten: null, note: 'The token cannot read D1 Analytics, or there is no data for today yet.' };
  return { available: true, rowsRead: own.sum?.rowsRead ?? 0, rowsWritten: own.sum?.rowsWritten ?? 0, note: '来自 Cloudflare GraphQL Analytics（UTC 当日，仅本数据库）。' };
}

export async function runtimeView(db: D1Database, env: Env): Promise<RuntimeView> {
  const [d1, workers, d1Usage] = await Promise.all([d1Status(db, env), workersStatus(db, env), d1AccountUsage(env)]);
  return { generatedAt: new Date().toISOString(), d1, workers, d1AccountUsage: d1Usage, tokenConfigured: !!(env.CF_API_TOKEN || env.CF_ANALYTICS_TOKEN) };
}
