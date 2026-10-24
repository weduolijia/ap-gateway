-- 让网关 API Key 绑定到指定渠道与该渠道的模型白名单，避免请求被路由到别的渠道。
-- channel_id 为空表示不绑定渠道，沿用全局路由；models 为空表示不限制模型（绑定渠道时即该渠道全部模型）。
ALTER TABLE gateway_api_keys ADD COLUMN channel_id TEXT;
ALTER TABLE gateway_api_keys ADD COLUMN models TEXT;
