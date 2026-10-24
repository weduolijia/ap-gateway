CREATE TABLE IF NOT EXISTS channel_key_rotation (channel_id TEXT PRIMARY KEY, pool_hash TEXT NOT NULL, key_index INTEGER NOT NULL CHECK(key_index >= 0));
