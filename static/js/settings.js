/*
File: static/js/settings.js
Author notes: Settings UI controller. I load/save config to the backend, manage
lookup lists, offline readiness checks, and keep live status badges in the
Settings headers so the operator always sees current state.
*/

const DEFAULT_SETTINGS = {
    triage_instruction: "Act as Lead Clinician. Priority: Life-saving protocols. Format: ## ASSESSMENT, ## PROTOCOL.",
    inquiry_instruction: "Act as Medical Librarian. Focus: Academic research and pharmacology.",
    tr_temp: 0.1,
    tr_tok: 1024,
    tr_p: 0.9,
    in_temp: 0.6,
    in_tok: 2048,
    in_p: 0.95,
    mission_context: "Isolated Medical Station offshore.",
    rep_penalty: 1.1,
    user_mode: "user",
    med_photo_model: "qwen",
    med_photo_prompt: "You are a pharmacy intake assistant on a sailing vessel. Look at the medication photo and return JSON only with keys: generic_name, brand_name, form, strength, expiry_date, batch_lot, storage_location, manufacturer, indication, allergy_warnings, dosage, notes.",
    vaccine_types: ["MMR", "DTaP", "HepB", "HepA", "Td/Tdap", "Influenza", "COVID-19"],
    pharmacy_labels: ["Antibiotic", "Analgesic", "Cardiac", "Respiratory", "Gastrointestinal", "Endocrine", "Emergency"],
    offline_force_flags: false
};

let settingsDirty = false;
let settingsLoaded = false;
let settingsAutoSaveTimer = null;
let offlineStatusCache = null;
let vaccineTypeList = [...DEFAULT_SETTINGS.vaccine_types];
let pharmacyLabelList = [...DEFAULT_SETTINGS.pharmacy_labels];
let offlineInitialized = false;

function setUserMode(mode) {
    const body = document.body;
    const normalized = ['advanced', 'developer'].includes((mode || '').toLowerCase()) ? mode.toLowerCase() : 'user';
    body.classList.remove('mode-user', 'mode-advanced', 'mode-developer');
    body.classList.add(`mode-${normalized}`);
    document.documentElement.classList.remove('mode-user', 'mode-advanced', 'mode-developer');
    document.documentElement.classList.add(`mode-${normalized}`);
    document.querySelectorAll('.dev-tag').forEach(el => {
        el.style.display = normalized === 'developer' ? 'inline-block' : '';
    });
    document.querySelectorAll('.developer-only').forEach(el => {
        el.style.display = normalized === 'developer' ? '' : 'none';
    });
    // Ensure triage sample inline respects user mode on load
    try {
        const triageHeader = document.getElementById('query-form-header');
        if (triageHeader && typeof toggleSection === 'function') {
            // Force a refresh of inline display based on current state and mode
            const body = triageHeader.nextElementSibling;
            const isExpanded = body && body.style.display !== 'none';
            const icon = triageHeader.querySelector('.detail-icon');
            if (icon && isExpanded) icon.textContent = '▾';
            if (icon && !isExpanded) icon.textContent = '▸';
            const sampleInline = triageHeader.querySelector('.triage-sample-inline');
            if (sampleInline) {
                const isAdvanced = normalized === 'advanced' || normalized === 'developer';
                sampleInline.style.display = (isExpanded && isAdvanced) ? 'flex' : 'none';
            }
        }
    } catch (err) { /* ignore */ }
    updateSettingsMeta(window.CACHED_SETTINGS || {});
    try {
        localStorage.setItem('user_mode', normalized);
    } catch (err) { /* ignore */ }
}

function updateSettingsMeta(settings = {}) {
    const isAdvanced = document.body.classList.contains('mode-advanced') || document.body.classList.contains('mode-developer');
    // Offline meta
    const offlineEl = document.getElementById('offline-meta');
    if (offlineEl) {
        const flagsOn = !!settings.offline_force_flags;
        if (isAdvanced && offlineStatusCache) {
            const cached = offlineStatusCache.cached_models || 0;
            offlineEl.textContent = `Cached models: ${cached} | Flags ${flagsOn ? 'ON' : 'OFF'}`;
        } else {
            const mode = (offlineStatusCache && offlineStatusCache.offline_mode) || flagsOn ? 'Offline' : 'Online';
            offlineEl.textContent = `Mode: ${mode}`;
        }
    }
    // Vaccine types
    const vaxEl = document.getElementById('vax-meta');
    if (vaxEl) vaxEl.textContent = `${vaccineTypeList.length} types`;
    // Pharmacy labels
    const pharmEl = document.getElementById('pharm-meta');
    if (pharmEl) pharmEl.textContent = `${pharmacyLabelList.length} labels`;
    // User mode
    const modeEl = document.getElementById('user-mode-meta');
    if (modeEl) modeEl.textContent = `Mode: ${settings.user_mode || 'user'}`;
    // Crew creds (updated when crew list loads)
    // Model params
    const modelEl = document.getElementById('model-meta');
    if (modelEl) {
        if (isAdvanced) {
            const triTok = Number(settings.tr_tok || settings.tr_tok === 0 ? settings.tr_tok : DEFAULT_SETTINGS.tr_tok);
            const inTok = Number(settings.in_tok || settings.in_tok === 0 ? settings.in_tok : DEFAULT_SETTINGS.in_tok);
            modelEl.textContent = `Tokens - Triage: ${triTok} | Inquiry: ${inTok}`;
        } else {
            modelEl.textContent = '';
        }
    }
}

function updateCrewCredMeta(count) {
    const el = document.getElementById('crew-creds-meta');
    if (el) el.textContent = `${count} credentialed`;
}

function applySettingsToUI(data = {}) {
    const merged = { ...DEFAULT_SETTINGS, ...(data || {}) };
    vaccineTypeList = normalizeVaccineTypes(merged.vaccine_types);
    pharmacyLabelList = normalizePharmacyLabels(merged.pharmacy_labels);
    renderVaccineTypes();
    renderPharmacyLabels();
    Object.keys(merged).forEach(k => {
        const el = document.getElementById(k);
        if (el) {
            if (el.type === 'checkbox') {
                el.checked = Boolean(merged[k]);
            } else {
                el.value = merged[k];
            }
        }
    });
    setUserMode(merged.user_mode);
    try { localStorage.setItem('user_mode', merged.user_mode || 'user'); } catch (err) { /* ignore */ }
    window.CACHED_SETTINGS = merged;
    settingsDirty = false;
    settingsLoaded = true;
    updateSettingsMeta(merged);
}

if (document.readyState !== 'loading') {
    applyStoredUserMode();
    loadSettingsUI().catch(() => {});
    bindSettingsDirtyTracking();
} else {
    document.addEventListener('DOMContentLoaded', () => {
        applyStoredUserMode();
        loadSettingsUI().catch(() => {});
        bindSettingsDirtyTracking();
    }, { once: true });
}

function bindSettingsDirtyTracking() {
    const fields = document.querySelectorAll('#Settings input, #Settings textarea, #Settings select');
    fields.forEach(el => {
        if (el.dataset.settingsDirtyBound) return;
        el.dataset.settingsDirtyBound = 'true';
        el.addEventListener('input', () => {
            settingsDirty = true;
            scheduleAutoSave('input-change');
            if (el.id === 'user_mode') {
                setUserMode(el.value);
                // Persist immediately to avoid losing mode if navigation happens quickly
                saveSettings(false, 'user-mode-change').catch(() => {});
            }
            if (el.classList.contains('developer-only')) {
                // Keep developer-only components in sync
                setUserMode(document.getElementById('user_mode')?.value || 'user');
            }
            updateSettingsMeta(window.CACHED_SETTINGS || {});
        });
        el.addEventListener('change', () => {
            settingsDirty = true;
            scheduleAutoSave('input-change');
            if (el.id === 'user_mode') {
                setUserMode(el.value);
                saveSettings(false, 'user-mode-change').catch(() => {});
            }
            if (el.classList.contains('developer-only')) {
                setUserMode(document.getElementById('user_mode')?.value || 'user');
            }
            updateSettingsMeta(window.CACHED_SETTINGS || {});
        });
    });
}

async function loadSettingsUI() {
    console.log('[settings] loadSettingsUI called');
    try {
        const url = '/api/data/settings';
        const res = await fetch(url, { credentials: 'same-origin' });
        console.log('[settings] fetch response status:', res.status);
        if (!res.ok) throw new Error(`Settings load failed (${res.status})`);
        const s = await res.json();
        console.log('[settings] loaded settings:', s);
        applySettingsToUI(s);
        console.log('[settings] settings applied to UI');
        try { localStorage.setItem('user_mode', s.user_mode || 'user'); } catch (err) { /* ignore */ }
        if (!offlineInitialized) {
            offlineInitialized = true;
            runOfflineCheck(false).catch((err) => {
                renderOfflineStatus(`Offline check failed: ${err.message}`, true);
            });
        }
    } catch (err) {
        console.error('[settings] load error', err);
        alert(`Unable to load settings: ${err.message}`);
        const localMode = (() => {
            try { return localStorage.getItem('user_mode') || 'user'; } catch (e) { return 'user'; }
        })();
        applySettingsToUI({ ...DEFAULT_SETTINGS, user_mode: localMode });
    }
}

function updateSettingsStatus(message, isError = false) {
    const el = document.getElementById('settings-save-status');
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? 'var(--red)' : '#2c3e50';
}

function applyStoredUserMode() {
    try {
        const stored = localStorage.getItem('user_mode') || 'user';
        setUserMode(stored);
    } catch (err) { /* ignore */ }
}

function scheduleAutoSave(reason = 'auto') {
    if (settingsAutoSaveTimer) clearTimeout(settingsAutoSaveTimer);
    settingsAutoSaveTimer = setTimeout(() => saveSettings(false, reason), 800);
}

async function saveSettings(showAlert = true, reason = 'manual') {
    try {
        const s = {};
        const numeric = new Set(['tr_temp','tr_tok','tr_p','in_temp','in_tok','in_p','rep_penalty']);
        ['triage_instruction','inquiry_instruction','tr_temp','tr_tok','tr_p','in_temp','in_tok','in_p','mission_context','rep_penalty','user_mode','med_photo_model','med_photo_prompt'].forEach(k => {
            const el = document.getElementById(k);
            if (!el) return;
            const val = el.type === 'checkbox' ? el.checked : el.value;
            if (numeric.has(k)) {
                const num = val === '' ? '' : Number(val);
                s[k] = Number.isFinite(num) ? num : DEFAULT_SETTINGS[k];
            } else {
                s[k] = val;
            }
        });
        const offlineToggle = document.getElementById('offline-force-flags');
        if (offlineToggle) s.offline_force_flags = !!offlineToggle.checked;
        s.vaccine_types = normalizeVaccineTypes(vaccineTypeList);
        s.pharmacy_labels = normalizePharmacyLabels(pharmacyLabelList);
        console.log('[settings] saving', { reason, payload: s });
        updateSettingsStatus('Saving…', false);
        const headers = { 'Content-Type': 'application/json' };
        const url = '/api/data/settings';
        const res = await fetch(url, {
            method:'POST',
            headers,
            body:JSON.stringify(s),
            credentials:'same-origin'
        });
        if (!res.ok) {
            let detail = '';
            try {
                const err = await res.json();
                detail = err?.error ? `: ${err.error}` : '';
            } catch (_) { /* ignore parse errors */ }
            throw new Error(`Save failed (${res.status})${detail}`);
        }
        const updated = await res.json();
        console.log('[settings] save response', updated);
        // Preserve the locally selected user_mode to avoid flicker if the server echoes stale data
        const merged = { ...updated, user_mode: s.user_mode || updated.user_mode, vaccine_types: s.vaccine_types || updated.vaccine_types };
        applySettingsToUI(merged);
        try { localStorage.setItem('user_mode', updated.user_mode || 'user'); } catch (err) { /* ignore */ }
        settingsDirty = false;
        updateSettingsStatus(`Saved at ${new Date().toLocaleTimeString()}`);
        if (showAlert) {
            alert("Configuration synchronized.");
        }
        if (typeof refreshPromptPreview === 'function') {
            const promptBox = document.getElementById('prompt-preview');
            // Only refresh if the user has not manually edited the prompt box
            if (!promptBox || promptBox.dataset.autofilled !== 'false') {
                refreshPromptPreview(true);
            }
        }
        updateSettingsMeta(updated);
    } catch (err) {
        if (showAlert) {
            alert(`Unable to save settings: ${err.message}`);
        }
        updateSettingsStatus(`Save error: ${err.message}`, true);
        console.error('[settings] save error', err);
    }
}

function resetSection(section) {
    if (section === 'triage') {
        document.getElementById('triage_instruction').value = DEFAULT_SETTINGS.triage_instruction;
        document.getElementById('tr_temp').value = DEFAULT_SETTINGS.tr_temp;
        document.getElementById('tr_tok').value = DEFAULT_SETTINGS.tr_tok;
        document.getElementById('tr_p').value = DEFAULT_SETTINGS.tr_p;
    } else if (section === 'inquiry') {
        document.getElementById('inquiry_instruction').value = DEFAULT_SETTINGS.inquiry_instruction;
        document.getElementById('in_temp').value = DEFAULT_SETTINGS.in_temp;
        document.getElementById('in_tok').value = DEFAULT_SETTINGS.in_tok;
        document.getElementById('in_p').value = DEFAULT_SETTINGS.in_p;
    } else if (section === 'mission') {
        document.getElementById('mission_context').value = DEFAULT_SETTINGS.mission_context;
    } else if (section === 'med_photo') {
        const el = document.getElementById('med_photo_prompt');
        if (el) el.value = DEFAULT_SETTINGS.med_photo_prompt;
    }
    saveSettings();
}

function normalizeVaccineTypes(list) {
    if (!Array.isArray(list)) return [...DEFAULT_SETTINGS.vaccine_types];
    const seen = new Set();
    return list
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => !!v)
        .filter((v) => {
            const key = v.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function renderVaccineTypes() {
    const container = document.getElementById('vaccine-types-list');
    if (!container) return;
    if (!vaccineTypeList.length) {
        container.innerHTML = '<div style="color:#666; font-size:12px;">No vaccine types defined. Add at least one to enable the dropdown.</div>';
        return;
    }
    container.innerHTML = vaccineTypeList
        .map((v, idx) => `
            <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid #eee;">
                <div style="width:28px; text-align:right; font-weight:700; color:#666;">${idx + 1}.</div>
                <div style="flex:1; font-weight:600;">${v}</div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <button class="btn btn-sm" style="background:#607d8b;" ${idx === 0 ? 'disabled' : ''} onclick="moveVaccineType(${idx}, -1)">Up</button>
                    <button class="btn btn-sm" style="background:#607d8b;" ${idx === vaccineTypeList.length - 1 ? 'disabled' : ''} onclick="moveVaccineType(${idx}, 1)">Down</button>
                    <button class="btn btn-sm" style="background:var(--red);" onclick="removeVaccineType(${idx})">Remove Remove</button>
                </div>
            </div>
        `).join('');
}

function addVaccineType() {
    const input = document.getElementById('vaccine-type-input');
    if (!input) return;
    const val = input.value.trim();
    if (!val) {
        alert('Enter a vaccine type before adding.');
        return;
    }
    vaccineTypeList = normalizeVaccineTypes([...vaccineTypeList, val]);
    input.value = '';
    renderVaccineTypes();
    settingsDirty = true;
    scheduleAutoSave('vaccine-type-add');
}

function removeVaccineType(idx) {
    if (idx < 0 || idx >= vaccineTypeList.length) return;
    vaccineTypeList.splice(idx, 1);
    vaccineTypeList = normalizeVaccineTypes(vaccineTypeList);
    renderVaccineTypes();
    settingsDirty = true;
    scheduleAutoSave('vaccine-type-remove');
}

function moveVaccineType(idx, delta) {
    const newIndex = idx + delta;
    if (newIndex < 0 || newIndex >= vaccineTypeList.length) return;
    const nextList = [...vaccineTypeList];
    const [item] = nextList.splice(idx, 1);
    nextList.splice(newIndex, 0, item);
    vaccineTypeList = normalizeVaccineTypes(nextList);
    renderVaccineTypes();
    settingsDirty = true;
    scheduleAutoSave('vaccine-type-reorder');
}

function normalizePharmacyLabels(list) {
    if (!Array.isArray(list)) return [...DEFAULT_SETTINGS.pharmacy_labels];
    const seen = new Set();
    return list
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => !!v)
        .filter((v) => {
            const key = v.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function renderPharmacyLabels() {
    const container = document.getElementById('pharmacy-labels-list');
    if (!container) return;
    if (!pharmacyLabelList.length) {
        container.innerHTML = '<div style="color:#666; font-size:12px;">No user labels defined. Add at least one to enable the dropdown.</div>';
        return;
    }
    container.innerHTML = pharmacyLabelList
        .map((v, idx) => `
            <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid #eee;">
                <div style="width:28px; text-align:right; font-weight:700; color:#666;">${idx + 1}.</div>
                <div style="flex:1; font-weight:600;">${v}</div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <button class="btn btn-sm" style="background:#607d8b;" ${idx === 0 ? 'disabled' : ''} onclick="movePharmacyLabel(${idx}, -1)">Up</button>
                    <button class="btn btn-sm" style="background:#607d8b;" ${idx === pharmacyLabelList.length - 1 ? 'disabled' : ''} onclick="movePharmacyLabel(${idx}, 1)">Down</button>
                    <button class="btn btn-sm" style="background:var(--red);" onclick="removePharmacyLabel(${idx})">Remove Remove</button>
                </div>
            </div>
        `).join('');
    window.CACHED_SETTINGS = window.CACHED_SETTINGS || {};
    window.CACHED_SETTINGS.pharmacy_labels = [...pharmacyLabelList];
    if (typeof window.refreshPharmacyLabelsFromSettings === 'function') {
        window.refreshPharmacyLabelsFromSettings(pharmacyLabelList);
    }
}

function addPharmacyLabel() {
    const input = document.getElementById('pharmacy-label-input');
    if (!input) return;
    const val = input.value.trim();
    if (!val) {
        alert('Enter a label before adding.');
        return;
    }
    pharmacyLabelList = normalizePharmacyLabels([...pharmacyLabelList, val]);
    input.value = '';
    renderPharmacyLabels();
    settingsDirty = true;
    scheduleAutoSave('pharmacy-label-add');
}

function removePharmacyLabel(idx) {
    if (idx < 0 || idx >= pharmacyLabelList.length) return;
    pharmacyLabelList.splice(idx, 1);
    pharmacyLabelList = normalizePharmacyLabels(pharmacyLabelList);
    renderPharmacyLabels();
    settingsDirty = true;
    scheduleAutoSave('pharmacy-label-remove');
}

function movePharmacyLabel(idx, delta) {
    const newIndex = idx + delta;
    if (newIndex < 0 || newIndex >= pharmacyLabelList.length) return;
    const nextList = [...pharmacyLabelList];
    const [item] = nextList.splice(idx, 1);
    nextList.splice(newIndex, 0, item);
    pharmacyLabelList = normalizePharmacyLabels(nextList);
    renderPharmacyLabels();
    settingsDirty = true;
    scheduleAutoSave('pharmacy-label-reorder');
}

function renderOfflineStatus(msg, isError = false) {
    const box = document.getElementById('offline-status');
    if (!box) return;
    box.style.color = isError ? 'var(--red)' : '#2c3e50';
    box.innerHTML = msg;
}

function setOfflineControlsEnabled(enabled) {
    ['offline-flag-btn', 'offline-download-btn', 'offline-check-btn', 'offline-backup-btn', 'offline-restore-btn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.disabled = !enabled;
            btn.style.opacity = enabled ? '1' : '0.6';
            btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
        }
    });
}

async function createOfflineBackup() {
    renderOfflineStatus('Creating offline backup…');
    try {
        const res = await fetch('/api/offline/backup', { method: 'POST', credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
        renderOfflineStatus(`Backup created: ${data.backup}`);
    } catch (err) {
        renderOfflineStatus(`Backup failed: ${err.message}`, true);
    }
}

async function restoreOfflineBackup() {
    renderOfflineStatus('Restoring latest backup…');
    try {
        const res = await fetch('/api/offline/restore', { method: 'POST', credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
        renderOfflineStatus(`Restored backup: ${data.restored}`);
        alert('Cache restored. Please reload the app.');
    } catch (err) {
        renderOfflineStatus(`Restore failed: ${err.message}`, true);
    }
}

function formatOfflineStatus(data) {
    const models = data.models || [];
    const missing = data.missing || models.filter((m) => !m.cached);
    const offline = data.offline_mode;
    const env = data.env || {};
    const disk = data.disk || {};
    const modelLines = models
        .map((m) => `${m.model}: ${m.cached ? 'Cached ✅' : 'Missing ❌'}${m.downloaded ? ' (downloaded)' : ''}${m.error ? ` (err: ${m.error})` : ''}`)
        .join('<br>');
    const envLines = Object.entries(env)
        .map(([k, v]) => `${k}: ${v || 'unset'}`)
        .join('<br>');
    let note = '';
    if (missing.length) {
        note = `<div style="color:var(--red); margin-top:6px;">Missing ${missing.length} model(s). Click "Download missing models" while online.</div>`;
    } else {
        note = `<div style="color:var(--green); margin-top:6px;">All required models cached.</div>`;
    }
    if (offline) {
        note += `<div style="margin-top:6px;">Offline mode flags detected.</div>`;
    } else {
        note += `<div style="margin-top:6px; color:#b26a00;">Offline flags not set; set HF_HUB_OFFLINE=1 and TRANSFORMERS_OFFLINE=1 before going offline.</div>`;
    }
    const diskLine = disk.total_gb ? `<div style="margin-top:6px; font-size:12px;">Cache disk (${disk.path || ''}): ${disk.free_gb || '?'}GB free / ${disk.total_gb || '?'}GB total.</div>` : '';
    const howTo = `<div style="margin-top:8px; font-size:12px; color:#333;">
<strong>Steps:</strong> 1) While online, click "Download missing models". 2) Then click "Backup cache". 3) Before sailing, set offline env flags and rerun "Check cache status".<br>
<strong>Required models:</strong> medgemma-1.5-4b-it, medgemma-27b-text-it, Qwen2.5-VL-7B-Instruct.
</div>`;
    return (
        `<strong>Models</strong><br>${modelLines || 'None'}<br><br>` +
        `<strong>Env</strong><br>${envLines}<br><br>` +
        `<strong>Cache</strong><br>${data.cache_dir || ''}` +
        note +
        diskLine +
        howTo
    );
}

function updateOfflineFlagButton() {
    const btn = document.getElementById('offline-flag-btn');
    const chk = document.getElementById('offline-force-flags');
    if (!btn) return;
    const offline = offlineStatusCache ? !!offlineStatusCache.offline_mode : false;
    btn.textContent = offline ? 'Disable offline flags' : 'Enable offline flags';
    btn.style.background = offline ? '#555' : '#b26a00';
    if (chk) chk.checked = offlineStatusCache ? !!(offlineStatusCache.env?.HF_HUB_OFFLINE === '1' || offlineStatusCache.offline_mode || DEFAULT_SETTINGS.offline_force_flags) : !!DEFAULT_SETTINGS.offline_force_flags;
}

async function runOfflineCheck(downloadMissing = false) {
    renderOfflineStatus(downloadMissing ? 'Checking and downloading missing models…' : 'Checking offline requirements…');
    setOfflineControlsEnabled(false);
    let spinner = null;
    const start = Date.now();
    if (downloadMissing) {
        spinner = setInterval(() => {
            const el = document.getElementById('offline-status');
            if (!el) return;
            const secs = Math.floor((Date.now() - start) / 1000);
            const dots = '.'.repeat((secs % 3) + 1);
            el.innerHTML = `Downloading missing models${dots}<br><small>${secs}s elapsed</small>`;
        }, 500);
    }
    try {
        const endpoint = downloadMissing ? '/api/offline/ensure' : '/api/offline/check';
        const res = await fetch(endpoint, { credentials: 'same-origin', method: downloadMissing ? 'POST' : 'GET' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
        offlineStatusCache = data;
        let message = formatOfflineStatus(data);
        if (downloadMissing && data.offline_mode) {
            message += '<div style="margin-top:6px; color:#b26a00;">Offline flags are enabled; downloads were skipped. Temporarily disable offline flags while online to fetch models.</div>';
        } else if (downloadMissing && data.missing && data.missing.length) {
            message += '<div style="margin-top:6px; color:#b26a00;">Some models still missing. Stay online and try again.</div>';
        } else if (downloadMissing && data.models && data.models.some(m => m.downloaded)) {
            message += '<div style="margin-top:6px; color:var(--green);">Downloads completed.</div>';
        }
        renderOfflineStatus(message);
        updateOfflineFlagButton();
        updateSettingsMeta(window.CACHED_SETTINGS || {});
    } catch (err) {
        renderOfflineStatus(`Error: ${err.message}. If missing models persist, stay online and click "Download missing models".`, true);
    } finally {
        if (spinner) clearInterval(spinner);
        setOfflineControlsEnabled(true);
    }
}

async function toggleOfflineFlags(forceEnable) {
    const desired = typeof forceEnable === 'boolean'
        ? forceEnable
        : !(offlineStatusCache ? !!offlineStatusCache.offline_mode : false);
    renderOfflineStatus(desired ? 'Enabling offline flags…' : 'Disabling offline flags…');
    try {
        const res = await fetch('/api/offline/flags', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enable: desired })
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
        offlineStatusCache = data;
        renderOfflineStatus(formatOfflineStatus(data));
        updateOfflineFlagButton();
        updateSettingsMeta(window.CACHED_SETTINGS || {});
    } catch (err) {
        renderOfflineStatus(`Unable to set offline flags: ${err.message}`, true);
    }
}

async function exportDefaultDataset() {
    const status = document.getElementById('default-export-status');
    if (status) {
        status.textContent = 'Exporting default dataset…';
        status.style.color = '#2c3e50';
    }
    try {
        const res = await fetch('/api/default/export', {
            method: 'POST',
            credentials: 'same-origin'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
            throw new Error(data.error || `Status ${res.status}`);
        }
        if (status) {
            status.textContent = `Exported: ${Array.isArray(data.written) ? data.written.join(', ') : 'default data'}`;
            status.style.color = '#2e7d32';
        } else {
            alert('Default dataset exported.');
        }
    } catch (err) {
        if (status) {
            status.textContent = `Export failed: ${err.message}`;
            status.style.color = 'var(--red)';
        } else {
            alert(`Export failed: ${err.message}`);
        }
    }
}

// Load crew credentials list
async function loadCrewCredentials() {
    const container = document.getElementById('crew-credentials');
    if (!container) return;
    container.innerHTML = 'Loading crew...';
    try {
        const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
        if (!data || data.length === 0) {
            container.innerHTML = '<div style="color:#666;">No crew members found.</div>';
            updateCrewCredMeta(0);
            return;
        }
        container.innerHTML = data.map(p => `
            <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                <div style="min-width:180px; font-weight:bold;">${p.firstName || ''} ${p.lastName || p.name || ''}</div>
                <input type="text" id="cred-user-${p.id}" value="${p.username || ''}" placeholder="Username" style="padding:8px; flex:1; min-width:140px;" oninput="debouncedSaveCred('${p.id}')">
                <input type="text" id="cred-pass-${p.id}" value="${p.password || ''}" placeholder="Password" style="padding:8px; flex:1; min-width:140px;" oninput="debouncedSaveCred('${p.id}')">
                <span id="cred-status-${p.id}" style="font-size:12px; color:#666;"></span>
            </div>
        `).join('');
        const credCount = data.filter(p => (p.username || '').trim() || (p.password || '').trim()).length;
        updateCrewCredMeta(credCount);
    } catch (err) {
        container.innerHTML = `<div style="color:red;">Error loading crew: ${err.message}</div>`;
        updateCrewCredMeta(0);
    }
}

// Save a single crew credential
const credSaveTimers = {};
async function saveCrewCredential(id) {
    const userEl = document.getElementById(`cred-user-${id}`);
    const passEl = document.getElementById(`cred-pass-${id}`);
    const statusEl = document.getElementById(`cred-status-${id}`);
    if (!userEl || !passEl) return;
    statusEl.textContent = 'Saving…';
    statusEl.style.color = '#666';
    try {
        const res = await fetch('/api/crew/credentials', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            credentials:'same-origin',
            body: JSON.stringify({id, username: userEl.value, password: passEl.value})
        });
        const text = await res.text();
        if (!res.ok) throw new Error(text || `Status ${res.status}`);
        statusEl.textContent = 'Saved';
        statusEl.style.color = '#2e7d32';
        setTimeout(() => { if (statusEl.textContent === 'Saved') statusEl.textContent=''; }, 1500);
    } catch (err) {
        statusEl.textContent = `Save failed: ${err.message}`;
        statusEl.style.color = 'var(--red)';
    }
}

function debouncedSaveCred(id) {
    clearTimeout(credSaveTimers[id]);
    credSaveTimers[id] = setTimeout(() => saveCrewCredential(id), 400);
}

// Expose functions to window for inline onclick handlers
window.saveSettings = saveSettings;
window.resetSection = resetSection;
window.loadCrewCredentials = loadCrewCredentials;
window.saveCrewCredential = saveCrewCredential;
window.setUserMode = setUserMode;
window.runOfflineCheck = runOfflineCheck;
window.createOfflineBackup = createOfflineBackup;
window.restoreOfflineBackup = restoreOfflineBackup;
window.addVaccineType = addVaccineType;
window.removeVaccineType = removeVaccineType;
window.moveVaccineType = moveVaccineType;
window.addPharmacyLabel = addPharmacyLabel;
window.removePharmacyLabel = removePharmacyLabel;
window.movePharmacyLabel = movePharmacyLabel;
