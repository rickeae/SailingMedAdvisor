/* =============================================================================
 * Author: Rick Escher
 * Project: SailingMedAdvisor
 * Context: Google HAI-DEF Framework
 * Models: Google MedGemmas
 * Program: Kaggle Impact Challenge
 * ========================================================================== */
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
    tr_k: 50,
    in_temp: 0.6,
    in_tok: 2048,
    in_p: 0.95,
    in_k: 50,
    mission_context: "Isolated Medical Station offshore.",
    rep_penalty: 1.1,
    user_mode: "user",
    last_prompt_verbatim: "",
    vaccine_types: ["MMR", "DTaP", "HepB", "HepA", "Td/Tdap", "Influenza", "COVID-19"],
    pharmacy_labels: ["Antibiotic", "Analgesic", "Cardiac", "Respiratory", "Gastrointestinal", "Endocrine", "Emergency"],
    equipment_categories: [],
    consumable_categories: [],
    offline_force_flags: false
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let settingsDirty = false;           // Track unsaved changes
let settingsLoaded = false;          // Prevent premature saves during init
let settingsAutoSaveTimer = null;    // Debounce timer for auto-save
let settingsSaveSequence = 0;        // Monotonic save request id
let offlineStatusCache = null;       // Cached offline status for UI updates
let vaccineTypeList = [...DEFAULT_SETTINGS.vaccine_types];   // Active vaccine types
let pharmacyLabelList = [...DEFAULT_SETTINGS.pharmacy_labels]; // Active pharmacy labels
let equipmentCategoryList = [...DEFAULT_SETTINGS.equipment_categories];
let consumableCategoryList = [...DEFAULT_SETTINGS.consumable_categories];
let offlineInitialized = false;     // Prevent duplicate offline checks
const PROMPT_TEMPLATE_CONFIG = {
    triage_instruction: {
        textareaId: 'triage_instruction',
        nameInputId: 'triage_prompt_template_name',
        selectId: 'triage_prompt_template_select',
        statusId: 'triage_prompt_template_status',
        emptyLabel: 'Select saved triage prompt…',
    },
    inquiry_instruction: {
        textareaId: 'inquiry_instruction',
        nameInputId: 'inquiry_prompt_template_name',
        selectId: 'inquiry_prompt_template_select',
        statusId: 'inquiry_prompt_template_status',
        emptyLabel: 'Select saved inquiry prompt…',
    },
};
const promptTemplateCache = {
    triage_instruction: [],
    inquiry_instruction: [],
};
let triagePromptTreePayload = null;
let triageTreeEditorState = {
    domain: '',
    problem: '',
    selectedOptionKeys: {
        anatomy_guardrails: '',
        severity_modifiers: '',
        mechanism_modifiers: '',
    },
};
const TRIAGE_TREE_OPTION_CATEGORY_LABELS = {
    anatomy_guardrails: 'Anatomy',
    severity_modifiers: 'Mechanism / Cause',
    mechanism_modifiers: 'Severity / Complication',
};
const TRIAGE_TREE_CATEGORY_EDITOR_IDS = {
    anatomy_guardrails: {
        select: 'triage-tree-anatomy-key-select',
        input: 'triage-tree-anatomy-key-new',
        text: 'triage-tree-anatomy-text',
    },
    severity_modifiers: {
        select: 'triage-tree-severity-key-select',
        input: 'triage-tree-severity-key-new',
        text: 'triage-tree-severity-text',
    },
    mechanism_modifiers: {
        select: 'triage-tree-mechanism-key-select',
        input: 'triage-tree-mechanism-key-new',
        text: 'triage-tree-mechanism-text',
    },
};

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
            const models = Array.isArray(offlineStatusCache.models) ? offlineStatusCache.models : [];
            const cached = models.filter((m) => !!m.cached).length;
            const total = models.length || (Number(offlineStatusCache.total_models) || 0);
            offlineEl.textContent = `Cached models: ${cached}/${total || '?'} | Flags ${flagsOn ? 'ON' : 'OFF'}`;
        } else {
            const isOffline = !!((offlineStatusCache && offlineStatusCache.offline_mode) || flagsOn);
            const mode = isOffline ? 'Offline' : 'Online';
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
    updateOfflineFlagButton();
}

/**
 * getPromptTemplateConfig: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function getPromptTemplateConfig(promptKey) {
    return PROMPT_TEMPLATE_CONFIG[promptKey] || null;
}

/**
 * updatePromptTemplateStatus: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function updatePromptTemplateStatus(promptKey, message, isError = false) {
    const cfg = getPromptTemplateConfig(promptKey);
    if (!cfg) return;
    const el = document.getElementById(cfg.statusId);
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? 'var(--red)' : '#4a5568';
}

/**
 * syncPromptTemplateSelectToEditor: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function syncPromptTemplateSelectToEditor(promptKey) {
    const cfg = getPromptTemplateConfig(promptKey);
    if (!cfg) return;
    const textarea = document.getElementById(cfg.textareaId);
    const select = document.getElementById(cfg.selectId);
    if (!textarea || !select) return;
    const currentText = (textarea.value || '').trim();
    const items = promptTemplateCache[promptKey] || [];
    const match = items.find((item) => (item.prompt_text || '').trim() === currentText);
    select.value = match ? String(match.id) : '';
}

/**
 * renderPromptTemplateOptions: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function renderPromptTemplateOptions(promptKey) {
    const cfg = getPromptTemplateConfig(promptKey);
    if (!cfg) return;
    const select = document.getElementById(cfg.selectId);
    if (!select) return;
    const prev = select.value;
    const items = promptTemplateCache[promptKey] || [];
    const options = [
        `<option value="">${cfg.emptyLabel}</option>`,
        ...items.map((item) => {
            const updated = item.updated_at ? new Date(item.updated_at).toLocaleString() : '';
            const updatedSuffix = updated ? ` (${updated})` : '';
            return `<option value="${item.id}">${item.name}${updatedSuffix}</option>`;
        }),
    ];
    select.innerHTML = options.join('');
    if (items.some((item) => String(item.id) === String(prev))) {
        select.value = String(prev);
    }
    syncPromptTemplateSelectToEditor(promptKey);
}

async function loadPromptTemplates(promptKey = null) {
    const cfg = promptKey ? getPromptTemplateConfig(promptKey) : null;
    if (promptKey && !cfg) return;
    try {
        const query = promptKey ? `?prompt_key=${encodeURIComponent(promptKey)}` : '';
        const res = await fetch(`/api/settings/prompt-library${query}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Prompt library load failed (${res.status})`);
        const payload = await res.json();
        const items = Array.isArray(payload?.items) ? payload.items : [];
        if (promptKey) {
            promptTemplateCache[promptKey] = items;
            renderPromptTemplateOptions(promptKey);
            updatePromptTemplateStatus(promptKey, '');
            return;
        }
        Object.keys(promptTemplateCache).forEach((key) => {
            promptTemplateCache[key] = items.filter((item) => item.prompt_key === key);
            renderPromptTemplateOptions(key);
            updatePromptTemplateStatus(key, '');
        });
    } catch (err) {
        if (promptKey) {
            updatePromptTemplateStatus(promptKey, `Load failed: ${err.message}`, true);
        } else {
            Object.keys(promptTemplateCache).forEach((key) => {
                updatePromptTemplateStatus(key, `Load failed: ${err.message}`, true);
            });
        }
    }
}

async function savePromptTemplate(promptKey) {
    const cfg = getPromptTemplateConfig(promptKey);
    if (!cfg) return;
    const nameEl = document.getElementById(cfg.nameInputId);
    const textEl = document.getElementById(cfg.textareaId);
    if (!nameEl || !textEl) return;
    const name = (nameEl.value || '').trim();
    const promptText = (textEl.value || '').trim();
    if (!name) {
        updatePromptTemplateStatus(promptKey, 'Enter a prompt name before saving.', true);
        return;
    }
    if (!promptText) {
        updatePromptTemplateStatus(promptKey, 'Prompt text is empty.', true);
        return;
    }
    try {
        updatePromptTemplateStatus(promptKey, 'Saving prompt version…');
        const res = await fetch('/api/settings/prompt-library', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                prompt_key: promptKey,
                name,
                prompt_text: promptText,
            }),
        });
        if (!res.ok) {
            let detail = '';
            try {
                const err = await res.json();
                detail = err?.error ? `: ${err.error}` : '';
            } catch (_) { /* ignore */ }
            throw new Error(`Save failed (${res.status})${detail}`);
        }
        const saved = await res.json();
        await loadPromptTemplates(promptKey);
        const select = document.getElementById(cfg.selectId);
        if (select && saved?.id) {
            select.value = String(saved.id);
        }
        updatePromptTemplateStatus(promptKey, `Saved "${saved?.name || name}".`);
    } catch (err) {
        updatePromptTemplateStatus(promptKey, `Save failed: ${err.message}`, true);
    }
}

/**
 * loadSelectedPromptTemplate: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function loadSelectedPromptTemplate(promptKey) {
    const cfg = getPromptTemplateConfig(promptKey);
    if (!cfg) return;
    const select = document.getElementById(cfg.selectId);
    const textEl = document.getElementById(cfg.textareaId);
    const nameEl = document.getElementById(cfg.nameInputId);
    if (!select || !textEl) return;
    const selectedId = String(select.value || '');
    if (!selectedId) {
        updatePromptTemplateStatus(promptKey, 'Select a saved prompt first.', true);
        return;
    }
    const items = promptTemplateCache[promptKey] || [];
    const chosen = items.find((item) => String(item.id) === selectedId);
    if (!chosen) {
        updatePromptTemplateStatus(promptKey, 'Saved prompt not found. Reload prompt list.', true);
        return;
    }
    textEl.value = chosen.prompt_text || '';
    if (nameEl) {
        nameEl.value = chosen.name || '';
    }
    textEl.dispatchEvent(new Event('input', { bubbles: true }));
    updatePromptTemplateStatus(promptKey, `Loaded "${chosen.name}" into active settings.`);
}

/**
 * updateTriageTreeStatus: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function updateTriageTreeStatus(message, isError = false) {
    const el = document.getElementById('triage-tree-status');
    if (!el) return;
    el.textContent = message || '';
    el.style.color = isError ? 'var(--red)' : '#4a5568';
}

/**
 * saveTriageTreeOnFieldExit: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function saveTriageTreeOnFieldExit(reason = 'field-exit') {
    if (!triagePromptTreePayload) return;
    saveTriagePromptTree({ silentStatus: true, reason }).catch(() => {});
}

/**
 * normalizeTriageTreePayload: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function normalizeTriageTreePayload(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Payload must be a JSON object.');
    }
    const baseDoctrine = typeof raw.base_doctrine === 'string' ? raw.base_doctrine.trim() : '';
    const tree = raw.tree;
    if (!tree || typeof tree !== 'object' || Array.isArray(tree) || !Object.keys(tree).length) {
        throw new Error('Payload must include a non-empty "tree" object.');
    }
    return {
        base_doctrine: baseDoctrine,
        tree,
    };
}

/**
 * ensureTriageTreeRoot: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function ensureTriageTreeRoot() {
    if (!triagePromptTreePayload || typeof triagePromptTreePayload !== 'object') {
        triagePromptTreePayload = { base_doctrine: '', tree: {} };
    }
    if (!triagePromptTreePayload.tree || typeof triagePromptTreePayload.tree !== 'object' || Array.isArray(triagePromptTreePayload.tree)) {
        triagePromptTreePayload.tree = {};
    }
    return triagePromptTreePayload.tree;
}

/**
 * getTriageTreeDomainNode: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function getTriageTreeDomainNode(domainKey, create = false) {
    const tree = ensureTriageTreeRoot();
    if (!domainKey) return null;
    if (!tree[domainKey] || typeof tree[domainKey] !== 'object' || Array.isArray(tree[domainKey])) {
        if (!create) return null;
        tree[domainKey] = { mindset: '', problems: {} };
    }
    if (!tree[domainKey].problems || typeof tree[domainKey].problems !== 'object' || Array.isArray(tree[domainKey].problems)) {
        tree[domainKey].problems = {};
    }
    return tree[domainKey];
}

/**
 * getTriageTreeProblemNode: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function getTriageTreeProblemNode(domainKey, problemKey, create = false) {
    const domainNode = getTriageTreeDomainNode(domainKey, create);
    if (!domainNode || !problemKey) return null;
    if (!domainNode.problems[problemKey] || typeof domainNode.problems[problemKey] !== 'object' || Array.isArray(domainNode.problems[problemKey])) {
        if (!create) return null;
        domainNode.problems[problemKey] = {
            procedure: '',
            anatomy_guardrails: {},
            severity_modifiers: {},
            mechanism_modifiers: {},
        };
    }
    const problemNode = domainNode.problems[problemKey];
    if (Object.prototype.hasOwnProperty.call(problemNode, 'exclusions')) {
        delete problemNode.exclusions;
    }
    ['anatomy_guardrails', 'severity_modifiers', 'mechanism_modifiers'].forEach((category) => {
        if (!problemNode[category] || typeof problemNode[category] !== 'object' || Array.isArray(problemNode[category])) {
            problemNode[category] = {};
        }
    });
    return problemNode;
}

/**
 * getTriageTreeOptionMap: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function getTriageTreeOptionMap(domainKey, problemKey, categoryKey, create = false) {
    const problemNode = getTriageTreeProblemNode(domainKey, problemKey, create);
    if (!problemNode) return {};
    if (!problemNode[categoryKey] || typeof problemNode[categoryKey] !== 'object' || Array.isArray(problemNode[categoryKey])) {
        if (!create) return {};
        problemNode[categoryKey] = {};
    }
    return problemNode[categoryKey];
}

/**
 * setTriageTreeSelectOptions: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function setTriageTreeSelectOptions(selectId, options, selectedValue, emptyLabel) {
    const select = document.getElementById(selectId);
    if (!select) return '';
    const values = Array.isArray(options) ? options.slice() : [];
    const selected = values.includes(selectedValue) ? selectedValue : '';
    select.innerHTML = `<option value="">${emptyLabel}</option>`;
    values.forEach((value) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        select.appendChild(opt);
    });
    select.value = selected;
    return selected;
}

/**
 * setTriageTreePathHint: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function setTriageTreePathHint(elementId, segments, fallbackText) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const cleaned = (Array.isArray(segments) ? segments : [])
        .map((segment) => String(segment || '').trim())
        .filter((segment) => !!segment);
    el.textContent = cleaned.length
        ? `Path: ${cleaned.join(' -> ')}`
        : `Path: ${fallbackText}`;
}

/**
 * syncTriageTreeEditorState: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function syncTriageTreeEditorState() {
    const tree = ensureTriageTreeRoot();
    const domains = Object.keys(tree);
    if (!domains.includes(triageTreeEditorState.domain)) {
        triageTreeEditorState.domain = domains[0] || '';
    }
    if (!triageTreeEditorState.selectedOptionKeys || typeof triageTreeEditorState.selectedOptionKeys !== 'object') {
        triageTreeEditorState.selectedOptionKeys = {
            anatomy_guardrails: '',
            severity_modifiers: '',
            mechanism_modifiers: '',
        };
    }
    const domainNode = getTriageTreeDomainNode(triageTreeEditorState.domain, false);
    const problems = domainNode ? Object.keys(domainNode.problems || {}) : [];
    if (!problems.includes(triageTreeEditorState.problem)) {
        triageTreeEditorState.problem = problems[0] || '';
    }
    Object.keys(TRIAGE_TREE_OPTION_CATEGORY_LABELS).forEach((categoryKey) => {
        const optionMap = getTriageTreeOptionMap(
            triageTreeEditorState.domain,
            triageTreeEditorState.problem,
            categoryKey,
            false
        );
        const optionKeys = Object.keys(optionMap || {});
        const current = triageTreeEditorState.selectedOptionKeys[categoryKey] || '';
        if (!optionKeys.includes(current)) {
            triageTreeEditorState.selectedOptionKeys[categoryKey] = optionKeys[0] || '';
        }
    });
}

/**
 * syncTriageTreeInputsToState: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function syncTriageTreeInputsToState() {
    if (!triagePromptTreePayload) return;
    const baseEl = document.getElementById('triage-tree-base-doctrine');
    if (baseEl) {
        triagePromptTreePayload.base_doctrine = (baseEl.value || '').trim();
    }
    const domainNode = getTriageTreeDomainNode(triageTreeEditorState.domain, false);
    const mindsetEl = document.getElementById('triage-tree-domain-mindset');
    if (domainNode && mindsetEl) {
        domainNode.mindset = (mindsetEl.value || '').trim();
    }
    const problemNode = getTriageTreeProblemNode(triageTreeEditorState.domain, triageTreeEditorState.problem, false);
    const procedureEl = document.getElementById('triage-tree-procedure');
    if (problemNode) {
        if (procedureEl) {
            problemNode.procedure = (procedureEl.value || '').trim();
        }
    }
    if (problemNode) {
        Object.entries(TRIAGE_TREE_CATEGORY_EDITOR_IDS).forEach(([categoryKey, ids]) => {
            const selectedKey = triageTreeEditorState.selectedOptionKeys?.[categoryKey] || '';
            const textEl = document.getElementById(ids.text);
            if (!selectedKey || !textEl) return;
            const optionMap = getTriageTreeOptionMap(
                triageTreeEditorState.domain,
                triageTreeEditorState.problem,
                categoryKey,
                true
            );
            optionMap[selectedKey] = (textEl.value || '').trim();
        });
    }
}

/**
 * clearTriageTreeSelectedOptions: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function clearTriageTreeSelectedOptions() {
    triageTreeEditorState.selectedOptionKeys = {
        anatomy_guardrails: '',
        severity_modifiers: '',
        mechanism_modifiers: '',
    };
}

/**
 * bindTriageTreeEditorHandlers: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function bindTriageTreeEditorHandlers() {
    const domainSelect = document.getElementById('triage-tree-domain-select');
    if (domainSelect && !domainSelect.dataset.bound) {
        domainSelect.dataset.bound = '1';
        domainSelect.addEventListener('change', () => {
            syncTriageTreeInputsToState();
            triageTreeEditorState.domain = domainSelect.value || '';
            triageTreeEditorState.problem = '';
            clearTriageTreeSelectedOptions();
            renderTriageTreeEditorControls();
        });
        domainSelect.addEventListener('blur', () => {
            saveTriageTreeOnFieldExit('domain-blur');
        });
    }

    const problemSelect = document.getElementById('triage-tree-problem-select');
    if (problemSelect && !problemSelect.dataset.bound) {
        problemSelect.dataset.bound = '1';
        problemSelect.addEventListener('change', () => {
            syncTriageTreeInputsToState();
            triageTreeEditorState.problem = problemSelect.value || '';
            clearTriageTreeSelectedOptions();
            renderTriageTreeEditorControls();
        });
        problemSelect.addEventListener('blur', () => {
            saveTriageTreeOnFieldExit('problem-blur');
        });
    }

    Object.entries(TRIAGE_TREE_CATEGORY_EDITOR_IDS).forEach(([categoryKey, ids]) => {
        const optionSelect = document.getElementById(ids.select);
        if (optionSelect && !optionSelect.dataset.bound) {
            optionSelect.dataset.bound = '1';
            optionSelect.addEventListener('change', () => {
                syncTriageTreeInputsToState();
                triageTreeEditorState.selectedOptionKeys[categoryKey] = optionSelect.value || '';
                renderTriageTreeEditorControls();
            });
            optionSelect.addEventListener('blur', () => {
                saveTriageTreeOnFieldExit(`${categoryKey}-blur`);
            });
        }
    });

    const baseEl = document.getElementById('triage-tree-base-doctrine');
    if (baseEl && !baseEl.dataset.bound) {
        baseEl.dataset.bound = '1';
        baseEl.addEventListener('input', () => {
            if (!triagePromptTreePayload) return;
            triagePromptTreePayload.base_doctrine = (baseEl.value || '').trim();
        });
        baseEl.addEventListener('blur', () => {
            saveTriageTreeOnFieldExit('base-blur');
        });
    }

    const mindsetEl = document.getElementById('triage-tree-domain-mindset');
    if (mindsetEl && !mindsetEl.dataset.bound) {
        mindsetEl.dataset.bound = '1';
        mindsetEl.addEventListener('input', () => {
            const domainNode = getTriageTreeDomainNode(triageTreeEditorState.domain, false);
            if (domainNode) {
                domainNode.mindset = (mindsetEl.value || '').trim();
            }
        });
        mindsetEl.addEventListener('blur', () => {
            saveTriageTreeOnFieldExit('mindset-blur');
        });
    }

    const procedureEl = document.getElementById('triage-tree-procedure');
    if (procedureEl && !procedureEl.dataset.bound) {
        procedureEl.dataset.bound = '1';
        procedureEl.addEventListener('input', () => {
            const problemNode = getTriageTreeProblemNode(triageTreeEditorState.domain, triageTreeEditorState.problem, false);
            if (problemNode) {
                problemNode.procedure = (procedureEl.value || '').trim();
            }
        });
        procedureEl.addEventListener('blur', () => {
            saveTriageTreeOnFieldExit('procedure-blur');
        });
    }

    Object.entries(TRIAGE_TREE_CATEGORY_EDITOR_IDS).forEach(([categoryKey, ids]) => {
        const textEl = document.getElementById(ids.text);
        if (textEl && !textEl.dataset.bound) {
            textEl.dataset.bound = '1';
            textEl.addEventListener('input', () => {
                const selectedKey = triageTreeEditorState.selectedOptionKeys?.[categoryKey] || '';
                if (!selectedKey) return;
                const optionMap = getTriageTreeOptionMap(
                    triageTreeEditorState.domain,
                    triageTreeEditorState.problem,
                    categoryKey,
                    true
                );
                optionMap[selectedKey] = (textEl.value || '').trim();
            });
            textEl.addEventListener('blur', () => {
                saveTriageTreeOnFieldExit(`${categoryKey}-text-blur`);
            });
        }
    });
}

/**
 * renderTriageTreeEditor: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function renderTriageTreeEditor(payload) {
    const normalized = normalizeTriageTreePayload(payload);
    triagePromptTreePayload = JSON.parse(JSON.stringify(normalized));
    bindTriageTreeEditorHandlers();
    renderTriageTreeEditorControls();
}

/**
 * renderTriageTreeCategoryControls: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function renderTriageTreeCategoryControls(categoryKey, selectedDomain, selectedProblem, problemNode) {
    const ids = TRIAGE_TREE_CATEGORY_EDITOR_IDS[categoryKey];
    if (!ids) return;
    const optionMap = getTriageTreeOptionMap(
        selectedDomain,
        selectedProblem,
        categoryKey,
        false
    );
    const optionKeys = Object.keys(optionMap || {});
    const selectedOption = setTriageTreeSelectOptions(
        ids.select,
        optionKeys,
        triageTreeEditorState.selectedOptionKeys?.[categoryKey] || '',
        `Select ${TRIAGE_TREE_OPTION_CATEGORY_LABELS[categoryKey] || 'option'}...`
    );
    triageTreeEditorState.selectedOptionKeys[categoryKey] = selectedOption;

    const selectEl = document.getElementById(ids.select);
    if (selectEl) {
        selectEl.disabled = !problemNode;
    }

    const inputEl = document.getElementById(ids.input);
    if (inputEl) {
        inputEl.disabled = !problemNode;
    }

    const textEl = document.getElementById(ids.text);
    if (textEl) {
        textEl.value = selectedOption ? (optionMap[selectedOption] || '') : '';
        textEl.disabled = !problemNode || !selectedOption;
    }
}

/**
 * renderTriageTreeEditorControls: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function renderTriageTreeEditorControls() {
    if (!triagePromptTreePayload) return;
    syncTriageTreeEditorState();
    const tree = ensureTriageTreeRoot();
    const domains = Object.keys(tree);
    const selectedDomain = setTriageTreeSelectOptions(
        'triage-tree-domain-select',
        domains,
        triageTreeEditorState.domain,
        'Select domain...'
    );
    triageTreeEditorState.domain = selectedDomain;
    const domainNode = getTriageTreeDomainNode(selectedDomain, false);

    const mindsetEl = document.getElementById('triage-tree-domain-mindset');
    if (mindsetEl) {
        mindsetEl.value = domainNode ? (domainNode.mindset || '') : '';
        mindsetEl.disabled = !domainNode;
    }

    const problems = domainNode ? Object.keys(domainNode.problems || {}) : [];
    const selectedProblem = setTriageTreeSelectOptions(
        'triage-tree-problem-select',
        problems,
        triageTreeEditorState.problem,
        'Select problem...'
    );
    triageTreeEditorState.problem = selectedProblem;
    const problemSelectEl = document.getElementById('triage-tree-problem-select');
    if (problemSelectEl) {
        problemSelectEl.disabled = !domainNode;
    }
    const problemNode = getTriageTreeProblemNode(selectedDomain, selectedProblem, false);

    const procedureEl = document.getElementById('triage-tree-procedure');
    if (procedureEl) {
        procedureEl.value = problemNode ? (problemNode.procedure || '') : '';
        procedureEl.disabled = !problemNode;
    }

    const baseEl = document.getElementById('triage-tree-base-doctrine');
    if (baseEl && document.activeElement !== baseEl) {
        baseEl.value = triagePromptTreePayload.base_doctrine || '';
    }

    ['anatomy_guardrails', 'severity_modifiers', 'mechanism_modifiers'].forEach((categoryKey) => {
        renderTriageTreeCategoryControls(categoryKey, selectedDomain, selectedProblem, problemNode);
    });

    const selectedAnatomy = triageTreeEditorState.selectedOptionKeys?.anatomy_guardrails || '';
    const selectedMechanism = triageTreeEditorState.selectedOptionKeys?.severity_modifiers || '';
    const selectedSeverity = triageTreeEditorState.selectedOptionKeys?.mechanism_modifiers || '';

    setTriageTreePathHint('triage-tree-base-path', [], 'Global (all triage paths)');
    setTriageTreePathHint('triage-tree-domain-path', [selectedDomain], '(select Domain)');
    setTriageTreePathHint('triage-tree-procedure-path', [selectedDomain, selectedProblem], '(select Domain and Problem)');
    setTriageTreePathHint('triage-tree-anatomy-path', [selectedDomain, selectedProblem, selectedAnatomy], '(select Domain, Problem, and Anatomy)');
    setTriageTreePathHint('triage-tree-severity-path', [selectedDomain, selectedProblem, selectedAnatomy, selectedMechanism], '(select Domain, Problem, Anatomy, and Mechanism)');
    setTriageTreePathHint('triage-tree-mechanism-path', [selectedDomain, selectedProblem, selectedAnatomy, selectedMechanism, selectedSeverity], '(select Domain, Problem, Anatomy, Mechanism, and Severity)');
}

/**
 * addTriageTreeDomain: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function addTriageTreeDomain() {
    if (!triagePromptTreePayload) return;
    syncTriageTreeInputsToState();
    const input = document.getElementById('triage-tree-domain-new');
    const name = (input?.value || '').trim();
    if (!name) {
        updateTriageTreeStatus('Enter a domain name first.', true);
        return;
    }
    const tree = ensureTriageTreeRoot();
    const existing = Object.keys(tree).find((key) => key.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
        updateTriageTreeStatus(`Domain "${existing}" already exists.`, true);
        return;
    }
    tree[name] = { mindset: '', problems: {} };
    triageTreeEditorState.domain = name;
    triageTreeEditorState.problem = '';
    clearTriageTreeSelectedOptions();
    if (input) input.value = '';
    renderTriageTreeEditorControls();
    updateTriageTreeStatus(`Added domain "${name}".`);
    saveTriageTreeOnFieldExit('domain-add');
}

/**
 * deleteTriageTreeDomain: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function deleteTriageTreeDomain() {
    if (!triagePromptTreePayload) return;
    syncTriageTreeInputsToState();
    const key = triageTreeEditorState.domain;
    if (!key) {
        updateTriageTreeStatus('Select a domain to delete.', true);
        return;
    }
    if (!confirm(`Delete domain "${key}" and all its problems?`)) return;
    const tree = ensureTriageTreeRoot();
    delete tree[key];
    triageTreeEditorState.domain = '';
    triageTreeEditorState.problem = '';
    clearTriageTreeSelectedOptions();
    renderTriageTreeEditorControls();
    updateTriageTreeStatus(`Deleted domain "${key}".`);
    saveTriageTreeOnFieldExit('domain-delete');
}

/**
 * addTriageTreeProblem: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function addTriageTreeProblem() {
    if (!triagePromptTreePayload) return;
    syncTriageTreeInputsToState();
    const domainKey = triageTreeEditorState.domain;
    if (!domainKey) {
        updateTriageTreeStatus('Select a domain first.', true);
        return;
    }
    const input = document.getElementById('triage-tree-problem-new');
    const name = (input?.value || '').trim();
    if (!name) {
        updateTriageTreeStatus('Enter a problem name first.', true);
        return;
    }
    const domainNode = getTriageTreeDomainNode(domainKey, true);
    const existing = Object.keys(domainNode.problems || {}).find((key) => key.trim().toLowerCase() === name.toLowerCase());
    if (existing) {
        updateTriageTreeStatus(`Problem "${existing}" already exists in ${domainKey}.`, true);
        return;
    }
    domainNode.problems[name] = {
        procedure: '',
        anatomy_guardrails: {},
        severity_modifiers: {},
        mechanism_modifiers: {},
    };
    triageTreeEditorState.problem = name;
    clearTriageTreeSelectedOptions();
    if (input) input.value = '';
    renderTriageTreeEditorControls();
    updateTriageTreeStatus(`Added problem "${name}" under ${domainKey}.`);
    saveTriageTreeOnFieldExit('problem-add');
}

/**
 * deleteTriageTreeProblem: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function deleteTriageTreeProblem() {
    if (!triagePromptTreePayload) return;
    syncTriageTreeInputsToState();
    const domainKey = triageTreeEditorState.domain;
    const problemKey = triageTreeEditorState.problem;
    if (!domainKey || !problemKey) {
        updateTriageTreeStatus('Select a problem to delete.', true);
        return;
    }
    if (!confirm(`Delete problem "${problemKey}" from "${domainKey}"?`)) return;
    const domainNode = getTriageTreeDomainNode(domainKey, false);
    if (!domainNode || !domainNode.problems) return;
    delete domainNode.problems[problemKey];
    triageTreeEditorState.problem = '';
    clearTriageTreeSelectedOptions();
    renderTriageTreeEditorControls();
    updateTriageTreeStatus(`Deleted problem "${problemKey}".`);
    saveTriageTreeOnFieldExit('problem-delete');
}

/**
 * addTriageTreeCategoryOption: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function addTriageTreeCategoryOption(categoryKey) {
    if (!triagePromptTreePayload) return;
    if (!TRIAGE_TREE_OPTION_CATEGORY_LABELS[categoryKey]) return;
    syncTriageTreeInputsToState();
    const domainKey = triageTreeEditorState.domain;
    const problemKey = triageTreeEditorState.problem;
    if (!domainKey || !problemKey) {
        updateTriageTreeStatus('Select a domain and problem first.', true);
        return;
    }
    const input = document.getElementById(TRIAGE_TREE_CATEGORY_EDITOR_IDS[categoryKey].input);
    const key = (input?.value || '').trim();
    if (!key) {
        updateTriageTreeStatus('Enter an option name first.', true);
        return;
    }
    const optionMap = getTriageTreeOptionMap(domainKey, problemKey, categoryKey, true);
    const existing = Object.keys(optionMap).find((name) => name.trim().toLowerCase() === key.toLowerCase());
    if (existing) {
        updateTriageTreeStatus(`Option "${existing}" already exists in ${TRIAGE_TREE_OPTION_CATEGORY_LABELS[categoryKey]}.`, true);
        return;
    }
    optionMap[key] = '';
    triageTreeEditorState.selectedOptionKeys[categoryKey] = key;
    if (input) input.value = '';
    renderTriageTreeEditorControls();
    updateTriageTreeStatus(`Added option "${key}" to ${TRIAGE_TREE_OPTION_CATEGORY_LABELS[categoryKey]}.`);
    saveTriageTreeOnFieldExit(`${categoryKey}-add`);
}

/**
 * deleteTriageTreeCategoryOption: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function deleteTriageTreeCategoryOption(categoryKey) {
    if (!triagePromptTreePayload) return;
    if (!TRIAGE_TREE_OPTION_CATEGORY_LABELS[categoryKey]) return;
    syncTriageTreeInputsToState();
    const domainKey = triageTreeEditorState.domain;
    const problemKey = triageTreeEditorState.problem;
    const optionKey = triageTreeEditorState.selectedOptionKeys?.[categoryKey] || '';
    if (!domainKey || !problemKey || !optionKey) {
        updateTriageTreeStatus('Select an option to delete.', true);
        return;
    }
    if (!confirm(`Delete option "${optionKey}" from ${TRIAGE_TREE_OPTION_CATEGORY_LABELS[categoryKey]}?`)) return;
    const optionMap = getTriageTreeOptionMap(domainKey, problemKey, categoryKey, false);
    delete optionMap[optionKey];
    triageTreeEditorState.selectedOptionKeys[categoryKey] = '';
    renderTriageTreeEditorControls();
    updateTriageTreeStatus(`Deleted option "${optionKey}".`);
    saveTriageTreeOnFieldExit(`${categoryKey}-delete`);
}

/**
 * addTriageTreeAnatomyOption: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function addTriageTreeAnatomyOption() {
    addTriageTreeCategoryOption('anatomy_guardrails');
}

/**
 * deleteTriageTreeAnatomyOption: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function deleteTriageTreeAnatomyOption() {
    deleteTriageTreeCategoryOption('anatomy_guardrails');
}

/**
 * addTriageTreeSeverityOption: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function addTriageTreeSeverityOption() {
    addTriageTreeCategoryOption('severity_modifiers');
}

/**
 * deleteTriageTreeSeverityOption: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function deleteTriageTreeSeverityOption() {
    deleteTriageTreeCategoryOption('severity_modifiers');
}

/**
 * addTriageTreeMechanismOption: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function addTriageTreeMechanismOption() {
    addTriageTreeCategoryOption('mechanism_modifiers');
}

/**
 * deleteTriageTreeMechanismOption: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function deleteTriageTreeMechanismOption() {
    deleteTriageTreeCategoryOption('mechanism_modifiers');
}

async function loadTriagePromptTree() {
    try {
        updateTriageTreeStatus('Loading triage decision tree...');
        const res = await fetch('/api/settings/triage-tree', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const payload = await res.json();
        const normalized = normalizeTriageTreePayload(payload?.payload || payload);
        renderTriageTreeEditor(normalized);
        const domainCount = Object.keys(normalized.tree || {}).length;
        updateTriageTreeStatus(`Loaded triage tree (${domainCount} domain${domainCount === 1 ? '' : 's'}).`);
    } catch (err) {
        updateTriageTreeStatus(`Load failed: ${err.message}`, true);
    }
}

async function saveTriagePromptTree(options = {}) {
    const silentStatus = !!options.silentStatus;
    const reason = options.reason || 'manual';
    if (!triagePromptTreePayload) {
        updateTriageTreeStatus('No triage tree is loaded.', true);
        return;
    }
    syncTriageTreeInputsToState();

    let normalized;
    try {
        normalized = normalizeTriageTreePayload(triagePromptTreePayload);
    } catch (err) {
        updateTriageTreeStatus(err.message || 'Invalid triage tree payload.', true);
        return;
    }

    try {
        if (!silentStatus) {
            updateTriageTreeStatus('Saving triage decision tree...');
        }
        const res = await fetch('/api/settings/triage-tree', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ payload: normalized }),
        });
        if (!res.ok) {
            let detail = '';
            try {
                const err = await res.json();
                detail = err?.error ? `: ${err.error}` : '';
            } catch (_) { /* ignore */ }
            throw new Error(`Save failed (${res.status})${detail}`);
        }
        const payload = await res.json();
        const saved = normalizeTriageTreePayload(payload?.payload || normalized);
        renderTriageTreeEditor(saved);
        const domainCount = Object.keys(saved.tree || {}).length;
        if (silentStatus) {
            updateTriageTreeStatus(
                `Auto-saved triage tree (${domainCount} domain${domainCount === 1 ? '' : 's'}) at ${new Date().toLocaleTimeString()}.`
            );
        } else {
            updateTriageTreeStatus(`Saved triage tree (${domainCount} domain${domainCount === 1 ? '' : 's'}).`);
        }
        if (typeof refreshPromptPreview === 'function') {
            refreshPromptPreview(true);
        }
        console.log('[settings] triage tree saved', { reason, domainCount });
    } catch (err) {
        updateTriageTreeStatus(`Save failed: ${err.message}`, true);
    }
}

function exportTriagePromptTreeJson() {
    if (!triagePromptTreePayload) {
        updateTriageTreeStatus('No triage tree is loaded.', true);
        return;
    }
    syncTriageTreeInputsToState();
    let normalized;
    try {
        normalized = normalizeTriageTreePayload(triagePromptTreePayload);
    } catch (err) {
        updateTriageTreeStatus(err.message || 'Unable to export triage tree.', true);
        return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `clinical_triage_pathway_${stamp}.json`;
    const blob = new Blob([JSON.stringify(normalized, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    updateTriageTreeStatus(`Exported triage pathway JSON (${filename}).`);
}

function triggerTriagePromptTreeImportPicker() {
    const input = document.getElementById('triage-tree-import-file');
    if (!input) {
        updateTriageTreeStatus('Import input is unavailable.', true);
        return;
    }
    input.value = '';
    input.click();
}

async function importTriagePromptTreeJson(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
        updateTriageTreeStatus(`Importing ${file.name}...`);
        const raw = await file.text();
        let parsed;
        try {
            parsed = JSON.parse(raw || '{}');
        } catch (err) {
            throw new Error('Selected file is not valid JSON.');
        }
        const normalized = normalizeTriageTreePayload(parsed?.payload || parsed);
        renderTriageTreeEditor(normalized);
        await saveTriagePromptTree({ silentStatus: false, reason: 'import-json' });
        updateTriageTreeStatus(`Imported triage pathway from ${file.name}.`);
    } catch (err) {
        updateTriageTreeStatus(`Import failed: ${err.message}`, true);
    } finally {
        if (event?.target) event.target.value = '';
    }
}

async function resetTriagePromptTreeToDefault() {
    if (!confirm('Reset the entire Clinical Triage Pathway to the default JSON file? This will overwrite current pathway edits.')) {
        return;
    }
    try {
        updateTriageTreeStatus('Resetting triage pathway to default JSON...');
        const res = await fetch('/api/settings/triage-tree/reset', {
            method: 'POST',
            credentials: 'same-origin',
        });
        if (!res.ok) {
            let detail = '';
            try {
                const err = await res.json();
                detail = err?.error ? `: ${err.error}` : '';
            } catch (_) { /* ignore */ }
            throw new Error(`Reset failed (${res.status})${detail}`);
        }
        const payload = await res.json();
        const normalized = normalizeTriageTreePayload(payload?.payload || payload);
        renderTriageTreeEditor(normalized);
        const domainCount = Object.keys(normalized.tree || {}).length;
        updateTriageTreeStatus(`Reset complete. Loaded default triage tree (${domainCount} domain${domainCount === 1 ? '' : 's'}).`);
        if (typeof refreshPromptPreview === 'function') {
            refreshPromptPreview(true);
        }
    } catch (err) {
        updateTriageTreeStatus(`Reset failed: ${err.message}`, true);
    }
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
        if (el.dataset.settingsNoAutosave === '1') return;
        if (el.dataset.settingsDirtyBound) return;
        el.dataset.settingsDirtyBound = 'true';
        el.addEventListener('input', () => {
            settingsDirty = true;
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
            if (el.id === 'user_mode') {
                setUserMode(el.value);
                saveSettings(false, 'user-mode-change').catch(() => {});
            }
            if (el.classList.contains('developer-only')) {
                setUserMode(document.getElementById('user_mode')?.value || 'user');
            }
            updateSettingsMeta(window.CACHED_SETTINGS || {});
        });
        el.addEventListener('blur', () => {
            if (!settingsDirty) return;
            if (el.id === 'user_mode') return;
            saveSettings(false, 'field-blur').catch(() => {});
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
        loadPromptTemplates().catch(() => {});
        loadTriagePromptTree().catch(() => {});
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
        loadPromptTemplates().catch(() => {});
        loadTriagePromptTree().catch(() => {});
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
    settingsAutoSaveTimer = setTimeout(() => saveSettings(false, reason), 1500);
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
 * Includes: tr_temp, tr_tok, tr_p, tr_k, in_temp, in_tok, in_p, in_k, rep_penalty
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
    const saveSeq = ++settingsSaveSequence;
    try {
        const s = {};
        const numeric = new Set(['tr_temp','tr_tok','tr_p','tr_k','in_temp','in_tok','in_p','in_k','rep_penalty']);
        ['triage_instruction','inquiry_instruction','tr_temp','tr_tok','tr_p','tr_k','in_temp','in_tok','in_p','in_k','mission_context','rep_penalty','user_mode'].forEach(k => {
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
        if (saveSeq !== settingsSaveSequence) {
            console.log('[settings] ignoring stale save response', { saveSeq, latest: settingsSaveSequence, reason });
            return false;
        }
        console.log('[settings] save response', updated);
        // Preserve the locally selected user_mode to avoid flicker if the server echoes stale data
        const merged = {
            ...updated,
            user_mode: s.user_mode || updated.user_mode,
            vaccine_types: s.vaccine_types || updated.vaccine_types,
            pharmacy_labels: s.pharmacy_labels || updated.pharmacy_labels
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
        return true;
    } catch (err) {
        if (saveSeq !== settingsSaveSequence) {
            console.log('[settings] ignoring stale save error', { saveSeq, latest: settingsSaveSequence, reason, error: err?.message });
            return false;
        }
        if (showAlert) {
            alert(`Unable to save settings: ${err.message}`);
        }
        updateSettingsStatus(`Save error: ${err.message}`, true);
        console.error('[settings] save error', err);
        return false;
    }
}

/**
 * Ensure pending settings changes are persisted before chat submission.
 *
 * This prevents a race where triage/inquiry requests use older persisted
 * model parameters if the user edits Settings and submits chat immediately.
 *
 * @returns {Promise<boolean>} True when settings are synchronized.
 */
async function flushSettingsBeforeChat() {
    if (!settingsLoaded) return true;
    if (settingsAutoSaveTimer) {
        clearTimeout(settingsAutoSaveTimer);
        settingsAutoSaveTimer = null;
    }
    if (!settingsDirty) return true;
    updateSettingsStatus('Saving before consultation…');
    return await saveSettings(false, 'pre-chat-flush');
}

/**
 * Reset a settings section to default values.
 * 
 * Sections:
 * - 'triage': Triage prompt and parameters (temp, tokens, top-p, top-k)
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
        document.getElementById('tr_k').value = DEFAULT_SETTINGS.tr_k;
    } else if (section === 'inquiry') {
        document.getElementById('inquiry_instruction').value = DEFAULT_SETTINGS.inquiry_instruction;
        document.getElementById('in_temp').value = DEFAULT_SETTINGS.in_temp;
        document.getElementById('in_tok').value = DEFAULT_SETTINGS.in_tok;
        document.getElementById('in_p').value = DEFAULT_SETTINGS.in_p;
        document.getElementById('in_k').value = DEFAULT_SETTINGS.in_k;
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

/**
 * renderEquipmentCategories: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
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

/**
 * addEquipmentCategory: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
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

/**
 * removeEquipmentCategory: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function removeEquipmentCategory(idx) {
    if (idx < 0 || idx >= equipmentCategoryList.length) return;
    equipmentCategoryList.splice(idx, 1);
    equipmentCategoryList = normalizeEquipmentCategories(equipmentCategoryList);
    renderEquipmentCategories();
    settingsDirty = true;
    scheduleAutoSave('equipment-category-remove');
}

/**
 * moveEquipmentCategory: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
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

/**
 * renderConsumableCategories: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
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

/**
 * addConsumableCategory: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
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

/**
 * removeConsumableCategory: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function removeConsumableCategory(idx) {
    if (idx < 0 || idx >= consumableCategoryList.length) return;
    consumableCategoryList.splice(idx, 1);
    consumableCategoryList = normalizeConsumableCategories(consumableCategoryList);
    renderConsumableCategories();
    settingsDirty = true;
    scheduleAutoSave('consumable-category-remove');
}

/**
 * moveConsumableCategory: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
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
    const chk = document.getElementById('offline-force-flags');
    if (chk) chk.disabled = !enabled;
}

/**
 * Create timestamped backup of model cache.
 * 
 * Backup Process:
 * 1. Calls /api/offline/backup (POST)
 * 2. Backend creates a timestamped ZIP snapshot
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
    setOfflineControlsEnabled(false);
    try {
        const res = await fetch('/api/offline/backup', { method: 'POST', credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
        const file = (data.backup || '').split('/').pop() || data.backup;
        renderOfflineStatus(`Backup created successfully: ${file}`);
    } catch (err) {
        renderOfflineStatus(`Backup failed: ${err.message}`, true);
    } finally {
        setOfflineControlsEnabled(true);
    }
}

/**
 * Restore model cache from latest backup.
 * 
 * Restoration Process:
 * 1. Calls /api/offline/restore (POST)
 * 2. Backend finds latest ZIP backup
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
    setOfflineControlsEnabled(false);
    try {
        const res = await fetch('/api/offline/restore', { method: 'POST', credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
        const file = (data.restored || '').split('/').pop() || data.restored;
        renderOfflineStatus(`Backup restored: ${file}`);
        alert('Cache restored. Please reload the app.');
    } catch (err) {
        renderOfflineStatus(`Restore failed: ${err.message}`, true);
    } finally {
        setOfflineControlsEnabled(true);
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
    const esc = (value) => {
        const raw = value == null ? '' : String(value);
        if (window.escapeHtml) return window.escapeHtml(raw);
        return raw
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };
    const totalModels = Number(data.total_models) || models.length;
    const cachedModels = Number(data.cached_models) || models.filter((m) => !!m.cached).length;
    const ready = missing.length === 0;
    const readinessLabel = ready ? 'READY FOR OFFLINE USE' : 'NOT READY FOR OFFLINE USE';
    const readinessColor = ready ? 'var(--green)' : 'var(--red)';

    const modelRows = models.map((m) => {
        const state = m.cached ? 'Cached' : 'Missing';
        const stateColor = m.cached ? 'var(--green)' : 'var(--red)';
        const detailParts = [];
        if (m.downloaded) detailParts.push('downloaded now');
        if (m.error) detailParts.push(`error: ${m.error}`);
        const detail = detailParts.length ? detailParts.join(' | ') : '';
        return `
            <tr>
                <td style="padding:4px 6px; border-bottom:1px solid #e5e7eb;">${esc(m.model)}</td>
                <td style="padding:4px 6px; border-bottom:1px solid #e5e7eb; color:${stateColor}; font-weight:700;">${state}</td>
                <td style="padding:4px 6px; border-bottom:1px solid #e5e7eb; color:#475569;">${esc(detail)}</td>
            </tr>
        `;
    }).join('');

    let nextAction = '';
    if (!ready) {
        nextAction = offline
            ? 'Offline flags are enabled. Disable offline mode temporarily, connect to internet, and download missing models.'
            : 'Connect to internet and click "Download missing models", then re-run readiness check.';
    } else if (!offline) {
        nextAction = 'All models are cached. Before departure, enable offline mode so runtime will not attempt network access.';
    } else {
        nextAction = 'All checks passed. Keep current state for offshore use.';
    }

    const diskLine = disk.total_gb
        ? `${esc(disk.free_gb)} GB free of ${esc(disk.total_gb)} GB`
        : 'Disk information unavailable';

    const envLines = [
        `HF_HUB_OFFLINE=${env.HF_HUB_OFFLINE || 'unset'}`,
        `TRANSFORMERS_OFFLINE=${env.TRANSFORMERS_OFFLINE || 'unset'}`,
        `HF_HOME=${env.HF_HOME || 'unset'}`,
        `HUGGINGFACE_HUB_CACHE=${env.HUGGINGFACE_HUB_CACHE || 'unset'}`,
        `AUTO_DOWNLOAD_MODELS=${env.AUTO_DOWNLOAD_MODELS || 'unset'}`,
    ].map((line) => esc(line)).join('<br>');

    return `
        <div style="padding:10px; border:1px solid #d1d5db; border-radius:8px; background:#ffffff;">
            <div style="font-weight:800; color:${readinessColor}; margin-bottom:6px;">${readinessLabel}</div>
            <div style="font-size:13px; color:#1f2937; margin-bottom:6px;">
                Models cached: <strong>${cachedModels}/${totalModels || '?'}</strong>
            </div>
            <div style="font-size:13px; color:#1f2937; margin-bottom:6px;">
                Offline mode: <strong>${offline ? 'ENABLED' : 'DISABLED'}</strong>
            </div>
            <div style="font-size:13px; color:#1f2937; margin-bottom:8px;">
                Cache disk: <strong>${diskLine}</strong>
            </div>
            <div style="font-size:13px; color:${ready ? '#14532d' : '#991b1b'}; margin-bottom:8px;">
                Next action: ${esc(nextAction)}
            </div>
            <table style="width:100%; border-collapse:collapse; font-size:12px; margin-bottom:8px;">
                <thead>
                    <tr style="background:#f8fafc; text-align:left; color:#334155;">
                        <th style="padding:4px 6px; border-bottom:1px solid #cbd5e1;">Model</th>
                        <th style="padding:4px 6px; border-bottom:1px solid #cbd5e1;">Status</th>
                        <th style="padding:4px 6px; border-bottom:1px solid #cbd5e1;">Details</th>
                    </tr>
                </thead>
                <tbody>
                    ${modelRows || '<tr><td colspan="3" style="padding:6px;">No model status available.</td></tr>'}
                </tbody>
            </table>
            <details style="font-size:12px; color:#475569;">
                <summary style="cursor:pointer; font-weight:700;">Technical details</summary>
                <div style="margin-top:6px;">
                    <strong>Cache dir:</strong> ${esc(data.cache_dir || '')}<br>
                    ${envLines}
                </div>
            </details>
        </div>
    `;
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
    btn.textContent = offline ? 'Disable offline mode' : 'Enable offline mode';
    btn.style.background = offline ? '#555' : '#b26a00';
    if (chk) {
        const persisted = !!(window.CACHED_SETTINGS && window.CACHED_SETTINGS.offline_force_flags);
        chk.checked = offlineStatusCache
            ? !!(offlineStatusCache.env?.HF_HUB_OFFLINE === '1' || offlineStatusCache.offline_mode || persisted)
            : persisted;
    }
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
        if (downloadMissing && data.download_requested && !data.download_allowed) {
            message += '<div style="margin-top:6px; color:#b26a00;">Download was not allowed in the current mode. Disable offline mode and retry while connected.</div>';
        } else if (downloadMissing && data.missing && data.missing.length) {
            message += '<div style="margin-top:6px; color:#b26a00;">Some models still missing. Stay online and try again.</div>';
        } else if (downloadMissing && data.models && data.models.some(m => m.downloaded)) {
            message += '<div style="margin-top:6px; color:var(--green);">Downloads completed.</div>';
        } else if (downloadMissing && (!data.models || !data.models.some(m => m.downloaded))) {
            message += '<div style="margin-top:6px; color:#475569;">No downloads were needed; cache was already complete.</div>';
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

/**
 * Return to login/splash from Settings.
 *
 * Behavior:
 * - If crew credentials exist, log out current session first so next access requires login.
 * - If no credentials exist, just navigate to the login/splash screen.
 */
async function returnToLoginSplash() {
    try {
        const res = await fetch('/api/auth/meta', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        window.location.href = data && data.has_credentials ? '/logout' : '/login';
    } catch (_) {
        // Fail safe: force logout to avoid keeping an authenticated session unexpectedly.
        window.location.href = '/logout';
    }
}

// Expose functions to window for inline onclick handlers
window.saveSettings = saveSettings;
window.flushSettingsBeforeChat = flushSettingsBeforeChat;
window.resetSection = resetSection;
window.loadCrewCredentials = loadCrewCredentials;
window.saveCrewCredential = saveCrewCredential;
window.returnToLoginSplash = returnToLoginSplash;
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


//

// MAINTENANCE NOTE
// Historical auto-generated note blocks were removed because they were repetitive and
// obscured real logic changes during review. Keep focused comments close to behavior-
// critical code paths (UI state hydration, async fetch lifecycle, and mode-gated
// controls) so maintenance remains actionable.
