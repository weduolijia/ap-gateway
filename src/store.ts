import type { Channel, ChannelKeySelection, Protocol, RequestLog, Settings } from './types';
import { AppError, channelApiKeys, DEFAULT_SETTINGS, DEMO_CHANNEL } from './config';
import { cacheDrop, cacheRead, cacheWrite } from './cache';

const CONFIG_CACHE_MS = 60_000;
const PROTOCOL_CACHE_MS = 60_000;
const ROTATION_CACHE_MS = 60_000;
const ROTATION_KEY_PREFIX = 'rotation:';
const PROTOCOL_KEY_PREFIX = 'protocol:';

async function keyPoolHash(keys: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(keys)));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function parseLogRow(config: string): RequestLog {
  return { keyIndex: null, keyCount: 0, ...JSON.parse(config) };
}

export class Store {
  constructor(private db: D1Database) {}
  async channels(): Promise<Channel[]> {
    const cached = cacheRead<Channel[]>(this.db, 'channels');
    if (cached) return cached;
    const rows = await this.db.prepare('SELECT config FROM channels ORDER BY created_at').all<{ config: string }>();
    const channels = [DEMO_CHANNEL, ...rows.results.map(r => JSON.parse(r.config) as Channel)];
    cacheWrite(this.db, 'channels', channels, CONFIG_CACHE_MS);
    return channels;
  }
  async channel(id: string): Promise<Channel | null> {
    if (id === 'demo') return { ...DEMO_CHANNEL };
    const row = await this.db.prepare('SELECT config FROM channels WHERE id=?').bind(id).first<{ config: string }>();
    return row ? JSON.parse(row.config) : null;
  }
  async saveChannel(c: Channel, existing?: Channel): Promise<void> {
    const config = JSON.stringify(c);
    const save = existing
      ? this.db.prepare('UPDATE channels SET config=?,updated_at=? WHERE id=? AND config=?').bind(config, c.updatedAt, c.id, JSON.stringify(existing))
      : this.db.prepare('INSERT INTO channels(id,config,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at').bind(c.id, config, c.createdAt, c.updatedAt);
    const results = await this.db.batch([
      save,
      this.db.prepare('DELETE FROM channel_key_rotation WHERE channel_id=? AND pool_hash<>? AND EXISTS(SELECT 1 FROM channels WHERE id=? AND config=?)').bind(c.id, await keyPoolHash(channelApiKeys(c)), c.id, config),
      this.db.prepare('DELETE FROM protocol_cache WHERE cache_key LIKE ? AND EXISTS(SELECT 1 FROM channels WHERE id=? AND config=?)').bind(`${c.id}:%`, c.id, config),
    ]);
    if (existing && !results[0].meta.changes) throw new AppError('渠道配置已更新，请刷新后重试', 409, 'channel_conflict');
    cacheDrop(this.db, 'channels');
    cacheDrop(this.db, `${PROTOCOL_KEY_PREFIX}${c.id}:`);
    cacheDrop(this.db, `${ROTATION_KEY_PREFIX}${c.id}`);
  }
  async deleteChannel(id: string): Promise<void> {
    await this.db.batch([this.db.prepare('DELETE FROM channels WHERE id=?').bind(id), this.db.prepare('DELETE FROM protocol_cache WHERE cache_key LIKE ?').bind(`${id}:%`), this.db.prepare('DELETE FROM channel_key_rotation WHERE channel_id=?').bind(id)]);
    cacheDrop(this.db, 'channels');
    cacheDrop(this.db, `${PROTOCOL_KEY_PREFIX}${id}:`);
    cacheDrop(this.db, `${ROTATION_KEY_PREFIX}${id}`);
  }
  async selectApiKey(channel: Channel): Promise<ChannelKeySelection> {
    const keys = channelApiKeys(channel);
    if (keys.length <= 1) return { apiKey: keys[0], keyIndex: keys.length ? 1 : null, keyCount: keys.length };
    const poolHash = await keyPoolHash(keys);
    const rotationKey = `${ROTATION_KEY_PREFIX}${channel.id}`;
    const cached = cacheRead<{ hash: string; index: number }>(this.db, rotationKey);
    if (cached?.hash === poolHash) {
      const index = (cached.index + 1) % keys.length;
      cacheWrite(this.db, rotationKey, { hash: poolHash, index }, ROTATION_CACHE_MS);
      return { apiKey: keys[index], keyIndex: index + 1, keyCount: keys.length };
    }
    const row = await this.db.prepare('INSERT INTO channel_key_rotation(channel_id,pool_hash,key_index) SELECT ?,?,0 WHERE EXISTS(SELECT 1 FROM channels WHERE id=? AND config=?) ON CONFLICT(channel_id) DO UPDATE SET key_index=CASE WHEN channel_key_rotation.pool_hash=excluded.pool_hash THEN (channel_key_rotation.key_index+1)%? ELSE 0 END,pool_hash=excluded.pool_hash RETURNING key_index').bind(channel.id, poolHash, channel.id, JSON.stringify(channel), keys.length).first<{ key_index: number }>();
    if (!row) throw new AppError('渠道配置已更新，请刷新后重试', 409, 'channel_conflict');
    cacheWrite(this.db, rotationKey, { hash: poolHash, index: row.key_index }, ROTATION_CACHE_MS);
    return { apiKey: keys[row.key_index], keyIndex: row.key_index + 1, keyCount: keys.length };
  }
  async settings(): Promise<Settings> {
    const cached = cacheRead<Settings>(this.db, 'settings');
    if (cached) return cached;
    const row = await this.db.prepare('SELECT config FROM settings WHERE id=1').first<{ config: string }>();
    const settings = { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.config) : {}) };
    cacheWrite(this.db, 'settings', settings, CONFIG_CACHE_MS);
    return settings;
  }
  async saveSettings(s: Settings): Promise<void> {
    await this.db.prepare('INSERT INTO settings(id,config) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').bind(JSON.stringify(s)).run();
    cacheDrop(this.db, 'settings');
  }
  async log(log: RequestLog, retention: number): Promise<void> {
    await this.db.batch([
      this.db.prepare('INSERT INTO request_logs(id,time,status,duration_ms,config) VALUES(?,?,?,?,?)').bind(log.id, log.time, log.status, log.durationMs, JSON.stringify(log)),
      this.db.prepare('DELETE FROM request_logs WHERE id IN (SELECT id FROM request_logs ORDER BY time DESC LIMIT -1 OFFSET ?)').bind(retention),
    ]);
  }
  async logs(): Promise<{ logs: RequestLog[]; cursor: number }> {
    const [rows, head] = await Promise.all([
      this.db.prepare('SELECT config FROM request_logs ORDER BY time DESC LIMIT 500').all<{ config: string }>(),
      this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS cursor FROM request_logs').first<{ cursor: number }>(),
    ]);
    return { logs: rows.results.map(row => parseLogRow(row.config)), cursor: head?.cursor ?? 0 };
  }
  async logsSince(after: number): Promise<{ logs: RequestLog[]; cursor: number; reset: boolean }> {
    const [rows, head] = await Promise.all([
      this.db.prepare('SELECT config FROM request_logs WHERE rowid > ? ORDER BY rowid DESC LIMIT 500').bind(after).all<{ config: string }>(),
      this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS cursor FROM request_logs').first<{ cursor: number }>(),
    ]);
    const cursor = head?.cursor ?? 0;
    // More new rows than one page means a full reload is cheaper than paging; a cursor past the
    // current maximum can only mean the log table was cleared while the client was away.
    if (rows.results.length >= 500 || (!rows.results.length && after > cursor)) {
      return { logs: (await this.logs()).logs, cursor, reset: true };
    }
    return { logs: rows.results.map(row => parseLogRow(row.config)), cursor, reset: false };
  }
  async clearLogs(): Promise<void> { await this.db.prepare('DELETE FROM request_logs').run(); }
  async stats(): Promise<{ total: number; successRate: number; avgLatencyMs: number; activeChannels: number }> {
    const row = await this.db.prepare('SELECT COUNT(*) AS total,SUM(CASE WHEN status>=200 AND status<300 THEN 1 ELSE 0 END) AS success,AVG(duration_ms) AS latency FROM request_logs').first<{ total: number; success: number; latency: number }>();
    return { total: row?.total ?? 0, successRate: row?.total ? Math.round(row.success / row.total * 1000) / 10 : 0, avgLatencyMs: Math.round(row?.latency ?? 0), activeChannels: (await this.channels()).filter(c => c.enabled && !c.isDemo).length };
  }
  async cachedProtocol(key: string): Promise<Protocol | undefined> {
    const memoryKey = `${PROTOCOL_KEY_PREFIX}${key}`;
    const cached = cacheRead<Protocol>(this.db, memoryKey);
    if (cached) return cached;
    const r = await this.db.prepare('SELECT protocol FROM protocol_cache WHERE cache_key=? AND expires_at>?').bind(key, Date.now()).first<{ protocol: Protocol }>();
    if (r?.protocol) cacheWrite(this.db, memoryKey, r.protocol, PROTOCOL_CACHE_MS);
    return r?.protocol;
  }
  async cacheProtocol(key: string, protocol: Protocol): Promise<void> {
    const memoryKey = `${PROTOCOL_KEY_PREFIX}${key}`;
    const known = cacheRead<Protocol>(this.db, memoryKey);
    cacheWrite(this.db, memoryKey, protocol, PROTOCOL_CACHE_MS);
    if (known === protocol) return;
    await this.db.prepare('INSERT INTO protocol_cache(cache_key,protocol,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET protocol=excluded.protocol,expires_at=excluded.expires_at').bind(key, protocol, Date.now() + 3600000).run();
  }
}
