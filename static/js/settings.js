// Settings and configuration management

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
    user_mode: "user"
};

let settingsDirty = false;
let settingsLoaded = false;
let settingsAutoSaveTimer = null;

function setUserMode(mode) {
    const body = document.body;
    const normalized = ['advanced', 'developer'].includes((mode || '').toLowerCase()) ? mode.toLowerCase() : 'user';
    body.classList.remove('mode-user', 'mode-advanced', 'mode-developer');
    body.classList.add(`mode-${normalized}`);
}

function applySettingsToUI(data = {}) {
    const merged = { ...DEFAULT_SETTINGS, ...(data || {}) };
    Object.keys(merged).forEach(k => {
        const el = document.getElementById(k);
        if (el) {
            el.value = merged[k];
        }
    });
    setUserMode(merged.user_mode);
    settingsDirty = false;
    settingsLoaded = true;
}

if (document.readyState !== 'loading') {
    loadSettingsUI().catch(() => {});
    bindSettingsDirtyTracking();
} else {
    document.addEventListener('DOMContentLoaded', () => {
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
            }
        });
        el.addEventListener('change', () => {
            settingsDirty = true;
            scheduleAutoSave('input-change');
            if (el.id === 'user_mode') {
                setUserMode(el.value);
            }
        });
    });
}

async function loadSettingsUI() {
    console.log('[settings] loadSettingsUI called');
    try {
        const res = await fetch('/api/data/settings', { credentials: 'same-origin' });
        console.log('[settings] fetch response status:', res.status);
        if (!res.ok) throw new Error(`Settings load failed (${res.status})`);
        const s = await res.json();
        console.log('[settings] loaded settings:', s);
        applySettingsToUI(s);
        console.log('[settings] settings applied to UI');
    } catch (err) {
        console.error('[settings] load error', err);
        alert(`Unable to load settings: ${err.message}`);
        applySettingsToUI(DEFAULT_SETTINGS);
    }
}

function updateSettingsStatus(message, isError = false) {
    const el = document.getElementById('settings-save-status');
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? 'var(--red)' : '#2c3e50';
}

function scheduleAutoSave(reason = 'auto') {
    if (settingsAutoSaveTimer) clearTimeout(settingsAutoSaveTimer);
    settingsAutoSaveTimer = setTimeout(() => saveSettings(false, reason), 800);
}

async function saveSettings(showAlert = true, reason = 'manual') {
    try {
        const s = {};
        const numeric = new Set(['tr_temp','tr_tok','tr_p','in_temp','in_tok','in_p','rep_penalty']);
        ['triage_instruction','inquiry_instruction','tr_temp','tr_tok','tr_p','in_temp','in_tok','in_p','mission_context','rep_penalty','user_mode'].forEach(k => {
            const el = document.getElementById(k);
            if (!el) return;
            const val = el.value;
            if (numeric.has(k)) {
                const num = val === '' ? '' : Number(val);
                s[k] = Number.isFinite(num) ? num : DEFAULT_SETTINGS[k];
            } else {
                s[k] = val;
            }
        });
        console.log('[settings] saving', { reason, payload: s });
        updateSettingsStatus('Saving…', false);
        const res = await fetch('/api/data/settings', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
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
        applySettingsToUI(updated);
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
    }
    saveSettings();
}

function renderOfflineStatus(msg, isError = false) {
    const box = document.getElementById('offline-status');
    if (!box) return;
    box.style.color = isError ? 'var(--red)' : '#2c3e50';
    box.innerHTML = msg;
}

async function runOfflineCheck() {
    renderOfflineStatus('Checking offline requirements…');
    try {
        const res = await fetch('/api/offline/check', { credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
        const modelLines = (data.models || []).map(m => {
            return `${m.model}: ${m.cached ? 'Cached ✅' : 'Missing ❌'}`;
        }).join('<br>');
        const env = data.env || {};
        const envLines = Object.entries(env).map(([k,v]) => `${k}: ${v || 'unset'}`).join('<br>');
        renderOfflineStatus(
            `<strong>Models</strong><br>${modelLines || 'None'}<br><br>` +
            `<strong>Env</strong><br>${envLines}<br><br>` +
            `<strong>Cache</strong><br>${data.cache_dir || ''}`
        );
    } catch (err) {
        renderOfflineStatus(`Error: ${err.message}`, true);
    }
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

// Load crew credentials list
async function loadCrewCredentials() {
    const container = document.getElementById('crew-credentials');
    if (!container) return;
    container.innerHTML = 'Loading crew...';
    try {
        const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
        if (!data || data.length === 0) {
            container.innerHTML = '<div style="color:#666;">No crew members found.</div>';
            return;
        }
        const hasCreds = data.some(p => p.username || p.password);
        if (!hasCreds) {
            container.innerHTML = '<div style="color:#666;">No credentials assigned yet. To enable username/password login per crew, assign them below.</div>' +
                data.map(p => `
                    <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                        <div style="min-width:180px; font-weight:bold;">${p.firstName || ''} ${p.lastName || p.name || ''}</div>
                        <input type="text" id="cred-user-${p.id}" value="${p.username || ''}" placeholder="Username" style="padding:8px; flex:1; min-width:140px;">
                        <input type="text" id="cred-pass-${p.id}" value="${p.password || ''}" placeholder="Password" style="padding:8px; flex:1; min-width:140px;">
                        <button class="btn btn-sm" style="background:var(--inquiry);" onclick="saveCrewCredential('${p.id}')">Save</button>
                    </div>
                `).join('');
            return;
        }
        container.innerHTML = data.map(p => `
            <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                <div style="min-width:180px; font-weight:bold;">${p.firstName || ''} ${p.lastName || p.name || ''}</div>
                <input type="text" id="cred-user-${p.id}" value="${p.username || ''}" placeholder="Username" style="padding:8px; flex:1; min-width:140px;">
                <input type="text" id="cred-pass-${p.id}" value="${p.password || ''}" placeholder="Password" style="padding:8px; flex:1; min-width:140px;">
                <button class="btn btn-sm" style="background:var(--inquiry);" onclick="saveCrewCredential('${p.id}')">Save</button>
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = `<div style="color:red;">Error loading crew: ${err.message}</div>`;
    }
}

// Save a single crew credential
async function saveCrewCredential(id) {
    const userEl = document.getElementById(`cred-user-${id}`);
    const passEl = document.getElementById(`cred-pass-${id}`);
    if (!userEl || !passEl) return;
    try {
        const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
        const patient = data.find(p => p.id === id);
        if (!patient) throw new Error('Crew member not found');
        patient.username = userEl.value;
        patient.password = passEl.value;
        const res = await fetch('/api/data/patients', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data), credentials:'same-origin'});
        if (!res.ok) throw new Error(res.statusText || 'Save failed');
        alert('Saved credentials for crew member.');
    } catch (err) {
        alert(`Failed to save credentials: ${err.message}`);
    }
}

// Expose functions to window for inline onclick handlers
window.saveSettings = saveSettings;
window.resetSection = resetSection;
window.loadCrewCredentials = loadCrewCredentials;
window.saveCrewCredential = saveCrewCredential;
window.setUserMode = setUserMode;
window.runOfflineCheck = runOfflineCheck;
window.createOfflineBackup = createOfflineBackup;
