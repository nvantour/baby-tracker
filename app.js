(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────

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

  // ── Airtable API Layer ──────────────────────────────────────

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
      res = await fetch(url, options);
    } catch (err) {
      showToast('Connection error. Check your internet.', 'error');
      throw err;
    }
    if (res.status === 429 && retries < 2) {
      await delay(30000);
      return apiRequest(url, options, retries + 1);
    }
    if (res.status === 401) {
      showToast('Invalid API token. Check settings.', 'error');
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.error?.message || `Error ${res.status}`;
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
    const url = `${apiUrl()}?${params.toString()}`;
    return apiRequest(url, { method: 'GET', headers: apiHeaders() });
  }

  async function fetchTodayRecords() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 86400000);
    const startStr = startOfDay.toISOString();
    const endStr = endOfDay.toISOString();
    const formula = `AND({Timestamp} >= '${startStr}', {Timestamp} < '${endStr}')`;
    const allRecords = [];
    let offset = null;
    do {
      const data = await fetchRecords({
        filterFormula: formula,
        sort: [{ field: 'Timestamp', direction: 'desc' }],
        pageSize: 100,
        offset: offset,
      });
      if (!data) return [];
      allRecords.push(...data.records);
      offset = data.offset || null;
    } while (offset);
    return allRecords;
  }

  // ── Event Logging ───────────────────────────────────────────

  function flashCard(id) {
    const card = document.getElementById(id);
    card.classList.add('tapped');
    setTimeout(() => card.classList.remove('tapped'), 300);
  }

  async function logPee() {
    flashCard('card-pee');
    const result = await createRecord({
      Type: 'pee',
      Timestamp: new Date().toISOString(),
    });
    if (result) { showToast('Pee diaper logged', 'success'); refreshAll(); }
  }

  async function logPoop() {
    flashCard('card-poop');
    const result = await createRecord({
      Type: 'poop',
      Timestamp: new Date().toISOString(),
    });
    if (result) { showToast('Poop diaper logged', 'success'); refreshAll(); }
  }

  async function logFeeding(side, startTime, durationSecs) {
    const durationMin = Math.round(durationSecs / 60);
    const result = await createRecord({
      Type: 'feeding',
      Timestamp: new Date().toISOString(),
      Side: side,
      StartTime: startTime.toISOString(),
      Duration: durationSecs,
    });
    if (result) {
      const label = side.charAt(0).toUpperCase() + side.slice(1);
      showToast(`Feeding logged (${label}, ${durationMin} min)`, 'success');
      refreshAll();
    }
  }

  async function logTemperature(temp) {
    const result = await createRecord({
      Type: 'temperature',
      Timestamp: new Date().toISOString(),
      Temperature: temp,
    });
    if (result) { showToast(`Temperature logged (${temp.toFixed(1)} \u00B0C)`, 'success'); refreshAll(); }
  }

  // ── Refresh All Sections ─────────────────────────────────────

  async function refreshAll() {
    await Promise.all([
      refreshTodayView(),
      refreshHistoryView(),
    ]);
  }

  // ── Log View UI ─────────────────────────────────────────────

  let timerInterval = null;
  let timerStartTime = null;
  let selectedSide = null;
  let isPaused = false;
  let pausedElapsed = 0; // seconds accumulated before current resume
  let restInterval = null;
  let restRemaining = 0;

  // ── Timer Persistence ──────────────────────────────────────

  function saveTimerState() {
    const state = {
      selectedSide: selectedSide,
      timerStartTime: timerStartTime ? timerStartTime.toISOString() : null,
      isPaused: isPaused,
      pausedElapsed: pausedElapsed,
    };
    localStorage.setItem('bt_timer_state', JSON.stringify(state));
  }

  function clearTimerState() {
    localStorage.removeItem('bt_timer_state');
  }

  function restoreTimer() {
    const raw = localStorage.getItem('bt_timer_state');
    if (!raw) return;
    let state;
    try { state = JSON.parse(raw); } catch (e) { clearTimerState(); return; }
    if (!state || !state.selectedSide) { clearTimerState(); return; }

    // Restore variables
    selectedSide = state.selectedSide;
    isPaused = state.isPaused;
    pausedElapsed = state.pausedElapsed || 0;

    if (!isPaused && state.timerStartTime) {
      timerStartTime = new Date(state.timerStartTime);
    }

    // Restore UI: show feeding panel with timer
    document.getElementById('panel-feeding').classList.remove('hidden');
    document.querySelector('.side-buttons').classList.add('hidden');
    document.querySelector('.panel-instruction').classList.add('hidden');
    document.getElementById('timer-section').classList.remove('hidden');

    const label = selectedSide.charAt(0).toUpperCase() + selectedSide.slice(1);
    document.getElementById('timer-side-label').textContent = `${label} side`;

    const pauseBtn = document.getElementById('btn-pause-timer');
    if (isPaused) {
      pauseBtn.textContent = 'Resume';
      pauseBtn.classList.add('paused');
    } else {
      pauseBtn.textContent = 'Pause';
      pauseBtn.classList.remove('paused');
      // Restart the interval
      timerInterval = setInterval(updateTimerDisplay, 1000);
    }

    updateTimerDisplay();
  }

  function initLogView() {
    document.getElementById('card-pee').addEventListener('click', logPee);
    document.getElementById('card-poop').addEventListener('click', logPoop);
    document.getElementById('card-feeding').addEventListener('click', showFeedingPanel);
    document.getElementById('card-temperature').addEventListener('click', showTemperaturePanel);
    document.getElementById('close-feeding').addEventListener('click', closeFeedingPanel);
    document.getElementById('close-temperature').addEventListener('click', closeTemperaturePanel);

    // Side buttons
    document.querySelectorAll('.side-btn').forEach(btn => {
      btn.addEventListener('click', () => startTimer(btn.dataset.side));
    });

    // Pause and stop timer
    document.getElementById('btn-pause-timer').addEventListener('click', togglePause);
    document.getElementById('btn-stop-timer').addEventListener('click', stopTimer);
    document.getElementById('btn-skip-rest').addEventListener('click', skipRest);

    // Temperature stepper
    document.getElementById('temp-minus').addEventListener('click', () => adjustTemp(-0.1));
    document.getElementById('temp-plus').addEventListener('click', () => adjustTemp(0.1));
    document.getElementById('btn-log-temp').addEventListener('click', () => {
      const val = parseFloat(document.getElementById('temp-value').textContent);
      logTemperature(val);
      closeTemperaturePanel();
    });
  }

  function showFeedingPanel() {
    flashCard('card-feeding');
    closeTemperaturePanel();
    resetFeedingPanel();
    document.getElementById('panel-feeding').classList.remove('hidden');
  }

  function closeFeedingPanel() {
    clearInterval(timerInterval);
    timerInterval = null;
    timerStartTime = null;
    selectedSide = null;
    isPaused = false;
    pausedElapsed = 0;
    clearInterval(restInterval);
    restInterval = null;
    restRemaining = 0;
    clearTimerState();
    document.getElementById('rest-section').classList.add('hidden');
    document.getElementById('panel-feeding').classList.add('hidden');
  }

  function resetFeedingPanel() {
    clearInterval(timerInterval);
    timerInterval = null;
    timerStartTime = null;
    selectedSide = null;
    isPaused = false;
    pausedElapsed = 0;
    clearInterval(restInterval);
    restInterval = null;
    restRemaining = 0;
    document.getElementById('timer-section').classList.add('hidden');
    document.getElementById('rest-section').classList.add('hidden');
    document.getElementById('timer-display').textContent = '00:00';
    document.getElementById('timer-side-label').textContent = '';
    const pauseBtn = document.getElementById('btn-pause-timer');
    pauseBtn.textContent = 'Pause';
    pauseBtn.classList.remove('paused');
    document.querySelectorAll('.side-btn').forEach(b => b.classList.remove('selected'));
    const sideButtons = document.querySelector('.side-buttons');
    const instruction = document.querySelector('.panel-instruction');
    sideButtons.classList.remove('hidden');
    instruction.classList.remove('hidden');
  }

  function startTimer(side) {
    selectedSide = side;
    timerStartTime = new Date();
    isPaused = false;
    pausedElapsed = 0;

    // Highlight selected side
    document.querySelectorAll('.side-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset.side === side);
    });

    // Hide side buttons and instruction, show timer
    document.querySelector('.side-buttons').classList.add('hidden');
    document.querySelector('.panel-instruction').classList.add('hidden');
    document.getElementById('timer-section').classList.remove('hidden');

    const label = side.charAt(0).toUpperCase() + side.slice(1);
    document.getElementById('timer-side-label').textContent = `${label} side`;

    timerInterval = setInterval(updateTimerDisplay, 1000);
    updateTimerDisplay();
    saveTimerState();
  }

  function togglePause() {
    const pauseBtn = document.getElementById('btn-pause-timer');
    if (!isPaused) {
      // Pause: save elapsed time and stop the interval
      isPaused = true;
      pausedElapsed += Math.floor((Date.now() - timerStartTime.getTime()) / 1000);
      clearInterval(timerInterval);
      timerInterval = null;
      pauseBtn.textContent = 'Resume';
      pauseBtn.classList.add('paused');
      saveTimerState();
    } else {
      // Resume: reset timerStartTime to now (elapsed is already saved in pausedElapsed)
      isPaused = false;
      timerStartTime = new Date();
      timerInterval = setInterval(updateTimerDisplay, 1000);
      pauseBtn.textContent = 'Pause';
      pauseBtn.classList.remove('paused');
      saveTimerState();
    }
  }

  function getTotalElapsedSecs() {
    if (isPaused) {
      return pausedElapsed;
    }
    return pausedElapsed + Math.floor((Date.now() - timerStartTime.getTime()) / 1000);
  }

  function updateTimerDisplay() {
    const elapsed = getTotalElapsedSecs();
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    document.getElementById('timer-display').textContent = `${mins}:${secs}`;
  }

  function stopTimer() {
    if (!selectedSide) return;
    clearInterval(timerInterval);
    timerInterval = null;
    const durationSecs = getTotalElapsedSecs();
    const feedStartTime = new Date(Date.now() - durationSecs * 1000);
    logFeeding(selectedSide, feedStartTime, durationSecs);
    clearTimerState();

    // Hide timer, show rest countdown
    document.getElementById('timer-section').classList.add('hidden');
    startRestCountdown();
  }

  function startRestCountdown() {
    restRemaining = 180;
    const restDisplay = document.getElementById('rest-display');
    const restSection = document.getElementById('rest-section');
    restSection.classList.remove('hidden');
    updateRestDisplay();

    restInterval = setInterval(() => {
      restRemaining--;
      updateRestDisplay();
      if (restRemaining <= 0) {
        clearInterval(restInterval);
        restInterval = null;
        showToast('Rest time is over!', 'success');
        closeFeedingPanel();
      }
    }, 1000);
  }

  function updateRestDisplay() {
    const mins = String(Math.floor(restRemaining / 60)).padStart(2, '0');
    const secs = String(restRemaining % 60).padStart(2, '0');
    document.getElementById('rest-display').textContent = `${mins}:${secs}`;
  }

  function skipRest() {
    clearInterval(restInterval);
    restInterval = null;
    closeFeedingPanel();
  }

  let tempValue = 37.0;

  function showTemperaturePanel() {
    flashCard('card-temperature');
    closeFeedingPanel();
    tempValue = 37.0;
    document.getElementById('temp-value').textContent = tempValue.toFixed(1);
    document.getElementById('panel-temperature').classList.remove('hidden');
  }

  function closeTemperaturePanel() {
    document.getElementById('panel-temperature').classList.add('hidden');
  }

  function adjustTemp(delta) {
    tempValue = Math.round((tempValue + delta) * 10) / 10;
    tempValue = Math.max(34.0, Math.min(42.0, tempValue));
    document.getElementById('temp-value').textContent = tempValue.toFixed(1);
  }

  // ── Today View ──────────────────────────────────────────────

  async function refreshTodayView() {
    const dateEl = document.getElementById('today-date');
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });

    const loading = document.getElementById('today-loading');
    loading.classList.remove('hidden');

    try {
      const records = await fetchTodayRecords();
      const summary = computeTodaySummary(records);
      renderTodaySummary(summary);
    } catch (err) {
      console.error('Today view error:', err);
    } finally {
      loading.classList.add('hidden');
    }
  }

  function computeTodaySummary(records) {
    let feedingCount = 0;
    let totalDurationSecs = 0;
    let lastFeedingTime = null;
    let tempCount = 0;
    let latestTemp = null;
    let latestTempTime = null;
    let peeCount = 0;
    let poopCount = 0;
    let vitaminD = false;
    let vitaminDRecordId = null;
    let vitaminK = false;
    let vitaminKRecordId = null;

    records.forEach(r => {
      const f = r.fields;
      const ts = new Date(f.Timestamp);
      switch (f.Type) {
        case 'feeding':
          feedingCount++;
          totalDurationSecs += f.Duration || 0;
          if (!lastFeedingTime || ts > lastFeedingTime) lastFeedingTime = ts;
          break;
        case 'temperature':
          tempCount++;
          if (!latestTempTime || ts > latestTempTime) {
            latestTemp = f.Temperature;
            latestTempTime = ts;
          }
          break;
        case 'pee':
          peeCount++;
          break;
        case 'poop':
          poopCount++;
          break;
        case 'vitamin_d':
          vitaminD = true;
          vitaminDRecordId = r.id;
          break;
        case 'vitamin_k':
          vitaminK = true;
          vitaminKRecordId = r.id;
          break;
      }
    });

    return {
      feedingCount,
      totalMinutes: Math.round(totalDurationSecs / 60),
      lastFeedingTime,
      tempCount,
      latestTemp,
      peeCount,
      poopCount,
      vitaminD,
      vitaminDRecordId,
      vitaminK,
      vitaminKRecordId,
    };
  }

  function renderTodaySummary(s) {
    document.getElementById('stat-feedings').textContent = s.feedingCount;
    document.getElementById('stat-feeding-detail').textContent = `${s.totalMinutes} min`;
    const lastFeedEl = document.getElementById('stat-last-feed');
    if (s.lastFeedingTime) {
      lastFeedEl.textContent = `Last feed: ${formatTimeSince(s.lastFeedingTime)}`;
    } else {
      lastFeedEl.textContent = '';
    }

    if (s.latestTemp !== null) {
      document.getElementById('stat-temperature').textContent =
        `${s.latestTemp.toFixed(1)}\u00B0`;
      document.getElementById('stat-temp-detail').textContent =
        `${s.tempCount} reading${s.tempCount !== 1 ? 's' : ''}`;
    } else {
      document.getElementById('stat-temperature').textContent = '\u2013';
      document.getElementById('stat-temp-detail').textContent = '';
    }

    document.getElementById('stat-pee').textContent = s.peeCount;
    document.getElementById('stat-poop').textContent = s.poopCount;

    // Sync vitamin checkboxes with Airtable data
    syncVitaminCheckboxes(s);
  }

  function formatTimeSince(date) {
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const hours = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    return `${hours}h ${mins}m ago`;
  }

  // ── History View ────────────────────────────────────────────

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
      if (historyOffset) {
        document.getElementById('btn-load-more').classList.remove('hidden');
      }
      if (historyRecords.length === 0) {
        document.getElementById('history-empty').classList.remove('hidden');
      }
    } catch (err) {
      console.error('History view error:', err);
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

      group.records.forEach(record => {
        section.appendChild(createEventRow(record));
      });

      container.appendChild(section);
    });
  }

  function groupRecordsByDay(records) {
    const map = new Map();
    records.forEach(r => {
      const ts = new Date(r.fields.Timestamp);
      const key = ts.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      if (!map.has(key)) {
        map.set(key, { label: key, records: [] });
      }
      map.get(key).records.push(r);
    });
    return Array.from(map.values());
  }

  function createEventRow(record) {
    const f = record.fields;
    const row = document.createElement('div');
    row.className = 'event-row';

    const icon = document.createElement('div');
    icon.className = 'event-icon';
    const icons = { feeding: '\u{1F37C}', temperature: '\u{1F321}', pee: '\u{1F4A7}', poop: '\u{1F4A9}', vitamin_d: '\u2600\uFE0F', vitamin_k: '\u{1F48A}' };
    icon.textContent = icons[f.Type] || '';

    const info = document.createElement('div');
    info.className = 'event-info';

    const desc = document.createElement('div');
    desc.className = 'event-desc';
    desc.textContent = formatEventDesc(f);

    const time = document.createElement('div');
    time.className = 'event-time';
    const ts = f.Type === 'feeding' && f.StartTime
      ? new Date(f.StartTime)
      : new Date(f.Timestamp);
    time.textContent = ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    info.appendChild(desc);
    info.appendChild(time);
    row.appendChild(icon);
    row.appendChild(info);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'event-delete';
    deleteBtn.innerHTML = '&#x1F5D1;&#xFE0F;';
    deleteBtn.setAttribute('aria-label', 'Delete entry');
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this entry?')) return;
      try {
        await deleteRecord(record.id);
        historyRecords = historyRecords.filter(r => r.id !== record.id);
        renderHistoryList();
        refreshTodayView();
        showToast('Entry deleted', 'success');
      } catch (err) {
        // error already shown by apiRequest
      }
    });
    row.appendChild(deleteBtn);

    return row;
  }

  function formatEventDesc(fields) {
    switch (fields.Type) {
      case 'feeding': {
        const side = fields.Side
          ? fields.Side.charAt(0).toUpperCase() + fields.Side.slice(1)
          : '';
        const mins = fields.Duration ? Math.round(fields.Duration / 60) : 0;
        return `Feeding \u2013 ${side}, ${mins} min`;
      }
      case 'temperature':
        return `Temperature: ${(fields.Temperature || 0).toFixed(1)} \u00B0C`;
      case 'pee':
        return 'Pee diaper';
      case 'poop':
        return 'Poop diaper';
      case 'vitamin_d':
        return 'Vitamin D given';
      case 'vitamin_k':
        return 'Vitamin K given';
      default:
        return fields.Type || 'Unknown';
    }
  }

  // ── Toast ───────────────────────────────────────────────────

  let toastTimeout = null;

  function showToast(message, type) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast';
    if (type === 'error') toast.classList.add('toast-error');
    if (type === 'success') toast.classList.add('toast-success');
    toast.classList.remove('hidden');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    }, 2500);
  }

  // ── Config Modal ────────────────────────────────────────────

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
      showToast('Token and Base ID are required', 'error');
      return;
    }

    saveConfig(token, baseId, tableName);
    hideConfigModal();
    showToast('Settings saved', 'success');

    refreshAll();
  }

  function initConfigModal() {
    document.getElementById('btn-settings').addEventListener('click', showConfigModal);
    document.getElementById('btn-config-cancel').addEventListener('click', hideConfigModal);
    document.getElementById('btn-config-save').addEventListener('click', handleConfigSave);
  }

  // ── Daily Vitamins (synced via Airtable) ───────────────────

  let vitaminDRecordId = null;
  let vitaminKRecordId = null;
  let vitaminBusy = false; // prevent double-tap

  function syncVitaminCheckboxes(summary) {
    const checkD = document.getElementById('check-vitamin-d');
    const checkK = document.getElementById('check-vitamin-k');

    checkD.checked = summary.vitaminD;
    checkK.checked = summary.vitaminK;
    vitaminDRecordId = summary.vitaminDRecordId;
    vitaminKRecordId = summary.vitaminKRecordId;

    updateVitaminUI(checkD, checkK);
  }

  function updateVitaminUI(checkD, checkK) {
    const labelD = document.getElementById('label-vitamin-d');
    const labelK = document.getElementById('label-vitamin-k');
    labelD.classList.toggle('checked', checkD.checked);
    labelK.classList.toggle('checked', checkK.checked);
  }

  async function handleVitaminToggle(type, checkbox) {
    if (vitaminBusy) { checkbox.checked = !checkbox.checked; return; }
    vitaminBusy = true;

    const checkD = document.getElementById('check-vitamin-d');
    const checkK = document.getElementById('check-vitamin-k');

    try {
      if (checkbox.checked) {
        // Create record in Airtable
        const result = await createRecord({
          Type: type,
          Timestamp: new Date().toISOString(),
        });
        if (result && result.records && result.records[0]) {
          if (type === 'vitamin_d') vitaminDRecordId = result.records[0].id;
          if (type === 'vitamin_k') vitaminKRecordId = result.records[0].id;
          showToast(type === 'vitamin_d' ? 'Vitamin D logged' : 'Vitamin K logged', 'success');
        }
      } else {
        // Delete record from Airtable
        const recordId = type === 'vitamin_d' ? vitaminDRecordId : vitaminKRecordId;
        if (recordId) {
          await deleteRecord(recordId);
          if (type === 'vitamin_d') vitaminDRecordId = null;
          if (type === 'vitamin_k') vitaminKRecordId = null;
          showToast(type === 'vitamin_d' ? 'Vitamin D removed' : 'Vitamin K removed', 'success');
        }
      }
      updateVitaminUI(checkD, checkK);
      refreshAll();
    } catch (err) {
      // Revert checkbox on error
      checkbox.checked = !checkbox.checked;
      updateVitaminUI(checkD, checkK);
    } finally {
      vitaminBusy = false;
    }
  }

  function initVitamins() {
    const checkD = document.getElementById('check-vitamin-d');
    const checkK = document.getElementById('check-vitamin-k');

    checkD.addEventListener('change', () => handleVitaminToggle('vitamin_d', checkD));
    checkK.addEventListener('change', () => handleVitaminToggle('vitamin_k', checkK));
  }

  // ── Init ────────────────────────────────────────────────────

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

  document.addEventListener('DOMContentLoaded', () => {
    initLogView();
    initConfigModal();
    initHistoryLoadMore();
    initVitamins();
    registerServiceWorker();
    restoreTimer();

    if (!isConfigured()) {
      showConfigModal();
    } else {
      refreshAll();
    }
  });
})();
