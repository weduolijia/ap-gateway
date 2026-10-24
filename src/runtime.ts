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

interface TableMeta { name: string; hasConfig: boolean }

async function tableMeta(db: D1Database): Promise<TableMeta[]> {
  // pragma_table_info is not callable through D1's correlated form (SQLITE_AUTH), so the column
  // list comes from the CREATE TABLE text in one round trip instead of one PRAGMA per table.
  const listed = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
    .all<{ name: string; sql: string | null }>();
  return listed.results.filter(row => TABLE_NAME.test(row.name)).map(row => ({ name: row.name, hasConfig: /\bconfig\b/i.test(row.sql ?? '') }));
}

/**
 * All per-table counts, the log window and today's totals in a single D1 batch (one HTTP round trip).
 * The panel is opened by hand, but it must not fan out into a dozen sequential D1 calls.
 */
async function collectStats(db: D1Database, meta: TableMeta[], dayStart: string): Promise<{
  tables: TableStat[]; logWindow: { oldest: string | null; newest: string | null };
  today: { requests: number; errors: number | null; avg_ms: number | null; max_ms: number | null };
}> {
  const statements = meta.map(table => table.hasConfig
    ? db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(config)),0) AS payload FROM "${table.name}"`)
    : db.prepare(`SELECT COUNT(*) AS rows, NULL AS payload FROM "${table.name}"`));
  statements.push(db.prepare('SELECT MIN(time) AS oldest, MAX(time) AS newest FROM request_logs'));
  statements.push(db.prepare('SELECT COUNT(*) AS requests, SUM(CASE WHEN status>=500 THEN 1 ELSE 0 END) AS errors, AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms FROM request_logs WHERE time>=?').bind(dayStart));
  const results = await db.batch(statements) as D1Result<Record<string, any>>[];
  const tables: TableStat[] = meta.map((table, index) => ({
    name: table.name,
    rows: (results[index]?.results?.[0]?.rows as number | undefined) ?? null,
    payloadBytes: (results[index]?.results?.[0]?.payload as number | null | undefined) ?? null,
  }));
  const window = results[meta.length]?.results?.[0] ?? {};
  const today = results[meta.length + 1]?.results?.[0] ?? {};
  return {
    tables,
    logWindow: { oldest: (window.oldest as string | null) ?? null, newest: (window.newest as string | null) ?? null },
    today: { requests: Number(today.requests ?? 0), errors: today.errors === null || today.errors === undefined ? null : Number(today.errors), avg_ms: today.avg_ms === null || today.avg_ms === undefined ? null : Number(today.avg_ms), max_ms: today.max_ms === null || today.max_ms === undefined ? null : Number(today.max_ms) },
  };
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

const accountGraphQuery = (accountId: string, databaseId: string | undefined, today: string) => `{ viewer { accounts(filter: {accountTag: "${accountId}"}) {
  workersInvocationsAdaptive(limit: 20, filter: {date_geq: "${today}", date_leq: "${today}"}) { sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { scriptName } }
  d1AnalyticsAdaptiveGroups(limit: 50, filter: {date_geq: "${today}", date_leq: "${today}"}) { sum { readQueries writeQueries rowsRead rowsWritten } dimensions { databaseId } }
} } }`;

async function accountUsage(env: Env, databaseId: string | undefined): Promise<{ workers: WorkersStatus['accountUsage']; d1: D1AccountUsage }> {
  const unavailableWorkers: WorkersStatus['accountUsage'] = { available: false, requests: null, errors: null, cpuTimeP50Ms: null, cpuTimeP99Ms: null, period: null, note: '' };
  const unavailableD1: D1AccountUsage = { available: false, rowsRead: null, rowsWritten: null, note: '' };
  if (!analyticsToken(env)) {
    const note = 'CF_ANALYTICS_TOKEN is not set; account-level usage is unavailable.';
    return { workers: { ...unavailableWorkers, note }, d1: { ...unavailableD1, note } };
  }
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  // One GraphQL round trip covers both Workers and D1 usage.
  const payload = await graphql(env, accountGraphQuery(env.CF_ACCOUNT_ID!, databaseId, dayStart.toISOString().slice(0, 10)));
  const account = payload?.data?.viewer?.accounts?.[0];
  const own = Array.isArray(account?.workersInvocationsAdaptive) ? account.workersInvocationsAdaptive.find((row: any) => row?.dimensions?.scriptName === 'ap-gateway') : undefined;
  const workers: WorkersStatus['accountUsage'] = own
    ? {
      available: true,
      requests: own.sum?.requests ?? 0,
      errors: own.sum?.errors ?? 0,
      cpuTimeP50Ms: typeof own.quantiles?.cpuTimeP50 === 'number' ? Math.round(own.quantiles.cpuTimeP50 / 10) / 100 : null,
      cpuTimeP99Ms: typeof own.quantiles?.cpuTimeP99 === 'number' ? Math.round(own.quantiles.cpuTimeP99 / 10) / 100 : null,
      period: 'today',
      note: 'From Cloudflare GraphQL Analytics (UTC day, ap-gateway script only).',
    }
    : { ...unavailableWorkers, note: 'The token cannot read Workers Analytics, or there is no data for today yet.' };
  const d1Row = Array.isArray(account?.d1AnalyticsAdaptiveGroups) ? account.d1AnalyticsAdaptiveGroups.find((row: any) => row?.dimensions?.databaseId === databaseId) : undefined;
  const d1: D1AccountUsage = d1Row
    ? { available: true, rowsRead: d1Row.sum?.rowsRead ?? 0, rowsWritten: d1Row.sum?.rowsWritten ?? 0, note: '来自 Cloudflare GraphQL Analytics（UTC 当日，仅本数据库）。' }
    : { ...unavailableD1, note: 'The token cannot read D1 Analytics, or there is no data for today yet.' };
  return { workers, d1 };
}

// Repeated panel opens within this window reuse the previous result; the data moves on a minute scale.
const VIEW_TTL_MS = 30_000;
const viewCache = new WeakMap<object, { value: RuntimeView; expires: number }>();

export async function runtimeView(db: D1Database, env: Env, now = Date.now()): Promise<RuntimeView> {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  let reachable = true;
  try { await db.prepare('SELECT 1 AS ok').first(); } catch { reachable = false; }

  const warnings: string[] = [];
  if (!reachable) warnings.push('D1 connection failed');
  let meta: TableMeta[] = [];
  let collected: Awaited<ReturnType<typeof collectStats>> | null = null;
  if (reachable) {
    try { meta = await tableMeta(db); } catch { warnings.push('Could not list tables'); }
    try { collected = await collectStats(db, meta, dayStart.toISOString()); }
    catch { warnings.push('Could not read table statistics'); }
  }

  // External calls (metadata + account analytics) run alongside each other, not after the D1 work.
  const [size, usage] = await Promise.all([
    reachable ? d1MetadataSize(env) : Promise.resolve({ size: null, note: '' }),
    accountUsage(env, env.CF_D1_DATABASE_ID),
  ]);
  if (size.note) warnings.push(size.note);

  const tables = collected?.tables ?? [];
  const totalRows = tables.length && tables.every(table => table.rows !== null) ? tables.reduce((sum, table) => sum + (table.rows ?? 0), 0) : null;
  const d1: D1Status = {
    name: env.CF_D1_DATABASE_ID ? 'ap-gateway-cloud-db' : 'ap-gateway-db',
    reachable,
    sizeBytes: size.size,
    sizeSource: size.size !== null ? 'metadata-api' : 'unavailable',
    storagePercent: size.size !== null ? Math.round(size.size / PLAN_LIMITS.d1DatabaseBytes * 10000) / 100 : null,
    tables,
    totalRows,
    requestLogRows: tables.find(table => table.name === 'request_logs')?.rows ?? null,
    logWindow: collected?.logWindow ?? { oldest: null, newest: null },
    warnings,
  };
  const today = collected?.today;
  const workers: WorkersStatus = {
    requestsToday: today ? today.requests : null,
    errorsToday: today ? today.errors : null,
    averageDurationMs: today?.avg_ms != null ? Math.round(today.avg_ms) : null,
    maxDurationMs: today?.max_ms ?? null,
    source: today ? 'request-log' : 'unavailable',
    planLimits: PLAN_LIMITS,
    accountUsage: usage.workers,
  };
  const view: RuntimeView = { generatedAt: new Date(now).toISOString(), d1, workers, d1AccountUsage: usage.d1, tokenConfigured: !!(env.CF_API_TOKEN || env.CF_ANALYTICS_TOKEN) };
  viewCache.set(db as unknown as object, { value: view, expires: now + VIEW_TTL_MS });
  return view;
}

export function cachedRuntimeView(db: object): RuntimeView | undefined {
  const entry = viewCache.get(db);
  return entry && entry.expires > Date.now() ? entry.value : undefined;
}

export async function d1Status(db: D1Database, env: Env): Promise<D1Status> {
  return (await runtimeView(db, env)).d1;
}

export async function workersStatus(db: D1Database, env: Env): Promise<WorkersStatus> {
  return (await runtimeView(db, env)).workers;
}

export async function d1AccountUsage(env: Env): Promise<D1AccountUsage> {
  return (await accountUsage(env, env.CF_D1_DATABASE_ID)).d1;
}
