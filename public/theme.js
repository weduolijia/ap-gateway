'use strict';

(() => {
  const storageKey = 'ap-gateway-theme';
  const preferences = ['system', 'light', 'dark'];
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(storageKey);
    if (preferences.includes(saved)) preference = saved;
  } catch {}

  function applyTheme() {
    const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#0c151b' : '#f7f9fa');
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved);
    document.querySelectorAll('[data-theme-select]').forEach((select) => { select.value = preference; });
    document.getElementById('theme-icon')?.setAttribute('href', `#i-${preference === 'system' ? 'monitor' : resolved === 'dark' ? 'moon' : 'sun'}`);
    const status = document.getElementById('theme-status');
    if (status) status.textContent = preference === 'system' ? `跟随系统，当前为${resolved === 'dark' ? '深色' : '浅色'}` : `已切换到${resolved === 'dark' ? '深色' : '浅色'}外观`;
  }

  applyTheme();
  media.addEventListener('change', () => { if (preference === 'system') applyTheme(); });
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = preferences.includes(event.newValue) ? event.newValue : 'system';
    applyTheme();
  });
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-select]').forEach((select) => {
      select.addEventListener('change', () => {
        preference = preferences.includes(select.value) ? select.value : 'system';
        try { localStorage.setItem(storageKey, preference); } catch {}
        applyTheme();
      });
    });
    applyTheme();
  }, { once: true });
})();
