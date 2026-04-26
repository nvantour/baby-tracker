(function () {
  'use strict';

  // ── Rate Limiter ──────────────────────────────────────────
  const RATE_LIMIT = 5;
  const RATE_WINDOW_MS = 1000;
  const requestTimestamps = [];

  async function rateLimitedFetch(url, options) {
    while (true) {
      const now = Date.now();
      while (requestTimestamps.length > 0 && requestTimestamps[0] <= now - RATE_WINDOW_MS) {
        requestTimestamps.shift();
      }
      if (requestTimestamps.length < RATE_LIMIT) {
        requestTimestamps.push(now);
        return fetch(url, options);
      }
      const waitMs = requestTimestamps[0] + RATE_WINDOW_MS - now + 10;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  // ── Day Boundary (07:00) ──────────────────────────────────
  const DAY_START_HOUR = 7;

  function getDayBoundary() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAY_START_HOUR, 0, 0);
    if (now.getHours() < DAY_START_HOUR) start.setDate(start.getDate() - 1);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  function getDayKey() {
    const { start } = getDayBoundary();
    return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  }

  // ── Today Records Cache ───────────────────────────────────
  let todayRecordsCache = null;
  let todayCacheKey = null;

  function isCacheValid() {
    return todayRecordsCache !== null && todayCacheKey === getDayKey();
  }

  function addToCache(record) {
    if (!isCacheValid()) return;
    todayRecordsCache.unshift(record);
  }

  function removeFromCache(recordId) {
    if (!isCacheValid()) return;
    todayRecordsCache = todayRecordsCache.filter(r => r.id !== recordId);
  }

  // ── Config ────────────────────────────────────────────────
  const STORAGE = {
    TOKEN: 'bt_airtable_token',
    BASE_ID: 'bt_airtable_base_id',
    TABLE_NAME: 'bt_airtable_table_name',
  };

  function getConfig() {
    return {
      token: localStorage.getItem(STORAGE.TOKEN) || '',
      baseId: localStorage.getItem(STORAGE.BASE_ID) || '',
      tableName: localStorage.getItem(STORAGE.TABLE_NAME) || 'BabyLog',
    };
  }

  function saveConfig(token, baseId, tableName) {
    localStorage.setItem(STORAGE.TOKEN, token.replace(/\s/g, ''));
    localStorage.setItem(STORAGE.BASE_ID, baseId.replace(/\s/g, ''));
    localStorage.setItem(STORAGE.TABLE_NAME, (tableName || 'BabyLog').trim());
  }

  function isConfigured() {
    const c = getConfig();
    return c.token.length > 0 && c.baseId.length > 0;
  }

  // ── Airtable API Layer ────────────────────────────────────
  function apiUrl() {
    const c = getConfig();
    return `https://api.airtable.com/v0/${c.baseId.trim()}/${encodeURIComponent(c.tableName.trim())}`;
  }

  function apiHeaders() {
    const c = getConfig();
    return {
      Authorization: `Bearer ${c.token}`,
      'Content-Type': 'application/json',
    };
  }

  async function apiRequest(url, options, retries = 0) {
    let res;
    try {
      res = await rateLimitedFetch(url, options);
    } catch (err) {
      showToast('Verbindingsfout. Check je internet.', 'error');
      throw err;
    }
    if (res.status === 429 && retries < 2) {
      await new Promise(r => setTimeout(r, 30000));
      return apiRequest(url, options, retries + 1);
    }
    if (res.status === 401) {
      showToast('Ongeldige API token. Check instellingen.', 'error');
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.error?.message || `Fout ${res.status}`;
      showToast(msg, 'error');
      throw new Error(msg);
    }
    return res.json();
  }

  async function createRecord(fields) {
    if (!isConfigured()) { showConfigModal(); return null; }
    return apiRequest(apiUrl(), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ records: [{ fields }] }),
    });
  }

  async function deleteRecord(recordId) {
    if (!isConfigured()) { showConfigModal(); return null; }
    return apiRequest(`${apiUrl()}/${recordId}`, {
      method: 'DELETE',
      headers: apiHeaders(),
    });
  }

  async function fetchRecords(opts = {}) {
    if (!isConfigured()) { showConfigModal(); return null; }
    const params = new URLSearchParams();
    if (opts.filterFormula) params.set('filterByFormula', opts.filterFormula);
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
    if (opts.offset) params.set('offset', opts.offset);
    if (opts.sort) {
      opts.sort.forEach((s, i) => {
        params.set(`sort[${i}][field]`, s.field);
        params.set(`sort[${i}][direction]`, s.direction);
      });
    }
    return apiRequest(`${apiUrl()}?${params.toString()}`, { method: 'GET', headers: apiHeaders() });
  }

  async function fetchTodayRecords(forceRefresh = false) {
    if (!forceRefresh && isCacheValid()) return todayRecordsCache;

    const { start, end } = getDayBoundary();
    const formula = `AND({Timestamp} >= '${start.toISOString()}', {Timestamp} < '${end.toISOString()}')`;
    const all = [];
    let offset = null;
    do {
      const data = await fetchRecords({
        filterFormula: formula,
        sort: [{ field: 'Timestamp', direction: 'desc' }],
        pageSize: 100,
        offset,
      });
      if (!data) return [];
      all.push(...data.records);
      offset = data.offset || null;
    } while (offset);

    todayRecordsCache = all;
    todayCacheKey = getDayKey();
    return all;
  }

  // ── Time helpers ──────────────────────────────────────────
  function getCurrentTimeStr() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function timeStrToISO(timeStr) {
    const now = new Date();
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
    // If user enters a time that's in the future (more than 5 min ahead), assume it's from yesterday
    if (d.getTime() > now.getTime() + 5 * 60000) {
      d.setDate(d.getDate() - 1);
    }
    return d.toISOString();
  }

  function formatTime(date) {
    return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDuration(totalMinutes) {
    const m = Math.round(totalMinutes);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem > 0 ? `${h}u ${rem}m` : `${h}u`;
  }

  // ── Event Logging ─────────────────────────────────────────
  async function logSleepStart(timeStr) {
    const result = await createRecord({
      Type: 'sleep_start',
      Timestamp: timeStrToISO(timeStr),
    });
    if (result) {
      showToast('Slaaptijd gelogd', 'success');
      optimisticRefresh(result.records[0]);
      resetTimeInput('input-sleep-time');
    }
  }

  async function logWake(timeStr) {
    const result = await createRecord({
      Type: 'wake',
      Timestamp: timeStrToISO(timeStr),
    });
    if (result) {
      showToast('Wakker gelogd', 'success');
      optimisticRefresh(result.records[0]);
      resetTimeInput('input-wake-time');
    }
  }

  async function logCry(durationMin) {
    const result = await createRecord({
      Type: 'cry',
      Timestamp: new Date().toISOString(),
      Duration: durationMin,
    });
    if (result) {
      showToast(`Huilen gelogd (${durationMin} min)`, 'success');
      optimisticRefresh(result.records[0]);
    }
  }

  async function logFeedingOffered(success, startTimeStr, durationMin) {
    const fields = {
      Type: 'feeding_offered',
      Timestamp: new Date().toISOString(),
      FeedingSuccess: success ? 'Succes!' : 'Ze wilde niet',
    };
    if (success && startTimeStr) {
      fields.StartTime = timeStrToISO(startTimeStr);
      fields.Duration = durationMin;
    }
    const result = await createRecord(fields);
    if (result) {
      const msg = success
        ? `Borstvoeding gelogd (gelukt, ${durationMin} min)`
        : 'Borstvoeding aangeboden (niet gelukt)';
      showToast(msg, 'success');
      optimisticRefresh(result.records[0]);
    }
  }

  // ── Optimistic Updates ────────────────────────────────────
  function optimisticRefresh(newRecord) {
    addToCache(newRecord);
    historyRecords.unshift(newRecord);
    rerenderFromCache();
  }

  function optimisticDelete(recordId) {
    removeFromCache(recordId);
    historyRecords = historyRecords.filter(r => r.id !== recordId);
    rerenderFromCache();
  }

  function rerenderFromCache() {
    if (isCacheValid() && activeTab === 'dashboard') {
      const stats = computeDashboard(todayRecordsCache);
      renderDashboard(stats);
    }
    renderHistoryList();
  }

  async function refreshAll() {
    await Promise.all([
      fetchTodayRecords(true).then(records => {
        if (activeTab === 'dashboard') {
          const stats = computeDashboard(records);
          renderDashboard(stats);
        }
      }),
      refreshHistoryView(),
    ]);
  }

  // ── Tab Navigation ────────────────────────────────────────
  let activeTab = 'log';

  function switchTab(tab) {
    activeTab = tab;
    document.getElementById('view-log').classList.toggle('hidden', tab !== 'log');
    document.getElementById('view-dashboard').classList.toggle('hidden', tab !== 'dashboard');
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    if (tab === 'dashboard') refreshDashboard();
  }

  function initTabNav() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
  }

  // ── Log View UI ───────────────────────────────────────────
  let cryMinutes = 5;
  let feedingMinutes = 10;

  // Track which time inputs the user has manually edited
  const touchedInputs = new Set();

  function resetTimeInput(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = getCurrentTimeStr();
    touchedInputs.delete(id);
  }

  function initTimeInput(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!el.value) el.value = getCurrentTimeStr();
    el.addEventListener('input', () => touchedInputs.add(id));
    el.addEventListener('change', () => touchedInputs.add(id));
  }

  function tickTimeInputs() {
    // Only auto-update fields the user hasn't touched
    ['input-sleep-time', 'input-wake-time', 'input-feeding-start'].forEach(id => {
      if (!touchedInputs.has(id)) {
        const el = document.getElementById(id);
        if (el) el.value = getCurrentTimeStr();
      }
    });
  }

  function initLogView() {
    initTimeInput('input-sleep-time');
    initTimeInput('input-wake-time');
    initTimeInput('input-feeding-start');

    // Slaap
    document.getElementById('btn-sleep-now').addEventListener('click', () => {
      logSleepStart(getCurrentTimeStr());
    });
    document.getElementById('btn-sleep-log').addEventListener('click', () => {
      const t = document.getElementById('input-sleep-time').value;
      if (!t) return showToast('Vul een tijd in', 'error');
      logSleepStart(t);
    });

    document.getElementById('btn-wake-now').addEventListener('click', () => {
      logWake(getCurrentTimeStr());
    });
    document.getElementById('btn-wake-log').addEventListener('click', () => {
      const t = document.getElementById('input-wake-time').value;
      if (!t) return showToast('Vul een tijd in', 'error');
      logWake(t);
    });

    // Huilen
    document.getElementById('cry-minus').addEventListener('click', () => {
      cryMinutes = Math.max(1, cryMinutes - 1);
      document.getElementById('cry-value').textContent = cryMinutes;
    });
    document.getElementById('cry-plus').addEventListener('click', () => {
      cryMinutes = Math.min(180, cryMinutes + 1);
      document.getElementById('cry-value').textContent = cryMinutes;
    });
    document.getElementById('btn-cry-log').addEventListener('click', () => {
      logCry(cryMinutes);
    });

    // Borstvoeding
    const successBtn = document.getElementById('btn-feeding-success');
    const failedBtn = document.getElementById('btn-feeding-failed');
    const successForm = document.getElementById('feeding-success-form');

    successBtn.addEventListener('click', () => {
      successBtn.classList.add('selected');
      failedBtn.classList.remove('selected');
      successForm.classList.remove('hidden');
      document.getElementById('input-feeding-start').value = getCurrentTimeStr();
    });

    failedBtn.addEventListener('click', () => {
      failedBtn.classList.add('selected');
      successBtn.classList.remove('selected');
      successForm.classList.add('hidden');
      logFeedingOffered(false, null, null);
      setTimeout(() => failedBtn.classList.remove('selected'), 600);
    });

    document.getElementById('feeding-minus').addEventListener('click', () => {
      feedingMinutes = Math.max(1, feedingMinutes - 1);
      document.getElementById('feeding-value').textContent = feedingMinutes;
    });
    document.getElementById('feeding-plus').addEventListener('click', () => {
      feedingMinutes = Math.min(120, feedingMinutes + 1);
      document.getElementById('feeding-value').textContent = feedingMinutes;
    });
    document.getElementById('btn-feeding-save').addEventListener('click', () => {
      const startTime = document.getElementById('input-feeding-start').value;
      if (!startTime) return showToast('Vul een starttijd in', 'error');
      logFeedingOffered(true, startTime, feedingMinutes);
      successBtn.classList.remove('selected');
      successForm.classList.add('hidden');
      resetTimeInput('input-feeding-start');
    });
  }

  // ── Dashboard ─────────────────────────────────────────────
  let activeDashTab = 'overview';
  let liveTimerInterval = null;
  let lastDashStats = null;

  function switchDashTab(tab) {
    activeDashTab = tab;
    document.querySelectorAll('.dash-view').forEach(v => v.classList.add('hidden'));
    document.getElementById(`dash-${tab}`).classList.remove('hidden');
    document.querySelectorAll('.dash-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.dash === tab);
    });
  }

  function initDashboard() {
    document.querySelectorAll('.dash-tab').forEach(btn => {
      btn.addEventListener('click', () => switchDashTab(btn.dataset.dash));
    });
  }

  function pairSleepWakeEvents(records) {
    const events = records
      .filter(r => r.fields.Type === 'sleep_start' || r.fields.Type === 'wake')
      .sort((a, b) => new Date(a.fields.Timestamp) - new Date(b.fields.Timestamp));

    const sleepPeriods = [];
    const wakePeriods = [];
    let lastSleepStart = null;
    let lastWake = null;

    for (const event of events) {
      const ts = new Date(event.fields.Timestamp);
      if (event.fields.Type === 'sleep_start') {
        if (lastWake !== null) {
          wakePeriods.push({ start: lastWake, end: ts });
          lastWake = null;
        }
        lastSleepStart = ts;
      } else {
        if (lastSleepStart !== null) {
          sleepPeriods.push({ start: lastSleepStart, end: ts });
          lastSleepStart = null;
        }
        lastWake = ts;
      }
    }
    if (lastSleepStart !== null) sleepPeriods.push({ start: lastSleepStart, end: null });
    if (lastWake !== null) wakePeriods.push({ start: lastWake, end: null });

    return { sleepPeriods, wakePeriods };
  }

  function computeDashboard(records) {
    const { sleepPeriods, wakePeriods } = pairSleepWakeEvents(records);
    const cries = records
      .filter(r => r.fields.Type === 'cry')
      .sort((a, b) => new Date(a.fields.Timestamp) - new Date(b.fields.Timestamp));
    const feedings = records
      .filter(r => r.fields.Type === 'feeding_offered')
      .sort((a, b) => new Date(a.fields.Timestamp) - new Date(b.fields.Timestamp));

    const completeSleep = sleepPeriods.filter(p => p.end !== null);
    const totalSleepMin = completeSleep.reduce((s, p) => s + (p.end - p.start) / 60000, 0);
    const avgNapMin = completeSleep.length > 0 ? totalSleepMin / completeSleep.length : 0;
    const currentlySleeping = sleepPeriods.find(p => p.end === null) || null;
    const currentlyAwake = wakePeriods.find(p => p.end === null) || null;

    const totalCryMin = cries.reduce((s, r) => s + (r.fields.Duration || 0), 0);

    const totalFeedingsOffered = feedings.length;
    const successFeedings = feedings.filter(r => r.fields.FeedingSuccess === 'Succes!').length;
    const failedFeedings = feedings.filter(r => r.fields.FeedingSuccess === 'Ze wilde niet').length;
    const avgFeedingsPerWakePeriod = wakePeriods.length > 0
      ? totalFeedingsOffered / wakePeriods.length
      : 0;

    const feedingsPerWakePeriod = wakePeriods.map(wp => {
      const inPeriod = feedings.filter(f => {
        const ts = new Date(f.fields.Timestamp);
        return ts >= wp.start && (wp.end === null ? true : ts < wp.end);
      });
      const successInPeriod = inPeriod.filter(f => f.fields.FeedingSuccess === 'Succes!');
      const totalDurMin = successInPeriod.reduce((s, f) => s + (f.fields.Duration || 0), 0);
      return {
        wakePeriod: wp,
        count: inPeriod.length,
        successCount: successInPeriod.length,
        totalDurMin,
      };
    });

    return {
      sleepPeriods, wakePeriods,
      totalSleepMin, avgNapMin,
      currentlySleeping, currentlyAwake,
      cries, totalCryMin,
      feedings, totalFeedingsOffered,
      successFeedings, failedFeedings,
      avgFeedingsPerWakePeriod, feedingsPerWakePeriod,
    };
  }

  function getPeriodMinutes(period) {
    const end = period.end || new Date();
    return (end - period.start) / 60000;
  }

  function getDayLabel() {
    const { start } = getDayBoundary();
    return start.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function renderOverview(stats) {
    const el = document.getElementById('dash-overview');
    let html = `<div class="dash-date">📅 ${escapeHtml(getDayLabel())} (vanaf 07:00)</div>
      <div class="overview-grid">
        <div class="overview-card sleep-card">
          <div class="overview-icon">💤</div>
          <div class="overview-value">${escapeHtml(formatDuration(stats.totalSleepMin))}</div>
          <div class="overview-label">slaap</div>
        </div>
        <div class="overview-card cry-card">
          <div class="overview-icon">😢</div>
          <div class="overview-value">${stats.totalCryMin} min</div>
          <div class="overview-label">huiltijd</div>
        </div>
        <div class="overview-card wake-card">
          <div class="overview-icon">⏱</div>
          <div class="overview-value">${stats.wakePeriods.filter(p => p.end !== null).length}</div>
          <div class="overview-label">wakkertijden</div>
        </div>
        <div class="overview-card feeding-card">
          <div class="overview-icon">🤱</div>
          <div class="overview-value">${stats.totalFeedingsOffered}×</div>
          <div class="overview-label">aangeboden</div>
        </div>
      </div>`;

    if (stats.currentlySleeping) {
      html += `<div class="live-status sleep-status">
        <span class="live-dot"></span>
        💤 Nu slapend: <strong id="live-sleep-time">${formatDuration(getPeriodMinutes(stats.currentlySleeping))}</strong>
      </div>`;
    }
    if (stats.currentlyAwake) {
      const dur = getPeriodMinutes(stats.currentlyAwake);
      const warn = dur > 90;
      html += `<div class="live-status ${warn ? 'wake-status-warn' : 'wake-status'}">
        <span class="live-dot"></span>
        ☀️ Nu wakker: <strong id="live-wake-time">${formatDuration(dur)}</strong>
        ${warn ? '<span class="warn-badge">Lang wakker</span>' : ''}
      </div>`;
    }
    el.innerHTML = html;
  }

  function renderSleepTab(stats) {
    const el = document.getElementById('dash-sleep');
    const completeSleep = stats.sleepPeriods.filter(p => p.end !== null);
    const completeWake = stats.wakePeriods.filter(p => p.end !== null);

    let html = `<div class="dash-summary">
      <div class="summary-row"><span>Totale slaap</span><strong>${formatDuration(stats.totalSleepMin)}</strong></div>
      <div class="summary-row"><span>Aantal dutjes</span><strong>${completeSleep.length}×</strong></div>
      <div class="summary-row"><span>Gem. dutje</span><strong>${completeSleep.length > 0 ? formatDuration(stats.avgNapMin) : '—'}</strong></div>
    </div>

    <div class="period-section">
      <h3 class="period-title">💤 Dutjes</h3>`;

    if (stats.currentlySleeping) {
      html += `<div class="period-item period-live">
        <span class="live-dot"></span>
        <span>${formatTime(stats.currentlySleeping.start)} → nu</span>
        <span class="period-dur" id="live-sleep-dur">${formatDuration(getPeriodMinutes(stats.currentlySleeping))}</span>
      </div>`;
    }
    if (completeSleep.length === 0 && !stats.currentlySleeping) {
      html += '<p class="empty-state">Nog geen dutjes gelogd</p>';
    }
    completeSleep.forEach(p => {
      html += `<div class="period-item">
        <span>${formatTime(p.start)} → ${formatTime(p.end)}</span>
        <span class="period-dur">${formatDuration((p.end - p.start) / 60000)}</span>
      </div>`;
    });
    html += `</div>

    <div class="period-section">
      <h3 class="period-title">☀️ Wakkertijden</h3>`;

    if (stats.currentlyAwake) {
      const dur = getPeriodMinutes(stats.currentlyAwake);
      const warn = dur > 90;
      html += `<div class="period-item period-live ${warn ? 'period-warn' : ''}">
        <span class="live-dot"></span>
        <span>${formatTime(stats.currentlyAwake.start)} → nu ${warn ? '⚠️' : ''}</span>
        <span class="period-dur" id="live-wake-dur">${formatDuration(dur)}</span>
      </div>`;
    }
    if (completeWake.length === 0 && !stats.currentlyAwake) {
      html += '<p class="empty-state">Nog geen wakkertijden gelogd</p>';
    }
    completeWake.forEach(p => {
      html += `<div class="period-item">
        <span>${formatTime(p.start)} → ${formatTime(p.end)}</span>
        <span class="period-dur">${formatDuration((p.end - p.start) / 60000)}</span>
      </div>`;
    });
    html += '</div>';

    el.innerHTML = html;
  }

  function renderCryTab(stats) {
    const el = document.getElementById('dash-cry');
    let html = `<div class="dash-summary">
      <div class="summary-row"><span>Totale huiltijd</span><strong>${stats.totalCryMin} min</strong></div>
      <div class="summary-row"><span>Aantal momenten</span><strong>${stats.cries.length}×</strong></div>
    </div>
    <div class="period-section">
      <h3 class="period-title">😢 Huilmomenten</h3>`;

    if (stats.cries.length === 0) {
      html += '<p class="empty-state">Geen huilmomenten gelogd</p>';
    } else {
      stats.cries.forEach(r => {
        html += `<div class="period-item">
          <span>${formatTime(new Date(r.fields.Timestamp))}</span>
          <span class="period-dur">${r.fields.Duration || 0} min</span>
        </div>`;
      });
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function renderFeedingTab(stats) {
    const el = document.getElementById('dash-feeding');
    let html = `<div class="dash-summary">
      <div class="summary-row"><span>Aangeboden</span><strong>${stats.totalFeedingsOffered}×</strong></div>
      <div class="summary-row"><span>Gelukt / Niet gelukt</span><strong>${stats.successFeedings}× / ${stats.failedFeedings}×</strong></div>
      <div class="summary-row"><span>Gem. per wakkertijd</span><strong>${stats.avgFeedingsPerWakePeriod.toFixed(1)}×</strong></div>
    </div>
    <div class="period-section">
      <h3 class="period-title">🤱 Per wakkertijd</h3>`;

    if (stats.feedingsPerWakePeriod.length === 0) {
      html += '<p class="empty-state">Geen wakkertijden gelogd</p>';
    } else {
      stats.feedingsPerWakePeriod.forEach(fp => {
        const endLabel = fp.wakePeriod.end ? formatTime(fp.wakePeriod.end) : 'nu';
        html += `<div class="feeding-period-item">
          <div class="feeding-period-header">${formatTime(fp.wakePeriod.start)} → ${endLabel}</div>
          <div class="feeding-period-stats">
            <span>${fp.count}× aangeboden</span>
            ${fp.successCount > 0 ? `<span>· ${fp.successCount}× gelukt (${formatDuration(fp.totalDurMin)})</span>` : ''}
          </div>
        </div>`;
      });
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function renderDashboard(stats) {
    lastDashStats = stats;
    renderOverview(stats);
    renderSleepTab(stats);
    renderCryTab(stats);
    renderFeedingTab(stats);

    if (liveTimerInterval) clearInterval(liveTimerInterval);
    if (stats.currentlySleeping || stats.currentlyAwake) {
      liveTimerInterval = setInterval(updateLiveTimers, 30000);
    }
  }

  function updateLiveTimers() {
    if (!lastDashStats) return;
    if (lastDashStats.currentlySleeping) {
      const dur = formatDuration(getPeriodMinutes(lastDashStats.currentlySleeping));
      const a = document.getElementById('live-sleep-time');
      const b = document.getElementById('live-sleep-dur');
      if (a) a.textContent = dur;
      if (b) b.textContent = dur;
    }
    if (lastDashStats.currentlyAwake) {
      const dur = formatDuration(getPeriodMinutes(lastDashStats.currentlyAwake));
      const a = document.getElementById('live-wake-time');
      const b = document.getElementById('live-wake-dur');
      if (a) a.textContent = dur;
      if (b) b.textContent = dur;
    }
  }

  async function refreshDashboard(forceRefresh = false) {
    const loading = document.getElementById('dashboard-loading');
    loading.classList.remove('hidden');
    try {
      const records = await fetchTodayRecords(forceRefresh);
      const stats = computeDashboard(records);
      renderDashboard(stats);
    } catch (err) {
      console.error('Dashboard error:', err);
    } finally {
      loading.classList.add('hidden');
    }
  }

  // ── History View ──────────────────────────────────────────
  let historyOffset = null;
  let historyRecords = [];
  let isLoadingHistory = false;

  async function refreshHistoryView() {
    historyOffset = null;
    historyRecords = [];
    document.getElementById('history-list').innerHTML = '';
    document.getElementById('history-empty').classList.add('hidden');
    await loadHistoryPage();
  }

  async function loadHistoryPage() {
    if (isLoadingHistory) return;
    isLoadingHistory = true;
    const loading = document.getElementById('history-loading');
    loading.classList.remove('hidden');
    document.getElementById('btn-load-more').classList.add('hidden');

    try {
      const data = await fetchRecords({
        sort: [{ field: 'Timestamp', direction: 'desc' }],
        pageSize: 100,
        offset: historyOffset || undefined,
      });
      if (!data) return;
      historyRecords.push(...data.records);
      historyOffset = data.offset || null;
      renderHistoryList();
      if (historyOffset) document.getElementById('btn-load-more').classList.remove('hidden');
      if (historyRecords.length === 0) {
        document.getElementById('history-empty').classList.remove('hidden');
      }
    } catch (err) {
      console.error('History error:', err);
    } finally {
      loading.classList.add('hidden');
      isLoadingHistory = false;
    }
  }

  function renderHistoryList() {
    const container = document.getElementById('history-list');
    container.innerHTML = '';
    const groups = groupRecordsByDay(historyRecords);
    groups.forEach(group => {
      const section = document.createElement('div');
      section.className = 'day-group';
      const header = document.createElement('div');
      header.className = 'day-header';
      header.textContent = group.label;
      section.appendChild(header);
      group.records.forEach(record => section.appendChild(createEventRow(record)));
      container.appendChild(section);
    });
  }

  function groupRecordsByDay(records) {
    const map = new Map();
    records.forEach(r => {
      const ts = new Date(r.fields.Timestamp);
      const key = ts.toLocaleDateString('nl-NL', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
      if (!map.has(key)) map.set(key, { label: key, records: [] });
      map.get(key).records.push(r);
    });
    return Array.from(map.values());
  }

  const EVENT_ICONS = {
    sleep_start: '🌙',
    wake: '☀️',
    cry: '😢',
    feeding_offered: '🤱',
  };

  function createEventRow(record) {
    const f = record.fields;
    const row = document.createElement('div');
    row.className = 'event-row';

    const icon = document.createElement('div');
    icon.className = 'event-icon';
    icon.textContent = EVENT_ICONS[f.Type] || '•';

    const info = document.createElement('div');
    info.className = 'event-info';

    const desc = document.createElement('div');
    desc.className = 'event-desc';
    desc.textContent = formatEventDesc(f);

    const time = document.createElement('div');
    time.className = 'event-time';
    const ts = f.Type === 'feeding_offered' && f.StartTime
      ? new Date(f.StartTime)
      : new Date(f.Timestamp);
    time.textContent = ts.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

    info.appendChild(desc);
    info.appendChild(time);
    row.appendChild(icon);
    row.appendChild(info);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'event-delete';
    deleteBtn.innerHTML = '🗑️';
    deleteBtn.setAttribute('aria-label', 'Verwijder');
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Deze registratie verwijderen?')) return;
      try {
        await deleteRecord(record.id);
        optimisticDelete(record.id);
        showToast('Verwijderd', 'success');
      } catch (err) { /* error toast already shown */ }
    });
    row.appendChild(deleteBtn);
    return row;
  }

  function formatEventDesc(f) {
    switch (f.Type) {
      case 'sleep_start': return 'Slapen gestart';
      case 'wake':        return 'Wakker geworden';
      case 'cry':         return `Gehuild — ${f.Duration || 0} min`;
      case 'feeding_offered':
        if (f.FeedingSuccess === 'Succes!') {
          return `Borstvoeding gelukt — ${f.Duration || 0} min`;
        }
        return 'Borstvoeding aangeboden — niet gelukt';
      default: return f.Type || 'Onbekend';
    }
  }

  // ── Toast ─────────────────────────────────────────────────
  let toastTimeout = null;

  function showToast(message, type) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast';
    if (type === 'error')   toast.classList.add('toast-error');
    if (type === 'success') toast.classList.add('toast-success');
    toast.classList.remove('hidden');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.add('hidden'), 2500);
  }

  // ── Config Modal ──────────────────────────────────────────
  function showConfigModal() {
    const c = getConfig();
    document.getElementById('input-token').value = c.token;
    document.getElementById('input-base-id').value = c.baseId;
    document.getElementById('input-table-name').value = c.tableName;
    document.getElementById('config-modal').classList.remove('hidden');
  }

  function hideConfigModal() {
    document.getElementById('config-modal').classList.add('hidden');
  }

  function handleConfigSave() {
    const token = document.getElementById('input-token').value;
    const baseId = document.getElementById('input-base-id').value;
    const tableName = document.getElementById('input-table-name').value;

    if (!token.trim() || !baseId.trim()) {
      showToast('Token en Base ID zijn verplicht', 'error');
      return;
    }

    saveConfig(token, baseId, tableName);
    hideConfigModal();
    showToast('Instellingen opgeslagen', 'success');
    todayRecordsCache = null;
    refreshAll();
  }

  function initConfigModal() {
    document.getElementById('btn-settings').addEventListener('click', showConfigModal);
    document.getElementById('btn-config-cancel').addEventListener('click', hideConfigModal);
    document.getElementById('btn-config-save').addEventListener('click', handleConfigSave);
  }

  function initHistoryLoadMore() {
    document.getElementById('btn-load-more').addEventListener('click', loadHistoryPage);
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('SW registration failed:', err);
      });
    }
  }

  // ── Init ──────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    initTabNav();
    initLogView();
    initDashboard();
    initHistoryLoadMore();
    initConfigModal();
    registerServiceWorker();

    if (!isConfigured()) {
      showConfigModal();
    } else {
      refreshAll();
    }

    // Refresh time inputs every minute so default stays current
    setInterval(tickTimeInputs, 60000);
  });
})();
