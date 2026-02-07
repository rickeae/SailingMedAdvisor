/*
File: static/js/chat.js
Author notes: Front-end controller for MedGemma AI chat interface.

Key Responsibilities:
- Dual-mode chat system (Triage vs Inquiry consultations)
- Dynamic prompt composition with patient context injection
- Privacy/logging toggle (saves history or runs ephemeral)
- Model selection and performance metrics tracking
- Chat history reactivation (resume previous conversations)
- Triage-specific metadata fields (consciousness, breathing, pain, etc.)
- Test case samples for triage validation
- LocalStorage persistence of chat state across sessions
- Real-time prompt preview with edit capability
- Integration with crew/patient selection from crew.js

Chat Modes:
1. TRIAGE MODE: Medical emergency assessment with structured fields
   - Requires: consciousness, breathing, pain, main problem, temp, circulation, cause
   - Optimized for rapid emergency decision support
   - Visual: Red theme (#ffecec background)

2. INQUIRY MODE: General medical questions and consultations
   - Open-ended questions without structured fields
   - Used for non-emergency medical information
   - Visual: Green theme (#e6f5ec background)

Data Flow:
- User input → Prompt builder → API /api/chat → AI model → Response display
- Chat logs saved to history.json (unless logging disabled)
- Patient context injected from crew selection
- Prompt customization via expandable editor

Privacy Modes:
- LOGGING ON: Saves all chats to history.json, associates with crew member
- LOGGING OFF: Ephemeral mode, no persistence, clears on page refresh

LocalStorage Keys:
- sailingmed:lastPrompt: Most recent user message
- sailingmed:lastPatient: Selected crew member ID
- sailingmed:lastChatMode: Current mode (triage/inquiry)
- sailingmed:loggingOff: Privacy toggle state (1=off, 0=on)
- sailingmed:promptPreviewOpen: Prompt editor expanded state
- sailingmed:promptPreviewContent: Custom prompt text
- sailingmed:chatState: Per-mode input field persistence
- sailingmed:skipLastChat: Flag to skip restoring last chat on load

Integration Points:
- crew.js: Patient selection dropdown, history display
- settings.js: Custom prompts, model configuration
- main.js: Tab navigation, data loading coordination
*/

// HTML escaping utility (from utils.js or fallback)
const escapeHtml = (window.Utils && window.Utils.escapeHtml) ? window.Utils.escapeHtml : (str) => str;

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

// Privacy state: true = logging disabled (ephemeral), false = logging enabled
let isPrivate = false;

// Most recent user message (persisted to localStorage)
let lastPrompt = '';

// Flag to prevent concurrent chat submissions
let isProcessing = false;

// Current chat mode: 'triage' or 'inquiry'
let currentMode = 'triage';

// LocalStorage persistence keys
const LAST_PROMPT_KEY = 'sailingmed:lastPrompt';
const LAST_PATIENT_KEY = 'sailingmed:lastPatient';
const LAST_CHAT_MODE_KEY = 'sailingmed:lastChatMode';
const LOGGING_MODE_KEY = 'sailingmed:loggingOff';
const PROMPT_PREVIEW_STATE_KEY = 'sailingmed:promptPreviewOpen';
const PROMPT_PREVIEW_CONTENT_KEY = 'sailingmed:promptPreviewContent';
const CHAT_STATE_KEY = 'sailingmed:chatState';
const SKIP_LAST_CHAT_KEY = 'sailingmed:skipLastChat';

// Triage test samples loaded from server
let triageSamples = [];

// Model performance tracking: { model: {count, total_ms, avg_ms} }
let chatMetrics = {};

// Dynamic triage field options loaded from server
let triageOptions = {};

/**
 * Load chat performance metrics from server.
 * 
 * Metrics track average response times per model to provide ETA estimates
 * during chat processing. Used to show users expected wait times.
 * 
 * Metrics Structure:
 * ```javascript
 * {
 *   "google/medgemma-1.5-4b-it": {
 *     count: 15,
 *     total_ms: 300000,
 *     avg_ms: 20000  // ~20 seconds average
 *   },
 *   "google/medgemma-1.5-27b-it": {
 *     count: 3,
 *     total_ms: 180000,
 *     avg_ms: 60000  // ~60 seconds average
 *   }
 * }
 * ```
 * 
 * Called on page load to initialize ETA estimates.
 */
async function loadChatMetrics() {
    try {
        const res = await fetch('/api/chat/metrics', { credentials: 'same-origin' });
        const data = await res.json();
        if (res.ok && data && typeof data.metrics === 'object') {
            chatMetrics = data.metrics || {};
        }
    } catch (err) {
        console.warn('[chat] unable to load chat metrics', err);
    }
}

/**
 * Load triage test case samples from server.
 * 
 * Test samples allow quick testing of triage functionality with pre-defined
 * scenarios. Each sample includes situation text and all triage metadata fields.
 * 
 * Populates the "Select a Test Case" dropdown in triage mode for rapid testing.
 * 
 * Sample Structure:
 * ```javascript
 * {
 *   id: 1,
 *   situation: "Crew member fell from mast",
 *   chat_text: "John fell 15 feet, unconscious...",
 *   responsive: "Unconscious",
 *   breathing: "Labored breathing",
 *   pain: "Unable to assess",
 *   main_problem: "Head trauma",
 *   temp: "Normal",
 *   circulation: "Weak pulse",
 *   cause: "Trauma/Injury"
 * }
 * ```
 * 
 * @returns {Promise<Array>} Array of triage sample objects
 */
async function loadTriageSamples() {
    if (triageSamples.length) return triageSamples;
    try {
        const res = await fetch('/api/triage/samples', { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        triageSamples = await res.json();
        const select = document.getElementById('triage-sample-select');
        if (select && Array.isArray(triageSamples)) {
            select.innerHTML = '<option value=\"\">Select a Test Case</option>';
            triageSamples.forEach((s) => {
                const opt = document.createElement('option');
                opt.value = String(s.id);
                opt.textContent = `${s.id}. ${s.situation}`;
                select.appendChild(opt);
            });
        }
    } catch (err) {
        console.warn('Unable to load triage samples', err);
    }
    return triageSamples;
}

/**
 * Load dynamic triage field options from server.
 * 
 * Allows customization of triage dropdown options via settings without
 * code changes. Populates all triage metadata select fields.
 * 
 * Fields Populated:
 * - triage-consciousness: Patient responsiveness level
 * - triage-breathing-status: Breathing quality/pattern
 * - triage-pain-level: Pain severity (1-10 or descriptive)
 * - triage-main-problem: Primary complaint category
 * - triage-temperature: Body temperature status
 * - triage-circulation: Blood circulation/pulse status
 * - triage-cause: Injury/illness cause category
 * 
 * Falls back to existing options if server load fails.
 * 
 * @returns {Promise<Object>} Map of field IDs to option arrays
 */
async function loadTriageOptions() {
    if (Object.keys(triageOptions).length) return triageOptions;
    try {
        const res = await fetch('/api/triage/options', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        triageOptions = await res.json();
    } catch (err) {
        console.warn('Unable to load triage options', err);
        triageOptions = {};
    }
    const fields = [
        'triage-consciousness',
        'triage-breathing-status',
        'triage-pain-level',
        'triage-main-problem',
        'triage-temperature',
        'triage-circulation',
        'triage-cause',
    ];
    fields.forEach((field) => {
        const select = document.getElementById(field);
        if (!select) return;
        const opts = triageOptions[field] || Array.from(select.options).map((o) => o.value).filter(Boolean);
        select.innerHTML = '<option value=\"\">Select...</option>';
        opts.forEach((val) => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            select.appendChild(opt);
        });
    });
    return triageOptions;
}

/**
 * Safely set a select element's value, creating option if needed.
 * 
 * Handles edge case where sample data contains custom values not in
 * the current option list. Creates a new option dynamically to avoid
 * silently failing to apply the sample data.
 * 
 * @param {HTMLSelectElement} selectEl - The select element to update
 * @param {string} value - The value to set
 */
function setSelectValue(selectEl, value) {
    if (!selectEl) return;
    const match = Array.from(selectEl.options).find(o => o.value === value || o.textContent === value);
    if (match) {
        selectEl.value = match.value;
        return;
    }
    const opt = new Option(value, value, true, true);
    selectEl.add(opt);
    selectEl.value = value;
}

/**
 * Apply a triage test sample to all form fields.
 * 
 * Fills both the main message textarea and all triage metadata dropdowns
 * with pre-defined test data. Useful for quick testing and demonstrations.
 * 
 * Triggers input events to ensure prompt preview updates reflect the changes.
 * 
 * @param {string|number} sampleId - ID of the sample to apply
 */
function applyTriageSample(sampleId) {
    if (!sampleId) return;
    const sample = triageSamples.find((s) => String(s.id) === String(sampleId));
    if (!sample) return;
    const msgTextarea = document.getElementById('msg');
    if (msgTextarea) {
        msgTextarea.value = sample.chat_text || '';
        msgTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setSelectValue(document.getElementById('triage-consciousness'), sample.responsive || '');
    setSelectValue(document.getElementById('triage-breathing-status'), sample.breathing || '');
    setSelectValue(document.getElementById('triage-pain-level'), sample.pain || '');
    setSelectValue(document.getElementById('triage-main-problem'), sample.main_problem || '');
    setSelectValue(document.getElementById('triage-temperature'), sample.temp || '');
    setSelectValue(document.getElementById('triage-circulation'), sample.circulation || '');
    setSelectValue(document.getElementById('triage-cause'), sample.cause || '');
    persistChatState();
}

/**
 * Initialize the prompt preview/editor panel.
 * 
 * Setup Process:
 * 1. Binds click/keyboard handlers to toggle expansion
 * 2. Tracks manual edits to prevent auto-refresh overwrites
 * 3. Restores previous state (expanded/collapsed) from localStorage
 * 4. Pre-populates with cached or default prompt
 * 5. Binds input handlers to all fields for state persistence
 * 
 * The prompt editor allows users to:
 * - View the exact prompt being sent to the AI model
 * - Customize the prompt for specific needs
 * - See how patient context is injected
 * - Edit system instructions or constraints
 * 
 * Auto-fill Logic:
 * - If user has manually edited (dataset.autofilled = 'false'), preserve edits
 * - If no manual edits, auto-refresh when patient/mode/fields change
 * - Restore from localStorage on page load
 * 
 * Called on DOMContentLoaded to ensure all elements exist.
 */
function setupPromptInjectionPanel() {
    const promptHeader = document.getElementById('prompt-preview-header');
    const promptBox = document.getElementById('prompt-preview');
    if (promptHeader && !promptHeader.dataset.bound) {
        promptHeader.dataset.bound = 'true';
        promptHeader.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePromptPreviewArrow(promptHeader);
        });
        promptHeader.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                togglePromptPreviewArrow(promptHeader);
            }
        });
    }

    if (promptBox && !promptBox.dataset.inputBound) {
        promptBox.dataset.inputBound = 'true';
        promptBox.addEventListener('input', () => {
            promptBox.dataset.autofilled = 'false';
            try { localStorage.setItem(PROMPT_PREVIEW_CONTENT_KEY, promptBox.value || ''); } catch (err) { /* ignore */ }
        });
    }
    const msgTextarea = document.getElementById('msg');
    if (msgTextarea && !msgTextarea.dataset.stateBound) {
        msgTextarea.dataset.stateBound = 'true';
        msgTextarea.addEventListener('input', () => {
            persistChatState();
        });
    }

    if (promptHeader) {
        let shouldOpen = false;
        try {
            shouldOpen = localStorage.getItem(PROMPT_PREVIEW_STATE_KEY) === 'true';
        } catch (err) { /* ignore */ }
        togglePromptPreviewArrow(promptHeader, shouldOpen);
    }

    // Pre-populate with the default prompt from settings so users can edit immediately
    if (promptBox) {
        try {
            const cached = localStorage.getItem(PROMPT_PREVIEW_CONTENT_KEY);
            if (cached && promptBox.dataset.autofilled !== 'false') {
                promptBox.value = cached;
                promptBox.dataset.autofilled = 'false';
            }
        } catch (err) { /* ignore */ }
    }
    if (promptBox && promptBox.dataset.autofilled !== 'false' && (!promptBox.value || !promptBox.value.trim())) {
        refreshPromptPreview();
    }
}

if (document.readyState !== 'loading') {
    setupPromptInjectionPanel();
    bindTriageMetaRefresh();
    applyChatState(currentMode);
    loadChatMetrics().catch(() => {});
} else {
    document.addEventListener('DOMContentLoaded', setupPromptInjectionPanel, { once: true });
    document.addEventListener('DOMContentLoaded', bindTriageMetaRefresh, { once: true });
    document.addEventListener('DOMContentLoaded', () => applyChatState(currentMode), { once: true });
    document.addEventListener('DOMContentLoaded', () => loadChatMetrics().catch(() => {}), { once: true });
}

document.addEventListener('DOMContentLoaded', () => {
    try {
        const stored = localStorage.getItem(LOGGING_MODE_KEY);
        if (stored === '1') {
            isPrivate = true;
        }
    } catch (err) { /* ignore */ }
    const btn = document.getElementById('priv-btn');
    if (btn) {
        btn.style.background = isPrivate ? 'var(--triage)' : '#333';
        btn.style.border = isPrivate ? '2px solid #fff' : '1px solid #222';
        btn.innerText = isPrivate ? 'LOGGING: OFF' : 'LOGGING: ON';
    }
});

/**
 * Update all UI elements to reflect current mode and privacy state.
 * 
 * Visual Changes:
 * - Banner colors (red for triage, green for inquiry)
 * - Button colors and text
 * - Field visibility (triage metadata shown/hidden)
 * - Placeholder text
 * - Privacy indicator styling
 * 
 * Called After:
 * - Mode changes (triage ↔ inquiry)
 * - Privacy toggle
 * - Page initialization
 * 
 * Mode-Specific UI:
 * - TRIAGE: Red theme, structured fields visible, "SUBMIT FOR TRIAGE" button
 * - INQUIRY: Green theme, fields hidden, "SUBMIT INQUIRY" button
 * 
 * Privacy Indicator:
 * - LOGGING ON: Gray background, normal border
 * - LOGGING OFF: Red background, white border, prominent warning
 */
function updateUI() {
    const banner = document.getElementById('banner');
    const modeSelect = document.getElementById('mode-select');
    const privBtn = document.getElementById('priv-btn');
    const msg = document.getElementById('msg');
    const queryTitle = document.getElementById('query-form-title');
    const runBtn = document.getElementById('run-btn');
    const modelSelect = document.getElementById('model-select');
    const promptRefreshInline = document.getElementById('prompt-refresh-inline');
    const promptHeader = document.getElementById('prompt-preview-header');
    
    // Remove both classes first
    banner.classList.remove('inquiry-mode', 'private-mode', 'no-privacy');
    
    // Add appropriate mode class
    if (currentMode === 'inquiry') {
        banner.classList.add('inquiry-mode');
    }
    
    // Privacy visuals
    if (isPrivate) {
        banner.classList.add('private-mode');
    } else {
        banner.classList.add('no-privacy');
    }
    
    if (modeSelect) {
        modeSelect.value = currentMode;
        modeSelect.style.background = currentMode === 'triage' ? '#ffecec' : '#e6f5ec';
    }
    const triageMeta = document.getElementById('triage-meta-selects');
    if (triageMeta) {
        triageMeta.style.display = currentMode === 'triage' ? 'grid' : 'none';
    }
    if (queryTitle) {
        queryTitle.innerText = currentMode === 'triage' ? 'Triage Consultation Entry' : 'Inquiry Consultation Entry';
    }

    if (privBtn) {
        privBtn.classList.toggle('is-private', isPrivate);
        privBtn.innerText = isPrivate ? 'LOGGING: OFF' : 'LOGGING: ON';
        privBtn.style.background = isPrivate ? 'var(--triage)' : '#333';
        privBtn.style.border = isPrivate ? '2px solid #fff' : '1px solid #222';
    }

    if (msg) {
        msg.placeholder = currentMode === 'triage' ? "What is the situation?" : "Ask your question";
    }
    if (runBtn) {
        runBtn.innerText = currentMode === 'triage' ? 'SUBMIT FOR TRIAGE' : 'SUBMIT INQUIRY';
        runBtn.style.background = currentMode === 'triage' ? 'var(--triage)' : 'var(--inquiry)';
    }
    if (promptRefreshInline) {
        const isExpanded = promptHeader && promptHeader.getAttribute('aria-expanded') === 'true';
        const isAdvanced = document.body.classList.contains('mode-advanced') || document.body.classList.contains('mode-developer');
        promptRefreshInline.style.display = (isExpanded && isAdvanced) ? 'flex' : 'none';
    }
    // Show inline refresh only when prompt section is expanded (handled in toggle)
    if (promptRefreshInline) {
        const promptHeader = document.getElementById('prompt-preview-header');
        const isExpanded = promptHeader && promptHeader.getAttribute('aria-expanded') === 'true';
        promptRefreshInline.style.display = isExpanded ? 'flex' : 'none';
    }
    // Default model to 4B on load
    if (modelSelect && !modelSelect.value) {
        modelSelect.value = 'google/medgemma-1.5-4b-it';
    }
}

/**
 * Bind event listeners to triage metadata fields for prompt refresh.
 * 
 * When any triage field changes:
 * 1. Persists the change to localStorage (chat state)
 * 2. Refreshes prompt preview (if expanded and auto-fill enabled)
 * 
 * Uses dataset flag (tmodeBound) to prevent duplicate binding.
 * 
 * Fields Monitored:
 * - Consciousness level
 * - Breathing status
 * - Pain level
 * - Main problem
 * - Temperature
 * - Circulation
 * - Cause of injury/illness
 */
function bindTriageMetaRefresh() {
    const ids = [
        'triage-consciousness',
        'triage-breathing-status',
        'triage-pain-level',
        'triage-main-problem',
        'triage-temperature',
        'triage-circulation',
        'triage-cause',
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el && !el.dataset.tmodeBound) {
            el.dataset.tmodeBound = 'true';
            el.addEventListener('change', () => {
                persistChatState();
                refreshPromptPreview();
            });
        }
    });
}

/**
 * Load persisted chat state from localStorage.
 * 
 * Chat state is stored per-mode to allow switching between triage and
 * inquiry without losing unsaved work in either mode.
 * 
 * State Structure:
 * ```javascript
 * {
 *   triage: {
 *     msg: "Patient fell from mast...",
 *     fields: {
 *       "triage-consciousness": "Unconscious",
 *       "triage-breathing-status": "Labored",
 *       // ... other triage fields
 *     }
 *   },
 *   inquiry: {
 *     msg: "What antibiotics treat UTI?"
 *   }
 * }
 * ```
 * 
 * @returns {Object} Chat state object or empty object if not found
 */
function loadChatState() {
    try {
        const raw = localStorage.getItem(CHAT_STATE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed ? parsed : {};
    } catch (err) {
        return {};
    }
}

/**
 * Persist current chat state to localStorage.
 * 
 * Saves both the main message and mode-specific fields (triage metadata)
 * separately per mode, allowing seamless mode switching without data loss.
 * 
 * Called After:
 * - User types in message field
 * - User changes triage dropdown
 * - Mode switch (to save state before switching)
 * 
 * @param {string} modeOverride - Optional mode to save state for (default: current mode)
 */
function persistChatState(modeOverride) {
    const mode = modeOverride || currentMode;
    const state = loadChatState();
    const msgEl = document.getElementById('msg');
    state[mode] = state[mode] || {};
    state[mode].msg = msgEl ? msgEl.value : '';
    if (mode === 'triage') {
        const ids = [
            'triage-consciousness',
            'triage-breathing-status',
            'triage-pain-level',
            'triage-main-problem',
            'triage-temperature',
            'triage-circulation',
            'triage-cause',
        ];
        state[mode].fields = {};
        ids.forEach((id) => {
            const el = document.getElementById(id);
            if (el) state[mode].fields[id] = el.value || '';
        });
    }
    try { localStorage.setItem(CHAT_STATE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
}

/**
 * Restore chat state from localStorage to UI fields.
 * 
 * Called when:
 * - Switching modes (restore previously entered data for that mode)
 * - Page load (restore work in progress)
 * 
 * Only restores fields that exist in saved state to avoid overwriting
 * with empty values.
 * 
 * @param {string} modeOverride - Optional mode to restore state from (default: current mode)
 */
function applyChatState(modeOverride) {
    const mode = modeOverride || currentMode;
    const state = loadChatState();
    const modeState = state[mode] || {};
    const msgEl = document.getElementById('msg');
    if (msgEl && typeof modeState.msg === 'string') {
        msgEl.value = modeState.msg;
    }
    if (mode === 'triage' && modeState.fields && typeof modeState.fields === 'object') {
        Object.entries(modeState.fields).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el) el.value = val;
        });
    }
}

/**
 * Toggle privacy/logging mode.
 * 
 * Privacy Modes:
 * - LOGGING ON (isPrivate=false): All chats saved to history.json with crew association
 * - LOGGING OFF (isPrivate=true): Ephemeral mode, no database persistence
 * 
 * Use Cases:
 * - LOGGING OFF: Sensitive consultations, practice scenarios, testing
 * - LOGGING ON: Normal operations, building medical history records
 * 
 * Visual Feedback:
 * - Button color changes (gray → red)
 * - Border emphasis (solid → white outline)
 * - Text updates ("LOGGING: ON" ↔ "LOGGING: OFF")
 * - Banner styling changes
 * 
 * State persisted to localStorage for consistency across sessions.
 */
function togglePriv() {
    isPrivate = !isPrivate;
    const btn = document.getElementById('priv-btn');
    btn.style.background = isPrivate ? 'var(--triage)' : '#333';
    btn.style.border = isPrivate ? '2px solid #fff' : '1px solid #222';
    btn.innerText = isPrivate ? 'LOGGING: OFF' : 'LOGGING: ON';
    try { localStorage.setItem(LOGGING_MODE_KEY, isPrivate ? '1' : '0'); } catch (err) { /* ignore */ }
    updateUI();
}

/**
 * Execute chat submission to AI model.
 * 
 * Processing Flow:
 * 1. Validate input and check processing lock
 * 2. Show loading blocker with ETA estimate
 * 3. Collect all form data (message, patient, mode, triage fields)
 * 4. Check for custom prompt override
 * 5. Submit to /api/chat endpoint
 * 6. Handle 28B model confirmation if needed
 * 7. Parse and display Markdown response
 * 8. Update metrics and refresh history
 * 9. Persist state and unlock UI
 * 
 * Model Confirmation:
 * 27B model requires explicit confirmation due to long processing time
 * (potentially 60+ seconds on CPU). Shows confirm dialog before proceeding.
 * 
 * Prompt Override:
 * If prompt editor is expanded and contains custom text, sends modified
 * prompt instead of default system prompt. Allows advanced users to
 * customize AI instructions.
 * 
 * Response Handling:
 * - Parses Markdown with marked.js (if available)
 * - Falls back to <br> replacement
 * - Shows model name and duration
 * - Displays errors with red border
 * - Scrolls to show new response
 * 
 * Side Effects:
 * - Saves chat to history.json (unless logging disabled)
 * - Updates crew member's medical log
 * - Refreshes chat metrics
 * - Triggers loadData() to update crew history UI
 * 
 * @param {string} promptText - Optional override for message text
 * @param {boolean} force28b - Skip 28B confirmation (after user confirms)
 */
async function runChat(promptText = null, force28b = false) {
    const txt = promptText || document.getElementById('msg').value;
    if(!txt || isProcessing) return;
    
    isProcessing = true;
    lastPrompt = txt;
    const startTime = Date.now();
    const blocker = document.getElementById('chat-blocker');
    const modelName = document.getElementById('model-select').value || 'google/medgemma-1.5-4b-it';
    if (blocker) {
        const title = blocker.querySelector('h3');
        if (title) title.textContent = currentMode === 'triage' ? 'Processing Triage Chat…' : 'Processing Inquiry Chat…';
        const modelLine = document.getElementById('chat-model-line');
        const etaLine = document.getElementById('chat-eta-line');
        if (modelLine) modelLine.textContent = `Model: ${modelName}`;
        const avgMs = (chatMetrics[modelName]?.avg_ms) || (modelName.toLowerCase().includes('27b') ? 60000 : 20000);
        const eta = new Date(Date.now() + avgMs);
        if (etaLine) etaLine.textContent = `Expected finish: ~${eta.toLocaleTimeString()} (avg ${Math.round(avgMs/1000)}s)`;
        blocker.style.display = 'flex';
    }
    
        // Show loading indicator
        const display = document.getElementById('display');
        const loadingDiv = document.createElement('div');
        loadingDiv.id = 'loading-indicator';
        loadingDiv.className = 'loading-indicator';
        loadingDiv.innerHTML = '🔄 Analyzing...';
        display.appendChild(loadingDiv);
    display.scrollTop = display.scrollHeight;
    
    // Disable buttons
    document.getElementById('run-btn').disabled = true;
        
    try {
        const fd = new FormData();
        fd.append('message', txt);
        const patientVal = document.getElementById('p-select').value;
        try { localStorage.setItem(LAST_PATIENT_KEY, patientVal); } catch (err) { /* ignore */ }
        fd.append('patient', patientVal);
        fd.append('mode', currentMode);
        fd.append('private', isPrivate);
        fd.append('model_choice', modelName);
        fd.append('force_28b', force28b ? 'true' : 'false');
        if (currentMode === 'triage') {
            fd.append('triage_consciousness', document.getElementById('triage-consciousness')?.value || '');
            fd.append('triage_breathing_status', document.getElementById('triage-breathing-status')?.value || '');
            fd.append('triage_pain_level', document.getElementById('triage-pain-level')?.value || '');
            fd.append('triage_main_problem', document.getElementById('triage-main-problem')?.value || '');
            fd.append('triage_temperature', document.getElementById('triage-temperature')?.value || '');
            fd.append('triage_circulation', document.getElementById('triage-circulation')?.value || '');
            fd.append('triage_cause', document.getElementById('triage-cause')?.value || '');
        }
        const promptTextarea = document.getElementById('prompt-preview');
        const manualOverride = promptTextarea && promptTextarea.dataset.autofilled === 'false';
        if (manualOverride) {
            const baseText = (promptTextarea.value || '').trim();
            const composedPrompt = baseText ? buildOverridePrompt(baseText, txt, currentMode) : txt;
            if (composedPrompt) {
                fd.append('override_prompt', composedPrompt);
            }
        }
        
        const res = await (await fetch('/api/chat', {method:'POST', body:fd, credentials:'same-origin'})).json();
        const endTime = Date.now();
        
        // Remove loading indicator
        loadingDiv.remove();
        
        if (res.confirm_28b) {
            const ok = confirm(res.error || 'The 28B model on CPU can take an hour or more. Continue?');
            if (ok) {
                isProcessing = false;
                document.getElementById('run-btn').disabled = false;
                                return runChat(promptText || txt, true);
            }
            display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>INFO:</b> ${res.error || 'Cancelled running 28B model.'}</div>`;
        } else if (res.error) {
            display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>ERROR:</b> ${res.error}</div>`;
        } else {
            const durationMs = endTime - startTime;
            const parsed = (window.marked && typeof window.marked.parse === 'function')
                ? window.marked.parse(res.response || '')
                : (res.response || '').replace(/\n/g, '<br>');
            const meta = res.model ? `[${res.model}${res.duration_ms ? ` · ${Math.round(res.duration_ms)} ms` : ` · ${Math.round(durationMs)} ms`}]` : '';
            display.innerHTML += `<div class="response-block"><b>${meta}</b><br>${parsed}</div>`;
            if (res.model && res.model_metrics) {
                chatMetrics[res.model] = res.model_metrics;
            }
            try { localStorage.setItem(SKIP_LAST_CHAT_KEY, '0'); } catch (err) { /* ignore */ }
            if (typeof loadData === 'function') {
                loadData(); // refresh crew history/logs after a chat completes
            }
        }
        
        // Keep user-entered text so they can tweak/re-run
        persistChatState();
        try {
            localStorage.setItem(LAST_PROMPT_KEY, lastPrompt);
            localStorage.setItem(LAST_CHAT_MODE_KEY, currentMode);
        } catch (err) { /* ignore storage issues */ }
        if (display.lastElementChild) display.lastElementChild.scrollIntoView({behavior:'smooth'});
    } catch (error) {
        loadingDiv.remove();
        display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>ERROR:</b> ${error.message}</div>`;
    } finally {
        isProcessing = false;
        const blocker = document.getElementById('chat-blocker');
        if (blocker) blocker.style.display = 'none';
        document.getElementById('run-btn').disabled = false;
            }
}


// Handle Enter key for submission
document.addEventListener('DOMContentLoaded', () => {
    console.log('[DEBUG] chat.js DOMContentLoaded');
    setupPromptInjectionPanel();
    loadTriageOptions();
    loadTriageSamples();
    const msgTextarea = document.getElementById('msg');
    if (msgTextarea) {
        msgTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                runChat();
            }
        });
    }
    const savedPrompt = localStorage.getItem(LAST_PROMPT_KEY);
    if (savedPrompt) lastPrompt = savedPrompt;
    loadTriageSamples().catch(() => {});

    // Debug current patient select state
    const pSelect = document.getElementById('p-select');
    if (pSelect) {
        console.log('[DEBUG] p-select initial options', pSelect.options.length, Array.from(pSelect.options).map(o => o.value));
    } else {
        console.warn('[DEBUG] p-select not found on DOMContentLoaded');
    }
});

/**
 * Reactivate a previous chat conversation from history.
 * 
 * Reactivation Process:
 * 1. Loads full history from server
 * 2. Finds target entry by ID
 * 3. Collects all entries for same patient + mode (thread)
 * 4. Switches to correct mode
 * 5. Navigates to chat tab
 * 6. Restores patient selection
 * 7. Displays previous exchange in chat area
 * 8. Prefills message box with last query
 * 9. Injects full transcript into prompt editor for context
 * 
 * Thread Grouping:
 * Finds all history entries matching:
 * - Same patient (by ID or name)
 * - Same mode (triage or inquiry)
 * Sorted chronologically to provide conversation context.
 * 
 * Transcript Injection:
 * Full conversation history injected into prompt so AI model can:
 * - Reference previous discussion
 * - Maintain context across sessions
 * - Provide consistent follow-up advice
 * 
 * Use Cases:
 * - Continue interrupted consultations
 * - Follow up after implementing advice
 * - Review and expand on previous diagnosis
 * - Share context with relief crew
 * 
 * UI Updates:
 * - Auto-expands prompt editor to show transcript
 * - Focuses message field for immediate input
 * - Shows "Reactivated Chat" header in display
 * - Restores patient selection and mode
 * 
 * @param {string} historyId - Unique ID of history entry to reactivate
 */
async function reactivateChat(historyId) {
    try {
        const res = await fetch('/api/data/history', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`History load failed (${res.status})`);
        const data = await res.json();
        const entry = Array.isArray(data) ? data.find((h) => h.id === historyId) : null;
        if (!entry) {
            alert('Unable to reactivate: history entry not found.');
            return;
        }
        const sameThread = Array.isArray(data)
            ? data
                .filter((h) => {
                    const samePatient = (entry.patient_id && h.patient_id === entry.patient_id) || (entry.patient && h.patient === entry.patient);
                    const sameMode = (entry.mode || 'triage') === (h.mode || 'triage');
                    return samePatient && sameMode;
                })
                .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
            : [entry];
        const transcript = sameThread
            .map((h, idx) => {
                const title = h.date ? `Entry ${idx + 1} — ${h.date}` : `Entry ${idx + 1}`;
                return `${title}\nQUERY:\n${h.query || ''}\nRESPONSE:\n${h.response || ''}`;
            })
            .join('\n\n----\n\n');
        // Set mode based on stored value if present
        if (entry.mode) {
            setMode(entry.mode);
        }
        // Navigate to the correct tab
        const triageTabBtn = document.querySelector('.tab.tab-triage');
        if (triageTabBtn) {
            triageTabBtn.click();
        }
        // Attempt to restore patient selection using patient_id first, then name
        const patientSelect = document.getElementById('p-select');
        if (patientSelect) {
            let targetVal = entry.patient_id || '';
            if (targetVal && Array.from(patientSelect.options).some((o) => o.value === targetVal)) {
                patientSelect.value = targetVal;
            } else if (entry.patient) {
                const matchByName = Array.from(patientSelect.options).find((o) => o.textContent === entry.patient);
                if (matchByName) patientSelect.value = matchByName.value;
            }
            try { localStorage.setItem(LAST_PATIENT_KEY, patientSelect.value || ''); } catch (err) { /* ignore */ }
        }
        // Restore chat area with previous exchange
        const display = document.getElementById('display');
        if (display) {
            const queryHtml = escapeHtml(entry.query || '').replace(/\n/g, '<br>');
            const respHtml = escapeHtml(entry.response || '').replace(/\n/g, '<br>');
            display.innerHTML = `
                <div class="response-block" style="border-left-color:var(--inquiry);">
                    <b>Reactivated Chat</b><br>
                    <div style="margin-top:6px;"><strong>Query:</strong><br>${queryHtml}</div>
                    <div style="margin-top:6px;"><strong>Response:</strong><br>${respHtml}</div>
                </div>`;
            display.scrollTop = display.scrollHeight;
        }
        // Prefill message box with last query so user can continue
        const msgTextarea = document.getElementById('msg');
        if (msgTextarea) {
            msgTextarea.value = entry.query || '';
            msgTextarea.focus();
        }
        // Restore prompt (injected) view if available
        const promptBox = document.getElementById('prompt-preview');
        const promptHeader = document.getElementById('prompt-preview-header');
        if (promptBox && entry.prompt) {
            promptBox.value = entry.prompt;
            promptBox.dataset.autofilled = 'false';
            try { localStorage.setItem(PROMPT_PREVIEW_CONTENT_KEY, entry.prompt); } catch (err) { /* ignore */ }
            if (promptHeader) {
                togglePromptPreviewArrow(promptHeader, true);
            }
        }
        // Inject transcript into prompt preview so the model sees prior context
        if (promptBox) {
            const transcriptBlock = transcript ? `Previous chat transcript:\n${transcript}` : '';
            const combined = [transcriptBlock, promptBox.value].filter(Boolean).join('\n\n');
            promptBox.value = combined;
            promptBox.dataset.autofilled = 'false';
            try { localStorage.setItem(PROMPT_PREVIEW_CONTENT_KEY, combined); } catch (err) { /* ignore */ }
            if (promptHeader) {
                togglePromptPreviewArrow(promptHeader, true);
            }
            const container = document.getElementById('prompt-preview-container');
            if (container) container.style.display = 'block';
        }
        // Persist last prompt locally
        if (entry.query) {
            lastPrompt = entry.query;
            try { localStorage.setItem(LAST_PROMPT_KEY, entry.query); } catch (err) { /* ignore */ }
        }
        alert('Chat restored. You can continue the conversation.');
    } catch (err) {
        alert(`Unable to reactivate chat: ${err.message}`);
    }
}

window.reactivateChat = reactivateChat;
window.applyTriageSample = applyTriageSample;

/**
 * Switch chat mode (triage ↔ inquiry) with state preservation.
 * 
 * Mode Switch Process:
 * 1. Save current mode's state (message + fields)
 * 2. Update currentMode variable
 * 3. Update all UI elements (colors, visibility, text)
 * 4. Update mode selector dropdown
 * 5. Restore new mode's previously saved state
 * 6. Refresh prompt preview if editor is open
 * 
 * State Preservation:
 * Allows users to switch modes without losing unsaved work. Each mode's
 * state (message text + triage fields) is independently persisted.
 * 
 * Use Case Example:
 * - User enters triage consultation
 * - Realizes it's non-emergency
 * - Switches to inquiry mode (triage data preserved)
 * - Later switches back (triage fields restored)
 * 
 * @param {string} mode - Target mode: 'triage' or 'inquiry'
 */
function setMode(mode) {
    const target = mode === 'inquiry' ? 'inquiry' : 'triage';
    if (target === currentMode) return;
    // Save current mode state before switching
    persistChatState(currentMode);
    currentMode = target;
    updateUI();
    const select = document.getElementById('mode-select');
    if (select) {
        select.value = target;
    }
    applyChatState(target);
    const container = document.getElementById('prompt-preview-container');
    if (container && container.style.display === 'block') {
        refreshPromptPreview();
    }
}

/**
 * Toggle between triage and inquiry modes.
 * Convenience wrapper for setMode() that flips between the two modes.
 */
function toggleMode() {
    setMode(currentMode === 'triage' ? 'inquiry' : 'triage');
}

/**
 * Normalize whitespace in prompt text.
 * 
 * Cleans excessive blank lines (3+ → 2) and trims leading/trailing whitespace.
 * Improves prompt readability without affecting semantic content.
 * 
 * @param {string} text - Raw prompt text
 * @returns {string} Cleaned text
 */
function cleanPromptWhitespace(text) {
    return (text || '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Remove user message from prompt text to show template only.
 * 
 * When displaying prompt preview, we want to show the system instructions
 * and context without the user's actual message embedded. This keeps the
 * editor clean and focused on the template/customization.
 * 
 * The user message is visible in the main message textarea, so including
 * it in the prompt preview would be redundant and confusing.
 * 
 * Removal Strategies:
 * 1. Find label line (QUERY: or SITUATION:) and clear text after label
 * 2. Search for exact message text and remove it
 * 3. Fall back to returning prompt as-is if no match found
 * 
 * @param {string} promptText - Full prompt including message
 * @param {string} userMessage - User's message to remove
 * @param {string} mode - Current chat mode
 * @returns {string} Prompt with user message removed
 */
function stripUserMessageFromPrompt(promptText, userMessage, mode = currentMode) {
    if (!promptText) return '';
    const msg = (userMessage || '').trim();
    const label = mode === 'inquiry' ? 'QUERY:' : 'SITUATION:';
    const lines = promptText.split('\n');
    const idx = lines.findIndex(line => line.trimStart().startsWith(label));
    if (idx !== -1) {
        const labelPos = lines[idx].indexOf(label);
        const prefix = labelPos >= 0 ? lines[idx].slice(0, labelPos) : '';
        lines[idx] = `${prefix}${label} `;
        return cleanPromptWhitespace(lines.join('\n'));
    }
    if (msg && promptText.includes(msg)) {
        return cleanPromptWhitespace(promptText.replace(msg, ''));
    }
    return cleanPromptWhitespace(promptText);
}

/**
 * Build final prompt by injecting user message into custom prompt template.
 * 
 * When user has edited the prompt in the preview editor, this function
 * combines their custom template with the actual user message before
 * sending to the AI model.
 * 
 * Injection Strategies:
 * 1. Find label line (QUERY: or SITUATION:) and append message
 * 2. If no label found, append with label at end
 * 
 * This allows users to:
 * - Customize system instructions
 * - Add constraints or guidelines
 * - Modify context injection
 * - Override default prompts entirely
 * 
 * While still ensuring the user's actual question/situation is included.
 * 
 * @param {string} basePrompt - Custom prompt template (without user message)
 * @param {string} userMessage - User's message to inject
 * @param {string} mode - Current chat mode
 * @returns {string} Complete prompt ready for API submission
 */
function buildOverridePrompt(basePrompt, userMessage, mode = currentMode) {
    const base = cleanPromptWhitespace(basePrompt);
    const msg = (userMessage || '').trim();
    if (!base) return '';
    if (!msg) return base;
    const label = mode === 'inquiry' ? 'QUERY:' : 'SITUATION:';
    const lines = base.split('\n');
    const idx = lines.findIndex(line => line.trimStart().startsWith(label));
    if (idx !== -1) {
        const labelPos = lines[idx].indexOf(label);
        const prefix = labelPos >= 0 ? lines[idx].slice(0, labelPos) : '';
        lines[idx] = `${prefix}${label} ${msg}`;
        return lines.join('\n');
    }
    return `${base}\n\n${label} ${msg}`;
}

/**
 * Refresh prompt preview by fetching generated prompt from server.
 * 
 * Auto-Refresh Logic:
 * - Only refreshes if user hasn't manually edited (autofilled=true)
 * - Can be forced with force=true parameter
 * - Skips if prompt editor has custom content (dataset.autofilled='false')
 * 
 * Preview Generation:
 * Calls /api/chat/preview endpoint which:
 * 1. Loads custom prompts from settings
 * 2. Injects patient medical history
 * 3. Adds triage metadata (if in triage mode)
 * 4. Returns full prompt text
 * 
 * User Message Handling:
 * Strips user message from preview to keep editor clean. The message
 * is visible in main textarea, so showing it again would be redundant.
 * 
 * Use Cases:
 * - User switches patient → preview updates with new medical history
 * - User changes triage fields → preview updates with new metadata
 * - User switches modes → preview updates with mode-specific template
 * - User expands editor → initial preview loaded
 * 
 * @param {boolean} force - Force refresh even if user has edited prompt
 */
async function refreshPromptPreview(force = false) {
    const msgVal = document.getElementById('msg')?.value || '';
    const patientVal = document.getElementById('p-select')?.value || '';
    const promptBox = document.getElementById('prompt-preview');
    if (!promptBox) return;
    if (!force && promptBox.dataset.autofilled === 'false') return;
    const fd = new FormData();
    fd.append('message', msgVal);
    fd.append('patient', patientVal);
    fd.append('mode', currentMode);
    if (currentMode === 'triage') {
        fd.append('triage_consciousness', document.getElementById('triage-consciousness')?.value || '');
        fd.append('triage_breathing_status', document.getElementById('triage-breathing-status')?.value || '');
        fd.append('triage_pain_level', document.getElementById('triage-pain-level')?.value || '');
        fd.append('triage_main_problem', document.getElementById('triage-main-problem')?.value || '');
        fd.append('triage_temperature', document.getElementById('triage-temperature')?.value || '');
        fd.append('triage_circulation', document.getElementById('triage-circulation')?.value || '');
        fd.append('triage_cause', document.getElementById('triage-cause')?.value || '');
    }
    try {
        const res = await fetch('/api/chat/preview', { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        const data = await res.json();
        promptBox.value = stripUserMessageFromPrompt(data.prompt || '', msgVal, data.mode || currentMode);
        promptBox.dataset.autofilled = 'true';
        try { localStorage.setItem(PROMPT_PREVIEW_CONTENT_KEY, promptBox.value); } catch (err) { /* ignore */ }
    } catch (err) {
        promptBox.value = `Unable to build prompt: ${err.message}`;
        promptBox.dataset.autofilled = 'true';
    }
}

/**
 * Toggle visibility of prompt preview/editor panel.
 * 
 * Manages:
 * - Container visibility (show/hide)
 * - Arrow icon rotation (▸ collapsed, ▾ expanded)
 * - Refresh button visibility
 * - ARIA attributes for accessibility
 * - State persistence to localStorage
 * 
 * When Opened:
 * - Triggers auto-refresh to show current prompt
 * - Focuses prompt textarea for immediate editing
 * - Shows refresh button
 * - Persists expanded state
 * 
 * When Closed:
 * - Hides container
 * - Rotates arrow to collapsed state
 * - Hides refresh button
 * - Persists collapsed state
 * 
 * Advanced Feature:
 * Prompt editor is hidden by default for beginner/standard users.
 * Advanced/developer users can expand to see and customize prompts.
 * 
 * @param {HTMLElement} btn - Header button element (or auto-finds)
 * @param {boolean} forceOpen - Force specific state (null=toggle, true=open, false=close)
 */
function togglePromptPreviewArrow(btn, forceOpen = null) {
    const header = btn || document.getElementById('prompt-preview-header');
    const container = document.getElementById('prompt-preview-container') || header?.nextElementSibling;
    const refreshRow = document.getElementById('prompt-refresh-row') || container?.querySelector('#prompt-refresh-row');
    const icon = header?.querySelector('.detail-icon');
    if (!container || !header) return;
    const shouldOpen = forceOpen === null ? container.style.display !== 'block' : !!forceOpen;
    container.style.display = shouldOpen ? 'block' : 'none';
    if (icon) icon.textContent = shouldOpen ? '▾' : '▸';
    header.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    if (refreshRow) refreshRow.style.display = shouldOpen ? 'flex' : 'none';
    try { localStorage.setItem(PROMPT_PREVIEW_STATE_KEY, shouldOpen ? 'true' : 'false'); } catch (err) { /* ignore */ }
    if (shouldOpen) {
        refreshPromptPreview();
        const promptBox = document.getElementById('prompt-preview') || container.querySelector('#prompt-preview');
        if (promptBox) promptBox.focus();
    }
}

/**
 * Clear chat response display area.
 * 
 * Behavior by Mode:
 * - LOGGING ON: Confirms before clearing, reminds user of history location
 * - LOGGING OFF: Warns that response wasn't saved, confirms deletion
 * 
 * Sets SKIP_LAST_CHAT_KEY to prevent restoring cleared conversation on
 * next page load.
 * 
 * User Guidance:
 * In logging mode, explains that previous (saved) responses remain
 * accessible via Crew Health & Log tab organized by crew member.
 */
function clearDisplay() {
    const display = document.getElementById('display');
    if (!display) return;
    if (isPrivate) {
        const confirmed = confirm('Logging is OFF. Clear this response? It has not been saved.');
        if (!confirmed) return;
    } else {
        alert('The previous response has been cleared. Previous responses that were logged are organized by Crew Member name in the Consultation Log.');
    }
    display.innerHTML = '';
    try { localStorage.setItem(SKIP_LAST_CHAT_KEY, '1'); } catch (err) { /* ignore */ }
}

// Expose inline handlers
window.togglePromptPreviewArrow = togglePromptPreviewArrow;
window.clearDisplay = clearDisplay;
window.refreshPromptPreview = refreshPromptPreview;
