/* =============================================================================
 * Author: Rick Escher
 * Project: SailingMedAdvisor
 * Context: Google HAI-DEF Framework
 * Models: Google MedGemmas
 * Program: Kaggle Impact Challenge
 * ========================================================================== */
/*
File: static/js/chat.js
Author notes: Front-end controller for MedGemma AI chat interface.

Key Responsibilities:
- Dual-mode chat system (Triage vs Inquiry consultations)
- Dynamic prompt composition with patient context injection
- Privacy/logging toggle (saves history or runs ephemeral)
- Model selection and performance metrics tracking
- Chat session restoration (resume previous consultations)
- Triage-specific metadata fields (consciousness, breathing, pain, etc.)
- LocalStorage persistence of chat state across sessions
- Real-time prompt preview with edit capability
- Integration with crew/patient selection from crew.js

Chat Modes:
1. TRIAGE MODE: Medical emergency assessment with structured fields
   - Includes: patient condition snapshot + clinical triage pathway selectors
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
- sailingmed:chatState: Per-mode input field persistence
- sailingmed:skipLastChat: Flag to skip restoring last chat on load

Integration Points:
- crew.js: Patient selection dropdown, history display
- settings.js: Custom prompts, model configuration
- main.js: Tab navigation, data loading coordination
*/

// HTML escaping utility (from utils.js or fallback)
const escapeHtml = (window.Utils && window.Utils.escapeHtml) ? window.Utils.escapeHtml : (str) => str;
const renderAssistantMarkdownChat = (window.Utils && window.Utils.renderAssistantMarkdown)
    ? window.Utils.renderAssistantMarkdown
    : (txt) => (window.marked && typeof window.marked.parse === 'function')
        ? window.marked.parse(txt || '', { gfm: true, breaks: true })
        : escapeHtml(txt || '').replace(/\n/g, '<br>');

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

// Active consultation session state, tracked independently by mode.
function createEmptyModeSession() {
    return {
        sessionId: null,
        sessionMeta: null,
        transcript: [],
        promptBase: '',
    };
}

const modeSessions = {
    triage: createEmptyModeSession(),
    inquiry: createEmptyModeSession(),
};

/**
 * normalizeMode: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function normalizeMode(mode) {
    return mode === 'inquiry' ? 'inquiry' : 'triage';
}

/**
 * getModeSession: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function getModeSession(mode = currentMode) {
    return modeSessions[normalizeMode(mode)];
}

// LocalStorage persistence keys
const LAST_PROMPT_KEY = 'sailingmed:lastPrompt';
const LAST_PATIENT_KEY = 'sailingmed:lastPatient';
const LAST_CHAT_MODE_KEY = 'sailingmed:lastChatMode';
const LOGGING_MODE_KEY = 'sailingmed:loggingOff';
const PROMPT_PREVIEW_STATE_KEY = 'sailingmed:promptPreviewOpen';
const PROMPT_PREVIEW_CONTENT_KEY = 'sailingmed:promptPreviewContent';
const CHAT_STATE_KEY = 'sailingmed:chatState';
const SKIP_LAST_CHAT_KEY = 'sailingmed:skipLastChat';
const EMPTY_RESPONSE_PLACEHOLDER_TEXT = 'No consultation response yet. Expand "Start New Triage Consultation" above and submit to generate guidance.';

/**
 * buildEmptyResponsePlaceholderHtml: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function buildEmptyResponsePlaceholderHtml() {
    return `<div class="chat-empty-state">${escapeHtml(EMPTY_RESPONSE_PLACEHOLDER_TEXT)}</div>`;
}

// Model performance tracking: { model: {count, total_ms, avg_ms} }
let chatMetrics = {};

// Hierarchical triage decision tree loaded from server
let triageDecisionTree = null;

const TRIAGE_PATHWAY_FIELD_IDS = [
    'triage-domain',
    'triage-problem',
    'triage-anatomy',
    'triage-severity',
    'triage-mechanism',
];
const TRIAGE_CONDITION_FIELD_IDS = [
    'triage-consciousness',
    'triage-breathing',
    'triage-circulation',
    'triage-overall-stability',
];
const TRIAGE_FIELD_IDS = [
    ...TRIAGE_CONDITION_FIELD_IDS,
    ...TRIAGE_PATHWAY_FIELD_IDS,
];
const TRIAGE_FIELD_WRAPPERS = {
    'triage-domain': 'triage-domain-field',
    'triage-problem': 'triage-problem-field',
    'triage-anatomy': 'triage-anatomy-field',
    'triage-severity': 'triage-severity-field',
    'triage-mechanism': 'triage-mechanism-field',
    'triage-consciousness': 'triage-consciousness-field',
    'triage-breathing': 'triage-breathing-field',
    'triage-circulation': 'triage-circulation-field',
    'triage-overall-stability': 'triage-overall-stability-field',
};

let promptRefreshTimer = null;
let blockerCountdownTimer = null;
let triageSupplementDialogShownThisStart = false;

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
 * normalizeTriageNodeKey: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function normalizeTriageNodeKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * formatTriageOptionLabel: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function formatTriageOptionLabel(value) {
    return String(value || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * lookupTriageNode: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function lookupTriageNode(options, selectedValue) {
    if (!options || typeof options !== 'object') return { key: '', node: null };
    const selected = String(selectedValue || '').trim();
    if (!selected) return { key: '', node: null };
    if (Object.prototype.hasOwnProperty.call(options, selected)) {
        return { key: selected, node: options[selected] };
    }
    const wanted = normalizeTriageNodeKey(selected);
    if (!wanted) return { key: '', node: null };
    const matchKey = Object.keys(options).find((key) => normalizeTriageNodeKey(key) === wanted);
    if (!matchKey) return { key: '', node: null };
    return { key: matchKey, node: options[matchKey] };
}

/**
 * setTriageSelectOptions: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function setTriageSelectOptions(selectId, values, placeholder = 'Select...') {
    const select = document.getElementById(selectId);
    if (!select) return;
    const safeValues = Array.isArray(values) ? values.filter((v) => String(v || '').trim()) : [];
    const previous = select.value || '';
    select.innerHTML = `<option value="">${placeholder}</option>`;
    safeValues.forEach((val) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = formatTriageOptionLabel(val);
        select.appendChild(opt);
    });
    if (safeValues.includes(previous)) {
        select.value = previous;
    } else {
        select.value = '';
    }
}

/**
 * setTriageFieldVisibility: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function setTriageFieldVisibility(selectId, visible) {
    const wrap = document.getElementById(TRIAGE_FIELD_WRAPPERS[selectId]);
    if (!wrap) return;
    wrap.style.display = visible ? '' : 'none';
}

/**
 * setTriageFieldEnabled: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function setTriageFieldEnabled(selectId, enabled) {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.disabled = !enabled;
}

/**
 * sortTriageLabels: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function sortTriageLabels(values) {
    return (Array.isArray(values) ? values.slice() : []).sort((a, b) =>
        String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' })
    );
}

/**
 * syncTriageTreeSelections: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function syncTriageTreeSelections() {
    const tree = triageDecisionTree?.tree;
    if (!tree || typeof tree !== 'object') return;

    const domainKeys = sortTriageLabels(Object.keys(tree));
    setTriageSelectOptions('triage-domain', domainKeys);
    setTriageFieldVisibility('triage-domain', true);
    setTriageFieldEnabled('triage-domain', true);

    const domainSelect = document.getElementById('triage-domain');
    const domainMatch = lookupTriageNode(tree, domainSelect?.value || '');
    if (domainSelect && !domainMatch.key) {
        domainSelect.value = '';
    }
    const domainNode = (domainMatch.node && typeof domainMatch.node === 'object') ? domainMatch.node : {};

    const problemMap = (domainNode && typeof domainNode.problems === 'object') ? domainNode.problems : {};
    const problemKeys = sortTriageLabels(Object.keys(problemMap));
    setTriageSelectOptions('triage-problem', problemKeys);
    setTriageFieldVisibility('triage-problem', true);
    setTriageFieldEnabled('triage-problem', !!domainMatch.key);

    const problemSelect = document.getElementById('triage-problem');
    const problemMatch = lookupTriageNode(problemMap, problemSelect?.value || '');
    if (problemSelect && !problemMatch.key) {
        problemSelect.value = '';
    }
    const problemNode = (problemMatch.node && typeof problemMatch.node === 'object') ? problemMatch.node : {};

    const anatomyMap = (problemNode && typeof problemNode.anatomy_guardrails === 'object') ? problemNode.anatomy_guardrails : {};
    const severityMap = (problemNode && typeof problemNode.severity_modifiers === 'object') ? problemNode.severity_modifiers : {};
    const mechanismMap = (problemNode && typeof problemNode.mechanism_modifiers === 'object') ? problemNode.mechanism_modifiers : {};

    const anatomyKeys = sortTriageLabels(Object.keys(anatomyMap));
    const severityKeys = sortTriageLabels(Object.keys(severityMap));
    const mechanismKeys = sortTriageLabels(Object.keys(mechanismMap));

    setTriageSelectOptions('triage-anatomy', anatomyKeys, 'Select...');
    setTriageSelectOptions('triage-severity', severityKeys, 'Select...');
    setTriageSelectOptions('triage-mechanism', mechanismKeys, 'Select...');

    const anatomyVisible = anatomyKeys.length > 0;
    const severityVisible = severityKeys.length > 0;
    const mechanismVisible = mechanismKeys.length > 0;
    setTriageFieldVisibility('triage-anatomy', true);
    setTriageFieldVisibility('triage-severity', true);
    setTriageFieldVisibility('triage-mechanism', true);

    const anatomySelect = document.getElementById('triage-anatomy');
    const severitySelect = document.getElementById('triage-severity');
    const mechanismSelect = document.getElementById('triage-mechanism');

    if (!anatomyVisible && anatomySelect) anatomySelect.value = '';
    if (!severityVisible && severitySelect) severitySelect.value = '';
    if (!mechanismVisible && mechanismSelect) mechanismSelect.value = '';

    const canChooseProblem = !!domainMatch.key;
    if (!canChooseProblem && problemSelect) {
        problemSelect.value = '';
    }
    setTriageFieldEnabled('triage-problem', canChooseProblem);

    const canChooseAnatomy = !!domainMatch.key && !!problemMatch.key && anatomyVisible;
    if (!canChooseAnatomy && anatomySelect) {
        anatomySelect.value = '';
    }
    setTriageFieldEnabled('triage-anatomy', canChooseAnatomy);

    const anatomySatisfied = !anatomyVisible || !!(anatomySelect?.value || '');
    const canChooseSeverity = !!domainMatch.key && !!problemMatch.key && severityVisible && anatomySatisfied;
    if (!canChooseSeverity && severitySelect) {
        severitySelect.value = '';
    }
    setTriageFieldEnabled('triage-severity', canChooseSeverity);

    const severitySatisfied = !severityVisible || !!(severitySelect?.value || '');
    const canChooseMechanism = !!domainMatch.key && !!problemMatch.key && mechanismVisible && anatomySatisfied && severitySatisfied;
    if (!canChooseMechanism && mechanismSelect) {
        mechanismSelect.value = '';
    }
    setTriageFieldEnabled('triage-mechanism', canChooseMechanism);
}

async function loadTriageDecisionTree(force = false) {
    if (triageDecisionTree && !force) return triageDecisionTree;
    try {
        const res = await fetch('/api/triage/tree', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const payload = await res.json();
        if (!payload || typeof payload !== 'object' || typeof payload.tree !== 'object') {
            throw new Error('Invalid tree payload');
        }
        triageDecisionTree = payload;
    } catch (err) {
        console.warn('[chat] unable to load triage tree', err);
        triageDecisionTree = null;
    }
    syncTriageTreeSelections();
    return triageDecisionTree;
}

/**
 * schedulePromptRefresh: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function schedulePromptRefresh(delayMs = 140) {
    if (promptRefreshTimer) {
        clearTimeout(promptRefreshTimer);
    }
    promptRefreshTimer = setTimeout(() => {
        promptRefreshTimer = null;
        refreshPromptPreview();
    }, delayMs);
}

/**
 * clearBlockerCountdown: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function clearBlockerCountdown() {
    if (blockerCountdownTimer) {
        clearInterval(blockerCountdownTimer);
        blockerCountdownTimer = null;
    }
}

/**
 * Initialize the prompt preview/editor panel.
 * 
 * Setup Process:
 * 1. Binds click/keyboard handlers to toggle expansion
 * 2. Tracks manual edits to prevent auto-refresh overwrites
 * 3. Restores previous state (expanded/collapsed) from localStorage
 * 4. Pre-populates with default prompt
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
        });
    }
    const msgTextarea = document.getElementById('msg');
    if (msgTextarea && !msgTextarea.dataset.stateBound) {
        msgTextarea.dataset.stateBound = 'true';
        msgTextarea.addEventListener('input', () => {
            persistChatState();
            schedulePromptRefresh();
        });
    }

    if (promptHeader) {
        let shouldOpen = false;
        try {
            shouldOpen = localStorage.getItem(PROMPT_PREVIEW_STATE_KEY) === 'true';
        } catch (err) { /* ignore */ }
        togglePromptPreviewArrow(promptHeader, shouldOpen);
    }

    if (promptBox && promptBox.dataset.autofilled !== 'false' && (!promptBox.value || !promptBox.value.trim())) {
        refreshPromptPreview();
    }
}

if (document.readyState !== 'loading') {
    setupPromptInjectionPanel();
    bindTriageMetaRefresh();
    loadTriageDecisionTree().catch(() => {});
    applyChatState(currentMode);
    loadChatMetrics().catch(() => {});
} else {
    document.addEventListener('DOMContentLoaded', setupPromptInjectionPanel, { once: true });
    document.addEventListener('DOMContentLoaded', bindTriageMetaRefresh, { once: true });
    document.addEventListener('DOMContentLoaded', () => loadTriageDecisionTree().catch(() => {}), { once: true });
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
    const blocker = document.getElementById('chat-blocker');
    if (blocker) blocker.classList.remove('active');
});

/**
 * isSessionActive: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function isSessionActive(modeOverride = currentMode) {
    const modeSession = getModeSession(modeOverride);
    return !!modeSession.sessionId;
}

/**
 * isAdvancedMode: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function isAdvancedMode() {
    return document.body.classList.contains('mode-advanced') || document.body.classList.contains('mode-developer');
}

/**
 * getStartPanelExpanded: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function getStartPanelExpanded() {
    const body = document.getElementById('query-form-body');
    if (!body) return false;
    return body.style.display === '' || body.style.display === 'block';
}

/**
 * setStartPanelExpanded: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function setStartPanelExpanded(expanded) {
    const header = document.getElementById('query-form-header');
    const body = document.getElementById('query-form-body');
    if (!header || !body) return;
    const nextExpanded = !!expanded;
    body.style.display = nextExpanded ? 'block' : 'none';
    const icon = header.querySelector('.detail-icon');
    if (icon) icon.textContent = nextExpanded ? '▾' : '▸';
    if (header.dataset?.prefKey) {
        try { localStorage.setItem(header.dataset.prefKey, nextExpanded.toString()); } catch (err) { /* ignore */ }
    }
    updateStartPanelTitle();
}

/**
 * updateStartPanelTitle: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function updateStartPanelTitle() {
    const queryTitle = document.getElementById('query-form-title');
    if (!queryTitle) return;
    const expanded = getStartPanelExpanded();
    const modeLabel = currentMode === 'triage' ? 'Triage' : 'Inquiry';
    queryTitle.innerText = expanded
        ? `Start New ${modeLabel} Consultation`
        : `Expand to Start a New ${modeLabel} Consultation`;
}

/**
 * resetStartForm: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function resetStartForm() {
    const msg = document.getElementById('msg');
    if (msg) msg.value = '';
    const patientSelect = document.getElementById('p-select');
    if (patientSelect) patientSelect.value = '';
    const ids = [
        ...TRIAGE_FIELD_IDS,
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    try { localStorage.removeItem(LAST_PATIENT_KEY); } catch (err) { /* ignore */ }
    persistChatState();
    resetPromptPreviewToDefault();
}

/**
 * resetConsultationUiForDemo: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function resetConsultationUiForDemo() {
    if (promptRefreshTimer) {
        clearTimeout(promptRefreshTimer);
        promptRefreshTimer = null;
    }
    clearBlockerCountdown();
    isProcessing = false;
    triageSupplementDialogShownThisStart = false;

    Object.assign(modeSessions.triage, createEmptyModeSession());
    Object.assign(modeSessions.inquiry, createEmptyModeSession());

    currentMode = 'triage';

    const display = document.getElementById('display');
    if (display) display.innerHTML = '';
    renderTranscript([]);

    const chatInput = document.getElementById('chat-input');
    if (chatInput) chatInput.value = '';
    const msgInput = document.getElementById('msg');
    if (msgInput) msgInput.value = '';

    const patientSelect = document.getElementById('p-select');
    if (patientSelect) patientSelect.value = '';

    TRIAGE_FIELD_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    syncTriageTreeSelections();

    const modelSelect = document.getElementById('model-select');
    if (modelSelect && modelSelect.options.length) {
        modelSelect.selectedIndex = 0;
    }
    const chatModelSelect = document.getElementById('chat-model-select');
    if (chatModelSelect) {
        if (modelSelect && modelSelect.value) {
            chatModelSelect.value = modelSelect.value;
        } else if (chatModelSelect.options.length) {
            chatModelSelect.selectedIndex = 0;
        }
    }

    const modeSelect = document.getElementById('mode-select');
    if (modeSelect) modeSelect.value = 'triage';

    const promptBox = document.getElementById('prompt-preview');
    if (promptBox) {
        promptBox.value = '';
        promptBox.dataset.autofilled = 'true';
    }
    const promptHeader = document.getElementById('prompt-preview-header');
    const promptContainer = document.getElementById('prompt-preview-container');
    const promptInline = document.getElementById('prompt-refresh-inline');
    if (promptHeader) {
        promptHeader.setAttribute('aria-expanded', 'false');
        const icon = promptHeader.querySelector('.detail-icon');
        if (icon) icon.textContent = '▸';
    }
    if (promptContainer) promptContainer.style.display = 'none';
    if (promptInline) promptInline.style.display = 'none';

    isPrivate = false;

    try {
        localStorage.removeItem(LAST_PROMPT_KEY);
        localStorage.removeItem(LAST_PATIENT_KEY);
        localStorage.removeItem(LAST_CHAT_MODE_KEY);
        localStorage.removeItem(CHAT_STATE_KEY);
        localStorage.removeItem(PROMPT_PREVIEW_CONTENT_KEY);
        localStorage.removeItem(PROMPT_PREVIEW_STATE_KEY);
        localStorage.setItem(LOGGING_MODE_KEY, '0');
        localStorage.setItem(SKIP_LAST_CHAT_KEY, '1');
    } catch (err) { /* ignore */ }

    setStartPanelExpanded(true);
    updateUI();
    syncStartPanelWithConsultationState();
}

/**
 * hasPreviousConsultationResponseOnScreen: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function hasPreviousConsultationResponseOnScreen(modeOverride = currentMode) {
    if (isSessionActive(modeOverride)) return true;
    const display = document.getElementById('display');
    if (!display) return false;
    const hasStructuredContent = !!display.querySelector('.chat-message, .response-block');
    if (!hasStructuredContent) return false;
    const text = (display.textContent || '').trim();
    if (!text) return false;
    return text !== EMPTY_RESPONSE_PLACEHOLDER_TEXT;
}

/**
 * restorePromptDefaultsForCurrentMode: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function restorePromptDefaultsForCurrentMode() {
    const modeSession = getModeSession(currentMode);
    modeSession.promptBase = '';
    resetPromptPreviewToDefault();
}

/**
 * clearConsultationForNewStart: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function clearConsultationForNewStart({ setSkipLastChat = true } = {}) {
    if (isSessionActive(currentMode)) {
        endActiveSession({ clearDisplay: true, mode: currentMode });
    } else {
        const modeSession = getModeSession(currentMode);
        modeSession.sessionId = null;
        modeSession.sessionMeta = null;
        modeSession.transcript = [];
        modeSession.promptBase = '';
        syncCurrentModeTranscriptView();
        const chatInput = document.getElementById('chat-input');
        if (chatInput) chatInput.value = '';
    }
    resetStartForm();
    if (setSkipLastChat) {
        try { localStorage.setItem(SKIP_LAST_CHAT_KEY, '1'); } catch (err) { /* ignore */ }
    }
}

/**
 * handleStartPanelToggle: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function handleStartPanelToggle(expanded) {
    const isExpanded = !!expanded;
    if (!isExpanded) {
        updateStartPanelTitle();
        return;
    }
    const hadPrevious = hasPreviousConsultationResponseOnScreen(currentMode);
    if (hadPrevious) {
        clearConsultationForNewStart({ setSkipLastChat: true });
        const msg = isPrivate
            ? 'Previous consultation response was cleared from the screen. Logging is OFF, so it was not saved to the Consultation Log.'
            : 'Previous consultation response was saved to the Consultation Log and cleared from the screen.';
        alert(msg);
    }
    restorePromptDefaultsForCurrentMode();
    updateStartPanelTitle();
}

/**
 * syncStartPanelWithConsultationState: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function syncStartPanelWithConsultationState() {
    const hasPrevious = hasPreviousConsultationResponseOnScreen(currentMode);
    setStartPanelExpanded(!hasPrevious);
}

/**
 * syncCurrentModeTranscriptView: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function syncCurrentModeTranscriptView() {
    const modeSession = getModeSession(currentMode);
    if (isSessionActive(currentMode)) {
        renderTranscript(modeSession.transcript || []);
    } else {
        renderTranscript([]);
    }
}

/**
 * endActiveSession: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function endActiveSession({ clearDisplay = true, mode = currentMode } = {}) {
    const modeSession = getModeSession(mode);
    modeSession.sessionId = null;
    modeSession.sessionMeta = null;
    modeSession.transcript = [];
    modeSession.promptBase = '';
    if (clearDisplay && normalizeMode(mode) === normalizeMode(currentMode)) {
        syncCurrentModeTranscriptView();
    }
    if (normalizeMode(mode) === normalizeMode(currentMode)) {
        const chatInput = document.getElementById('chat-input');
        if (chatInput) chatInput.value = '';
    }
    updateUI();
}

/**
 * capturePromptBaseForSession: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function capturePromptBaseForSession() {
    if (!isAdvancedMode()) return '';
    const promptBox = document.getElementById('prompt-preview');
    if (!promptBox) return '';
    if (promptBox.dataset.autofilled === 'false' && promptBox.value.trim()) {
        return cleanPromptWhitespace(promptBox.value);
    }
    return '';
}

/**
 * setStartFormDisabled: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function setStartFormDisabled(disabled) {
    const ids = [
        'p-select',
        'model-select',
        'msg',
        ...TRIAGE_FIELD_IDS,
        'priv-btn',
        'prompt-preview',
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (disabled) {
            el.setAttribute('disabled', 'disabled');
        } else {
            el.removeAttribute('disabled');
        }
    });
}

/**
 * syncModelSelects: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function syncModelSelects(sourceId) {
    const primary = document.getElementById('model-select');
    const chatModel = document.getElementById('chat-model-select');
    if (!primary || !chatModel) return;
    if (sourceId === 'model-select') {
        chatModel.value = primary.value;
    } else if (sourceId === 'chat-model-select') {
        primary.value = chatModel.value;
    } else if (!chatModel.value && primary.value) {
        chatModel.value = primary.value;
    } else if (!primary.value && chatModel.value) {
        primary.value = chatModel.value;
    }
}

/**
 * updateChatComposerVisibility: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function updateChatComposerVisibility() {
    const composer = document.getElementById('chat-composer');
    if (!composer) return;
    composer.style.display = isSessionActive() ? 'flex' : 'none';
}

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
        modeSelect.disabled = false;
    }
    const triageConditionContainer = document.getElementById('triage-condition-container');
    if (triageConditionContainer) {
        triageConditionContainer.style.display = currentMode === 'triage' ? 'block' : 'none';
    }
    const triagePathwayContainer = document.getElementById('triage-pathway-container');
    if (triagePathwayContainer) {
        triagePathwayContainer.style.display = currentMode === 'triage' ? 'block' : 'none';
    }
    const triageMeta = document.getElementById('triage-meta-selects');
    if (triageMeta) {
        triageMeta.style.display = currentMode === 'triage' ? 'grid' : 'none';
    }
    updateStartPanelTitle();

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
        runBtn.innerText = currentMode === 'triage'
            ? 'Submit to Start Triage Consultation'
            : 'Submit to Start Inquiry Consultation';
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
    syncModelSelects();
    updateChatComposerVisibility();
    setStartFormDisabled(isSessionActive());
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
 * - Consciousness
 * - Breathing
 * - Circulation
 * - Overall Stability
 * - Domain
 * - Problem / Injury Type
 * - Anatomy
 * - Severity / Complication
 * - Mechanism / Cause
 */
function bindTriageMetaRefresh() {
    const ids = [...TRIAGE_FIELD_IDS];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el && !el.dataset.tmodeBound) {
            el.dataset.tmodeBound = 'true';
            el.addEventListener('change', () => {
                if (TRIAGE_PATHWAY_FIELD_IDS.includes(id)) {
                    syncTriageTreeSelections();
                }
                persistChatState();
                schedulePromptRefresh(0);
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
 *       "triage-domain": "Trauma",
 *       "triage-problem": "Fracture",
 *       "triage-anatomy": "Leg / Foot",
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
    const patientEl = document.getElementById('p-select');
    const modelEl = document.getElementById('model-select');
    const chatModelEl = document.getElementById('chat-model-select');
    state[mode] = state[mode] || {};
    state[mode].msg = msgEl ? msgEl.value : '';
    state[mode].patient = patientEl ? patientEl.value : '';
    state[mode].start_model = modelEl ? modelEl.value : '';
    state[mode].chat_model = chatModelEl ? chatModelEl.value : '';
    state[mode].is_private = !!isPrivate;
    if (mode === 'triage') {
        const ids = [...TRIAGE_FIELD_IDS];
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
    if (msgEl) {
        msgEl.value = typeof modeState.msg === 'string' ? modeState.msg : '';
    }
    if (mode === 'triage') {
        TRIAGE_FIELD_IDS.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        syncTriageTreeSelections();
        if (modeState.fields && typeof modeState.fields === 'object') {
            const orderedIds = [
                'triage-consciousness',
                'triage-breathing',
                'triage-circulation',
                'triage-overall-stability',
                'triage-domain',
                'triage-problem',
                'triage-anatomy',
                'triage-severity',
                'triage-mechanism',
            ];
            orderedIds.forEach((id) => {
                const el = document.getElementById(id);
                if (el && typeof modeState.fields[id] === 'string') {
                    el.value = modeState.fields[id];
                    syncTriageTreeSelections();
                }
            });
        }
    }

    const patientEl = document.getElementById('p-select');
    if (patientEl && typeof modeState.patient === 'string') {
        const hasValue = Array.from(patientEl.options).some((o) => o.value === modeState.patient);
        if (hasValue) {
            patientEl.value = modeState.patient;
        }
    }
    const modelEl = document.getElementById('model-select');
    if (modelEl && typeof modeState.start_model === 'string') {
        const hasValue = Array.from(modelEl.options).some((o) => o.value === modeState.start_model);
        if (hasValue) {
            modelEl.value = modeState.start_model;
        }
    }
    const chatModelEl = document.getElementById('chat-model-select');
    if (chatModelEl && typeof modeState.chat_model === 'string') {
        const hasValue = Array.from(chatModelEl.options).some((o) => o.value === modeState.chat_model);
        if (hasValue) {
            chatModelEl.value = modeState.chat_model;
        }
    }
    if (typeof modeState.is_private === 'boolean') {
        isPrivate = modeState.is_private;
        try { localStorage.setItem(LOGGING_MODE_KEY, isPrivate ? '1' : '0'); } catch (err) { /* ignore */ }
    }
    syncModelSelects();
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
    if (isSessionActive()) {
        alert('Logging is locked for the current session. Start a new consultation to change it.');
        return;
    }
    isPrivate = !isPrivate;
    const btn = document.getElementById('priv-btn');
    btn.style.background = isPrivate ? 'var(--triage)' : '#333';
    btn.style.border = isPrivate ? '2px solid #fff' : '1px solid #222';
    btn.innerText = isPrivate ? 'LOGGING: OFF' : 'LOGGING: ON';
    try { localStorage.setItem(LOGGING_MODE_KEY, isPrivate ? '1' : '0'); } catch (err) { /* ignore */ }
    persistChatState(currentMode);
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
function buildSessionMetaPayload({ initialQuery, patientId, patientName, mode }) {
    const modeKey = normalizeMode(mode || currentMode);
    const modeSession = getModeSession(modeKey);
    const base = modeSession.sessionMeta || {};
    const startedAt = base.started_at || base.date || new Date().toISOString().slice(0, 16).replace('T', ' ');
    const meta = {
        session_id: modeSession.sessionId || base.session_id,
        mode: modeKey || base.mode || currentMode,
        patient_id: patientId ?? base.patient_id,
        patient: patientName ?? base.patient,
        initial_query: base.initial_query || initialQuery,
        started_at: startedAt,
    };
    if (modeSession.promptBase) meta.prompt_base = modeSession.promptBase;
    if (base.triage_path && typeof base.triage_path === 'object') {
        meta.triage_path = base.triage_path;
    } else if (modeKey === 'triage') {
        const path = {
            domain: document.getElementById('triage-domain')?.value || '',
            problem: document.getElementById('triage-problem')?.value || '',
            anatomy: document.getElementById('triage-anatomy')?.value || '',
            severity: document.getElementById('triage-severity')?.value || '',
            mechanism: document.getElementById('triage-mechanism')?.value || '',
        };
        const filtered = Object.fromEntries(Object.entries(path).filter(([, v]) => !!String(v || '').trim()));
        if (Object.keys(filtered).length) {
            meta.triage_path = filtered;
        }
    }
    return meta;
}

async function submitChatMessage({ message, isStart, force28b = false }) {
    const txt = (message || '').trim();
    if (!txt || isProcessing) return;
    isProcessing = true;
    if (typeof window.flushSettingsBeforeChat === 'function') {
        try {
            const synced = await window.flushSettingsBeforeChat();
            if (!synced) {
                alert('Unable to save Settings values before consultation. Please review Settings and try again.');
                isProcessing = false;
                return;
            }
        } catch (err) {
            alert(`Unable to sync Settings before consultation: ${err.message || err}`);
            isProcessing = false;
            return;
        }
    }
    lastPrompt = txt;
    const mode = normalizeMode(isStart ? currentMode : currentMode);
    const modeSession = getModeSession(mode);
    const modelSelectId = isStart ? 'model-select' : 'chat-model-select';
    const modelName = document.getElementById(modelSelectId)?.value || 'google/medgemma-1.5-4b-it';
    const blocker = document.getElementById('chat-blocker');
    if (blocker) {
        clearBlockerCountdown();
        const title = blocker.querySelector('h3');
        if (title) title.textContent = mode === 'triage' ? 'Processing Triage Chat…' : 'Processing Inquiry Chat…';
        const modelLine = document.getElementById('chat-model-line');
        const etaLine = document.getElementById('chat-eta-line');
        if (modelLine) modelLine.textContent = `Model: ${modelName}`;
        const avgMs = (chatMetrics[modelName]?.avg_ms) || (modelName.toLowerCase().includes('27b') ? 60000 : 20000);
        if (etaLine) {
            const expectedSeconds = Math.max(1, Math.round(avgMs / 1000));
            let remainingSeconds = expectedSeconds;
            etaLine.textContent = `Expected duration: ~${expectedSeconds}s • Remaining: ${remainingSeconds}s`;
            blockerCountdownTimer = setInterval(() => {
                remainingSeconds = Math.max(0, remainingSeconds - 1);
                const remainingLabel = remainingSeconds > 0 ? `${remainingSeconds}s` : '<1s';
                etaLine.textContent = `Expected duration: ~${expectedSeconds}s • Remaining: ${remainingLabel}`;
            }, 1000);
        }
        blocker.classList.add('active');
    }

    const display = document.getElementById('display');
    const loadingDiv = document.createElement('div');
    loadingDiv.id = 'loading-indicator';
    loadingDiv.className = 'loading-indicator';
    loadingDiv.innerHTML = '🔄 Analyzing...';
    if (display) {
        display.appendChild(loadingDiv);
        display.scrollTop = display.scrollHeight;
    }

    document.getElementById('run-btn').disabled = true;
    const sendBtn = document.getElementById('chat-send-btn');
    if (sendBtn) sendBtn.disabled = true;

    try {
        const fd = new FormData();
        fd.append('message', txt);
        const patientVal = document.getElementById('p-select')?.value || '';
        const patientName = document.getElementById('p-select')?.selectedOptions?.[0]?.textContent || '';
        if (isStart) {
            try { localStorage.setItem(LAST_PATIENT_KEY, patientVal); } catch (err) { /* ignore */ }
            fd.append('patient', patientVal);
        } else {
            fd.append('patient', modeSession.sessionMeta?.patient_id || modeSession.sessionMeta?.patient || patientVal || '');
        }
        fd.append('mode', mode);
        fd.append('private', isPrivate ? 'true' : 'false');
        fd.append('model_choice', modelName);
        fd.append('force_28b', force28b ? 'true' : 'false');
        if (isStart && mode === 'triage') {
            fd.append('triage_consciousness', document.getElementById('triage-consciousness')?.value || '');
            fd.append('triage_breathing', document.getElementById('triage-breathing')?.value || '');
            fd.append('triage_circulation', document.getElementById('triage-circulation')?.value || '');
            fd.append('triage_overall_stability', document.getElementById('triage-overall-stability')?.value || '');
            fd.append('triage_domain', document.getElementById('triage-domain')?.value || '');
            fd.append('triage_problem', document.getElementById('triage-problem')?.value || '');
            fd.append('triage_anatomy', document.getElementById('triage-anatomy')?.value || '');
            fd.append('triage_severity', document.getElementById('triage-severity')?.value || '');
            fd.append('triage_mechanism', document.getElementById('triage-mechanism')?.value || '');
        }
        fd.append('session_action', isStart ? 'start' : 'message');
        if (!isStart && modeSession.sessionId) {
            fd.append('session_id', modeSession.sessionId);
        }
        if (!isStart && modeSession.transcript.length) {
            fd.append('transcript', JSON.stringify(modeSession.transcript));
        }
        const metaPayload = buildSessionMetaPayload({
            initialQuery: txt,
            patientId: patientVal,
            patientName,
            mode,
        });
        fd.append('session_meta', JSON.stringify(metaPayload));

        const triageMeta = isStart && mode === 'triage' ? collectTriageMeta() : null;
        if (modeSession.promptBase) {
            const overridePrompt = buildSessionOverridePrompt(modeSession.promptBase, modeSession.transcript, txt, triageMeta, mode);
            if (overridePrompt) {
                fd.append('override_prompt', overridePrompt);
            }
        }

        const response = await fetch('/api/chat', { method: 'POST', body: fd, credentials: 'same-origin' });
        const res = await response.json();

        if (
            isStart
            && mode === 'triage'
            && res?.triage_pathway_supplemented
            && !triageSupplementDialogShownThisStart
        ) {
            alert(
                'Clinical Triage Pathway is not fully defined for the selected choices. '
                + 'Your selection(s) will be supplemented with the general triage prompt from Settings.'
            );
            triageSupplementDialogShownThisStart = true;
        }

        loadingDiv.remove();

        if (res.gpu_busy) {
            if (display && normalizeMode(currentMode) === mode) {
                display.innerHTML += `<div class="response-block" style="border-left-color:#b26a00;"><b>GPU BUSY:</b> ${res.error || 'GPU is currently busy. Please retry in a moment.'}</div>`;
                display.scrollTop = display.scrollHeight;
            }
            if (res.error) {
                alert(res.error);
            }
        } else if (res.confirm_28b) {
            const ok = confirm(res.error || 'The 28B model on CPU can take an hour or more. Continue?');
            if (ok) {
                isProcessing = false;
                document.getElementById('run-btn').disabled = false;
                if (sendBtn) sendBtn.disabled = false;
                return submitChatMessage({ message: txt, isStart, force28b: true });
            }
            if (display && normalizeMode(currentMode) === mode) {
                display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>INFO:</b> ${res.error || 'Cancelled running 28B model.'}</div>`;
            }
        } else if (res.error) {
            if (display && normalizeMode(currentMode) === mode) {
                display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>ERROR:</b> ${res.error}</div>`;
            }
        } else {
            modeSession.sessionId = res.session_id || modeSession.sessionId;
            modeSession.transcript = Array.isArray(res.transcript) ? res.transcript : modeSession.transcript;
            modeSession.sessionMeta = {
                ...(metaPayload || {}),
                ...(res.session_meta || {}),
                session_id: modeSession.sessionId,
                mode,
            };
            if (res.model && res.model_metrics) {
                chatMetrics[res.model] = res.model_metrics;
            } else if (res.model && Number.isFinite(Number(res.duration_ms))) {
                const durMs = Number(res.duration_ms);
                const current = chatMetrics[res.model] || { count: 0, total_ms: 0, avg_ms: 0 };
                const nextCount = (current.count || 0) + 1;
                const nextTotal = (current.total_ms || 0) + durMs;
                chatMetrics[res.model] = {
                    count: nextCount,
                    total_ms: nextTotal,
                    avg_ms: nextTotal / nextCount,
                };
            }
            if (normalizeMode(currentMode) === mode) {
                renderTranscript(modeSession.transcript, { scrollTo: 'latest-assistant-start' });
            }
            updateUI();
            if (normalizeMode(currentMode) === mode) {
                syncStartPanelWithConsultationState();
            }
            try { localStorage.setItem(SKIP_LAST_CHAT_KEY, '0'); } catch (err) { /* ignore */ }
            if (typeof loadData === 'function') {
                loadData();
            }
            const chatInput = document.getElementById('chat-input');
            if (chatInput) chatInput.value = '';
        }

        persistChatState();
        try {
            localStorage.setItem(LAST_PROMPT_KEY, lastPrompt);
            localStorage.setItem(LAST_CHAT_MODE_KEY, currentMode);
        } catch (err) { /* ignore */ }
    } catch (error) {
        loadingDiv.remove();
        if (display && normalizeMode(currentMode) === mode) {
            display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>ERROR:</b> ${error.message}</div>`;
        }
    } finally {
        isProcessing = false;
        if (isStart) {
            triageSupplementDialogShownThisStart = false;
        }
        clearBlockerCountdown();
        const blocker = document.getElementById('chat-blocker');
        if (blocker) blocker.classList.remove('active');
        document.getElementById('run-btn').disabled = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}

async function runChat(promptText = null, force28b = false) {
    if (isSessionActive(currentMode)) {
        alert('Expand "Start New Consultation" to begin a new consultation.');
        return;
    }
    if (promptRefreshTimer) {
        clearTimeout(promptRefreshTimer);
        promptRefreshTimer = null;
    }
    triageSupplementDialogShownThisStart = false;
    const previewData = await refreshPromptPreview();
    if (currentMode === 'triage' && previewData?.triage_pathway_supplemented) {
        alert(
            'Clinical Triage Pathway is not fully defined for the selected choices. '
            + 'Your selection(s) will be supplemented with the general triage prompt from Settings.'
        );
        triageSupplementDialogShownThisStart = true;
    }
    const modeSession = getModeSession(currentMode);
    modeSession.promptBase = capturePromptBaseForSession();
    await submitChatMessage({ message: promptText || document.getElementById('msg').value, isStart: true, force28b });
}

async function sendChatMessage() {
    if (!isSessionActive(currentMode)) {
        alert('Start a new consultation first.');
        return;
    }
    const input = document.getElementById('chat-input');
    const message = input ? input.value : '';
    await submitChatMessage({ message, isStart: false });
}


// Handle Enter key for submission
document.addEventListener('DOMContentLoaded', () => {
    console.log('[DEBUG] chat.js DOMContentLoaded');
    setupPromptInjectionPanel();
    loadTriageDecisionTree()
        .then(() => {
            applyChatState(currentMode);
            persistChatState(currentMode);
            schedulePromptRefresh(0);
        })
        .catch(() => {});
    const msgTextarea = document.getElementById('msg');
    if (msgTextarea) {
        msgTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                runChat();
            }
        });
    }
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }
    const modelSelect = document.getElementById('model-select');
    if (modelSelect && !modelSelect.dataset.bound) {
        modelSelect.dataset.bound = 'true';
        modelSelect.addEventListener('change', () => {
            syncModelSelects('model-select');
            persistChatState(currentMode);
        });
    }
    const chatModelSelect = document.getElementById('chat-model-select');
    if (chatModelSelect && !chatModelSelect.dataset.bound) {
        chatModelSelect.dataset.bound = 'true';
        chatModelSelect.addEventListener('change', () => {
            syncModelSelects('chat-model-select');
            persistChatState(currentMode);
        });
    }
    const patientSelect = document.getElementById('p-select');
    if (patientSelect && !patientSelect.dataset.chatModeBound) {
        patientSelect.dataset.chatModeBound = 'true';
        patientSelect.addEventListener('change', () => {
            persistChatState(currentMode);
            schedulePromptRefresh(0);
        });
    }
    const savedPrompt = localStorage.getItem(LAST_PROMPT_KEY);
    if (savedPrompt) lastPrompt = savedPrompt;

    // Debug current patient select state
    const pSelect = document.getElementById('p-select');
    if (pSelect) {
        console.log('[DEBUG] p-select initial options', pSelect.options.length, Array.from(pSelect.options).map(o => o.value));
    } else {
        console.warn('[DEBUG] p-select not found on DOMContentLoaded');
    }
});

/**
 * Restore a previous consultation session from history.
 * 
 * Restoration Process:
 * 1. Loads full history from server
 * 2. Finds target entry by ID
 * 3. Switches to correct mode
 * 4. Restores patient selection
 * 5. Loads full transcript into the chat UI
 * 
 * Use Cases:
 * - Continue interrupted consultations
 * - Follow up after implementing advice
 * - Review and expand on previous diagnosis
 * - Share context with relief crew
 * 
 * @param {string} historyId - Unique ID of history entry to restore
 */
async function restoreChatSession(historyId) {
    if (!historyId) return;
    if (isProcessing) return;
    try {
        const entry = await loadHistoryEntryById(historyId);
        if (!entry) {
            alert('Unable to restore: history entry not found.');
            return;
        }
        const restored = restoreHistoryEntrySession(entry, {
            focusInput: true,
            forceLoggingOn: true,
            notifyRestored: true,
            navigateToChat: true,
            allowTakeover: true,
        });
        if (!restored) return;
    } catch (err) {
        alert(`Unable to restore session: ${err.message}`);
    }
}

/**
 * historyEntryTimestamp: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function historyEntryTimestamp(entry) {
    if (!entry || typeof entry !== 'object') return Number.NEGATIVE_INFINITY;
    const raw = entry.updated_at || entry.date || '';
    if (!raw) return Number.NEGATIVE_INFINITY;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const ts = Date.parse(normalized);
    return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts;
}

/**
 * findMostRecentHistoryEntry: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function findMostRecentHistoryEntry(entries) {
    if (!Array.isArray(entries) || !entries.length) return null;
    const sorted = entries.slice().sort((a, b) => historyEntryTimestamp(b) - historyEntryTimestamp(a));
    return sorted[0] || null;
}

async function loadHistoryEntryById(historyId) {
    if (!historyId) return null;
    const res = await fetch('/api/data/history', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`History load failed (${res.status})`);
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data.find((h) => h.id === historyId) || null;
}

async function restoreChatAsReturned(historyId) {
    if (!historyId) return;
    if (isProcessing) return;
    try {
        const entry = await loadHistoryEntryById(historyId);
        if (!entry) {
            alert('Unable to restore: history entry not found.');
            return;
        }
        const restored = restoreHistoryEntrySession(entry, {
            focusInput: false,
            forceLoggingOn: true,
            notifyRestored: false,
            navigateToChat: true,
            allowTakeover: true,
            confirmTakeover: false,
            scrollTo: 'latest-assistant-start',
            forceStartPanelExpanded: true,
        });
        if (!restored) return;
    } catch (err) {
        alert(`Unable to restore session: ${err.message}`);
    }
}

async function restoreLatestChatAsReturned() {
    if (isProcessing) return;
    try {
        const res = await fetch('/api/data/history', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`History load failed (${res.status})`);
        const data = await res.json();
        const latest = findMostRecentHistoryEntry(Array.isArray(data) ? data : []);
        if (!latest || !latest.id) {
            alert('No consultation log entries found to restore.');
            return;
        }
        await restoreChatAsReturned(latest.id);
    } catch (err) {
        alert(`Unable to restore latest session: ${err.message}`);
    }
}

async function activateChatTabForRestore() {
    const chatTabBtn = document.querySelector(`.tab[onclick*="'Chat'"]`);
    if (chatTabBtn && typeof window.showTab === 'function') {
        try {
            const maybePromise = window.showTab(chatTabBtn, 'Chat');
            if (maybePromise && typeof maybePromise.then === 'function') {
                await maybePromise;
            }
            return;
        } catch (err) {
            console.warn('Failed to activate Chat tab during restore', err);
        }
    }
    if (chatTabBtn && typeof chatTabBtn.click === 'function') {
        chatTabBtn.click();
        return;
    }
    const chatPanel = document.getElementById('Chat');
    if (chatPanel) {
        document.querySelectorAll('.content').forEach((c) => { c.style.display = 'none'; });
        chatPanel.style.display = 'flex';
    }
    if (typeof updateUI === 'function') {
        updateUI();
    }
}

/**
 * showRestoredSessionNotice: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function showRestoredSessionNotice(mode, patientName) {
    const display = document.getElementById('display');
    if (!display) return;
    const existing = document.getElementById('chat-restore-notice');
    if (existing) existing.remove();
    const modeLabel = mode === 'inquiry' ? 'Inquiry' : 'Triage';
    const patientPart = patientName ? ` for ${patientName}` : '';
    const notice = document.createElement('div');
    notice.id = 'chat-restore-notice';
    notice.style.cssText = 'margin:0 0 10px 0; padding:8px 10px; border-left:4px solid #2e7d32; background:#eef8ef; color:#13361a; font-size:13px; font-weight:600;';
    notice.textContent = `Session restored: ${modeLabel}${patientPart}. Continue below.`;
    display.prepend(notice);
}

/**
 * setSelectValueByValueOrLabel: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function setSelectValueByValueOrLabel(select, rawValue) {
    if (!select) return;
    const wanted = String(rawValue || '').trim();
    if (!wanted) {
        select.value = '';
        return;
    }
    const options = Array.from(select.options || []);
    const exact = options.find((o) => String(o.value || '').trim() === wanted);
    if (exact) {
        select.value = exact.value;
        return;
    }
    const wantedLower = wanted.toLowerCase();
    const byLabel = options.find((o) => String(o.textContent || '').trim().toLowerCase() === wantedLower);
    select.value = byLabel ? byLabel.value : '';
}

/**
 * restoreStartFormFromHistory: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function restoreStartFormFromHistory(entry, messages, meta, mode) {
    const msgEl = document.getElementById('msg');
    const firstUserMsg = Array.isArray(messages)
        ? messages.find((m) => (m?.role || m?.type || '').toString().toLowerCase() === 'user')
        : null;
    const initialQuery = (meta?.initial_query || entry?.query || firstUserMsg?.message || '').toString();
    if (msgEl) msgEl.value = initialQuery;

    if (mode !== 'triage') {
        persistChatState(mode);
        return;
    }

    const pathFromMeta = (meta?.triage_path && typeof meta.triage_path === 'object') ? meta.triage_path : {};
    const conditionFromMeta = (meta?.triage_condition && typeof meta.triage_condition === 'object') ? meta.triage_condition : {};
    const triageMeta = (firstUserMsg?.triage_meta && typeof firstUserMsg.triage_meta === 'object')
        ? firstUserMsg.triage_meta
        : ((firstUserMsg?.triageMeta && typeof firstUserMsg.triageMeta === 'object') ? firstUserMsg.triageMeta : {});

    const path = {
        domain: pathFromMeta.domain || triageMeta['Domain'] || '',
        problem: pathFromMeta.problem || triageMeta['Problem / Injury Type'] || '',
        anatomy: pathFromMeta.anatomy || triageMeta['Anatomy'] || '',
        severity: pathFromMeta.severity || triageMeta['Severity / Complication'] || '',
        mechanism: pathFromMeta.mechanism || triageMeta['Mechanism / Cause'] || '',
    };
    const condition = {
        consciousness: conditionFromMeta.consciousness || triageMeta['Consciousness'] || '',
        breathing: conditionFromMeta.breathing || triageMeta['Breathing'] || '',
        circulation: conditionFromMeta.circulation || triageMeta['Circulation'] || '',
        overall_stability: conditionFromMeta.overall_stability || triageMeta['Overall Stability'] || '',
    };

    setSelectValueByValueOrLabel(document.getElementById('triage-consciousness'), condition.consciousness);
    setSelectValueByValueOrLabel(document.getElementById('triage-breathing'), condition.breathing);
    setSelectValueByValueOrLabel(document.getElementById('triage-circulation'), condition.circulation);
    setSelectValueByValueOrLabel(document.getElementById('triage-overall-stability'), condition.overall_stability);

    const domainEl = document.getElementById('triage-domain');
    const problemEl = document.getElementById('triage-problem');
    const anatomyEl = document.getElementById('triage-anatomy');
    const severityEl = document.getElementById('triage-severity');
    const mechanismEl = document.getElementById('triage-mechanism');

    setSelectValueByValueOrLabel(domainEl, path.domain);
    if (typeof syncTriageTreeSelections === 'function') syncTriageTreeSelections();

    setSelectValueByValueOrLabel(problemEl, path.problem);
    if (typeof syncTriageTreeSelections === 'function') syncTriageTreeSelections();

    setSelectValueByValueOrLabel(anatomyEl, path.anatomy);
    if (typeof syncTriageTreeSelections === 'function') syncTriageTreeSelections();

    setSelectValueByValueOrLabel(severityEl, path.severity);
    if (typeof syncTriageTreeSelections === 'function') syncTriageTreeSelections();

    setSelectValueByValueOrLabel(mechanismEl, path.mechanism);
    if (typeof syncTriageTreeSelections === 'function') syncTriageTreeSelections();

    persistChatState(mode);
    schedulePromptRefresh(0);
}

/**
 * restoreHistoryEntrySession: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function restoreHistoryEntrySession(entry, options = {}) {
    if (!entry || typeof entry !== 'object') return false;
    if (isProcessing) return false;
    const opts = {
        focusInput: false,
        forceLoggingOn: true,
        notifyRestored: false,
        allowTakeover: false,
        confirmTakeover: true,
        scrollTo: 'bottom',
        forceStartPanelExpanded: false,
        navigateToChat: false,
        ...options,
    };
    const parsed = parseHistoryTranscriptEntry(entry);
    const messages = parsed.messages || [];
    if (!messages.length) return false;
    const meta = parsed.meta || {};
    const mode = (entry.mode || meta.mode || 'triage') === 'inquiry' ? 'inquiry' : 'triage';

    if (isSessionActive(mode)) {
        if (!opts.allowTakeover) return false;
        if (opts.confirmTakeover) {
            const ok = confirm('Restore a previous session? This will end the current session and clear the transcript (it remains in the Consultation Log if logging is on).');
            if (!ok) return false;
        }
        endActiveSession({ clearDisplay: normalizeMode(currentMode) === mode, mode });
        if (normalizeMode(currentMode) === mode) {
            resetStartForm();
        }
    }

    if (normalizeMode(currentMode) !== mode) {
        setMode(mode);
    } else {
        updateUI();
    }

    const patientSelect = document.getElementById('p-select');
    if (patientSelect) {
        let targetVal = entry.patient_id || meta.patient_id || '';
        if (targetVal && Array.from(patientSelect.options).some((o) => o.value === targetVal)) {
            patientSelect.value = targetVal;
        } else if (entry.patient || meta.patient) {
            const name = entry.patient || meta.patient;
            const matchByName = Array.from(patientSelect.options).find((o) => o.textContent === name);
            if (matchByName) patientSelect.value = matchByName.value;
        }
        try { localStorage.setItem(LAST_PATIENT_KEY, patientSelect.value || ''); } catch (err) { /* ignore */ }
    }

    const modeSession = getModeSession(mode);
    modeSession.promptBase = meta.prompt_base || meta.promptBase || '';
    modeSession.sessionId = entry.id || meta.session_id || `session-${Date.now()}`;
    modeSession.transcript = messages;
    modeSession.sessionMeta = {
        session_id: modeSession.sessionId,
        mode,
        patient_id: entry.patient_id || meta.patient_id || '',
        patient: entry.patient || meta.patient || '',
        initial_query: entry.query || meta.initial_query || '',
        started_at: entry.date || meta.started_at || meta.date || '',
        prompt_base: modeSession.promptBase || undefined,
    };

    restoreStartFormFromHistory(entry, messages, meta, mode);

    const promptBox = document.getElementById('prompt-preview');
    if (promptBox && modeSession.promptBase) {
        promptBox.value = modeSession.promptBase;
        promptBox.dataset.autofilled = 'false';
    }
    const chatModelSelect = document.getElementById('chat-model-select');
    if (chatModelSelect && entry.model) {
        chatModelSelect.value = entry.model;
        syncModelSelects('chat-model-select');
    }
    if (opts.forceLoggingOn) {
        isPrivate = false;
        try { localStorage.setItem(LOGGING_MODE_KEY, '0'); } catch (err) { /* ignore */ }
    }

    renderTranscript(modeSession.transcript, { scrollTo: opts.scrollTo || 'bottom' });
    updateUI();
    syncStartPanelWithConsultationState();
    const applyForcedStartPanelExpansion = () => {
        if (
            opts.forceStartPanelExpanded
            && normalizeMode(mode) === 'triage'
            && normalizeMode(currentMode) === 'triage'
        ) {
            setStartPanelExpanded(true);
        }
    };
    if (!opts.navigateToChat) {
        applyForcedStartPanelExpansion();
    }
    persistChatState(mode);
    try { localStorage.setItem(SKIP_LAST_CHAT_KEY, '0'); } catch (err) { /* ignore */ }

    if (opts.navigateToChat) {
        const navPromise = activateChatTabForRestore();
        if (navPromise && typeof navPromise.finally === 'function') {
            navPromise.finally(() => {
                applyForcedStartPanelExpansion();
            });
        } else {
            applyForcedStartPanelExpansion();
        }
    }
    if (opts.focusInput) {
        const chatInput = document.getElementById('chat-input');
        if (chatInput) {
            chatInput.focus();
        }
    }
    if (opts.notifyRestored) {
        showRestoredSessionNotice(mode, modeSession.sessionMeta?.patient || '');
    }
    return true;
}

window.restoreChatSession = restoreChatSession;
window.restoreChatAsReturned = restoreChatAsReturned;
window.restoreLatestChatAsReturned = restoreLatestChatAsReturned;
window.restoreHistoryEntrySession = restoreHistoryEntrySession;
window.sendChatMessage = sendChatMessage;
window.updateStartPanelTitle = updateStartPanelTitle;
window.handleStartPanelToggle = handleStartPanelToggle;
window.syncStartPanelWithConsultationState = syncStartPanelWithConsultationState;
window.renderTranscript = renderTranscript;
window.resetConsultationUiForDemo = resetConsultationUiForDemo;

/**
 * syncPromptPreviewForMode: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function syncPromptPreviewForMode(mode) {
    const promptBox = document.getElementById('prompt-preview');
    if (!promptBox) return;
    const modeSession = getModeSession(mode);
    if (modeSession.promptBase) {
        promptBox.value = modeSession.promptBase;
        promptBox.dataset.autofilled = 'false';
        return;
    }
    // No mode-specific override: reset to auto mode and rebuild prompt from settings.
    promptBox.value = '';
    promptBox.dataset.autofilled = 'true';
    refreshPromptPreview(true);
}

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
    const select = document.getElementById('mode-select');
    if (select) {
        select.value = target;
    }
    applyChatState(target);
    syncPromptPreviewForMode(target);
    updateUI();
    syncCurrentModeTranscriptView();
    syncStartPanelWithConsultationState();
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
 * collectTriageMeta: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function collectTriageMeta() {
    const meta = {};
    const add = (label, value) => {
        if (value) meta[label] = value;
    };
    add('Consciousness', formatTriageOptionLabel(document.getElementById('triage-consciousness')?.value || ''));
    add('Breathing', formatTriageOptionLabel(document.getElementById('triage-breathing')?.value || ''));
    add('Circulation', formatTriageOptionLabel(document.getElementById('triage-circulation')?.value || ''));
    add('Overall Stability', formatTriageOptionLabel(document.getElementById('triage-overall-stability')?.value || ''));
    add('Domain', formatTriageOptionLabel(document.getElementById('triage-domain')?.value || ''));
    add('Problem / Injury Type', formatTriageOptionLabel(document.getElementById('triage-problem')?.value || ''));
    add('Anatomy', formatTriageOptionLabel(document.getElementById('triage-anatomy')?.value || ''));
    add('Mechanism / Cause', formatTriageOptionLabel(document.getElementById('triage-severity')?.value || ''));
    add('Severity / Complication', formatTriageOptionLabel(document.getElementById('triage-mechanism')?.value || ''));
    return meta;
}

/**
 * formatTriageMetaBlock: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function formatTriageMetaBlock(meta) {
    if (!meta || typeof meta !== 'object') return '';
    const lines = Object.entries(meta)
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k}: ${v}`);
    if (!lines.length) return '';
    return `TRIAGE INTAKE:\n${lines.join('\n')}`;
}

/**
 * buildConversationText: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function buildConversationText(messages, nextMessage, nextMeta) {
    const lines = [];
    (messages || []).forEach((msg) => {
        if (!msg || typeof msg !== 'object') return;
        const role = (msg.role || msg.type || '').toString().trim().toLowerCase();
        const content = msg.message || msg.content || '';
        if (!content) return;
        const label = role === 'user' ? 'USER' : 'ASSISTANT';
        if (role === 'user') {
            const metaBlock = formatTriageMetaBlock(msg.triage_meta || msg.triageMeta);
            if (metaBlock) lines.push(metaBlock);
        }
        lines.push(`${label}: ${content}`);
    });
    if (nextMessage) {
        const nextBlock = formatTriageMetaBlock(nextMeta);
        if (nextBlock) lines.push(nextBlock);
        lines.push(`USER: ${nextMessage}`);
    }
    return lines.join('\n').trim();
}

/**
 * buildSessionOverridePrompt: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function buildSessionOverridePrompt(basePrompt, transcript, nextMessage, nextMeta, mode = currentMode) {
    const base = cleanPromptWhitespace(basePrompt);
    if (!base) return '';
    const convo = buildConversationText(transcript, nextMessage, nextMeta);
    if (!convo) return base;
    const label = mode === 'inquiry' ? 'QUERY:' : 'SITUATION:';
    const lines = base.split('\n');
    const idx = lines.findIndex(line => line.trimStart().startsWith(label));
    if (idx !== -1) {
        const labelPos = lines[idx].indexOf(label);
        const prefix = labelPos >= 0 ? lines[idx].slice(0, labelPos) : '';
        lines[idx] = `${prefix}${label}\n${convo}`;
        return lines.join('\n');
    }
    return `${base}\n\n${label}\n${convo}`;
}

/**
 * parseHistoryTranscriptEntry: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function parseHistoryTranscriptEntry(entry) {
    if (!entry) return { messages: [], meta: {} };
    const raw = entry.response;
    if (raw && typeof raw === 'object' && Array.isArray(raw.messages)) {
        return { messages: raw.messages, meta: raw.meta || {} };
    }
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.messages)) {
                return { messages: parsed.messages, meta: parsed.meta || {} };
            }
        } catch (err) { /* ignore */ }
    }
    const messages = [];
    if (entry.query) {
        messages.push({ role: 'user', message: entry.query, ts: entry.date || '' });
    }
    if (entry.response) {
        messages.push({ role: 'assistant', message: entry.response, ts: entry.date || '' });
    }
    return { messages, meta: {} };
}

/**
 * scrollToLatestAssistantResponseStart: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function scrollToLatestAssistantResponseStart(display) {
    if (!display) return;
    const assistantBubbles = display.querySelectorAll('.chat-message.assistant');
    const latest = assistantBubbles.length ? assistantBubbles[assistantBubbles.length - 1] : null;
    if (!latest) {
        display.scrollTop = display.scrollHeight;
        return;
    }
    const top = Math.max(0, latest.offsetTop - display.offsetTop);
    display.scrollTop = top;
}

/**
 * renderTranscript: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function renderTranscript(messages, options = {}) {
    const display = document.getElementById('display');
    if (!display) return;
    const shouldAppend = options.append === true;
    const scrollMode = options.scrollTo || 'bottom';
    if (!shouldAppend) {
        display.innerHTML = '';
    }
    if (!messages || !messages.length) {
        if (!shouldAppend) {
            display.innerHTML = buildEmptyResponsePlaceholderHtml();
        }
        return;
    }
    messages.forEach((msg) => {
        if (!msg || typeof msg !== 'object') return;
        const role = (msg.role || msg.type || '').toString().trim().toLowerCase();
        const isUser = role === 'user';
        const bubble = document.createElement('div');
        bubble.className = `chat-message ${isUser ? 'user' : 'assistant'}`;
        const metaLine = document.createElement('div');
        metaLine.className = 'chat-meta';
        const metaParts = [];
        metaParts.push(isUser ? 'You' : 'MedGemma');
        if (isUser && msg.ts) {
            const ts = new Date(msg.ts);
            if (!Number.isNaN(ts.getTime())) {
                metaParts.push(ts.toLocaleString());
            }
        }
        metaLine.textContent = metaParts.join(' • ');
        bubble.appendChild(metaLine);
        const content = document.createElement('div');
        content.className = 'chat-content';
        const raw = msg.message || msg.content || '';
        if (!isUser) {
            content.innerHTML = renderAssistantMarkdownChat(raw || '');
        } else {
            content.innerHTML = escapeHtml(raw || '').replace(/\n/g, '<br>');
        }
        bubble.appendChild(content);
        const triageMeta = msg.triage_meta || msg.triageMeta;
        if (isUser && triageMeta && typeof triageMeta === 'object') {
            const metaEntries = Object.entries(triageMeta).filter(([, v]) => v);
            if (metaEntries.length) {
                const triageDiv = document.createElement('div');
                triageDiv.className = 'chat-triage-meta';
                triageDiv.innerHTML = `<strong>Triage Intake</strong><br>${metaEntries
                    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`)
                    .join('<br>')}`;
                bubble.appendChild(triageDiv);
            }
        }
        display.appendChild(bubble);
    });
    if (scrollMode === 'latest-assistant-start') {
        scrollToLatestAssistantResponseStart(display);
    } else {
        display.scrollTop = display.scrollHeight;
    }
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
    if (!promptBox) return null;
    if (!force && promptBox.dataset.autofilled === 'false') return null;
    const fd = new FormData();
    fd.append('message', msgVal);
    fd.append('patient', patientVal);
    fd.append('mode', currentMode);
    if (currentMode === 'triage') {
        fd.append('triage_consciousness', document.getElementById('triage-consciousness')?.value || '');
        fd.append('triage_breathing', document.getElementById('triage-breathing')?.value || '');
        fd.append('triage_circulation', document.getElementById('triage-circulation')?.value || '');
        fd.append('triage_overall_stability', document.getElementById('triage-overall-stability')?.value || '');
        fd.append('triage_domain', document.getElementById('triage-domain')?.value || '');
        fd.append('triage_problem', document.getElementById('triage-problem')?.value || '');
        fd.append('triage_anatomy', document.getElementById('triage-anatomy')?.value || '');
        fd.append('triage_severity', document.getElementById('triage-severity')?.value || '');
        fd.append('triage_mechanism', document.getElementById('triage-mechanism')?.value || '');
    }
    try {
        const res = await fetch('/api/chat/preview', { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        const data = await res.json();
        promptBox.value = stripUserMessageFromPrompt(data.prompt || '', msgVal, data.mode || currentMode);
        promptBox.dataset.autofilled = 'true';
        return data;
    } catch (err) {
        promptBox.value = `Unable to build prompt: ${err.message}`;
        promptBox.dataset.autofilled = 'true';
        return null;
    }
}

/**
 * resetPromptPreviewToDefault: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function resetPromptPreviewToDefault() {
    const promptBox = document.getElementById('prompt-preview');
    if (!promptBox) return;
    promptBox.value = '';
    promptBox.dataset.autofilled = 'true';
    try { localStorage.removeItem(PROMPT_PREVIEW_CONTENT_KEY); } catch (err) { /* ignore */ }
    refreshPromptPreview(true);
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

// Expose inline handlers
window.togglePromptPreviewArrow = togglePromptPreviewArrow;
window.refreshPromptPreview = refreshPromptPreview;


//

// MAINTENANCE NOTE
// Historical auto-generated note blocks were removed because they were repetitive and
// obscured real logic changes during review. Keep focused comments close to behavior-
// critical code paths (UI state hydration, async fetch lifecycle, and mode-gated
// controls) so maintenance remains actionable.
