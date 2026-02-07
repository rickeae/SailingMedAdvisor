/*
File: static/js/settings.js
Author notes: Application configuration management and settings UI controller.

Key Responsibilities:
- Application settings persistence (prompts, model parameters)
- User mode management (user/advanced/developer visibility levels)
- Offline mode configuration and model caching
- Dynamic list management (vaccine types, pharmacy labels)
- Crew login credentials management
- Auto-save with debouncing
- Live status indicators in section headers
- Default dataset export/import

Settings Architecture:
---------------------
Settings are stored in settings.json on the backend and cached in window.CACHED_SETTINGS
on the frontend. Auto-save triggers 800ms after user input to minimize write operations.

User Modes:
1. USER MODE (Default): Simplified interface, hides advanced configuration
   - Basic prompts visible
   - Simple status indicators
   - Essential functionality only

2. ADVANCED MODE: Shows model parameters and detailed configuration
   - Temperature, token limits, top-p visible
   - Detailed status with metrics
   - Import/export features
   - Sample test cases

3. DEVELOPER MODE: Full debugging and development features
   - All dev-tag elements visible
   - Raw data views
   - Debug logging
   - Developer-only sections

Offline Mode System:
-------------------
Enables complete offline operation for remote sailing:

1. Model Caching:
   - medgemma-1.5-4b-it (primary triage/inquiry model)
   - medgemma-27b-text-it (advanced model for complex cases)
   - (No photo/OCR models required)

2. Environment Flags:
   - HF_HUB_OFFLINE=1: Disables Hugging Face Hub connectivity checks
   - TRANSFORMERS_OFFLINE=1: Prevents transformer model downloads

3. Workflow:
   - While online: Download all required models
   - Before departure: Create cache backup
   - At sea: Enable offline flags, verify cache status
   - If corruption: Restore from backup

4. Cache Management:
   - Check cache status: Verifies all models present
   - Download missing: Fetches any missing models (requires internet)
   - Backup cache: Creates timestamped backup
   - Restore backup: Recovers from latest backup

Dynamic Lists:
-------------
Vaccine types and pharmacy labels are user-customizable lists that populate
dropdowns throughout the application. Changes sync immediately across all modules.

- Vaccine Types: Used in crew.js for vaccine record tracking
- Pharmacy Labels: Used in pharmacy.js for medication categorization
- Duplicate prevention and normalization on save
- Reorderable with up/down buttons

Crew Credentials:
----------------
Allows setting per-crew-member login credentials for future multi-user support.
Currently informational, will enable authentication in future releases.

Data Flow:
- Settings: /api/data/settings (settings.json)
- Crew Credentials: /api/crew/credentials
- Offline Status: /api/offline/check, /api/offline/ensure
- Default Export: /api/default/export

Integration Points:
- pharmacy.js: Pharmacy labels
- crew.js: Vaccine types
- chat.js: Triage/inquiry prompts, model parameters
- main.js: User mode visibility, initialization
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
    resource_injection_mode: "category_counts",
    last_prompt_verbatim: "",
    vaccine_types: ["MMR", "DTaP", "HepB", "HepA", "Td/Tdap", "Influenza", "COVID-19"],
    pharmacy_labels: ["Antibiotic", "Analgesic", "Cardiac", "Respiratory", "Gastrointestinal", "Endocrine", "Emergency"],
    equipment_categories: [
        "Diagnostics & monitoring",
        "Instruments & tools",
        "Airway & breathing",
        "Splints & supports",
        "Eye care",
        "Dental",
        "PPE",
        "Survival & utility",
        "Other"
    ],
    consumable_categories: [
        "Wound care & dressings",
        "Burn care",
        "Antiseptics & hygiene",
        "Irrigation & syringes",
        "Splints & supports",
        "PPE",
        "Survival & utility",
        "Other"
    ],
    offline_force_flags: false
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let settingsDirty = false;           // Track unsaved changes
let settingsLoaded = false;          // Prevent premature saves during init
let settingsAutoSaveTimer = null;    // Debounce timer for auto-save
let offlineStatusCache = null;       // Cached offline status for UI updates
let vaccineTypeList = [...DEFAULT_SETTINGS.vaccine_types];   // Active vaccine types
let pharmacyLabelList = [...DEFAULT_SETTINGS.pharmacy_labels]; // Active pharmacy labels
let equipmentCategoryList = [...DEFAULT_SETTINGS.equipment_categories];
let consumableCategoryList = [...DEFAULT_SETTINGS.consumable_categories];
let offlineInitialized = false;     // Prevent duplicate offline checks

/**
 * Set application user mode and update visibility.
 * 
 * User Mode Behaviors:
 * - USER: Simple interface, essential features only
 * - ADVANCED: Model parameters, detailed metrics, import/export
 * - DEVELOPER: Full debugging, all dev-tag elements, raw data views
 * 
 * UI Changes:
 * 1. Adds/removes mode-specific classes to body and html
 * 2. Shows/hides .developer-only elements
 * 3. Shows/hides .dev-tag elements
 * 4. Updates triage sample inline visibility
 * 5. Refreshes settings meta badges
 * 6. Persists to localStorage
 * 
 * Triggered By:
 * - Settings form user_mode select change
 * - Page load (from localStorage or server)
 * - Reset section
 * 
 * @param {string} mode - 'user', 'advanced', or 'developer'
 */
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

/**
 * Update live status badges in settings section headers.
 * 
 * Status Badges Display:
 * - Offline meta: Cached model count or online/offline mode
 * - Vaccine meta: Number of vaccine types configured
 * - Pharmacy meta: Number of user labels defined
 * - User mode meta: Current visibility mode
 * - Model meta: Token limits (advanced mode only)
 * 
 * Advanced Mode Differences:
 * Shows detailed technical info (token counts, model names) instead
 * of simplified summaries.
 * 
 * Called After:
 * - Settings load/save
 * - User mode change
 * - List modifications (vaccine types, pharmacy labels)
 * - Offline status updates
 * 
 * @param {Object} settings - Current settings object
 */
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
    // Equipment categories
    const equipCatEl = document.getElementById('equipment-cat-meta');
    if (equipCatEl) equipCatEl.textContent = `${equipmentCategoryList.length} categories`;
    // Consumable categories
    const consCatEl = document.getElementById('consumable-cat-meta');
    if (consCatEl) consCatEl.textContent = `${consumableCategoryList.length} categories`;
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

/**
 * Update crew credentials count badge.
 * 
 * Shows how many crew members have configured login credentials.
 * 
 * @param {number} count - Number of crew with credentials
 */
function updateCrewCredMeta(count) {
    const el = document.getElementById('crew-creds-meta');
    if (el) el.textContent = `${count} credentialed`;
}

/**
 * Apply settings data to UI form fields.
 * 
 * Application Process:
 * 1. Merges with defaults (fills missing fields)
 * 2. Normalizes vaccine types and pharmacy labels
 * 3. Renders dynamic lists
 * 4. Populates form inputs (text, number, checkbox, select)
 * 5. Sets user mode and updates visibility
 * 6. Caches in window.CACHED_SETTINGS
 * 7. Updates status badges
 * 8. Clears dirty flag
 * 
 * Field Type Handling:
 * - Checkbox: Sets checked property
 * - Others: Sets value property
 * 
 * Called By:
 * - loadSettingsUI (on page load)
 * - saveSettings (after successful save)
 * - Reset functions
 * 
 * @param {Object} data - Settings object from server or defaults
 */
function applySettingsToUI(data = {}) {
    const merged = { ...DEFAULT_SETTINGS, ...(data || {}) };
    vaccineTypeList = normalizeVaccineTypes(merged.vaccine_types);
    pharmacyLabelList = normalizePharmacyLabels(merged.pharmacy_labels);
    equipmentCategoryList = normalizeEquipmentCategories(merged.equipment_categories);
    consumableCategoryList = normalizeConsumableCategories(merged.consumable_categories);
    renderVaccineTypes();
    renderPharmacyLabels();
    renderEquipmentCategories();
    renderConsumableCategories();
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

/**
 * Bind change/input handlers to all settings form fields.
 * 
 * Tracking Strategy:
 * - Listens to both 'input' (typing) and 'change' (select, checkbox)
 * - Sets settingsDirty flag immediately
 * - Schedules auto-save (800ms debounce)
 * - Special handling for user_mode (immediate save)
 * - Updates status badges on change
 * 
 * Uses dataset flag to prevent duplicate binding.
 * 
 * Special Cases:
 * - user_mode: Immediate save + visibility update
 * - developer-only fields: Trigger mode refresh
 * 
 * Called On:
 * - DOMContentLoaded
 * - After dynamic content updates
 */
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

/**
 * Load settings from server and apply to UI.
 * 
 * Loading Flow:
 * 1. Fetches from /api/data/settings
 * 2. Applies to UI form fields
 * 3. Persists user_mode to localStorage
 * 4. Initializes offline check (first load only)
 * 5. Updates all status badges
 * 
 * Fallback Behavior:
 * If server load fails:
 * - Applies DEFAULT_SETTINGS
 * - Restores user_mode from localStorage
 * - Shows error alert
 * 
 * Offline Check:
 * On first load (offlineInitialized=false), automatically runs offline
 * status check to populate cache status. Subsequent loads skip this.
 * 
 * Called On:
 * - DOMContentLoaded
 * - Page initialization
 * - After applying stored user mode
 */
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

/**
 * Update settings save status indicator.
 * 
 * Shows:
 * - "Saving…" during save operation
 * - "Saved at [time]" on success
 * - "Save error: [message]" on failure
 * 
 * @param {string} message - Status message to display
 * @param {boolean} isError - If true, shows in red
 */
function updateSettingsStatus(message, isError = false) {
    const el = document.getElementById('settings-save-status');
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? 'var(--red)' : '#2c3e50';
}

/**
 * Apply user mode from localStorage on page load.
 * 
 * Ensures user mode persists across sessions before settings fully load.
 * Falls back to 'user' if localStorage unavailable or empty.
 */
function applyStoredUserMode() {
    try {
        const stored = localStorage.getItem('user_mode') || 'user';
        setUserMode(stored);
    } catch (err) { /* ignore */ }
}

/**
 * Schedule debounced auto-save of settings.
 * 
 * Debounce Period: 800ms
 * 
 * Prevents excessive save requests during rapid user input (typing,
 * slider adjustments). Each new input resets the timer.
 * 
 * @param {string} reason - Reason for save (for logging)
 */
function scheduleAutoSave(reason = 'auto') {
    if (settingsAutoSaveTimer) clearTimeout(settingsAutoSaveTimer);
    settingsAutoSaveTimer = setTimeout(() => saveSettings(false, reason), 800);
}

/**
 * Save settings to server with validation and side effects.
 * 
 * Save Process:
 * 1. Collects form values
 * 2. Validates and normalizes numeric fields
 * 3. Includes vaccine types and pharmacy labels
 * 4. POSTs to /api/data/settings
 * 5. Applies returned settings to UI
 * 6. Persists user_mode to localStorage
 * 7. Clears dirty flag
 * 8. Updates status indicator
 * 9. Triggers prompt preview refresh (if applicable)
 * 
 * Numeric Fields:
 * Validated and coerced to numbers. Falls back to defaults if invalid.
 * Includes: tr_temp, tr_tok, tr_p, in_temp, in_tok, in_p, rep_penalty
 * 
 * Side Effects:
 * - Updates window.CACHED_SETTINGS
 * - Triggers refreshPromptPreview() in chat.js (if prompt not manually edited)
 * - Updates all status meta badges
 * - Shows success/error in status indicator
 * 
 * User Mode Preservation:
 * Preserves locally selected user_mode over server echo to prevent flicker
 * if server has stale data.
 * 
 * @param {boolean} showAlert - Show success/error alert dialog
 * @param {string} reason - Reason for save (for logging and debugging)
 */
async function saveSettings(showAlert = true, reason = 'manual') {
    try {
        const s = {};
        const numeric = new Set(['tr_temp','tr_tok','tr_p','in_temp','in_tok','in_p','rep_penalty']);
        ['triage_instruction','inquiry_instruction','tr_temp','tr_tok','tr_p','in_temp','in_tok','in_p','mission_context','rep_penalty','user_mode','resource_injection_mode'].forEach(k => {
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
        s.equipment_categories = normalizeEquipmentCategories(equipmentCategoryList);
        s.consumable_categories = normalizeConsumableCategories(consumableCategoryList);
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
        const merged = {
            ...updated,
            user_mode: s.user_mode || updated.user_mode,
            vaccine_types: s.vaccine_types || updated.vaccine_types,
            pharmacy_labels: s.pharmacy_labels || updated.pharmacy_labels,
            equipment_categories: s.equipment_categories || updated.equipment_categories,
            consumable_categories: s.consumable_categories || updated.consumable_categories
        };
        applySettingsToUI(merged);
        try { localStorage.setItem('user_mode', updated.user_mode || 'user'); } catch (err) { /* ignore */ }
        settingsDirty = false;
        updateSettingsStatus(`Saved at ${new Date().toLocaleTimeString()}`);
        if (showAlert) {
            alert("Configuration synchronized.");
        }
        if (typeof refreshPromptPreview === 'function') {
            refreshPromptPreview();
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

/**
 * Reset a settings section to default values.
 * 
 * Sections:
 * - 'triage': Triage prompt and parameters (temp, tokens, top-p)
 * - 'inquiry': Inquiry prompt and parameters
 * - 'mission': Mission context description
 * 
 * Immediately saves after reset to persist changes.
 * 
 * @param {string} section - Section identifier
 */
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

/**
 * Normalize and deduplicate vaccine types list.
 * 
 * Normalization:
 * 1. Ensures array (falls back to defaults if not)
 * 2. Converts all items to trimmed strings
 * 3. Filters empty strings
 * 4. Removes case-insensitive duplicates
 * 5. Preserves original case of first occurrence
 * 
 * Use Cases:
 * - After loading from server
 * - After user adds/removes types
 * - Before saving to server
 * 
 * @param {Array} list - Raw vaccine types array
 * @returns {Array<string>} Normalized unique vaccine types
 */
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

/**
 * Render vaccine types list with management controls.
 * 
 * Displays:
 * - Numbered list of vaccine types
 * - Up/Down buttons for reordering (disabled at boundaries)
 * - Remove button for each type
 * - Empty state message if no types
 * 
 * Button States:
 * - First item: Up button disabled
 * - Last item: Down button disabled
 * - Remove always enabled
 * 
 * Called After:
 * - Settings load
 * - Add/remove/reorder operations
 */
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

/**
 * Add new vaccine type from input field.
 * 
 * Validation:
 * - Requires non-empty trimmed value
 * - Duplicate prevention via normalization
 * 
 * Process:
 * 1. Gets value from input
 * 2. Validates non-empty
 * 3. Appends to list
 * 4. Normalizes (deduplicates)
 * 5. Clears input
 * 6. Re-renders list
 * 7. Marks dirty + schedules auto-save
 * 
 * Side Effects:
 * - Updates crew.js vaccine dropdowns (via settings sync)
 * - Auto-saves after 800ms
 */
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

/**
 * Remove vaccine type by index.
 * 
 * Process:
 * 1. Validates index bounds
 * 2. Splices from array
 * 3. Normalizes remaining types
 * 4. Re-renders list
 * 5. Marks dirty + schedules auto-save
 * 
 * @param {number} idx - Index to remove
 */
function removeVaccineType(idx) {
    if (idx < 0 || idx >= vaccineTypeList.length) return;
    vaccineTypeList.splice(idx, 1);
    vaccineTypeList = normalizeVaccineTypes(vaccineTypeList);
    renderVaccineTypes();
    settingsDirty = true;
    scheduleAutoSave('vaccine-type-remove');
}

/**
 * Reorder vaccine type (move up or down).
 * 
 * Reordering Logic:
 * - delta=-1: Move up (earlier in list)
 * - delta=+1: Move down (later in list)
 * - Validates destination index is in bounds
 * 
 * Process:
 * 1. Calculates new index
 * 2. Validates bounds
 * 3. Removes item from old position
 * 4. Inserts at new position
 * 5. Normalizes list
 * 6. Re-renders
 * 7. Marks dirty + schedules auto-save
 * 
 * @param {number} idx - Current index
 * @param {number} delta - Direction (-1=up, +1=down)
 */
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

/**
 * Normalize and deduplicate pharmacy labels list.
 * 
 * Identical logic to normalizeVaccineTypes but for pharmacy labels.
 * Ensures unique, non-empty, trimmed labels with case-insensitive
 * duplicate detection.
 * 
 * @param {Array} list - Raw pharmacy labels array
 * @returns {Array<string>} Normalized unique labels
 */
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

/**
 * Render pharmacy labels list with management controls.
 * 
 * Displays:
 * - Numbered list of labels
 * - Up/Down reorder buttons
 * - Remove button
 * - Empty state if no labels
 * 
 * Side Effects:
 * - Updates window.CACHED_SETTINGS.pharmacy_labels
 * - Triggers refreshPharmacyLabelsFromSettings() in pharmacy.js
 *   to sync label dropdowns across medication forms
 * 
 * Integration:
 * Any changes immediately propagate to:
 * - New medication form label dropdown
 * - Existing medication label fields
 * - Pharmacy filter/sort options
 */
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

/**
 * Add new pharmacy label from input field.
 * 
 * Identical flow to addVaccineType but for pharmacy labels.
 * Validates, normalizes, renders, and auto-saves.
 */
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

/**
 * Remove pharmacy label by index.
 * 
 * @param {number} idx - Index to remove
 */
function removePharmacyLabel(idx) {
    if (idx < 0 || idx >= pharmacyLabelList.length) return;
    pharmacyLabelList.splice(idx, 1);
    pharmacyLabelList = normalizePharmacyLabels(pharmacyLabelList);
    renderPharmacyLabels();
    settingsDirty = true;
    scheduleAutoSave('pharmacy-label-remove');
}

/**
 * Reorder pharmacy label (move up or down).
 * 
 * @param {number} idx - Current index
 * @param {number} delta - Direction (-1=up, +1=down)
 */
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

// ============================================================================
// Equipment category settings
// ============================================================================

function normalizeEquipmentCategories(list) {
    if (!Array.isArray(list)) return [...DEFAULT_SETTINGS.equipment_categories];
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

function renderEquipmentCategories() {
    const container = document.getElementById('equipment-categories-list');
    if (!container) return;
    if (!equipmentCategoryList.length) {
        container.innerHTML = '<div style="color:#666; font-size:12px;">No equipment categories defined.</div>';
        updateSettingsMeta(window.CACHED_SETTINGS || {});
        return;
    }
    container.innerHTML = equipmentCategoryList
        .map((v, idx) => `
            <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid #eee;">
                <div style="width:28px; text-align:right; font-weight:700; color:#666;">${idx + 1}.</div>
                <div style="flex:1; font-weight:600;">${v}</div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <button class="btn btn-sm" style="background:#607d8b;" ${idx === 0 ? 'disabled' : ''} onclick="moveEquipmentCategory(${idx}, -1)">Up</button>
                    <button class="btn btn-sm" style="background:#607d8b;" ${idx === equipmentCategoryList.length - 1 ? 'disabled' : ''} onclick="moveEquipmentCategory(${idx}, 1)">Down</button>
                    <button class="btn btn-sm" style="background:var(--red);" onclick="removeEquipmentCategory(${idx})">Remove</button>
                </div>
            </div>
        `).join('');
    window.CACHED_SETTINGS = window.CACHED_SETTINGS || {};
    window.CACHED_SETTINGS.equipment_categories = [...equipmentCategoryList];
    if (typeof window.refreshEquipmentCategoriesFromSettings === 'function') {
        window.refreshEquipmentCategoriesFromSettings(equipmentCategoryList, consumableCategoryList);
    }
    updateSettingsMeta(window.CACHED_SETTINGS || {});
}

function addEquipmentCategory() {
    const input = document.getElementById('equipment-category-input');
    if (!input) return;
    const val = input.value.trim();
    if (!val) {
        alert('Enter a category before adding.');
        return;
    }
    equipmentCategoryList = normalizeEquipmentCategories([...equipmentCategoryList, val]);
    input.value = '';
    renderEquipmentCategories();
    settingsDirty = true;
    scheduleAutoSave('equipment-category-add');
}

function removeEquipmentCategory(idx) {
    if (idx < 0 || idx >= equipmentCategoryList.length) return;
    equipmentCategoryList.splice(idx, 1);
    equipmentCategoryList = normalizeEquipmentCategories(equipmentCategoryList);
    renderEquipmentCategories();
    settingsDirty = true;
    scheduleAutoSave('equipment-category-remove');
}

function moveEquipmentCategory(idx, delta) {
    const newIndex = idx + delta;
    if (newIndex < 0 || newIndex >= equipmentCategoryList.length) return;
    const nextList = [...equipmentCategoryList];
    const [item] = nextList.splice(idx, 1);
    nextList.splice(newIndex, 0, item);
    equipmentCategoryList = normalizeEquipmentCategories(nextList);
    renderEquipmentCategories();
    settingsDirty = true;
    scheduleAutoSave('equipment-category-reorder');
}

// ============================================================================
// Consumable category settings
// ============================================================================

function normalizeConsumableCategories(list) {
    if (!Array.isArray(list)) return [...DEFAULT_SETTINGS.consumable_categories];
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

function renderConsumableCategories() {
    const container = document.getElementById('consumable-categories-list');
    if (!container) return;
    if (!consumableCategoryList.length) {
        container.innerHTML = '<div style="color:#666; font-size:12px;">No consumable categories defined.</div>';
        updateSettingsMeta(window.CACHED_SETTINGS || {});
        return;
    }
    container.innerHTML = consumableCategoryList
        .map((v, idx) => `
            <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid #eee;">
                <div style="width:28px; text-align:right; font-weight:700; color:#666;">${idx + 1}.</div>
                <div style="flex:1; font-weight:600;">${v}</div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <button class="btn btn-sm" style="background:#607d8b;" ${idx === 0 ? 'disabled' : ''} onclick="moveConsumableCategory(${idx}, -1)">Up</button>
                    <button class="btn btn-sm" style="background:#607d8b;" ${idx === consumableCategoryList.length - 1 ? 'disabled' : ''} onclick="moveConsumableCategory(${idx}, 1)">Down</button>
                    <button class="btn btn-sm" style="background:var(--red);" onclick="removeConsumableCategory(${idx})">Remove</button>
                </div>
            </div>
        `).join('');
    window.CACHED_SETTINGS = window.CACHED_SETTINGS || {};
    window.CACHED_SETTINGS.consumable_categories = [...consumableCategoryList];
    if (typeof window.refreshEquipmentCategoriesFromSettings === 'function') {
        window.refreshEquipmentCategoriesFromSettings(equipmentCategoryList, consumableCategoryList);
    }
    updateSettingsMeta(window.CACHED_SETTINGS || {});
}

function addConsumableCategory() {
    const input = document.getElementById('consumable-category-input');
    if (!input) return;
    const val = input.value.trim();
    if (!val) {
        alert('Enter a category before adding.');
        return;
    }
    consumableCategoryList = normalizeConsumableCategories([...consumableCategoryList, val]);
    input.value = '';
    renderConsumableCategories();
    settingsDirty = true;
    scheduleAutoSave('consumable-category-add');
}

function removeConsumableCategory(idx) {
    if (idx < 0 || idx >= consumableCategoryList.length) return;
    consumableCategoryList.splice(idx, 1);
    consumableCategoryList = normalizeConsumableCategories(consumableCategoryList);
    renderConsumableCategories();
    settingsDirty = true;
    scheduleAutoSave('consumable-category-remove');
}

function moveConsumableCategory(idx, delta) {
    const newIndex = idx + delta;
    if (newIndex < 0 || newIndex >= consumableCategoryList.length) return;
    const nextList = [...consumableCategoryList];
    const [item] = nextList.splice(idx, 1);
    nextList.splice(newIndex, 0, item);
    consumableCategoryList = normalizeConsumableCategories(nextList);
    renderConsumableCategories();
    settingsDirty = true;
    scheduleAutoSave('consumable-category-reorder');
}

/**
 * Render offline status message in settings UI.
 * 
 * Shows:
 * - Check progress messages
 * - Download status with elapsed time
 * - Cache status summary
 * - Error messages
 * 
 * @param {string} msg - HTML message to display
 * @param {boolean} isError - If true, shows in red
 */
function renderOfflineStatus(msg, isError = false) {
    const box = document.getElementById('offline-status');
    if (!box) return;
    box.style.color = isError ? 'var(--red)' : '#2c3e50';
    box.innerHTML = msg;
}

/**
 * Enable/disable offline operation buttons.
 * 
 * Disables during async operations (checking, downloading, backing up)
 * to prevent concurrent operations that could corrupt cache.
 * 
 * Affected Buttons:
 * - offline-flag-btn: Toggle offline flags
 * - offline-download-btn: Download missing models
 * - offline-check-btn: Check cache status
 * - offline-backup-btn: Create backup
 * - offline-restore-btn: Restore from backup
 * 
 * @param {boolean} enabled - True to enable, false to disable
 */
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

/**
 * Create timestamped backup of model cache.
 * 
 * Backup Process:
 * 1. Calls /api/offline/backup (POST)
 * 2. Backend creates tar.gz of cache directory
 * 3. Stores with timestamp in filename
 * 4. Returns backup filename
 * 
 * Use Cases:
 * - Before going offline (insurance against corruption)
 * - After successful model downloads
 * - Before major updates
 * 
 * Recovery:
 * Use restoreOfflineBackup() to restore from latest backup.
 */
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

/**
 * Restore model cache from latest backup.
 * 
 * Restoration Process:
 * 1. Calls /api/offline/restore (POST)
 * 2. Backend finds latest .tar.gz backup
 * 3. Extracts to cache directory (overwrites existing)
 * 4. Returns restored backup filename
 * 
 * Alerts user to reload app after restoration to clear in-memory caches.
 * 
 * Use Cases:
 * - Cache corruption detected
 * - Models mysteriously missing after system update
 * - Rollback after failed manual modifications
 */
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

/**
 * Format offline status data into HTML display.
 * 
 * Display Sections:
 * 1. Models: List with cache status (Cached ✅ / Missing ❌)
 * 2. Environment: HF_HUB_OFFLINE, TRANSFORMERS_OFFLINE flags
 * 3. Cache: Cache directory path
 * 4. Status Note: Missing models count or success message
 * 5. Offline Flags: Warning if not set for offline operation
 * 6. Disk Space: Free/total space for cache directory
 * 7. How-To: Step-by-step offline preparation instructions
 * 
 * Required Models:
 * - medgemma-1.5-4b-it: Primary chat model
 * - medgemma-27b-text-it: Advanced model (optional but recommended)
 * - (No photo/OCR model required)
 * 
 * @param {Object} data - Offline status from /api/offline/check
 * @returns {string} Formatted HTML
 */
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
<strong>Required models:</strong> medgemma-1.5-4b-it, medgemma-27b-text-it.
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

/**
 * Update offline flag toggle button text and style.
 * 
 * Button States:
 * - Offline mode ON: "Disable offline flags" (gray background)
 * - Offline mode OFF: "Enable offline flags" (orange/warning background)
 * 
 * Also syncs checkbox state with cache status.
 */
function updateOfflineFlagButton() {
    const btn = document.getElementById('offline-flag-btn');
    const chk = document.getElementById('offline-force-flags');
    if (!btn) return;
    const offline = offlineStatusCache ? !!offlineStatusCache.offline_mode : false;
    btn.textContent = offline ? 'Disable offline flags' : 'Enable offline flags';
    btn.style.background = offline ? '#555' : '#b26a00';
    if (chk) chk.checked = offlineStatusCache ? !!(offlineStatusCache.env?.HF_HUB_OFFLINE === '1' || offlineStatusCache.offline_mode || DEFAULT_SETTINGS.offline_force_flags) : !!DEFAULT_SETTINGS.offline_force_flags;
}

/**
 * Check offline readiness or download missing models.
 * 
 * Two Modes:
 * 1. downloadMissing=false: Check only (GET /api/offline/check)
 *    - Verifies model presence
 *    - Checks environment flags
 *    - Reports disk space
 *    - Fast operation
 * 
 * 2. downloadMissing=true: Download + Check (POST /api/offline/ensure)
 *    - Downloads any missing models from Hugging Face
 *    - Shows progress spinner with elapsed time
 *    - Can take minutes for large models
 *    - Requires internet connection
 * 
 * Download Behavior:
 * - Skips download if offline flags enabled (shows warning)
 * - Downloads to HF_HOME cache directory
 * - Verifies integrity after download
 * - Updates status with completion message
 * 
 * UI Updates:
 * - Disables buttons during operation
 * - Shows spinner for downloads
 * - Updates cache status display
 * - Refreshes meta badges
 * 
 * Called By:
 * - Settings page load (check only, first time)
 * - "Check cache status" button (check only)
 * - "Download missing models" button (download mode)
 * 
 * @param {boolean} downloadMissing - If true, downloads missing models
 */
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

/**
 * Toggle offline environment flags.
 * 
 * Flags Controlled:
 * - HF_HUB_OFFLINE: Prevents Hugging Face Hub connectivity checks
 * - TRANSFORMERS_OFFLINE: Blocks transformer library from downloading
 * 
 * Toggle Logic:
 * - If forceEnable specified: Sets to that value
 * - Otherwise: Toggles opposite of current state
 * 
 * Backend Implementation:
 * Sets environment variables in app process. May require app restart
 * in some deployment scenarios.
 * 
 * Use Cases:
 * - Enable before going offline (after downloads complete)
 * - Disable when returning to port (to allow updates)
 * 
 * @param {boolean} forceEnable - Optional explicit enable/disable
 */
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

/**
 * Export default demo dataset to workspace.
 * 
 * Exports:
 * - Sample crew members with medical histories
 * - Example medications
 * - Triage test cases
 * - Sample chat history
 * 
 * Use Cases:
 * - New workspace initialization
 * - Testing after database corruption
 * - Demo/training scenarios
 * - Reference data restoration
 * 
 * Warns Before Overwrite:
 * Existing data may be overwritten. Backup first if needed.
 */
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

/**
 * Load and render crew credentials management UI.
 * 
 * Display:
 * - Lists all crew members
 * - Shows username/password inputs for each
 * - Auto-saves on input (400ms debounce)
 * - Shows save status per crew member
 * 
 * Credentials Purpose:
 * Future feature for per-crew-member authentication. Currently stored
 * but not enforced for login.
 * 
 * Integration:
 * Loads crew from /api/data/patients (same as crew.js)
 * Saves credentials to /api/crew/credentials
 * 
 * Called By:
 * - Settings page load
 * - Crew credentials section expansion
 */
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

/**
 * Save login credentials for a single crew member.
 * 
 * Save Process:
 * 1. Collects username and password from inputs
 * 2. POSTs to /api/crew/credentials
 * 3. Updates status indicator
 * 4. Clears status after 1.5s
 * 
 * Debounced via debouncedSaveCred (400ms) to prevent save spam
 * during typing.
 * 
 * @param {string} id - Crew member ID
 */
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

/**
 * Debounce wrapper for crew credential saves.
 * 
 * Debounce Period: 400ms
 * 
 * Each crew member has independent timer to allow editing multiple
 * crew credentials simultaneously without interference.
 * 
 * @param {string} id - Crew member ID
 */
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
window.addEquipmentCategory = addEquipmentCategory;
window.removeEquipmentCategory = removeEquipmentCategory;
window.moveEquipmentCategory = moveEquipmentCategory;
window.addConsumableCategory = addConsumableCategory;
window.removeConsumableCategory = removeConsumableCategory;
window.moveConsumableCategory = moveConsumableCategory;
