-- 保存网关密钥完整值，供管理页复制；升级前的历史密钥无法回填，只能重建。
ALTER TABLE gateway_api_keys ADD COLUMN secret TEXT;
