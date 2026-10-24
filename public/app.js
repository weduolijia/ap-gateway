'use strict';

const byId = (id) => document.getElementById(id);
const all = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const protocolNames = { auto: '自动协商', openai: 'Chat Completions', responses: 'Responses', anthropic: 'Anthropic', gemini: 'Gemini' };
const fingerprintNames = { passthrough: '标准透传', codex: 'Codex', 'claude-code': 'Claude Code' };
const pages = { overview: '网关概览', channels: '渠道管理', playground: '在线测试', logs: '请求记录', keys: 'API 密钥', settings: '设置与接入' };
const numberFormat = new Intl.NumberFormat('zh-CN');
const state = {
  channels: [], logs: [], keys: [], status: null, ready: false, loading: false, loadingKeys: false, keysRevision: 0, settingsDirty: false,
  logCursor: 0, currentPage: 'overview', statsStale: false,
  editingId: null, drawerReturnFocus: null, outputTab: 'content', logFilter: 'all', policyKeyId: null, policyModels: new Set(),
  output: '', raw: '', eventCount: 0, streamController: null, discovered: new Map(),
  responseEnd: { terminal: false, finishReason: false, incompleteReason: '' },
};
const auth = { authenticated: false, mode: 'enabled', csrfToken: '', version: 0, controller: new AbortController(), checking: false, retryUntil: 0, retryTimer: null, secret: '' };
const isCloudTest = () => state.status?.environment === 'cloud-test';

function sessionError() {
  return new Error('登录状态已失效，请重新登录。');
}

function clearSecret() {
  auth.secret = '';
  byId('key-secret-value').value = '';
  byId('key-secret-copy-status').textContent = '';
}

function clearSensitiveData() {
  state.streamController?.abort();
  state.streamController = null;
  state.channels = [];
  state.logs = [];
  state.keys = [];
  state.status = null;
  state.ready = false;
  state.loading = false;
  state.loadingKeys = false;
  state.settingsDirty = false;
  state.logCursor = 0;
  state.statsStale = false;
  state.editingId = null;
  state.drawerReturnFocus = null;
  state.discovered.clear();
  state.output = '';
  state.raw = '';
  state.eventCount = 0;
  state.responseEnd = { terminal: false, finishReason: false, incompleteReason: '' };
  clearSecret();
  byId('detail-dialog').close('cancel');
  byId('key-secret-dialog').close();
  byId('channel-drawer').hidden = true;
  document.body.classList.remove('drawer-open');
  closeSidebar();
  all('form', byId('app-shell')).forEach((form) => form.reset());
  byId('channel-form').reset();
  all('input, textarea', byId('app-shell')).concat(all('input, textarea', byId('channel-form'))).forEach((element) => {
    if (!['checkbox', 'radio'].includes(element.type)) element.value = '';
  });
  all('input, select, textarea', byId('test-form')).forEach((element) => { element.disabled = false; });
  for (const id of ['channels-body', 'overview-channel-body', 'logs-body', 'gateway-keys-body', 'traffic-chart', 'detail-content', 'test-channel', 'test-model', 'setting-channel', 'response-text', 'response-raw', 'toast-container']) byId(id).replaceChildren();
  for (const id of ['metric-total', 'metric-success', 'metric-latency', 'metric-channels', 'channel-nav-count', 'overview-channel-count', 'channels-enabled-summary', 'channels-model-summary', 'channel-result-count', 'log-result-count', 'key-nav-count', 'gateway-key-count', 'gateway-key-summary', 'test-channel-note', 'test-upstream-note', 'settings-saved', 'password-status', 'test-ttfb', 'test-duration', 'test-http', 'key-status', 'key-input-summary', 'metric-total-foot', 'metric-channels-foot', 'chart-total']) byId(id).textContent = '—';
  for (const id of ['global-error', 'channel-form-error', 'create-key-error', 'keys-error', 'password-error', 'test-error']) setError(id, '');
  for (const id of ['event-count', 'test-events']) byId(id).textContent = '0';
  byId('test-state').textContent = '等待请求';
  byId('test-state').className = 'badge neutral';
  byId('response-empty').hidden = false;
  byId('response-text').hidden = true;
  byId('response-text').classList.remove('streaming');
  byId('test-stop').hidden = true;
  byId('test-submit').disabled = false;
  byId('test-endpoint').removeAttribute('title');
  byId('test-endpoint').textContent = '/v1/chat/completions';
  byId('channel-keys').placeholder = '每行输入一个 API Key';
  byId('drawer-title').textContent = '添加渠道';
  byId('detail-title').textContent = '详情';
  byId('login-password').value = '';
}

function lockWorkspace(message = '') {
  auth.authenticated = false;
  auth.csrfToken = '';
  auth.version++;
  auth.controller.abort();
  auth.controller = new AbortController();
  byId('app-shell').hidden = true;
  byId('app-shell').inert = true;
  clearSensitiveData();
  byId('auth-screen').hidden = false;
  byId('auth-checking').hidden = true;
  byId('login-form').hidden = false;
  byId('retry-session').hidden = true;
  setError('login-error', message);
  document.title = '登录 · AP Gateway';
  byId('login-password').focus();
}

function unlockWorkspace(session) {
  if (!session?.authenticated || !['enabled', 'disabled'].includes(session.authMode || auth.mode)) throw sessionError();
  auth.mode = session.authMode || auth.mode;
  if (auth.mode === 'enabled' && typeof session.csrfToken !== 'string') throw new Error('登录安全信息不完整，请重新登录。');
  auth.authenticated = true;
  auth.csrfToken = session.csrfToken || '';
  byId('login-password').value = '';
  byId('auth-screen').hidden = true;
  byId('app-shell').hidden = false;
  byId('app-shell').inert = false;
  byId('logout-button').hidden = auth.mode === 'disabled';
  byId('password-form').hidden = auth.mode === 'disabled';
  byId('keys-management').hidden = auth.mode === 'disabled';
  byId('keys-disabled-note').hidden = auth.mode !== 'disabled';
  navigate();
}

async function authRequest(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: 'same-origin', cache: 'no-store', headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `无法完成验证（HTTP ${response.status}）`);
    error.status = response.status;
    const retryHeader = response.headers.get('retry-after');
    const headerSeconds = retryHeader && /^\d+(\.\d+)?$/.test(retryHeader) ? Number(retryHeader) : (Date.parse(retryHeader) - Date.now()) / 1000;
    error.retryAfter = Number(payload?.error?.retryAfterSeconds) || headerSeconds || 60;
    throw error;
  }
  if (!payload) throw new Error('无法读取登录状态，请重新连接。');
  return payload;
}

async function checkSession() {
  if (auth.checking) return;
  auth.checking = true;
  const version = auth.version;
  if (!auth.authenticated) {
    byId('auth-checking').hidden = false;
    byId('auth-checking').textContent = '正在确认登录状态…';
    byId('login-form').hidden = true;
    byId('retry-session').hidden = true;
  }
  try {
    const session = await authRequest('/api/auth/session');
    if (version !== auth.version) return;
    if (!session.authenticated) return lockWorkspace();
    unlockWorkspace(session);
    await loadAll();
    await loadKeys();
  } catch (error) {
    if (version !== auth.version) return;
    lockWorkspace();
    byId('login-form').hidden = true;
    byId('auth-checking').hidden = false;
    byId('auth-checking').textContent = `暂时无法连接网关：${error.message}`;
    byId('retry-session').hidden = false;
  } finally { auth.checking = false; }
}

function updateLoginWait() {
  const seconds = Math.max(0, Math.ceil((auth.retryUntil - Date.now()) / 1000));
  byId('login-submit').disabled = seconds > 0;
  byId('login-submit-label').textContent = seconds ? `${seconds} 秒后重试` : '登录工作空间';
  if (!seconds) { clearInterval(auth.retryTimer); auth.retryTimer = null; }
}

async function login(event) {
  event.preventDefault();
  const button = byId('login-submit');
  if (button.disabled || Date.now() < auth.retryUntil) return;
  const version = auth.version;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  byId('login-submit-label').textContent = '正在登录…';
  byId('login-password').readOnly = true;
  setError('login-error', '');
  try {
    const session = await authRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: byId('login-password').value }) });
    if (version !== auth.version) return;
    unlockWorkspace({ ...session, authMode: 'enabled' });
    auth.retryUntil = 0;
    await loadAll();
    await loadKeys();
  } catch (error) {
    if (version !== auth.version) return;
    byId('login-password').value = '';
    if (error.status === 429) {
      auth.retryUntil = Date.now() + Math.max(1, error.retryAfter) * 1000;
      clearInterval(auth.retryTimer);
      auth.retryTimer = setInterval(updateLoginWait, 1000);
      setError('login-error', '尝试次数过多，请等待倒计时结束后重试。');
    } else setError('login-error', error.status === 401 ? '管理密码不正确，请重新输入。' : error.message);
    byId('login-password').focus();
  } finally {
    byId('login-password').readOnly = false;
    button.removeAttribute('aria-busy');
    updateLoginWait();
  }
}

async function logout() {
  await withButton(byId('logout-button'), async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); lockWorkspace('已退出登录。'); }
    catch (error) {
      if (auth.authenticated) lockWorkspace('本页已锁定，但未能确认服务器退出状态。请重新登录后再次退出。');
    }
  });
}

async function gatewayFetch(path, options = {}) {
  if (!auth.authenticated) throw sessionError();
  if (new URL(path, location.href).origin !== location.origin) throw new Error('管理请求必须发送到当前网关。');
  const version = auth.version;
  const headers = new Headers(options.headers);
  if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase()) && auth.csrfToken) headers.set('x-csrf-token', auth.csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store', signal: options.signal || auth.controller.signal });
  if (version !== auth.version || !auth.authenticated) throw sessionError();
  if (response.status === 401 || response.status === 403) {
    const payload = await response.clone().json().catch(() => null);
    if (version !== auth.version || !auth.authenticated) throw sessionError();
    const type = payload?.error?.type;
    if ((response.status === 401 && path.startsWith('/api/') && path !== '/api/auth/password') || type === 'authentication_required') {
      lockWorkspace('登录已过期，请重新输入管理密码。');
      throw sessionError();
    }
    if (type === 'csrf_failed') {
      const session = await authRequest('/api/auth/session');
      if (version !== auth.version) throw sessionError();
      if (!session.authenticated) { lockWorkspace('登录已过期，请重新输入管理密码。'); throw sessionError(); }
      auth.csrfToken = session.csrfToken || '';
      throw new Error('安全验证已更新，请重新执行刚才的操作。');
    }
  }
  return response;
}

function apiErrorMessage(payload, status) {
  const error = payload?.error;
  const message = error?.message || `请求失败（HTTP ${status}）`;
  if (status !== 429) return message;
  const wait = Number.isFinite(error?.retryAfterSeconds) ? `上游建议 ${Math.ceil(error.retryAfterSeconds)} 秒后重试。` : '上游未提供恢复时间。';
  return `${message} ${wait} 本次请求已停止，未自动重发。`;
}

async function api(path, options = {}) {
  const version = auth.version;
  const response = await gatewayFetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const payload = await response.json().catch(() => null);
  if (version !== auth.version || !auth.authenticated) throw sessionError();
  if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
  if (payload === null) throw new Error('网关返回了无法识别的响应，请刷新后重试。');
  return payload;
}

function toast(message, error = false) {
  if (!auth.authenticated) return;
  const element = document.createElement('div');
  element.className = `toast${error ? ' error' : ''}`;
  element.innerHTML = `${icon(error ? 'info' : 'check')}<span>${escapeHtml(message)}</span>`;
  byId('toast-container').append(element);
  setTimeout(() => element.remove(), error ? 6500 : 4000);
}

function setError(id, message) {
  if (message && !auth.authenticated && id !== 'login-error') return;
  const element = byId(id);
  element.textContent = message || '';
  element.hidden = !message;
}

async function withButton(button, operation) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.querySelector('svg')?.classList.add('loading-icon');
  try { return await operation(); }
  finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.querySelector('svg')?.classList.remove('loading-icon');
  }
}

function navigate() {
  if (!auth.authenticated) return;
  const requested = location.hash.slice(1) || 'overview';
  const page = Object.hasOwn(pages, requested) ? requested : 'overview';
  all('.page').forEach((element) => { element.hidden = element.id !== `page-${page}`; });
  all('[data-nav]').forEach((element) => {
    const active = element.dataset.nav === page;
    element.classList.toggle('active', active);
    if (active) element.setAttribute('aria-current', 'page');
    else element.removeAttribute('aria-current');
  });
  byId('breadcrumb-page').textContent = pages[page];
  document.title = `${pages[page]} · AP Gateway`;
  closeSidebar();
  state.currentPage = page;
  if (state.ready) {
    if (page === 'keys') loadKeys();
    else if (page === 'logs') loadLogs().catch(() => {});
    else if (page === 'overview') {
      loadLogs().catch(() => {});
      if (state.statsStale || !state.status?.stats) loadStatus(true).catch(() => {});
    } else if (page === 'settings') loadStatus(false).catch(() => {});
  }
}

function closeSidebar() {
  byId('sidebar').classList.remove('open');
  byId('sidebar-backdrop').hidden = true;
  byId('menu-toggle').setAttribute('aria-expanded', 'false');
}

function formatDuration(duration) {
  if (duration === null || duration === undefined) return '—';
  return duration >= 1000 ? `${(duration / 1000).toFixed(2)} s` : `${Math.round(duration)} ms`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function channelModels(channel) {
  return [...new Set([...(channel?.models || []), ...Object.keys(channel?.modelMap || {}), ...(state.discovered.get(channel?.id) || [])])];
}

function channelKeyCount(channel) {
  return Number.isInteger(channel?.keyCount) && channel.keyCount >= 0 ? channel.keyCount : channel?.hasApiKey ? 1 : 0;
}

function channelKeyLabel(channel) {
  const count = channelKeyCount(channel);
  return channel.isDemo ? '演示无需 Key' : count ? `${count} 个 Key${count > 1 ? ' · 顺序轮换' : ''}` : '未配置 Key';
}

function logKeyLabel(log) {
  if (Number.isInteger(log.keyIndex) && log.keyIndex > 0 && Number.isInteger(log.keyCount) && log.keyCount >= log.keyIndex) return `Key ${log.keyIndex} / ${log.keyCount}`;
  if (log.keyCount === 0) return '未使用渠道 Key';
  return '未记录 Key 序号';
}

function logRoute(log) {
  const sent = Number.isInteger(log.attempts) && log.attempts > 0;
  const notSent = log.attempts === 0;
  return {
    incoming: protocolNames[log.incomingProtocol] || log.incomingProtocol || '未记录',
    upstream: protocolNames[log.upstreamProtocol] || log.upstreamProtocol || '未记录',
    label: sent ? '客户端 → 实际上游' : notSent ? '客户端 → 计划上游' : '客户端 → 记录的上游',
    state: sent ? '已发送上游' : notSent ? log.error === 'unsupported_protocol_conversion' ? '未发送上游 / 转换失败' : '未发送上游' : '旧记录：发送状态未记录',
    sent,
    notSent,
  };
}

function renderEnvironment() {
  const cloudTest = isCloudTest();
  const authDisabled = auth.mode === 'disabled';
  byId('workspace-name').textContent = cloudTest ? '云端工作空间' : '本地工作空间';
  byId('workspace-context').textContent = cloudTest ? '云端开发与测试' : '开发与测试';
  byId('workspace-key').textContent = cloudTest ? 'C' : 'L';
  byId('environment-label').textContent = cloudTest ? '云端测试环境' : '本地环境';
  byId('environment-note-title').textContent = authDisabled ? '本地测试模式' : '私有工作空间';
  byId('environment-access-note').textContent = authDisabled ? '鉴权已关闭，请在本机使用。' : '管理密码保护 · API 密钥接入';
  byId('environment-storage-note').textContent = cloudTest ? '配置与记录保存在云端 D1。' : '配置与记录保存在本地 D1。';
  byId('metric-total-foot').textContent = cloudTest ? '云端保留的全部请求' : '本地保留的全部请求';
  byId('auth-mode-label').textContent = authDisabled ? '本地免鉴权' : 'API 密钥鉴权';
  byId('client-key-note').hidden = false;
  byId('client-key-note').textContent = authDisabled ? '本地测试环境未启用鉴权，示例中的 Authorization 请求头可省略。' : '前往“API 密钥”创建接入密钥，将 sk-ap-YOUR_KEY 替换为生成的完整密钥。';
  byId('backup-description').textContent = cloudTest ? '在云端与本地工作空间间迁移配置' : '在本地工作空间间迁移你的配置';
}

function channelRow(channel, overview = false) {
  const models = channelModels(channel);
  const modelText = models.length ? `${models.length} 个模型` : '任意模型';
  const protocolClass = channel.protocol === 'auto' ? 'teal' : channel.protocol === 'anthropic' ? 'amber' : 'blue';
  const protocolTitle = channel.protocol === 'auto' ? `自动协商上游协议：${(channel.protocols || []).map((protocol) => protocolNames[protocol] || protocol).join(' / ')}` : `上游固定使用 ${protocolNames[channel.protocol] || channel.protocol}；客户端请求由网关自动转换。`;
  const actions = `<div class="row-actions"><button type="button" class="text-link" data-action="test" data-id="${escapeHtml(channel.id)}"${channel.enabled ? '' : ' disabled'}>测试</button>${channel.isDemo ? `<button type="button" class="icon-button" data-action="channel-detail" data-id="demo" aria-label="查看演示渠道">${icon('info')}</button>` : `<button type="button" class="icon-button" data-action="edit" data-id="${escapeHtml(channel.id)}" aria-label="编辑 ${escapeHtml(channel.name)}">${icon('edit')}</button>${overview ? '' : `<button type="button" class="icon-button danger" data-action="delete" data-id="${escapeHtml(channel.id)}" aria-label="删除 ${escapeHtml(channel.name)}">${icon('trash')}</button>`}`}</div>`;
  return `<tr><td><div class="channel-name-cell"><span class="channel-avatar">${channel.isDemo ? icon('flask') : escapeHtml(channel.name.slice(0, 1).toUpperCase())}</span><div><div class="channel-name-text">${escapeHtml(channel.name)}${channel.isDemo ? '<span class="badge neutral">演示</span>' : ''}</div><div class="channel-url" title="${escapeHtml(channel.baseUrl)}">${escapeHtml(channel.baseUrl)}</div><div class="channel-key-meta">${icon('key')}${channelKeyLabel(channel)}</div></div></div></td><td><span class="badge ${protocolClass}" title="${escapeHtml(protocolTitle)}">${escapeHtml(protocolNames[channel.protocol])}</span></td><td><button class="model-detail-button" type="button" data-action="channel-detail" data-id="${escapeHtml(channel.id)}" title="查看模型与渠道详情">${modelText}</button></td><td><span class="badge neutral">${escapeHtml(fingerprintNames[channel.fingerprint])}</span></td>${overview ? '' : `<td>${channel.isDemo ? '—' : channel.priority}</td>`}<td>${channel.isDemo || overview ? `<span class="channel-status ${channel.enabled ? 'enabled' : ''}"><i class="status-dot"></i>${channel.enabled ? '已启用' : '已停用'}</span>` : `<button type="button" class="channel-status status-button ${channel.enabled ? 'enabled' : ''}" data-action="toggle" data-id="${escapeHtml(channel.id)}" title="点击${channel.enabled ? '停用' : '启用'}渠道"><i class="status-dot"></i>${channel.enabled ? '已启用' : '已停用'}</button>`}</td><td class="align-right">${actions}</td></tr>`;
}

function renderChannels() {
  const search = byId('channel-search').value.trim().toLowerCase();
  const filter = byId('channel-filter').value;
  const filtered = state.channels.filter((channel) => {
    const matchesState = filter === 'all' || (filter === 'enabled' ? channel.enabled : !channel.enabled);
    return matchesState && `${channel.name} ${channel.baseUrl} ${channelModels(channel).join(' ')}`.toLowerCase().includes(search);
  });
  byId('channels-body').innerHTML = filtered.length ? filtered.map((channel) => channelRow(channel)).join('') : `<tr><td colspan="7" class="table-empty">${icon('search')}<strong>没有匹配的渠道</strong>试试其他关键词，或添加一个新渠道。</td></tr>`;
  byId('overview-channel-body').innerHTML = state.channels.slice(0, 5).map((channel) => channelRow(channel, true)).join('');
  byId('channel-nav-count').textContent = state.channels.length;
  byId('overview-channel-count').textContent = state.channels.length;
  byId('channel-result-count').textContent = `显示 ${filtered.length} / ${state.channels.length} 个渠道`;
  byId('channels-enabled-summary').textContent = state.channels.filter((channel) => channel.enabled).length;
  byId('channels-model-summary').textContent = new Set(state.channels.flatMap(channelModels)).size;
}

function populateSelect(element, channels, selected) {
  element.replaceChildren(...channels.map((channel) => new Option(`${channel.name} · ${channelKeyLabel(channel)}`, channel.id)));
  if (channels.some((channel) => channel.id === selected)) element.value = selected;
  else if (channels.some((channel) => channel.id === 'demo')) element.value = 'demo';
}

function renderSelectors() {
  const enabled = state.channels.filter((channel) => channel.enabled);
  const previousTestChannel = byId('test-channel').value;
  populateSelect(byId('test-channel'), enabled, previousTestChannel || 'demo');
  populateSelect(byId('setting-channel'), enabled, state.settingsDirty ? byId('setting-channel').value : state.status?.settings.defaultChannelId);
  renderTestModels(previousTestChannel !== byId('test-channel').value);
}

function renderTestModels(reset = false) {
  const channel = state.channels.find((item) => item.id === byId('test-channel').value);
  const models = channelModels(channel);
  const selector = byId('test-model');
  const previous = reset ? '' : selector.value;
  selector.replaceChildren(...(models.length ? models.map((model) => new Option(model, model)) : [new Option(channel ? '该渠道未配置模型' : '请先选择渠道', '')]));
  selector.value = models.includes(previous) ? previous : models[0] || '';
  const keyCount = channelKeyCount(channel);
  byId('test-channel-note').textContent = channel?.isDemo ? `当前为${isCloudTest() ? '云端' : '本地'}演示，不调用真实模型，也不会产生上游费用。` : channel ? `请求将发送到「${channel.name}」。${keyCount > 1 ? `已保存 ${keyCount} 个 Key，每次请求按顺序轮换；协议回退沿用同一个 Key，失败后仅在下次请求轮换。` : keyCount ? '使用已保存的 1 个上游 Key。' : '当前渠道未保存 API Key，请确认上游允许无密钥访问。'}` : '请先添加或启用一个渠道。';
  renderTestUpstream(reset);
  updateEndpoint();
}

function renderTestUpstream(reset = false) {
  const channel = state.channels.find((item) => item.id === byId('test-channel').value);
  const selector = byId('test-upstream');
  const fixedProtocol = channel && channel.protocol !== 'auto' ? channel.protocol : '';
  if (fixedProtocol) selector.value = fixedProtocol;
  else if (reset || selector.dataset.fixedProtocol) selector.value = 'auto';
  selector.dataset.fixedProtocol = fixedProtocol;
  selector.disabled = Boolean(fixedProtocol || !channel || state.streamController);
  byId('test-upstream-note').textContent = fixedProtocol ? `渠道已固定上游协议：${protocolNames[fixedProtocol] || fixedProtocol}。客户端接口和返回格式保持客户端协议。` : channel ? '可临时指定本次请求的上游协议；跟随渠道配置时自动协商。' : '请先选择一个可用渠道。';
}

function renderStats() {
  if (!state.status) return;
  const stats = state.status.stats;
  if (stats) {
    byId('metric-total').textContent = numberFormat.format(stats.total);
    byId('metric-success').innerHTML = stats.total ? `${stats.successRate}<small>%</small>` : '—';
    byId('metric-latency').innerHTML = stats.total ? `${numberFormat.format(stats.avgLatencyMs)}<small>ms</small>` : '—';
    byId('metric-channels').textContent = stats.activeChannels;
  }
  byId('metric-channels-foot').textContent = `${state.channels.filter((channel) => !channel.isDemo).length} 个真实渠道 · 另有 1 个内置演示`;
  byId('version-label').textContent = state.status.build ? `v${state.status.version} · ${state.status.build}` : `v${state.status.version}`;
  byId('version-label').title = `运行环境：${state.status.environment}${state.status.build ? `\n构建日期：${state.status.build}` : ''}`;
}

function renderTraffic() {
  if (!state.status) return;
  const currentHour = Math.floor(Date.now() / 3600000);
  const counts = Array.from({ length: 24 }, () => 0);
  for (const log of state.logs) {
    const index = Math.floor(new Date(log.time).getTime() / 3600000) - currentHour + 23;
    if (index >= 0 && index < 24) counts[index]++;
  }
  const maximum = Math.max(...counts, 1);
  byId('traffic-chart').replaceChildren(...counts.map((count, index) => {
    const bar = document.createElement('div');
    const hour = new Date((currentHour - 23 + index) * 3600000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    bar.className = 'chart-bar';
    bar.dataset.count = count;
    bar.style.height = `${Math.max(2, count / maximum * 100)}%`;
    bar.setAttribute('aria-label', `${hour} · ${count} 次请求`);
    bar.title = `${hour} · ${count} 次请求`;
    return bar;
  }));
  const total = counts.reduce((sum, count) => sum + count, 0);
  byId('chart-total').textContent = `${numberFormat.format(total)} 次请求`;
  byId('chart-empty').hidden = total > 0;
}

function renderLogs() {
  const filtered = state.logs.filter((log) => state.logFilter === 'all' || log.outcome === state.logFilter);
  all('[data-log-filter]').forEach((button) => button.classList.toggle('active', button.dataset.logFilter === state.logFilter));
  byId('logs-body').innerHTML = filtered.length ? filtered.map((log) => {
    const route = logRoute(log);
    return `<tr><td class="mono">${escapeHtml(formatTime(log.time))}</td><td><strong class="log-model">${escapeHtml(log.model)}</strong><div class="channel-url">${escapeHtml(log.channelName)}</div><div class="channel-key-meta">${icon('key')}${logKeyLabel(log)}</div></td><td><span class="log-route" title="${escapeHtml(route.label)}">${escapeHtml(route.incoming)}${icon('arrow')}${escapeHtml(route.upstream)}</span><div class="channel-url">${escapeHtml(route.label)}</div><div class="channel-url">${escapeHtml(route.state)}</div></td><td><span class="badge ${log.outcome === 'ok' ? 'teal' : log.outcome === 'cancelled' ? 'amber' : 'red'}">${escapeHtml(log.status)} · ${log.outcome === 'ok' ? '成功' : log.outcome === 'cancelled' ? '取消' : '失败'}</span></td><td class="mono">${formatDuration(log.firstByteMs)}</td><td class="mono">${formatDuration(log.durationMs)}</td><td><span class="badge ${log.stream ? 'blue' : 'neutral'}">${log.stream ? 'SSE' : 'JSON'}</span></td><td class="align-right"><button type="button" class="icon-button" data-action="log-detail" data-id="${escapeHtml(log.id)}" aria-label="查看请求详情">${icon('info')}</button></td></tr>`;
  }).join('') : `<tr><td colspan="8" class="table-empty">${icon('list')}<strong>${state.logFilter === 'all' ? '还没有请求记录' : '没有此状态的请求'}</strong>${state.logFilter === 'all' ? '发送一次在线测试，这里就会显示真实的请求数据。' : '切换筛选条件，查看其他请求。'}</td></tr>`;
  byId('log-result-count').textContent = `${filtered.length} 条记录 · 最多显示最近 500 条`;
}

function renderSettings() {
  if (!state.status || state.settingsDirty) return;
  const settings = state.status.settings;
  byId('setting-channel').value = settings.defaultChannelId;
  byId('setting-fingerprint').value = settings.defaultFingerprint;
  byId('setting-heartbeat').value = settings.heartbeatMs;
  byId('setting-timeout').value = settings.streamTimeoutMs;
  byId('setting-retention').value = settings.logRetention;
}

async function loadStatus(stats) {
  const status = await api(`/api/status${stats ? '' : '?stats=0'}`);
  state.status = status;
  if (stats) state.statsStale = false;
  renderEnvironment();
  renderStats();
  renderSettings();
}

async function loadChannels() {
  const version = auth.version;
  const result = await api('/api/channels');
  if (version !== auth.version || !auth.authenticated) return;
  state.channels = result.channels;
  renderChannels();
  renderSelectors();
  renderStats();
}

async function refreshVisiblePage() {
  const version = auth.version;
  try {
    if (state.currentPage === 'overview') {
      await Promise.all([loadStatus(true), loadChannels(), loadLogs()]);
    } else if (state.currentPage === 'channels') {
      await Promise.all([loadStatus(false), loadChannels()]);
    } else if (state.currentPage === 'logs') {
      await loadLogs();
    } else if (state.currentPage === 'keys') {
      await loadKeys(true);
    } else if (state.currentPage === 'settings') {
      await loadStatus(false);
    }
    if (version !== auth.version || !auth.authenticated) return;
    byId('connection-label').textContent = '网关已连接';
    byId('connection-dot').classList.remove('offline');
  } catch (error) {
    if (version !== auth.version || !auth.authenticated) return;
    byId('connection-label').textContent = '连接失败';
    byId('connection-dot').classList.add('offline');
  }
}

function mergeLogs(incoming, reset) {
  if (reset) state.logs = [];
  const known = new Set(state.logs.map((log) => log.id));
  const fresh = incoming.filter((log) => !known.has(log.id));
  if (!fresh.length && !reset) return false;
  state.logs = [...fresh, ...state.logs]
    .sort((left, right) => new Date(right.time) - new Date(left.time))
    .slice(0, 500);
  return true;
}

async function loadLogs() {
  const version = auth.version;
  const result = await api(state.logCursor ? `/api/logs?since=${state.logCursor}` : '/api/logs');
  if (version !== auth.version || !auth.authenticated) return;
  state.logCursor = result.cursor ?? state.logCursor;
  if (mergeLogs(result.logs, !!result.reset) || !state.logCursor) {
    renderLogs();
    renderTraffic();
  }
}

async function loadAll(notify = false) {
  if (state.loading || !auth.authenticated) return;
  const version = auth.version;
  state.loading = true;
  try {
    const [channelResult, logResult] = await Promise.all([api('/api/channels'), api(state.logCursor ? `/api/logs?since=${state.logCursor}` : '/api/logs'), loadStatus(state.currentPage === 'overview')]);
    if (version !== auth.version || !auth.authenticated) return;
    state.channels = channelResult.channels;
    state.logCursor = logResult.cursor ?? state.logCursor;
    mergeLogs(logResult.logs, !!logResult.reset);
    renderChannels();
    renderSelectors();
    renderStats();
    renderSettings();
    renderLogs();
    renderTraffic();
    if (state.keys.length) renderKeys();
    state.ready = true;
    byId('connection-label').textContent = '网关已连接';
    byId('connection-dot').classList.remove('offline');
    setError('global-error', '');
    if (notify) toast('网关数据已刷新');
  } catch (error) {
    if (version !== auth.version || !auth.authenticated) return;
    byId('connection-label').textContent = '连接失败';
    byId('connection-dot').classList.add('offline');
    setError('global-error', `无法加载网关数据：${error.message}。请确认${state.status?.environment === 'local' ? '本地服务正在运行' : '网关服务可用'}，点击右上角刷新重试。`);
    if (notify) toast(error.message, true);
  } finally { if (version === auth.version) state.loading = false; }
}

async function ensureChannels() {
  if (state.channels.length || !auth.authenticated) return;
  try {
    const result = await api('/api/channels');
    if (!state.channels.length) { state.channels = result.channels; renderSelectors(); }
  } catch { /* 列表列降级显示 */ }
}

function keyBindingLabel(key) {
  const channel = key.channelId ? state.channels.find((item) => item.id === key.channelId) : null;
  const channelName = key.channelId ? (channel?.name || (state.channels.length ? '渠道已删除' : '已绑定渠道')) : '';
  if (!key.channelId && !key.models) return '<span class="cell-secondary">跟随全局路由</span>';
  if (key.channelId && !key.models) return `<span class="key-binding"><strong>${escapeHtml(channelName)}</strong><small>全部模型</small></span>`;
  const count = Array.isArray(key.models) ? key.models.length : 0;
  if (!key.channelId) return `<span class="key-binding"><strong>未绑定渠道</strong><small>${count} 个模型</small></span>`;
  return `<span class="key-binding"><strong>${escapeHtml(channelName)}</strong><small>${count} 个模型</small></span>`;
}

function keyModelsFor(channel) {
  return channel ? channelModels(channel) : [];
}

async function openKeyPolicy(id) {
  const key = state.keys.find((item) => item.id === id);
  if (!key || !auth.authenticated) return;
  await ensureChannels();
  state.policyKeyId = id;
  state.policyModels = new Set(Array.isArray(key.models) ? key.models : []);
  const channelSelect = byId('key-policy-channel');
  const enabled = state.channels.filter((channel) => channel.enabled);
  channelSelect.replaceChildren(new Option('不绑定渠道（跟随全局路由）', ''), ...enabled.map((channel) => new Option(channel.name, channel.id)));
  channelSelect.value = key.channelId && enabled.some((channel) => channel.id === key.channelId) ? key.channelId : '';
  byId('key-policy-all').checked = !state.policyModels.size;
  byId('key-policy-error').hidden = true;
  byId('key-policy-error').textContent = '';
  byId('key-policy-title').textContent = `绑定「${key.name}」`;
  renderKeyPolicyModels();
  byId('key-policy-dialog').showModal();
  byId('key-policy-channel').focus();
}

function renderKeyPolicyModels() {
  const channelId = byId('key-policy-channel').value;
  const channel = state.channels.find((item) => item.id === channelId);
  const models = keyModelsFor(channel);
  const container = byId('key-policy-models');
  const all = byId('key-policy-all').checked;
  byId('key-policy-models-field').disabled = !channel || all;
  byId('key-policy-all-row').hidden = !channel;
  if (!channel) {
    container.replaceChildren();
    container.innerHTML = '<p class="field-note">选择渠道后可勾选该渠道允许的模型；不绑定渠道时，模型白名单不可用。</p>';
    return;
  }
  if (!models.length) {
    container.replaceChildren();
    container.innerHTML = '<p class="field-note">该渠道没有配置模型列表，视为允许任意模型名称。</p>';
    return;
  }
  container.replaceChildren(...models.map((model) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = model;
    input.checked = state.policyModels.has(model);
    input.disabled = all;
    label.append(input, document.createTextNode(model));
    return label;
  }));
}

async function saveKeyPolicy() {
  const key = state.keys.find((item) => item.id === state.policyKeyId);
  if (!key) return;
  const channelId = byId('key-policy-channel').value || null;
  const all = byId('key-policy-all').checked;
  const selected = channelId && !all ? [...byId('key-policy-models').querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value) : [];
  if (channelId && !all && !selected.length) {
    byId('key-policy-error').textContent = '请至少勾选一个模型，或选择允许该渠道的全部模型。';
    byId('key-policy-error').hidden = false;
    return;
  }
  await withButton(byId('save-key-policy'), async () => {
    try {
      byId('key-policy-error').hidden = true;
      await api(`/api/keys/${encodeURIComponent(key.id)}`, { method: 'PUT', body: JSON.stringify({ channelId, models: channelId ? selected : null }) });
      toast('密钥绑定已保存');
      byId('key-policy-dialog').close();
      await loadKeys(true);
    } catch (error) {
      byId('key-policy-error').textContent = error.message;
      byId('key-policy-error').hidden = false;
    }
  });
}

function keyStatus(key) {
  if (key.revokedAt) return { label: '已撤销', className: 'neutral', active: false };
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return { label: '已过期', className: 'amber', active: false };
  return { label: '可使用', className: 'teal', active: true };
}

function keyDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderKeys() {
  const activeCount = state.keys.filter((key) => keyStatus(key).active).length;
  byId('key-nav-count').textContent = activeCount;
  byId('gateway-key-count').textContent = state.keys.length;
  byId('gateway-key-summary').textContent = `${activeCount} 个可用 · ${state.keys.length - activeCount} 个已过期或撤销`;
  byId('gateway-keys-body').innerHTML = state.keys.length ? state.keys.map((key) => {
    const status = keyStatus(key);
    return `<tr><td><strong class="gateway-key-name">${escapeHtml(key.name)}</strong><code class="gateway-key-preview">${escapeHtml(key.preview)}</code></td><td><span class="badge ${status.className}">${status.label}</span></td><td>${keyBindingLabel(key)}</td><td class="mono">${escapeHtml(keyDate(key.createdAt))}</td><td class="mono">${key.expiresAt ? escapeHtml(keyDate(key.expiresAt)) : '永不过期'}</td><td class="mono">${key.lastUsedAt ? escapeHtml(keyDate(key.lastUsedAt)) : '尚未使用'}</td><td class="align-right"><div class="row-actions"><button type="button" class="text-link" data-key-detail="${escapeHtml(key.id)}" aria-label="查看 ${escapeHtml(key.name)} 的详情">查看</button>${key.secret ? `<button type="button" class="text-link" data-copy-key="${escapeHtml(key.id)}" aria-label="复制 ${escapeHtml(key.name)} 的完整密钥">复制</button>` : ''}${status.active ? `<button type="button" class="text-link" data-key-policy="${escapeHtml(key.id)}" aria-label="设置 ${escapeHtml(key.name)} 的渠道与模型">绑定</button>` : ''}${status.active ? `<button class="button danger-outline small" type="button" data-revoke-key="${escapeHtml(key.id)}">撤销</button>` : `<button class="button danger-outline small" type="button" data-purge-key="${escapeHtml(key.id)}" aria-label="删除 ${escapeHtml(key.name)}">删除</button>`}</div></td></tr>`;
  }).join('') : `<tr><td colspan="7" class="table-empty">${icon('key')}<strong>还没有 API 密钥</strong>创建第一把密钥，将你的应用连接到网关。</td></tr>`;
}

async function loadKeys(force = false) {
  if (!auth.authenticated || auth.mode === 'disabled' || (state.loadingKeys && !force)) return;
  const version = auth.version;
  const revision = ++state.keysRevision;
  state.loadingKeys = true;
  try {
    const result = await api('/api/keys');
    if (version !== auth.version || revision !== state.keysRevision || !auth.authenticated) return;
    state.keys = result.keys;
    if (state.keys.some((key) => key.channelId)) await ensureChannels();
    if (version !== auth.version || revision !== state.keysRevision || !auth.authenticated) return;
    renderKeys();
    setError('keys-error', '');
  } catch (error) {
    if (version === auth.version && revision === state.keysRevision && auth.authenticated) setError('keys-error', `无法读取密钥：${error.message}`);
  } finally { if (version === auth.version && revision === state.keysRevision) state.loadingKeys = false; }
}

async function createKey(event) {
  event.preventDefault();
  await withButton(byId('create-key-submit'), async () => {
    byId('create-key-submit').querySelector('span').textContent = '正在创建…';
    try {
      setError('create-key-error', '');
      const name = byId('gateway-key-name').value.trim();
      if (!name) throw new Error('请填写密钥名称。');
      const result = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name, expiresInDays: byId('gateway-key-expiry').value ? Number(byId('gateway-key-expiry').value) : null }) });
      if (typeof result.secret !== 'string' || !result.secret.startsWith('sk-ap-')) throw new Error('未收到完整密钥。请刷新列表，撤销刚创建的密钥后重试。');
      auth.secret = result.secret;
      byId('key-secret-value').value = auth.secret;
      byId('key-secret-copy-status').textContent = '';
      byId('key-secret-dialog').showModal();
      byId('copy-key-secret').focus();
      byId('create-key-form').reset();
      await loadKeys(true);
    } catch (error) { setError('create-key-error', error.message); }
    finally { byId('create-key-submit').querySelector('span').textContent = '创建密钥'; }
  });
}

async function copySecret() {
  if (!auth.authenticated || !auth.secret) return;
  const version = auth.version;
  try {
    await navigator.clipboard.writeText(auth.secret);
    if (version === auth.version && auth.secret) byId('key-secret-copy-status').textContent = '已复制，请保存到客户端或密码管理器。';
  } catch {
    if (version !== auth.version || !auth.secret) return;
    byId('key-secret-value').focus();
    byId('key-secret-value').select();
    byId('key-secret-copy-status').textContent = '浏览器未允许自动复制，已选中密钥，请手动复制。';
  }
}

async function showKeyDetail(key) {
  if (key.channelId) await ensureChannels();
  const status = keyStatus(key);
  showDetail('API 密钥详情', `<dl><dt>名称</dt><dd><strong>${escapeHtml(key.name)}</strong></dd><dt>状态</dt><dd><span class="badge ${status.className}">${status.label}</span></dd><dt>渠道与模型</dt><dd>${keyBindingLabel(key)}</dd>${key.secret ? `<dt class="detail-full">完整密钥</dt><dd class="detail-full"><div class="copy-field"><code>${escapeHtml(key.secret)}</code><button class="icon-button" type="button" data-copy-detail-key="${escapeHtml(key.id)}" aria-label="复制完整密钥">${icon('copy')}</button></div></dd>` : `<dt>密钥预览</dt><dd class="mono">${escapeHtml(key.preview)}</dd>`}<dt>创建时间</dt><dd>${escapeHtml(keyDate(key.createdAt))}</dd><dt>到期时间</dt><dd>${key.expiresAt ? escapeHtml(keyDate(key.expiresAt)) : '永不过期'}</dd><dt>最近使用</dt><dd>${key.lastUsedAt ? escapeHtml(keyDate(key.lastUsedAt)) : '尚未使用'}</dd><dt>密钥 ID</dt><dd class="mono">${escapeHtml(key.id)}</dd></dl>${key.secret ? '<p>点右侧图标可复制完整密钥。密钥等同密码，请只保存在自己的客户端或密码管理器中。</p>' : '<p>这把密钥创建于启用完整密钥保存之前的版本，服务端只有哈希，完整值无法恢复。如仍在使用，请撤销后重新创建。</p>'}${status.active ? '<p>撤销后，使用此密钥的应用将立即无法发送新请求。</p>' : '<p>该密钥已不可用，可永久删除其记录。</p>'}`);
}

async function copyKeySecret(id) {
  const key = state.keys.find((item) => item.id === id);
  if (!key) return;
  if (!key.secret) return toast('这把密钥没有保存完整值，无法复制。请重新创建密钥。', true);
  await copyText(key.secret);
}

async function revokeKey(id, button) {
  const key = state.keys.find((item) => item.id === id);
  if (!key || !await confirmAction('撤销 API 密钥', `撤销「${key.name}」后，使用此密钥的应用将无法继续发送新请求。此操作不可恢复，可随时创建新密钥。`, '确认撤销')) return;
  await withButton(button, async () => {
    try {
      await api(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('API 密钥已撤销');
      await loadKeys(true);
    } catch (error) { toast(error.message, true); }
  });
}

async function purgeKey(id, button) {
  const key = state.keys.find((item) => item.id === id);
  if (!key) return;
  if (!await confirmAction('永久删除密钥', `将永久删除「${key.name}」（${key.preview}）的记录。此操作不可恢复，其他密钥不受影响。`, '永久删除')) return;
  await withButton(button, async () => {
    try {
      await api(`/api/keys/${encodeURIComponent(id)}/permanent`, { method: 'DELETE' });
      toast('密钥记录已删除');
      await loadKeys(true);
    } catch (error) { toast(error.message, true); }
  });
}

async function changePassword(event) {
  event.preventDefault();
  await withButton(byId('password-submit'), async () => {
    try {
      setError('password-error', '');
      byId('password-status').textContent = '';
      const newPassword = byId('new-password').value;
      if (newPassword.length < 12) throw new Error('新密码至少需要 12 个字符。');
      if (newPassword !== byId('confirm-password').value) throw new Error('两次输入的新密码不一致。');
      if (newPassword === byId('current-password').value) throw new Error('新密码不能与当前密码相同。');
      byId('password-submit').querySelector('span').textContent = '正在修改…';
      const session = await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: byId('current-password').value, newPassword }) });
      if (!session.authenticated || !session.csrfToken) throw new Error('密码可能已修改，请退出后使用新密码重新登录。');
      auth.csrfToken = session.csrfToken;
      byId('password-form').reset();
      byId('password-status').textContent = '密码已更新，其他登录会话已退出。';
      toast('管理密码已更新');
    } catch (error) { setError('password-error', error.message); }
    finally { byId('password-submit').querySelector('span').textContent = '修改密码'; }
  });
}

function openChannel(id = null) {
  if (!auth.authenticated) return;
  const channel = state.channels.find((item) => item.id === id);
  if (channel?.isDemo) return showChannelDetail(channel);
  state.editingId = channel?.id || null;
  state.drawerReturnFocus = document.activeElement;
  byId('channel-form').reset();
  byId('drawer-title').textContent = channel ? '编辑渠道' : '添加渠道';
  byId('channel-name').value = channel?.name || '';
  byId('channel-url').value = channel?.baseUrl || '';
  byId('channel-keys').value = '';
  byId('channel-keys').disabled = false;
  byId('channel-priority').value = channel?.priority ?? 0;
  byId('channel-timeout').value = channel?.timeoutMs || 60000;
  byId('channel-enabled').checked = channel?.enabled ?? true;
  byId('channel-protocol').value = channel?.protocol || 'auto';
  byId('channel-fingerprint').value = channel?.fingerprint || state.status?.settings.defaultFingerprint || 'passthrough';
  byId('channel-headers').value = JSON.stringify(channel?.headers || {}, null, 2);
  byId('channel-model-map').value = JSON.stringify(channel?.modelMap || {}, null, 2);
  byId('channel-models').value = (channel?.models || []).join('\n');
  byId('channel-clear-key').checked = false;
  const keyCount = channelKeyCount(channel);
  byId('clear-key-row').hidden = !keyCount;
  byId('key-status').textContent = keyCount ? `已保存 ${keyCount} 个 Key` : '可选';
  byId('channel-keys').placeholder = keyCount ? `已保存 ${keyCount} 个 Key，留空保留\n每行输入一个新 Key，将替换整个密钥池` : '每行输入一个 API Key';
  renderKeyInputSummary();
  byId('drawer-probe').hidden = !channel;
  all('[name="protocols"]').forEach((checkbox) => { checkbox.checked = (channel?.protocols || Object.keys(protocolNames)).includes(checkbox.value); });
  byId('protocol-options').hidden = byId('channel-protocol').value !== 'auto';
  setError('channel-form-error', '');
  byId('channel-drawer').hidden = false;
  document.body.classList.add('drawer-open');
  byId('channel-name').focus();
}

function closeDrawer() {
  if (byId('save-channel').disabled) return;
  byId('channel-drawer').hidden = true;
  byId('channel-keys').value = '';
  document.body.classList.remove('drawer-open');
  state.editingId = null;
  state.drawerReturnFocus?.focus();
}

function jsonObject(id, label) {
  let value;
  try { value = JSON.parse(byId(id).value || '{}'); }
  catch { throw new Error(`${label}不是有效 JSON，请检查引号、逗号与括号。`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}须为 JSON 对象，例如 {"名称": "值"}。`);
  return value;
}

function readModels(value) {
  return [...new Set(value.split(/[\n\r,，]+/).map((model) => model.trim()).filter(Boolean))];
}

function readKeys(value) {
  return [...new Set(value.split(/[\r\n]+/).map((key) => key.trim()).filter(Boolean))];
}

function renderKeyInputSummary() {
  const count = readKeys(byId('channel-keys').value).length;
  const saved = channelKeyCount(state.channels.find((channel) => channel.id === state.editingId));
  byId('key-input-summary').textContent = byId('channel-clear-key').checked ? `保存后将清空已保存的 ${saved} 个 Key。` : count ? `将${saved ? '替换为' : '保存'} ${count} 个 Key${count > 1 ? '，按输入顺序轮换' : ''}；空行与重复项会自动忽略。` : saved ? `留空保留已保存的 ${saved} 个 Key；填写新 Key 将替换整个密钥池。` : '可添加一个或多个 Key；留空使用无密钥连接。';
}

async function saveChannel(event) {
  event.preventDefault();
  const button = byId('save-channel');
  let saved = false;
  await withButton(button, async () => {
    try {
      setError('channel-form-error', '');
      const protocol = byId('channel-protocol').value;
      const protocols = all('[name="protocols"]:checked').map((checkbox) => checkbox.value);
      if (protocol === 'auto' && !protocols.length) throw new Error('自动模式至少需要选择一种上游协议。');
      const payload = {
        name: byId('channel-name').value.trim(), baseUrl: byId('channel-url').value.trim(),
        enabled: byId('channel-enabled').checked, priority: Number(byId('channel-priority').value),
        timeoutMs: Number(byId('channel-timeout').value), protocol,
        protocols: protocol === 'auto' ? protocols : [...new Set([...protocols, protocol])],
        fingerprint: byId('channel-fingerprint').value,
        headers: jsonObject('channel-headers', '自定义请求头'),
        models: readModels(byId('channel-models').value), modelMap: jsonObject('channel-model-map', '模型别名映射'),
      };
      const apiKeys = readKeys(byId('channel-keys').value);
      if (byId('channel-clear-key').checked) payload.apiKeys = null;
      else if (apiKeys.length) payload.apiKeys = apiKeys;
      await api(state.editingId ? `/api/channels/${encodeURIComponent(state.editingId)}` : '/api/channels', { method: state.editingId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      toast(state.editingId ? '渠道已保存' : '渠道已添加，可以开始测试了');
      saved = true;
      await loadAll();
    } catch (error) {
      setError('channel-form-error', error.message);
      byId('channel-form-error').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
  if (saved) closeDrawer();
}

function showDetail(title, content) {
  if (!auth.authenticated) return;
  byId('detail-title').textContent = title;
  byId('detail-content').innerHTML = content;
  byId('detail-done').textContent = '关闭';
  byId('detail-done').className = 'button secondary';
  byId('detail-dialog').returnValue = '';
  byId('detail-dialog').showModal();
}

function showChannelDetail(channel) {
  const protocolDetails = channel.protocol === 'auto' ? `<dt>允许尝试的上游协议</dt><dd>${escapeHtml((channel.protocols || []).map((protocol) => protocolNames[protocol] || protocol).join(' / '))}</dd>` : '';
  showDetail(channel.name, `<dl><dt>上游地址</dt><dd>${escapeHtml(channel.baseUrl)}</dd><dt>上游协议（网关 → 渠道）</dt><dd>${escapeHtml(protocolNames[channel.protocol])}</dd>${protocolDetails}<dt>请求预设</dt><dd>${escapeHtml(fingerprintNames[channel.fingerprint])}</dd><dt>API Key 密钥池</dt><dd>${channelKeyLabel(channel)}${channelKeyCount(channel) ? '（密钥不回显）' : ''}</dd><dt>请求超时</dt><dd>${formatDuration(channel.timeoutMs)}</dd></dl><p>${channel.protocol === 'auto' ? '网关自动协商上游协议。' : '渠道已固定上游协议，网关将客户端请求转换为此协议。'}客户端接口和返回格式保持客户端协议。</p>${channelKeyCount(channel) > 1 ? '<p class="detail-key-note">每次请求按顺序选择一个 Key；协议回退沿用同一个 Key。失败后，下次请求使用下一个 Key，本次请求不会换 Key 重试。</p>' : ''}<p>已配置模型${channel.models.length ? '' : '：不限制模型名称'}</p><pre>${escapeHtml(channel.models.join('\n') || '（空）')}</pre><p>模型别名映射</p><pre>${escapeHtml(JSON.stringify(channel.modelMap, null, 2))}</pre>${channel.isDemo ? `<p>内置演示由${isCloudTest() ? '云端' : '本地'}代码生成文本，支持四种接口与流式响应，不调用真实大模型。</p>` : ''}`);
}

function confirmAction(title, message, label) {
  showDetail(title, `<p>${escapeHtml(message)}</p>`);
  byId('detail-done').textContent = label;
  byId('detail-done').className = 'button danger-outline';
  return new Promise((resolve) => {
    byId('detail-dialog').addEventListener('close', () => resolve(byId('detail-dialog').returnValue === 'confirm'), { once: true });
  });
}

async function channelAction(action, id, button) {
  const channel = state.channels.find((item) => item.id === id);
  if (action === 'log-detail') {
    const log = state.logs.find((item) => item.id === id);
    if (!log) return;
    const route = logRoute(log);
    const warnings = Array.isArray(log.conversionWarnings) ? log.conversionWarnings.filter((warning) => typeof warning === 'string') : [];
    const errorDetails = `${log.error ? `<p>错误代码</p><pre>${escapeHtml(log.error)}</pre>` : ''}${log.errorMessage ? `<p>失败原因</p><pre>${escapeHtml(log.errorMessage)}</pre>` : ''}${warnings.length ? `<p>兼容转换提示</p><pre>${escapeHtml(warnings.join('\n'))}</pre>` : ''}`;
    const attempts = route.sent ? `${log.attempts} 次（同一 Key 的协议尝试）` : route.notSent ? '0 次（未向上游发送请求）' : '未记录';
    const upstreamDetails = route.sent && (log.upstreamCode || log.upstreamMessage) ? `<dt>上游错误代码</dt><dd>${escapeHtml(log.upstreamCode || '未记录')}</dd><dt>上游原因</dt><dd>${escapeHtml(log.upstreamMessage || '上游未提供具体原因')}</dd>${log.status === 429 ? `<dt>建议等待</dt><dd>${Number.isFinite(log.retryAfterSeconds) ? `${Math.ceil(log.retryAfterSeconds)} 秒` : '上游未提供恢复时间'}</dd>` : ''}` : '';
    showDetail('请求详情', `<dl><dt>请求 ID</dt><dd class="mono">${escapeHtml(log.id)}</dd><dt>时间</dt><dd>${escapeHtml(formatTime(log.time))}</dd><dt>渠道</dt><dd>${escapeHtml(log.channelName)}</dd><dt>模型</dt><dd>${escapeHtml(log.model)}</dd><dt>${escapeHtml(route.label)}</dt><dd>${escapeHtml(route.incoming)} → ${escapeHtml(route.upstream)}</dd><dt>上游发送状态</dt><dd>${escapeHtml(route.state)}</dd><dt>请求预设</dt><dd>${escapeHtml(fingerprintNames[log.fingerprint])}</dd><dt>${route.sent ? '使用的 Key' : route.notSent ? '分配的 Key（未发送）' : '记录的 Key'}</dt><dd>${logKeyLabel(log)}</dd><dt>上游尝试次数</dt><dd>${escapeHtml(attempts)}</dd><dt>首字节 / 总耗时</dt><dd>${formatDuration(log.firstByteMs)} / ${formatDuration(log.durationMs)}</dd><dt>结果</dt><dd>HTTP ${escapeHtml(log.status)} · ${log.outcome === 'ok' ? '成功' : log.outcome === 'cancelled' ? '取消' : '失败'}</dd>${upstreamDetails}</dl>${errorDetails}<p>本记录仅包含请求元数据，不包含密钥、请求正文或模型回复。</p>`);
    return;
  }
  if (!channel) return;
  if (action === 'edit') return openChannel(id);
  if (action === 'channel-detail') return showChannelDetail(channel);
  if (action === 'test') {
    byId('test-channel').value = id;
    renderTestModels(true);
    location.hash = 'playground';
    byId('test-prompt').focus();
    return;
  }
  if (action === 'delete' && !await confirmAction('删除渠道', `删除「${channel.name}」后，其连接配置和密钥将从${isCloudTest() ? '云端' : '本地'}数据库移除，已有请求记录保留。`, '删除渠道')) return;
  await withButton(button, async () => {
    try {
      if (action === 'toggle') await api(`/api/channels/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ enabled: !channel.enabled }) });
      else if (action === 'delete') await api(`/api/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
      else return;
      toast(action === 'delete' ? '渠道已删除' : channel.enabled ? '渠道已停用' : '渠道已启用');
      await loadAll();
    } catch (error) { toast(error.message, true); }
  });
}

async function probeModels(button, drawer = false) {
  const channelId = drawer ? state.editingId : byId('test-channel').value;
  if (!channelId) return toast('请先保存渠道，再探测模型列表。', true);
  await withButton(button, async () => {
    try {
      const result = await api(`/api/channels/${encodeURIComponent(channelId)}/probe`, { method: 'POST' });
      state.discovered.set(channelId, result.models);
      if (drawer && state.editingId === channelId) {
        byId('channel-models').value = [...new Set([...readModels(byId('channel-models').value), ...result.models])].join('\n');
        toast(`发现 ${result.models.length} 个模型，已填入列表。点击保存渠道后生效。`);
      } else {
        renderTestModels();
        toast(result.message);
      }
    } catch (error) { toast(error.message, true); }
  });
}

function requestConfiguration() {
  const protocol = byId('test-protocol').value;
  const model = byId('test-model').value.trim();
  const prompt = byId('test-prompt').value;
  const stream = byId('test-stream').checked;
  if (protocol === 'responses') return { protocol, stream, endpoint: '/v1/responses', payload: { model, input: prompt, stream } };
  if (protocol === 'anthropic') return { protocol, stream, endpoint: '/v1/messages', payload: { model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024, stream } };
  if (protocol === 'gemini') return { protocol, stream, endpoint: `/v1beta/models/${encodeURIComponent(model || 'MODEL')}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, payload: { contents: [{ role: 'user', parts: [{ text: prompt }] }] } };
  return { protocol, stream, endpoint: '/v1/chat/completions', payload: { model, messages: [{ role: 'user', content: prompt }], stream } };
}

function updateEndpoint() {
  const config = requestConfiguration();
  byId('test-endpoint').textContent = config.endpoint;
  byId('test-mode-label').textContent = config.stream ? 'SSE 流式' : 'JSON 响应';
}

function responseText(payload, protocol, stream = false) {
  if (protocol === 'openai') {
    const content = stream ? payload.choices?.[0]?.delta?.content : payload.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text || '').join('') : '';
  }
  if (protocol === 'responses') {
    if (stream) return payload.type === 'response.output_text.delta' || payload.type === 'response.refusal.delta' ? payload.delta || '' : '';
    return payload.output_text || payload.output?.flatMap((item) => item.content || []).map((part) => part.text || part.refusal || '').join('') || '';
  }
  if (protocol === 'anthropic') return stream ? payload.type === 'content_block_delta' ? payload.delta?.text || '' : payload.type === 'content_block_start' ? payload.content_block?.text || '' : '' : payload.content?.map((part) => part.text || '').join('') || '';
  return payload.candidates?.[0]?.content?.parts?.filter((part) => !part.thought).map((part) => part.text || '').join('') || '';
}

function trackResponseEnd(payload, protocol, stream = false) {
  let reason = '';
  let finish = '';
  if (!stream) state.responseEnd.terminal = true;
  if (protocol === 'openai') {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      if (choice.finish_reason) state.responseEnd.finishReason = true;
      if (choice.finish_reason && !['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason)) finish ||= choice.finish_reason;
    }
  } else if (protocol === 'responses') {
    const response = payload.response || payload;
    if (['response.completed', 'response.incomplete'].includes(payload.type)) state.responseEnd.terminal = true;
    if (payload.type === 'response.incomplete' || response.status === 'incomplete') finish = response.incomplete_details?.reason || 'incomplete';
    if (!stream && response.status && response.status !== 'completed' && response.status !== 'incomplete') finish = response.status;
  } else if (protocol === 'anthropic') {
    const stopReason = payload.delta?.stop_reason || payload.stop_reason;
    if (stopReason) state.responseEnd.finishReason = true;
    if (stopReason && !['end_turn', 'stop_sequence', 'tool_use'].includes(stopReason)) finish = stopReason;
    if (payload.type === 'message_stop') {
      state.responseEnd.terminal = true;
      if (!state.responseEnd.finishReason) reason = '上游没有提供生成结束原因，当前回复可能不完整。';
    }
  } else if (protocol === 'gemini') {
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    if (candidates.length && candidates.every((candidate) => candidate.finishReason)) state.responseEnd.terminal = true;
    for (const candidate of candidates) if (candidate.finishReason && candidate.finishReason !== 'STOP') finish ||= candidate.finishReason;
    if (payload.promptFeedback?.blockReason) { state.responseEnd.terminal = true; finish = payload.promptFeedback.blockReason; }
  }
  if (finish) {
    const normalized = String(finish).toLowerCase();
    if (['length', 'max_tokens', 'max_output_tokens'].includes(normalized)) reason = '已达到上游的输出长度限制，当前回复不完整。已收到的内容保留在这里。';
    else if (['content_filter', 'safety', 'blocklist', 'prohibited_content', 'recitation', 'spii', 'image_safety'].includes(normalized)) reason = `上游因内容限制提前结束生成（${finish}），当前回复可能不完整。`;
    else reason = `上游未正常完成生成（${finish}），当前回复可能不完整。`;
  }
  if (reason) state.responseEnd.incompleteReason ||= reason;
}

function renderOutput() {
  byId('response-text').textContent = state.output || '正在等待模型内容…';
  byId('response-raw').textContent = state.raw || '正在等待响应事件…';
  byId('event-count').textContent = state.eventCount;
  byId('test-events').textContent = state.eventCount;
  const pane = byId(state.outputTab === 'raw' ? 'response-raw-pane' : 'response-content-pane');
  if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 150) pane.scrollTop = pane.scrollHeight;
}

function appendRaw(value) {
  state.raw += value;
  if (state.raw.length > 1000000) state.raw = '[较早事件已从页面预览中省略]\n' + state.raw.slice(-900000);
}

function parseEvent(frame, protocol) {
  const lines = frame.split(/\r\n|\r|\n/);
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
  const eventType = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
  appendRaw(`${frame}\n\n`);
  if (!data) return;
  state.eventCount++;
  if (data === '[DONE]') {
    if (protocol !== 'openai') throw new Error('当前协议收到不匹配的流式结束事件。');
    state.responseEnd.terminal = true;
    if (!state.responseEnd.finishReason) state.responseEnd.incompleteReason ||= '上游没有提供生成结束原因，当前回复可能不完整。';
    return;
  }
  let payload;
  try { payload = JSON.parse(data); }
  catch { throw new Error('收到无法解析的 SSE 数据，原始事件已保留供排查。'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('收到无法识别的 SSE 事件，原始事件已保留供排查。');
  if (!payload.type && eventType) payload.type = eventType;
  if (eventType === 'error' || payload.error || payload.type === 'error' || payload.type === 'response.failed') throw new Error(payload.error?.message || payload.response?.error?.message || payload.message || '上游在流式响应中返回错误。');
  state.output += responseText(payload, protocol, true);
  if (protocol === 'responses' && ['response.completed', 'response.incomplete'].includes(payload.type)) {
    const completedText = responseText(payload.response || payload, protocol);
    if (completedText.startsWith(state.output)) state.output = completedText;
  }
  trackResponseEnd(payload, protocol, true);
}

async function sendTest(event) {
  event.preventDefault();
  if (!auth.authenticated || state.streamController) return;
  const version = auth.version;
  if (!byId('test-model').value || !byId('test-prompt').value.trim()) return toast('请选择模型并填写消息内容。', true);
  const config = requestConfiguration();
  const controller = new AbortController();
  state.streamController = controller;
  state.output = '';
  state.raw = '';
  state.eventCount = 0;
  state.responseEnd = { terminal: false, finishReason: false, incompleteReason: '' };
  const started = performance.now();
  let firstByte = false;
  let reader;
  byId('response-empty').hidden = true;
  byId('response-text').hidden = false;
  byId('response-text').classList.add('streaming');
  byId('test-submit').disabled = true;
  all('input, select, textarea', byId('test-form')).forEach((element) => { element.disabled = true; });
  byId('test-stop').hidden = false;
  byId('test-state').className = 'badge blue';
  byId('test-state').textContent = '连接中';
  byId('test-http').textContent = '—';
  byId('test-ttfb').innerHTML = '—<small> ms</small>';
  setError('test-error', '');
  byId('test-error').classList.remove('incomplete');
  updateEndpoint();
  renderOutput();
  const timer = setInterval(() => { if (version === auth.version) byId('test-duration').innerHTML = `${Math.round(performance.now() - started)}<small> ms</small>`; }, 100);
  const markFirstByte = () => {
    if (firstByte) return;
    firstByte = true;
    byId('test-ttfb').innerHTML = `${Math.round(performance.now() - started)}<small> ms</small>`;
  };
  try {
    const headers = { 'content-type': 'application/json', 'x-ap-channel': byId('test-channel').value };
    const channel = state.channels.find((item) => item.id === byId('test-channel').value);
    if (channel?.protocol === 'auto' && byId('test-upstream').value !== 'auto') headers['x-ap-protocol'] = byId('test-upstream').value;
    if (byId('test-fingerprint').value) headers['x-ap-fingerprint'] = byId('test-fingerprint').value;
    const response = await gatewayFetch(config.endpoint, { method: 'POST', headers, body: JSON.stringify(config.payload), signal: controller.signal });
    byId('test-http').textContent = response.status;
    if (!response.ok) {
      const text = await response.text();
      if (version !== auth.version) throw sessionError();
      markFirstByte();
      appendRaw(text);
      let payload;
      try { payload = JSON.parse(text); } catch {}
      throw new Error(apiErrorMessage(payload, response.status));
    }
    const actualProtocol = response.headers.get('x-ap-protocol');
    byId('test-state').textContent = config.stream ? '生成中' : '接收中';
    byId('test-endpoint').title = actualProtocol ? `实际使用上游协议：${protocolNames[actualProtocol] || actualProtocol}` : config.endpoint;
    const streamingResponse = response.headers.get('content-type')?.includes('text/event-stream');
    byId('test-mode-label').textContent = streamingResponse ? 'SSE 流式' : 'JSON 响应';
    if (streamingResponse) {
      if (!response.body) throw new Error('响应没有可读取的流。');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const chunk = await reader.read();
        if (version !== auth.version) throw sessionError();
        if (chunk.done) { pending += decoder.decode(); break; }
        if (chunk.value.byteLength) markFirstByte();
        pending += decoder.decode(chunk.value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(pending))) {
          const frame = pending.slice(0, match.index);
          pending = pending.slice(match.index + match[0].length);
          if (frame.trim()) parseEvent(frame, config.protocol);
        }
        if (pending.length > 2000000) throw new Error('单个流式事件过大，已停止页面预览。');
        renderOutput();
      }
      if (pending.trim()) parseEvent(pending, config.protocol);
      if (!state.responseEnd.terminal) throw new Error('响应在协议结束事件前断开，已收到的内容可能不完整。');
    } else {
      const text = await response.text();
      if (version !== auth.version) throw sessionError();
      markFirstByte();
      const payload = JSON.parse(text);
      appendRaw(JSON.stringify(payload, null, 2));
      if (payload.error || payload.status === 'failed') throw new Error(payload.error?.message || '模型返回错误。');
      state.output = responseText(payload, config.protocol);
      state.eventCount = 1;
      trackResponseEnd(payload, config.protocol);
    }
    const incomplete = state.responseEnd.incompleteReason;
    if (!state.output) state.output = incomplete ? '本次生成未正常完成，没有可显示的文本。可切换到“原始事件”查看原因。' : '请求已完成，没有文本输出。可切换到“原始事件”查看完整响应。';
    byId('test-state').className = `badge ${incomplete ? 'amber' : 'teal'}`;
    byId('test-state').textContent = incomplete ? '响应不完整' : '已完成';
    if (incomplete) { setError('test-error', incomplete); byId('test-error').classList.add('incomplete'); }
  } catch (error) {
    if (version !== auth.version || !auth.authenticated) { await reader?.cancel().catch(() => {}); return; }
    const cancelled = controller.signal.aborted;
    const partial = !!state.output;
    byId('test-state').className = `badge ${cancelled || partial ? 'amber' : 'red'}`;
    byId('test-state').textContent = cancelled ? '已停止' : partial ? '响应中断' : '请求失败';
    if (!cancelled) setError('test-error', error.message);
    if (!state.output) state.output = cancelled ? '请求已停止。' : '本次请求未产生文本回复。';
    await reader?.cancel().catch(() => {});
  } finally {
    clearInterval(timer);
    reader?.releaseLock();
    if (version === auth.version && auth.authenticated) {
      state.streamController = null;
      byId('response-text').classList.remove('streaming');
      byId('test-submit').disabled = false;
      all('input, select, textarea', byId('test-form')).forEach((element) => { element.disabled = false; });
      renderTestUpstream();
      byId('test-stop').hidden = true;
      byId('test-duration').innerHTML = `${Math.round(performance.now() - started)}<small> ms</small>`;
      renderOutput();
      // A test just added a log; refresh the list incrementally and defer stats until the overview is shown.
      state.statsStale = true;
      setTimeout(() => { if (version === auth.version) loadLogs().catch(() => {}); }, 400);
    }
  }
}

async function copyText(value) {
  if (!value) return toast('还没有可复制的内容。');
  try {
    await navigator.clipboard.writeText(value);
    toast('已复制到剪贴板');
  } catch { toast('浏览器未允许复制，请手动选中文本复制。', true); }
}

async function saveSettings(event) {
  event.preventDefault();
  await withButton(event.submitter || byId('settings-form').querySelector('[type="submit"]'), async () => {
    try {
      const payload = { defaultChannelId: byId('setting-channel').value, defaultFingerprint: byId('setting-fingerprint').value, heartbeatMs: Number(byId('setting-heartbeat').value), streamTimeoutMs: Number(byId('setting-timeout').value), logRetention: Number(byId('setting-retention').value) };
      const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
      state.settingsDirty = false;
      state.status.settings = result.settings;
      byId('settings-saved').textContent = '设置已保存';
      toast('网关设置已保存');
      await loadAll();
    } catch (error) { toast(error.message, true); }
  });
}

async function exportConfig() {
  await withButton(byId('export-config'), async () => {
    try {
      const data = await api('/api/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `ap-gateway-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('配置已导出，文件不包含上游 API Key。');
    } catch (error) { toast(error.message, true); }
  });
}

async function importConfig(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('配置文件不能超过 2 MiB。');
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('配置文件不是有效 JSON。'); }
    if (!data || !Array.isArray(data.channels)) throw new Error('配置文件须包含 channels 渠道列表。');
    const count = data.channels.filter((channel) => channel?.id !== 'demo' && !channel?.isDemo).length;
    if (!await confirmAction('导入配置', `将新增 ${count} 个渠道${data.settings ? '并应用文件中的网关设置' : ''}。现有渠道会保留；重复导入会产生新副本。导出的备份不包含密钥，导入后需补充。`, '确认导入')) return;
    await withButton(byId('import-config'), async () => {
      const result = await api('/api/import', { method: 'POST', body: JSON.stringify(data) });
      state.settingsDirty = false;
      toast(`已导入 ${result.imported} 个渠道，请补充所需 API Key。`);
      await loadAll();
    });
  } catch (error) { toast(error.message, true); }
}

function setup() {
  byId('base-url').textContent = `${location.origin}/v1`;
  byId('integration-snippet').textContent = `curl ${location.origin}/v1/chat/completions \\\n  -H "Authorization: Bearer sk-ap-YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"ap-demo","messages":[{"role":"user","content":"你好"}],"stream":true}'`;
  byId('login-form').addEventListener('submit', login);
  byId('retry-session').addEventListener('click', checkSession);
  byId('logout-button').addEventListener('click', logout);
  byId('create-key-form').addEventListener('submit', createKey);
  byId('refresh-keys').addEventListener('click', () => withButton(byId('refresh-keys'), loadKeys));
  byId('gateway-keys-body').addEventListener('click', (event) => {
    if (!auth.authenticated) return;
    const copy = event.target.closest('[data-copy-key]');
    if (copy) return void copyKeySecret(copy.dataset.copyKey);
    const view = event.target.closest('[data-key-detail]');
    if (view) {
      const key = state.keys.find((item) => item.id === view.dataset.keyDetail);
      if (key) showKeyDetail(key);
      return;
    }
    const policy = event.target.closest('[data-key-policy]');
    if (policy) return void openKeyPolicy(policy.dataset.keyPolicy);
    const purge = event.target.closest('[data-purge-key]');
    if (purge) return void purgeKey(purge.dataset.purgeKey, purge);
    const revoke = event.target.closest('[data-revoke-key]');
    if (revoke) revokeKey(revoke.dataset.revokeKey, revoke);
  });
  byId('detail-content').addEventListener('click', (event) => {
    const copy = event.target.closest('[data-copy-detail-key]');
    if (copy) void copyKeySecret(copy.dataset.copyDetailKey);
  });
  byId('copy-key-secret').addEventListener('click', copySecret);
  byId('key-policy-channel').addEventListener('change', () => { state.policyModels = new Set(); byId('key-policy-all').checked = true; renderKeyPolicyModels(); });
  byId('key-policy-all').addEventListener('change', renderKeyPolicyModels);
  byId('save-key-policy').addEventListener('click', saveKeyPolicy);
  for (const id of ['close-key-policy', 'cancel-key-policy']) byId(id).addEventListener('click', () => byId('key-policy-dialog').close());
  byId('key-policy-models').addEventListener('change', (event) => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) state.policyModels.add(input.value); else state.policyModels.delete(input.value);
  });
  for (const id of ['close-key-secret', 'key-secret-done']) byId(id).addEventListener('click', () => byId('key-secret-dialog').close());
  byId('key-secret-dialog').addEventListener('close', clearSecret);
  byId('key-secret-dialog').addEventListener('cancel', clearSecret);
  byId('password-form').addEventListener('submit', changePassword);
  window.addEventListener('hashchange', navigate);
  byId('menu-toggle').addEventListener('click', () => {
    const open = byId('sidebar').classList.toggle('open');
    byId('sidebar-backdrop').hidden = !open;
    byId('menu-toggle').setAttribute('aria-expanded', String(open));
  });
  byId('sidebar-backdrop').addEventListener('click', closeSidebar);
  all('[data-open-channel]').forEach((button) => button.addEventListener('click', () => openChannel()));
  byId('refresh-all').addEventListener('click', () => withButton(byId('refresh-all'), () => loadAll(true)));
  for (const [id, loader] of [['refresh-channels', () => loadChannels()], ['refresh-logs', () => loadLogs()]]) byId(id).addEventListener('click', () => withButton(byId(id), async () => { await loader(); toast('数据已刷新'); }));
  byId('channel-search').addEventListener('input', renderChannels);
  byId('channel-filter').addEventListener('change', renderChannels);
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button && !button.disabled) channelAction(button.dataset.action, button.dataset.id, button).catch((error) => toast(error.message, true));
  });
  all('[data-log-filter]').forEach((button) => button.addEventListener('click', () => { state.logFilter = button.dataset.logFilter; renderLogs(); }));
  byId('clear-logs').addEventListener('click', async () => {
    if (!state.logs.length) return toast('目前没有需要清空的记录。');
    if (!await confirmAction('清空请求记录', `这会删除当前${isCloudTest() ? '云端' : '本地'}网关的全部请求记录，并重置概览中的请求统计。`, '清空记录')) return;
    await withButton(byId('clear-logs'), async () => {
      try { await api('/api/logs', { method: 'DELETE' }); toast('请求记录已清空'); await loadAll(); }
      catch (error) { toast(error.message, true); }
    });
  });
  byId('channel-form').addEventListener('submit', saveChannel);
  byId('channel-protocol').addEventListener('change', () => { byId('protocol-options').hidden = byId('channel-protocol').value !== 'auto'; });
  byId('channel-clear-key').addEventListener('change', () => {
    byId('channel-keys').disabled = byId('channel-clear-key').checked;
    if (byId('channel-clear-key').checked) byId('channel-keys').value = '';
    renderKeyInputSummary();
  });
  byId('channel-keys').addEventListener('input', renderKeyInputSummary);
  for (const id of ['close-drawer', 'cancel-channel']) byId(id).addEventListener('click', closeDrawer);
  byId('channel-drawer').addEventListener('click', (event) => { if (event.target === byId('channel-drawer')) closeDrawer(); });
  byId('drawer-probe').addEventListener('click', () => probeModels(byId('drawer-probe'), true));
  byId('close-detail').addEventListener('click', () => byId('detail-dialog').close('cancel'));
  byId('detail-done').addEventListener('click', () => byId('detail-dialog').close('confirm'));
  byId('detail-dialog').addEventListener('click', (event) => { if (event.target === byId('detail-dialog')) byId('detail-dialog').close('cancel'); });
  byId('try-demo').addEventListener('click', () => {
    byId('test-channel').value = 'demo';
    renderTestModels(true);
    location.hash = 'playground';
    byId('test-prompt').focus();
  });
  byId('test-channel').addEventListener('change', () => renderTestModels(true));
  byId('test-model').addEventListener('change', updateEndpoint);
  byId('test-protocol').addEventListener('change', updateEndpoint);
  byId('test-stream').addEventListener('change', updateEndpoint);
  byId('refresh-models').addEventListener('click', () => probeModels(byId('refresh-models')));
  byId('test-form').addEventListener('submit', sendTest);
  byId('test-stop').addEventListener('click', () => state.streamController?.abort());
  all('[data-output-tab]').forEach((button) => button.addEventListener('click', () => {
    state.outputTab = button.dataset.outputTab;
    all('[data-output-tab]').forEach((tab) => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
    byId('response-content-pane').hidden = state.outputTab !== 'content';
    byId('response-raw-pane').hidden = state.outputTab !== 'raw';
  }));
  byId('copy-output').addEventListener('click', () => copyText(state.outputTab === 'raw' ? state.raw : state.output));
  byId('copy-base-url').addEventListener('click', () => copyText(byId('base-url').textContent));
  byId('copy-snippet').addEventListener('click', () => copyText(byId('integration-snippet').textContent));
  byId('settings-form').addEventListener('input', () => { state.settingsDirty = true; byId('settings-saved').textContent = '有未保存的更改'; });
  byId('settings-form').addEventListener('submit', saveSettings);
  byId('export-config').addEventListener('click', exportConfig);
  byId('import-config').addEventListener('click', () => byId('import-file').click());
  byId('import-file').addEventListener('change', importConfig);
  document.addEventListener('keydown', (event) => {
    if (!auth.authenticated) return;
    if (event.key === 'Escape') { closeSidebar(); if (!byId('channel-drawer').hidden) closeDrawer(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !byId('page-playground').hidden && byId('channel-drawer').hidden && !byId('detail-dialog').open && !byId('key-secret-dialog').open) { event.preventDefault(); byId('test-form').requestSubmit(); }
    if (event.key === 'Tab' && !byId('channel-drawer').hidden) {
      const elements = all('button, input, select, textarea, [tabindex="0"]', byId('channel-drawer')).filter((element) => !element.disabled && element.getClientRects().length);
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('beforeunload', () => state.streamController?.abort());
  window.addEventListener('pagehide', () => lockWorkspace());
  window.addEventListener('pageshow', (event) => { if (event.persisted) checkSession(); });
  updateEndpoint();
  checkSession();
  setInterval(() => {
    if (auth.authenticated && !document.hidden && !state.streamController && byId('channel-drawer').hidden && !byId('key-secret-dialog').open) refreshVisiblePage();
  }, 30000);
}

setup();
