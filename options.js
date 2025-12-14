(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    saveIntervalSeconds: 5,
    autoplayAfterRestore: true,
    showNotification: true,
    skipAds: false
  };

  const els = {
    saveIntervalSelect: document.getElementById('saveIntervalSelect'),
    customIntervalRow: document.getElementById('customIntervalRow'),
    customIntervalInput: document.getElementById('customIntervalInput'),
    customIntervalError: document.getElementById('customIntervalError'),
    autoplayAfterRestore: document.getElementById('autoplayAfterRestore'),
    showNotification: document.getElementById('showNotification'),
    skipAds: document.getElementById('skipAds'),
    saveButton: document.getElementById('saveButton'),
    resetButton: document.getElementById('resetButton'),
    status: document.getElementById('status')
  };

  function setStatus(message) {
    els.status.textContent = message;
    if (!message) return;
    setTimeout(() => {
      if (els.status.textContent === message) els.status.textContent = '';
    }, 2500);
  }

  function clearError() {
    els.customIntervalError.textContent = '';
  }

  function showCustomRow(show) {
    els.customIntervalRow.hidden = !show;
  }

  function getSelectedIntervalSeconds() {
    const v = els.saveIntervalSelect.value;
    if (v === 'custom') {
      const raw = String(els.customIntervalInput.value ?? '').trim();
      if (!raw) return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || !Number.isFinite(n)) return null;
      return n;
    }
    return Number(v);
  }

  function validate() {
    clearError();

    const selected = els.saveIntervalSelect.value;
    if (selected === 'custom') {
      const seconds = getSelectedIntervalSeconds();
      if (seconds == null) {
        els.customIntervalError.textContent = '整数の秒数を入力してください。';
        return false;
      }
      if (seconds <= 0) {
        els.customIntervalError.textContent = '1以上の整数を入力してください。';
        return false;
      }
    }

    return true;
  }

  function syncCustomVisibility() {
    const isCustom = els.saveIntervalSelect.value === 'custom';
    showCustomRow(isCustom);
    if (!isCustom) clearError();
  }

  function applyToUI(settings) {
    const seconds = Number(settings.saveIntervalSeconds);

    const presetValues = new Set(['5', '10', '30', '60']);
    if (presetValues.has(String(seconds))) {
      els.saveIntervalSelect.value = String(seconds);
      els.customIntervalInput.value = '';
      showCustomRow(false);
    } else {
      els.saveIntervalSelect.value = 'custom';
      els.customIntervalInput.value = String(seconds);
      showCustomRow(true);
    }

    els.autoplayAfterRestore.checked = !!settings.autoplayAfterRestore;
    els.showNotification.checked = !!settings.showNotification;
    els.skipAds.checked = !!settings.skipAds;

    clearError();
  }

  async function loadSettings() {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    applyToUI(stored);
  }

  async function saveSettings() {
    if (!validate()) return;

    const intervalSeconds = getSelectedIntervalSeconds();
    if (intervalSeconds == null) return;

    const toSave = {
      saveIntervalSeconds: intervalSeconds,
      autoplayAfterRestore: !!els.autoplayAfterRestore.checked,
      showNotification: !!els.showNotification.checked,
      skipAds: !!els.skipAds.checked
    };

    await chrome.storage.sync.set(toSave);
    setStatus('保存しました');
  }

  async function resetSettings() {
    await chrome.storage.sync.set(DEFAULT_SETTINGS);
    await loadSettings();
    setStatus('初期値に戻しました');
  }

  els.saveIntervalSelect.addEventListener('change', () => {
    syncCustomVisibility();
    validate();
  });

  els.customIntervalInput.addEventListener('input', () => {
    validate();
  });

  els.saveButton.addEventListener('click', () => {
    saveSettings().catch(() => {
      setStatus('保存に失敗しました');
    });
  });

  els.resetButton.addEventListener('click', () => {
    resetSettings().catch(() => {
      setStatus('初期値に戻せませんでした');
    });
  });

  loadSettings().catch(() => {
    setStatus('設定の読み込みに失敗しました');
  });
})();
