/* =============================================================================
 * Author: Rick Escher
 * Project: SailingMedAdvisor
 * Context: Google HAI-DEF Framework
 * Models: Google MedGemmas
 * Program: Kaggle Impact Challenge
 * ========================================================================== */
/*
File: static/js/main.js
Author notes: Application orchestration and global UI utilities.

Key Responsibilities:
- Tab navigation and content switching
- Collapsible section management (queries, headers, details)
- Sidebar state persistence and synchronization
- Application initialization and data preloading
- Medical chest global search across all inventories
- LocalStorage state restoration

Architecture Overview:
---------------------
main.js acts as the conductor for the single-page application, coordinating:

1. **Tab System**: 5 main tabs with lazy loading
   - Chat: AI consultation interface
   - Medical Chest: Pharmacy inventory (preloaded for performance)
   - Crew Health & Log: Medical records and history
   - Vessel & Crew Info: Demographics and documents
   - Onboard Equipment: Medical equipment and consumables
   - Settings: Configuration and offline mode

2. **Collapsible Sections**: 3 different toggle patterns
   - toggleSection(): Standard sections (most common)
   - toggleDetailSection(): Detail panels with special handling
   - toggleCrewSection(): Crew cards with accordion behavior

3. **Sidebar Management**: Context-sensitive help/reference
   - Collapsed/expanded state persists across sessions
   - Auto-syncs with collapsible section states
   - Shows/hides relevant content per active tab

4. **Initialization Strategy**: Staggered loading for performance
   - Immediate: Chat tab (default landing)
   - Preload: Medical Chest (frequent access)
   - On-demand: Other tabs load when opened
   - Concurrent: Crew data, settings, history loaded together

5. **Global Search**: Unified search across all inventories
   - Searches pharmaceuticals, equipment, consumables
   - Scope filtering (all/pharma/equipment/consumables)
   - Grouped results by category
   - Expandable result sections

Data Loading Flow:
-----------------
```
Page Load → ensureCrewData() → Promise.all([
  /api/data/patients,
  /api/data/history,
  /api/data/settings
]) → loadCrewData() → Render UI

Tab Switch → showTab() → 
  if Chat: updateUI(), restoreCollapsibleState()
  if CrewMedical: ensureCrewData()
  if OnboardEquipment: loadEquipment()
  if Settings: loadSettingsUI(), loadCrewCredentials()
```

LocalStorage Keys:
- sailingmed:sidebarCollapsed: Sidebar state (1=collapsed, 0=expanded)
- sailingmed:lastOpenCrew: Last opened crew card ID
- sailingmed:skipLastChat: Flag to skip restoring last chat
- [headerId]: Per-section collapsed state

Integration Points:
- crew.js: loadCrewData() renders crew lists
- pharmacy.js: preloadPharmacy(), loadPharmacy()
- equipment.js: loadEquipment()
- settings.js: loadSettingsUI(), loadCrewCredentials()
- chat.js: updateUI(), refreshPromptPreview()
*/

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const SIDEBAR_STATE_KEY = 'sailingmed:sidebarCollapsed';
const renderAssistantMarkdownMain = (window.Utils && window.Utils.renderAssistantMarkdown)
    ? window.Utils.renderAssistantMarkdown
    : (txt) => (window.marked && typeof window.marked.parse === 'function')
        ? window.marked.parse(txt || '', { gfm: true, breaks: true })
        : (window.escapeHtml ? window.escapeHtml(txt || '') : String(txt || '')).replace(/\n/g, '<br>');
let globalSidebarCollapsed = false;  // Sidebar collapse state (synced across all tabs)
let crewDataLoaded = false;          // Prevent duplicate crew data loads
let crewDataPromise = null;          // Promise for concurrent load protection
let loadDataInFlight = null;         // Shared promise so concurrent refreshes collapse into one request
let cachedPatientsRoster = null;     // Last successful /api/data/patients payload for lightweight refreshes
const LAST_PATIENT_KEY_MAIN = 'sailingmed:lastPatient';
const CREW_OPTIONS_CACHE_KEY = 'sailingmed:crewOptionsCache';
const COLLAPSIBLE_PREF_SCHEMA_KEY = 'sailingmed:collapsiblePrefSchema';
const COLLAPSIBLE_PREF_SCHEMA_VERSION = '2';
let startupCriticalInitDone = false;   // Prevent duplicate critical bootstrap runs
let startupDeferredInitDone = false;   // Prevent duplicate deferred bootstrap runs
let startupCrewReadyPromise = null;    // Shared crew-ready promise across startup phases

/**
 * migrateCollapsiblePrefs: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function migrateCollapsiblePrefs() {
    try {
        const current = localStorage.getItem(COLLAPSIBLE_PREF_SCHEMA_KEY);
        if (current === COLLAPSIBLE_PREF_SCHEMA_VERSION) return;
        // Legacy values were stored inverted; normalize once.
        ['query-form-open', 'triage-pathway-open'].forEach((key) => {
            const raw = localStorage.getItem(key);
            if (raw === 'true') localStorage.setItem(key, 'false');
            else if (raw === 'false') localStorage.setItem(key, 'true');
        });
        localStorage.setItem(COLLAPSIBLE_PREF_SCHEMA_KEY, COLLAPSIBLE_PREF_SCHEMA_VERSION);
    } catch (err) { /* ignore */ }
}

/**
 * getCrewFullNameFast: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function getCrewFullNameFast(crew) {
    const first = crew && typeof crew.firstName === 'string' ? crew.firstName.trim() : '';
    const last = crew && typeof crew.lastName === 'string' ? crew.lastName.trim() : '';
    const full = `${first} ${last}`.trim();
    if (full) return full;
    if (crew && typeof crew.name === 'string' && crew.name.trim()) return crew.name.trim();
    return 'Unnamed Crew';
}

/**
 * Fast-path dropdown population so the Chat crew selector is usable
 * immediately after splash/login transition.
 *
 * This intentionally avoids rendering full crew/history UI and only updates
 * `#p-select` while the rest of loadData() continues in the background.
 */
function populateCrewSelectFast(patients) {
    if (!Array.isArray(patients)) return;
    const select = document.getElementById('p-select');
    if (!select) return;

    let storedValue = '';
    try {
        storedValue = localStorage.getItem(LAST_PATIENT_KEY_MAIN) || '';
    } catch (err) { /* ignore */ }
    const currentValue = select.value || '';
    const preferredValue = currentValue || storedValue;

    const frag = document.createDocumentFragment();
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Unnamed Crew Member';
    frag.appendChild(defaultOpt);
    patients.forEach((crew) => {
        const opt = document.createElement('option');
        opt.value = String((crew && crew.id) || '');
        opt.textContent = getCrewFullNameFast(crew);
        frag.appendChild(opt);
    });
    select.replaceChildren(frag);

    if (preferredValue && Array.from(select.options).some((opt) => opt.value === preferredValue)) {
        select.value = preferredValue;
        return;
    }
    if (preferredValue) {
        const byName = Array.from(select.options).find((opt) => opt.textContent === preferredValue);
        select.value = byName ? (byName.value || '') : '';
        return;
    }
    select.value = '';
}

/**
 * cacheCrewOptionsFast: persist lightweight crew selector options for instant hydration.
 */
function cacheCrewOptionsFast(patients) {
    if (!Array.isArray(patients)) return;
    const compact = patients
        .map((crew) => {
            const id = String((crew && crew.id) || '').trim();
            if (!id) return null;
            const label = getCrewFullNameFast(crew);
            return { id, label };
        })
        .filter(Boolean);
    if (!compact.length) return;
    try {
        localStorage.setItem(CREW_OPTIONS_CACHE_KEY, JSON.stringify(compact));
    } catch (err) { /* ignore */ }
}

/**
 * hydrateCrewSelectFromCache: render cached crew options before network completes.
 */
function hydrateCrewSelectFromCache() {
    try {
        const raw = localStorage.getItem(CREW_OPTIONS_CACHE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.length) return false;
        populateCrewSelectFast(parsed.map((entry) => ({
            id: entry && entry.id,
            name: entry && entry.label,
        })));
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * getMedicalChestRenderCount: function-level behavior note for maintainers.
 * Keep this block synchronized with implementation changes.
 */
function getMedicalChestRenderCount() {
    const pharmaCount = document.querySelectorAll('#pharmacy-list .history-item').length;
    const equipmentCount = document.querySelectorAll('#equipment-list .history-item').length;
    const consumableCount = document.querySelectorAll('#consumables-list .history-item').length;
    return pharmaCount + equipmentCount + consumableCount;
}

async function runMedicalChestLoadCycle() {
    const loaders = [];
    if (typeof loadEquipment === 'function') {
        loaders.push(Promise.resolve(loadEquipment()));
    }
    if (typeof loadPharmacy === 'function') {
        loaders.push(Promise.resolve(loadPharmacy()));
    }
    if (!loaders.length) return;
    await Promise.allSettled(loaders);
}

async function ensureMedicalChestLoaded() {
    await runMedicalChestLoadCycle();
    if (getMedicalChestRenderCount() > 0) return;
    try {
        const [invRes, toolsRes] = await Promise.all([
            fetch('/api/data/inventory', { credentials: 'same-origin' }),
            fetch('/api/data/tools', { credentials: 'same-origin' }),
        ]);
        const [invData, toolsData] = await Promise.all([
            invRes.ok ? invRes.json() : Promise.resolve([]),
            toolsRes.ok ? toolsRes.json() : Promise.resolve([]),
        ]);
        const hasBackendData = (Array.isArray(invData) && invData.length > 0)
            || (Array.isArray(toolsData) && toolsData.length > 0);
        if (hasBackendData) {
            console.warn('[DEBUG] Medical Chest rendered empty; retrying load once.');
            await new Promise((resolve) => setTimeout(resolve, 300));
            await runMedicalChestLoadCycle();
        }
    } catch (err) {
        console.warn('[DEBUG] Medical Chest retry probe failed:', err);
    }
}

/**
 * Set sidebar collapsed state across all sidebars.
 * 
 * Sidebar States:
 * - Expanded: Shows context help, reference content
 * - Collapsed: Hides sidebar, maximizes main content area
 * 
 * UI Changes:
 * 1. Adds/removes 'collapsed' class to all .page-sidebar elements
 * 2. Updates toggle button text ("Context ←" / "Context →")
 * 3. Adjusts page body layout classes
 * 4. Persists state to localStorage
 * 
 * Applied Globally:
 * All sidebars on the page sync to same state for consistency.
 * 
 * @param {boolean} collapsed - True to collapse, false to expand
 */
function setSidebarState(collapsed) {
    globalSidebarCollapsed = !!collapsed;
    try { localStorage.setItem(SIDEBAR_STATE_KEY, globalSidebarCollapsed ? '1' : '0'); } catch (err) { /* ignore */ }
    document.querySelectorAll('.page-sidebar').forEach((sidebar) => {
        sidebar.classList.toggle('collapsed', globalSidebarCollapsed);
        const button = sidebar.querySelector('.sidebar-toggle');
        if (button) button.textContent = globalSidebarCollapsed ? 'Context ←' : 'Context →';
        const body = sidebar.closest('.page-body');
        if (body) {
            body.classList.toggle('sidebar-open', !globalSidebarCollapsed);
            body.classList.toggle('sidebar-collapsed', globalSidebarCollapsed);
        }
    });
}

/**
 * Toggle standard collapsible section visibility.
 * 
 * Standard Pattern:
 * Header with .detail-icon (▸/▾) and body that expands/collapses.
 * 
 * Special Behaviors:
 * 1. Crew Sort Control: Shows only when crew list expanded
 * 2. Triage Sample Selector: Shows only when expanded AND in advanced/developer mode
 * 3. Sidebar Sync: Updates related sidebar sections if data-sidebar-id present
 * 4. State Persistence: Saves to localStorage if data-pref-key present
 * 
 * Used For:
 * - Query form sections
 * - Settings sections
 * - Crew list headers
 * - Equipment sections
 * 
 * @param {HTMLElement} el - Header element to toggle
 */
function toggleSection(el) {
    const body = el.nextElementSibling;
    const icon = el.querySelector('.detail-icon');
    const isExpanded = body.style.display === "block";
    const nextExpanded = !isExpanded;
    body.style.display = nextExpanded ? "block" : "none";
    if (icon) icon.textContent = nextExpanded ? "▾" : "▸";
    // Show/hide crew sort control only when crew list expanded
    const sortWrap = el.querySelector('#crew-sort-wrap');
    if (sortWrap) {
        sortWrap.style.display = nextExpanded ? "flex" : "none";
    }
    if (el.dataset && el.dataset.sidebarId) {
        syncSidebarSections(el.dataset.sidebarId, nextExpanded);
    }
    if (el.dataset && el.dataset.prefKey) {
        try { localStorage.setItem(el.dataset.prefKey, nextExpanded.toString()); } catch (err) { /* ignore */ }
    }
    if (el.id === 'query-form-header') {
        if (typeof window.handleStartPanelToggle === 'function') {
            window.handleStartPanelToggle(nextExpanded);
        } else if (typeof window.updateStartPanelTitle === 'function') {
            window.updateStartPanelTitle();
        }
    }
}

/**
 * Toggle detail section with prompt preview special handling.
 * 
 * Similar to toggleSection but with additional logic for:
 * - Prompt refresh inline button visibility (advanced/developer mode only)
 * - ARIA attributes for accessibility (aria-expanded)
 * 
 * Used For:
 * - Prompt preview/editor panel (chat.js)
 * - Other detail panels requiring ARIA support
 * 
 * @param {HTMLElement} el - Header element to toggle
 */
function toggleDetailSection(el) {
    const body = el.nextElementSibling;
    const icon = el.querySelector('.detail-icon');
    const isExpanded = body.style.display === "block";
    const nextExpanded = !isExpanded;
    body.style.display = nextExpanded ? "block" : "none";
    icon.textContent = nextExpanded ? "▾" : "▸";
    // Handle prompt refresh inline visibility
    const refreshInline = document.getElementById('prompt-refresh-inline');
    if (refreshInline && el.id === 'prompt-preview-header') {
        const isAdvanced = document.body.classList.contains('mode-advanced') || document.body.classList.contains('mode-developer');
        refreshInline.style.display = nextExpanded && isAdvanced ? 'flex' : 'none';
        el.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
    }
}

/**
 * Toggle crew card with accordion behavior.
 * 
 * Crew Card Features:
 * 1. Icon: Changes ▸ (collapsed) ↔ ▾ (expanded)
 * 2. Action Buttons: Shows/hides based on state
 * 3. Accordion Groups: Collapses siblings in same group when opening
 * 4. Sidebar Sync: Updates related sidebar content
 * 5. Last Opened: Remembers last opened crew for reload restoration
 * 
 * Accordion Behavior (Pharmacy):
 * When opening a medication card in pharmacy, other cards in the same
 * collapse-group automatically close to keep UI clean and focused.
 * 
 * Used For:
 * - Crew medical cards (crew.js)
 * - Pharmacy medication cards (pharmacy.js)
 * - Equipment cards (equipment.js)
 * 
 * @param {HTMLElement} el - Crew card header element
 */
function toggleCrewSection(el) {
    const body = el.nextElementSibling;
    const icon = el.querySelector('.toggle-label');
    const actionBtns = el.querySelectorAll('.history-action-btn');
    const isExpanded = body.style.display === "block";
    
    body.style.display = isExpanded ? "none" : "block";
    icon.textContent = isExpanded ? "▸" : "▾";
    actionBtns.forEach(btn => { btn.style.visibility = isExpanded ? "hidden" : "visible"; });
    if (el.dataset && el.dataset.sidebarId) {
        syncSidebarSections(el.dataset.sidebarId, !isExpanded);
    }
    // If this header participates in a collapse group, close siblings in the same group when opening
    const group = el.querySelector('.toggle-label')?.dataset?.collapseGroup || el.dataset.collapseGroup;
    if (!isExpanded && group) {
        const container = el.closest('#pharmacy-list') || el.parentElement;
        if (container) {
            container.querySelectorAll(`.toggle-label[data-collapse-group="${group}"]`).forEach(lbl => {
                const header = lbl.closest('.col-header');
                if (!header || header === el) return;
                const b = header.nextElementSibling;
                if (b && b.style.display !== "none") {
                    b.style.display = "none";
                    lbl.textContent = ">";
                    const btns = header.querySelectorAll('.history-action-btn');
                    btns.forEach(btn => { btn.style.visibility = "hidden"; });
                }
            });
        }
    }
    // Remember last opened crew card so we can restore after reloads (e.g., after uploads)
    if (!isExpanded) {
        try {
            const parent = el.closest('.collapsible[data-crew-id]');
            if (parent) {
                const crewId = parent.getAttribute('data-crew-id');
                localStorage.setItem('sailingmed:lastOpenCrew', crewId || '');
            }
        } catch (err) { /* ignore */ }
    }
}

/**
 * Toggle sidebar collapsed state.
 * 
 * Triggered by sidebar toggle button. Applies state globally to all
 * sidebars on the page via setSidebarState().
 * 
 * @param {HTMLElement} btn - Toggle button element
 */
function toggleSidebar(btn) {
    const sidebar = btn.closest ? btn.closest('.page-sidebar') : btn;
    if (!sidebar) return;
    // Toggle global state and apply to all sidebars
    const nextCollapsed = !globalSidebarCollapsed;
    setSidebarState(nextCollapsed);
}

/**
 * Sync sidebar section visibility with main content sections.
 * 
 * When main content section opens/closes, matching sidebar sections
 * (identified by data-sidebar-section attribute) show/hide accordingly.
 * 
 * Example:
 * ```html
 * <div data-sidebar-id="crew-medical">Crew Medical</div>
 * <!-- Opens... -->
 * <div data-sidebar-section="crew-medical">Related help content</div>
 * <!-- ^ This shows in sidebar -->
 * ```
 * 
 * @param {string} sectionId - Section identifier to sync
 * @param {boolean} isOpen - True if section is open
 */
function syncSidebarSections(sectionId, isOpen) {
    if (!sectionId) return;
    document.querySelectorAll(`[data-sidebar-section="${sectionId}"]`).forEach(sec => {
        if (isOpen) {
            sec.classList.remove('hidden');
        } else {
            sec.classList.add('hidden');
        }
    });
}

/**
 * Initialize sidebar state on page load.
 * 
 * Initialization Process:
 * 1. Restores collapsed state from localStorage
 * 2. Applies state to all sidebars
 * 3. Syncs sidebar sections with main content collapsible states
 * 
 * Called once during startup initialization.
 */
function initSidebarSync() {
    try {
        const saved = localStorage.getItem(SIDEBAR_STATE_KEY);
        globalSidebarCollapsed = saved === '1';
    } catch (err) { /* ignore */ }
    setSidebarState(globalSidebarCollapsed);
    document.querySelectorAll('[data-sidebar-id]').forEach(header => {
        const body = header.nextElementSibling;
        const isOpen = body && body.style.display === 'block';
        syncSidebarSections(header.dataset.sidebarId, isOpen);
    });
}

/**
 * Ensure crew data is loaded with concurrency protection.
 * 
 * Loading Strategy:
 * - First call: Initiates loadData(), sets promise
 * - Concurrent calls: Return existing promise (no duplicate loads)
 * - Subsequent calls after load: Return immediately (cached flag)
 * 
 * Protects against race conditions when multiple tabs/functions
 * request crew data simultaneously.
 * 
 * @returns {Promise<void>} Resolves when crew data loaded
 */
async function ensureCrewData() {
    if (crewDataLoaded) return;
    if (crewDataPromise) return crewDataPromise;
    crewDataPromise = loadData()
        .then(() => { crewDataLoaded = true; crewDataPromise = null; })
        .catch((err) => { crewDataPromise = null; throw err; });
    return crewDataPromise;
}

/**
 * Navigate to a tab and initialize its content.
 * 
 * Tab Switching Process:
 * 1. Hides all content sections
 * 2. Removes 'active' class from all tabs
 * 3. Shows target content section
 * 4. Adds 'active' class to clicked tab
 * 5. Updates banner controls visibility
 * 6. Loads tab-specific data/UI
 * 
 * Tab-Specific Initialization:
 * 
 * **Chat Tab:**
 * - Updates UI (mode, privacy state)
 * - Ensures crew data loaded (for patient selector)
 * - Loads context sidebar
 * - Restores collapsible state
 * - Prefetches prompt preview
 * 
 * **Settings Tab:**
 * - Loads settings UI
 * - Loads crew credentials
 * - Loads workspace switcher
 * - Loads context sidebar
 * 
 * **CrewMedical / VesselCrewInfo Tabs:**
 * - Ensures crew data loaded
 * - Loads vessel data (VesselCrewInfo only)
 * - Loads context sidebar
 * 
 * **OnboardEquipment Tab:**
 * - Loads equipment list
 * - Preloads pharmacy data
 * - Loads context sidebar
 * 
 * @param {Event} e - Click event
 * @param {string} n - Tab name/ID to show
 */
async function showTab(trigger, n) {
    console.log('[DEBUG] showTab ->', n);
    document.querySelectorAll('.content').forEach(c=>c.style.display='none');
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.getElementById(n).style.display='flex'; 
    const clickedTab = trigger?.currentTarget
        || (trigger && trigger.nodeType === 1 ? trigger : null)
        || document.querySelector(`.tab[onclick*="'${n}'"]`);
    if (clickedTab) {
        clickedTab.classList.add('active');
    }
    toggleBannerControls(n);
    if (n === 'Chat') updateUI();
    
    if(n === 'Settings') {
        if (typeof loadSettingsUI === 'function') {
            await loadSettingsUI();
        }
        if (typeof loadCrewCredentials === 'function') {
            loadCrewCredentials();
        }
        if (typeof loadWorkspaceSwitcher === 'function') {
            loadWorkspaceSwitcher();
        }
        loadContext('Settings');
    } else if(n === 'CrewMedical' || n === 'VesselCrewInfo') { 
        try {
            await ensureCrewData();
            if (n === 'VesselCrewInfo' && typeof ensureVesselLoaded === 'function') {
                await ensureVesselLoaded();
            }
        } catch (err) {
            console.warn('[DEBUG] showTab loadData failed:', err);
        }
        loadContext(n);
    } else if (n === 'OnboardEquipment') {
        await ensureMedicalChestLoaded();
        loadContext(n);
    }
    if (n === 'Chat') {
        try {
            await ensureCrewData();
        } catch (err) {
            console.warn('[DEBUG] Chat crew load failed:', err);
        }
        loadContext('Chat');
        if (typeof window.syncStartPanelWithConsultationState === 'function') {
            window.syncStartPanelWithConsultationState();
        } else {
            restoreCollapsibleState('query-form-header', true);
        }
        restoreCollapsibleState('triage-pathway-header', false);
        // Prefetch prompt preview so it is ready when expanded
        if (typeof refreshPromptPreview === 'function') {
            refreshPromptPreview();
        }
    }
}

// Ensure inline onclick handlers can always resolve this function.
window.showTab = showTab;

/**
 * Load crew, history, and settings data from server.
 * 
 * Loading Strategy:
 * - Concurrent fetch of history/settings on every call
 * - Optional patient roster reuse for lightweight refresh paths
 * - Patients: Hard requirement, fails if unavailable
 * - History: Soft requirement, continues if fails (empty array)
 * - Settings: Optional, uses defaults if unavailable
 *
 * Concurrency Strategy:
 * - If a refresh is already in flight, concurrent callers share that promise
 *   unless `options.force === true`
 *
 * Lightweight Refresh Mode:
 * - `options.skipPatients === true` reuses cached roster when available
 * - This keeps post-chat refreshes fast while still updating history/settings
 * 
 * Error Handling:
 * - History parse failure: Warns and continues with []
 * - Settings parse failure: Warns and continues with {}
 * - Patients failure: Throws error and shows graceful UI fallback
 * 
 * Race Condition Protection:
 * If loadCrewData not yet available (script still loading), retries
 * after 150ms to allow crew.js to finish initializing.
 * 
 * Side Effects:
 * - Sets window.CACHED_SETTINGS for global access
 * - Calls loadCrewData() to render crew UI
 * - Sets crewDataLoaded flag
 * - Updates patient selector dropdown
 * 
 * Fallback UI on Error:
 * - Shows "Unable to load crew data" message
 * - Provides "Unnamed Crew" option in selectors
 * - Prevents cascading errors
 * 
 * @throws {Error} If patients data unavailable or malformed
 */
async function loadData(options = {}) {
    const opts = {
        skipPatients: false,
        force: false,
        forcePatients: false,
        ...(options && typeof options === 'object' ? options : {}),
    };
    if (!opts.force && loadDataInFlight) {
        return loadDataInFlight;
    }
    loadDataInFlight = (async () => {
        console.log('[DEBUG] loadData: start', opts);
        try {
            const historyResPromise = fetch('/api/data/history', { credentials: 'same-origin' })
                .catch((err) => {
                    console.warn('History request failed before response; continuing without history.', err);
                    return null;
                });
            const settingsResPromise = fetch('/api/data/settings', { credentials: 'same-origin' })
                .catch((err) => {
                    console.warn('Settings request failed before response; using defaults.', err);
                    return null;
                });

            const shouldFetchPatients = !opts.skipPatients
                || opts.forcePatients
                || !Array.isArray(cachedPatientsRoster)
                || !cachedPatientsRoster.length;

            let data = Array.isArray(cachedPatientsRoster) ? cachedPatientsRoster : [];
            if (shouldFetchPatients) {
                // Prioritize patient roster fetch so #p-select is usable as early as possible.
                const patientsResPromise = fetch('/api/data/patients', { credentials: 'same-origin' });
                const patientOptionsPromise = fetch('/api/patients/options', { credentials: 'same-origin' })
                    .then(async (res) => {
                        if (!res.ok) return null;
                        const optionsData = await res.json();
                        return Array.isArray(optionsData) ? optionsData : null;
                    })
                    .then((optionsData) => {
                        if (Array.isArray(optionsData) && optionsData.length) {
                            populateCrewSelectFast(optionsData);
                            cacheCrewOptionsFast(optionsData);
                        }
                        return optionsData;
                    })
                    .catch((err) => {
                        console.warn('Patient options request failed before response; falling back to full patients payload.', err);
                        return null;
                    });

                const res = await patientsResPromise;
                if (!res.ok) {
                    if (!Array.isArray(cachedPatientsRoster) || !cachedPatientsRoster.length) {
                        throw new Error(`Patients request failed: ${res.status}`);
                    }
                    console.warn('Patients request failed; reusing cached roster. Status:', res.status);
                    data = cachedPatientsRoster;
                } else {
                    data = await res.json();
                    console.log('[DEBUG] loadData: patients status', res.status, 'length', Array.isArray(data) ? data.length : 'n/a');
                    if (!Array.isArray(data)) throw new Error('Unexpected patients data format');
                    cachedPatientsRoster = data;
                    populateCrewSelectFast(data);
                    cacheCrewOptionsFast(data);
                }

                // Ensure fast options request has settled; failures are already handled.
                await patientOptionsPromise;
            } else {
                // Reuse cached roster for lightweight refreshes (e.g., after chat completion).
                populateCrewSelectFast(data);
            }

            const [historyRes, settingsRes] = await Promise.all([historyResPromise, settingsResPromise]);
            console.log('[DEBUG] loadData: status history', historyRes ? historyRes.status : 'error', 'settings', settingsRes ? settingsRes.status : 'error');
            if (!settingsRes || !settingsRes.ok) console.warn('Settings request failed:', settingsRes ? settingsRes.status : 'network');

            // Parse history, but never block crew rendering if it fails
            let history = [];
            if (historyRes && historyRes.ok) {
                try {
                    const parsedHistory = await historyRes.json();
                    history = Array.isArray(parsedHistory) ? parsedHistory : [];
                } catch (err) {
                    console.warn('History parse failed; continuing without history.', err);
                    history = [];
                }
            } else {
                console.warn('History request failed; continuing without history. Status:', historyRes ? historyRes.status : 'network');
            }

            // Parse settings (optional)
            let settings = {};
            try {
                settings = (settingsRes && settingsRes.ok) ? await settingsRes.json() : {};
            } catch (err) {
                console.warn('Settings parse failed, using defaults.', err);
            }
            window.CACHED_SETTINGS = settings || {};

            // Ensure crew renderer is ready; retry briefly if the script is still loading
            if (typeof loadCrewData !== 'function') {
                console.warn('[DEBUG] loadCrewData missing; retrying shortly…');
                setTimeout(() => {
                    if (typeof loadCrewData === 'function') {
                        loadCrewData(data, history, settings || {});
                    } else {
                        console.error('[DEBUG] loadCrewData still missing after retry.');
                    }
                }, 150);
                return;
            }
            loadCrewData(data, history, settings || {});
            crewDataLoaded = true;

        } catch (err) {
            console.error('[DEBUG] Failed to load crew data', err);
            window.CACHED_SETTINGS = window.CACHED_SETTINGS || {};
            // Gracefully clear UI to avoid JS errors
            const pSelect = document.getElementById('p-select');
            if (pSelect) pSelect.innerHTML = '<option value=\"\">Unnamed Crew Member</option>';
            const medicalContainer = document.getElementById('crew-medical-list');
            if (medicalContainer) medicalContainer.innerHTML = `<div style="color:#666;">Unable to load crew data. ${err.message}</div>`;
            const infoContainer = document.getElementById('crew-info-list');
            if (infoContainer) infoContainer.innerHTML = `<div style="color:#666;">Unable to load crew data. ${err.message}</div>`;
        } finally {
            loadDataInFlight = null;
        }
    })();
    return loadDataInFlight;
}

/**
 * Show/hide tab-specific banner controls.
 * 
 * Banner Control Groups:
 * 
 * **Chat Tab:**
 * - Mode selector (triage/inquiry)
 * - Privacy toggle (logging on/off)
 * - Patient selector
 * 
 * **Crew Health & Log Tab:**
 * - Export all medical records button
 * 
 * **Vessel & Crew Info Tab:**
 * - Export crew CSV button (for border crossings)
 * - Export immigration zip button (crew + vessel package)
 * 
 * Other tabs: All banner controls hidden
 * 
 * @param {string} activeTab - Current active tab name
 */
function toggleBannerControls(activeTab) {
    const triageControls = document.getElementById('banner-controls-triage');
    const crewControls = document.getElementById('banner-controls-crew');
    const medExportAll = document.getElementById('crew-med-export-all-btn');
    const crewCsvBtn = document.getElementById('crew-csv-btn');
    const immigrationZipBtn = document.getElementById('crew-immigration-zip-btn');
    if (triageControls) triageControls.style.display = activeTab === 'Chat' ? 'flex' : 'none';
    if (crewControls) crewControls.style.display = (activeTab === 'CrewMedical' || activeTab === 'VesselCrewInfo') ? 'flex' : 'none';
    if (medExportAll) medExportAll.style.display = activeTab === 'CrewMedical' ? 'inline-flex' : 'none';
    if (crewCsvBtn) crewCsvBtn.style.display = activeTab === 'VesselCrewInfo' ? 'inline-flex' : 'none';
    if (immigrationZipBtn) immigrationZipBtn.style.display = activeTab === 'VesselCrewInfo' ? 'inline-flex' : 'none';
}

window.toggleBannerControls = toggleBannerControls;

/**
 * Application initialization on page load.
 * 
 * Initialization Sequence:
 * 1. **Crew Data**: Load immediately (used by multiple tabs)
 * 2. **Medical Chest**: Preload for fast access
 *    - preloadPharmacy(): Loads inventory
 *    - loadWhoMedsFromServer(): Loads WHO reference list
 *    - ensurePharmacyLabels(): Loads user labels
 *    - loadPharmacy(): Pre-renders pharmacy UI
 * 3. **Chat UI**: Initialize with updateUI()
 * 4. **Banner Controls**: Show Chat tab controls
 * 5. **Sidebar**: Initialize and restore state
 * 6. **Query Form**: Restore collapsed state
 * 7. **Last Chat**: Restore previous session view
 * 
 * Preloading Strategy:
 * Medical Chest is preloaded because:
 * - Frequently accessed (medications needed for consultations)
 * - Large dataset (better to load early than wait on tab switch)
 * - Improves perceived performance
 * 
 * Error Handling:
 * All preload operations use .catch() to prevent blocking page load
 * if individual components fail.
 * 
 * Called By: Browser on page load completion
 */
function runCriticalStartup() {
    if (startupCriticalInitDone) return;
    startupCriticalInitDone = true;
    console.log('[DEBUG] runCriticalStartup: start');
    migrateCollapsiblePrefs();
    // Use cached lightweight crew options immediately to avoid a blank selector
    // while network requests are still in flight.
    hydrateCrewSelectFromCache();
    startupCrewReadyPromise = ensureCrewData().catch((err) => {
        console.warn('[DEBUG] ensureCrewData failed during critical boot:', err);
    });
    updateUI();
    toggleBannerControls('Chat');
    initSidebarSync();
    if (typeof window.syncStartPanelWithConsultationState === 'function') {
        window.syncStartPanelWithConsultationState();
    } else {
        restoreCollapsibleState('query-form-header', true);
    }
    restoreCollapsibleState('triage-pathway-header', false);
}

function runDeferredStartup() {
    if (startupDeferredInitDone) return;
    startupDeferredInitDone = true;
    console.log('[DEBUG] runDeferredStartup: start');
    const preloadMedicalChest = () => {
        // Preload Medical Chest after crew dropdown hydration to prioritize chat readiness.
        if (typeof preloadPharmacy === 'function') {
            preloadPharmacy().catch((err) => console.warn('[DEBUG] preloadPharmacy failed:', err));
        }
        if (typeof loadWhoMedsFromServer === 'function') {
            loadWhoMedsFromServer().catch((err) => console.warn('[DEBUG] preload WHO meds failed:', err));
        }
        if (typeof ensurePharmacyLabels === 'function') {
            ensurePharmacyLabels().catch((err) => console.warn('[DEBUG] preload pharmacy labels failed:', err));
        }
        if (typeof loadPharmacy === 'function') {
            loadPharmacy(); // pre-warm Medical Chest so list is ready when tab opens
        }
    };
    const crewReady = startupCrewReadyPromise || ensureCrewData().catch((err) => {
        console.warn('[DEBUG] ensureCrewData failed during deferred boot:', err);
    });
    crewReady.finally(() => {
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(preloadMedicalChest, { timeout: 800 });
        } else {
            setTimeout(preloadMedicalChest, 0);
        }
    });
    restoreLastChatView();
}

document.addEventListener('DOMContentLoaded', runCriticalStartup);
window.addEventListener('load', runDeferredStartup);

// If scripts are injected late, run startup paths immediately as needed.
if (document.readyState === 'interactive' || document.readyState === 'complete') {
    runCriticalStartup();
}
if (document.readyState === 'complete') {
    runDeferredStartup();
}

// Ensure loadCrewData exists before any calls (safety for race conditions)
if (typeof window.loadCrewData !== 'function') {
    console.error('[DEBUG] window.loadCrewData is not defined at main.js load time.');
}

/**
 * Restore collapsible section state from localStorage.
 * 
 * Restoration Process:
 * 1. Looks for stored state in localStorage (by header ID or data-pref-key)
 * 2. Applies stored state or uses default if not found
 * 3. Updates icon (▸/▾)
 * 4. Special handling for prompt preview (ARIA + refresh button)
 * 
 * Special Cases:
 * 
 * **Prompt Preview Header:**
 * - Updates aria-expanded attribute
 * - Shows/hides prompt refresh inline button
 * 
 * Use Cases:
 * - Query form: Restore expanded/collapsed state
 * - Prompt preview: Restore editor visibility
 * - Settings sections: Restore user preferences
 * 
 * @param {string} headerId - ID of header element
 * @param {boolean} defaultOpen - Default state if no stored preference
 */
function restoreCollapsibleState(headerId, defaultOpen = true) {
    const header = document.getElementById(headerId);
    if (!header) return;
    const body = header.nextElementSibling;
    if (!body) return;
    let isOpen = defaultOpen;
    const key = header.dataset?.prefKey || headerId;
    try {
        const stored = localStorage.getItem(key);
        if (stored !== null) {
            isOpen = stored === 'true';
        }
    } catch (err) { /* ignore */ }
    body.style.display = isOpen ? 'block' : 'none';
    const icon = header.querySelector('.detail-icon');
    if (icon) icon.textContent = isOpen ? '▾' : '▸';
    if (headerId === 'prompt-preview-header') {
        const refreshInline = document.getElementById('prompt-refresh-inline');
        if (refreshInline) refreshInline.style.display = isOpen ? 'flex' : 'none';
        header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
}

/**
 * Load context sidebar content for tab.
 * 
 * Legacy Function:
 * Previously loaded remote context content. Now sidebars are static HTML,
 * so this is a no-op but kept for compatibility.
 * 
 * @param {string} tabName - Tab name (no longer used)
 * @deprecated Sidebars are now static HTML
 */
async function loadContext(tabName) {
    // Sidebars are now fully static HTML; no remote context to fetch.
    return;
}

/**
 * Restore the most recent chat session on page load.
 * 
 * Restoration Process:
 * 1. Checks display element is empty (fresh load)
 * 2. Checks skipLastChat flag (user may have cleared it)
 * 3. Fetches history from server
 * 4. Gets most recent entry
 * 5. Attempts active session restore via chat.js helper
 * 6. Falls back to read-only rendering if active restore is unavailable
 * 
 * Display Format:
 * - Title: "Last Session — [Patient] ([Date])"
 * - Query section
 * - Response section
 * 
 * Use Cases:
 * - User returns to page: See previous consultation
 * - Page refresh: Maintain context
 * - Quick reference: Check recent advice
 * 
 * Skip Conditions:
 * - User cleared display (skipLastChat=1)
 * - Display already has content (manual chat run)
 * - No history available
 * - History fetch fails
 * 
 * Integration:
 * Respects skipLastChat flag set when starting a new consultation clears prior
 * on-screen results.
 */
async function restoreLastChatView() {
    try {
        const display = document.getElementById('display');
        if (!display || display.children.length > 0) return;
        try {
            const skip = localStorage.getItem('sailingmed:skipLastChat');
            if (skip === '1') return;
        } catch (err) { /* ignore */ }
        const res = await fetch('/api/data/history', { credentials: 'same-origin' });
        if (!res.ok) return;
        const history = await res.json();
        if (!Array.isArray(history) || history.length === 0) return;
        const toTimestamp = (entry) => {
            if (!entry || typeof entry !== 'object') return Number.NEGATIVE_INFINITY;
            const raw = entry.updated_at || entry.date || '';
            if (!raw) return Number.NEGATIVE_INFINITY;
            const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
            const ts = Date.parse(normalized);
            return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts;
        };
        const sortedHistory = history.slice().sort((a, b) => toTimestamp(b) - toTimestamp(a));
        const last = sortedHistory[0];
        if (!last) return;
        if (typeof window.restoreHistoryEntrySession === 'function') {
            try {
                const restored = window.restoreHistoryEntrySession(last, {
                    focusInput: false,
                    forceLoggingOn: true,
                    notifyRestored: false,
                    allowTakeover: false,
                });
                if (restored) return;
            } catch (err) {
                console.warn('Failed to restore active last chat session', err);
            }
        }
        const parseTranscript = (entry) => {
            if (!entry) return { messages: [] };
            if (entry.response && typeof entry.response === 'object' && Array.isArray(entry.response.messages)) {
                return { messages: entry.response.messages, meta: entry.response.meta || {} };
            }
            if (typeof entry.response === 'string' && entry.response.trim().startsWith('{')) {
                try {
                    const parsed = JSON.parse(entry.response);
                    if (parsed && Array.isArray(parsed.messages)) {
                        return { messages: parsed.messages, meta: parsed.meta || {} };
                    }
                } catch (err) { /* ignore */ }
            }
            return { messages: [] };
        };
        const transcript = parseTranscript(last);
        if (transcript.messages.length && typeof window.renderTranscript === 'function') {
            display.innerHTML = `
                <div class="response-block" style="border-left-color:var(--inquiry);">
                    <div style="font-weight:800; margin-bottom:6px;">Last Consultation (read-only) — ${last.patient || 'Unknown'} (${last.date || ''})</div>
                    <div style="font-size:12px; color:#555;">Use the Consultation Log to restore and continue this session.</div>
                </div>
            `;
            window.renderTranscript(transcript.messages, { append: true });
            return;
        }
        const parse = (txt) => renderAssistantMarkdownMain(txt || '');
        const responseHtml = parse(last.response || '');
        const queryHtml = parse(last.query || '');
        display.innerHTML = `
            <div class="response-block">
                <div style="font-weight:800; margin-bottom:6px;">Last Session — ${last.patient || 'Unknown'} (${last.date || ''})</div>
                <div style="margin-bottom:8px;"><strong>Query:</strong><br>${queryHtml}</div>
                <div><strong>Response:</strong><br>${responseHtml}</div>
            </div>
        `;
    } catch (err) {
        console.warn('Failed to restore last chat view', err);
    } finally {
        if (typeof window.syncStartPanelWithConsultationState === 'function') {
            window.syncStartPanelWithConsultationState();
        }
    }
}

/**
 * Search across all medical inventories.
 * 
 * Search Scope:
 * - **all**: Pharmaceuticals + Equipment + Consumables
 * - **pharma**: Medications only
 * - **equipment**: Durable medical equipment only
 * - **consumables**: Single-use supplies only
 * 
 * Search Fields:
 * 
 * **Pharmaceuticals:**
 * - Generic name, brand name
 * - Indication, dosage
 * - Storage location, notes
 * 
 * **Equipment/Consumables:**
 * - Item name
 * - Storage location
 * - Notes, quantity
 * 
 * Results Display:
 * - Grouped by category (Pharmaceuticals, Equipment, Consumables)
 * - Collapsible result sections
 * - Shows count per category
 * - Item details (title, detail, storage location)
 * 
 * Use Cases:
 * - "Where is the amoxicillin?"
 * - "Do we have any splints?"
 * - "What's in Medical Bag 3?"
 * - "Find all antibiotics"
 * 
 * Performance:
 * Concurrent fetch of inventory and tools data for fast results.
 * Case-insensitive search for better UX.
 */
async function searchMedicalChest() {
    const input = document.getElementById('medchest-search-input');
    const scopeSel = document.getElementById('medchest-search-scope');
    const resultsBox = document.getElementById('medchest-search-results');
    if (!input || !scopeSel || !resultsBox) return;
    const q = (input.value || '').trim().toLowerCase();
    const scope = scopeSel.value || 'all';
    if (!q) {
        resultsBox.innerHTML = '<div style="color:#b71c1c;">Enter a search term.</div>';
        return;
    }
    resultsBox.innerHTML = '<div style="color:#555;">Searching…</div>';
    try {
        const wantPharma = scope === 'all' || scope === 'pharma';
        const wantEquip = scope === 'all' || scope === 'equipment' || scope === 'consumables';
        const [invData, toolsData] = await Promise.all([
            wantPharma ? fetch('/api/data/inventory', { credentials: 'same-origin' }).then(r => r.json()) : Promise.resolve([]),
            wantEquip ? fetch('/api/data/tools', { credentials: 'same-origin' }).then(r => r.json()) : Promise.resolve([]),
        ]);
        const results = [];
        if (wantPharma && Array.isArray(invData)) {
            invData.forEach(m => {
                const hay = [m.genericName, m.brandName, m.primaryIndication, m.standardDosage, m.storageLocation, m.notes].join(' ').toLowerCase();
                if (hay.includes(q)) {
                    results.push({ section: 'Pharmaceuticals', title: m.genericName || m.brandName || 'Medication', detail: m.strength || '', extra: m.storageLocation || '' });
                }
            });
        }
        if (wantEquip && Array.isArray(toolsData)) {
            toolsData.forEach(t => {
                const hay = [t.name, t.storageLocation, t.notes, t.quantity].join(' ').toLowerCase();
                const isConsumable = (t.type || '').toLowerCase() === 'consumable';
                const sec = isConsumable ? 'Consumables' : 'Equipment';
                if ((scope === 'consumables' && !isConsumable) || (scope === 'equipment' && isConsumable)) return;
                if (hay.includes(q)) {
                    results.push({ section: sec, title: t.name || 'Item', detail: t.quantity || '', extra: t.storageLocation || '' });
                }
            });
        }
        if (!results.length) {
            resultsBox.innerHTML = '<div style="color:#2c3e50;">No matches found.</div>';
            return;
        }
        const grouped = results.reduce((acc, r) => {
            acc[r.section] = acc[r.section] || [];
            acc[r.section].push(r);
            return acc;
        }, {});
        let html = '';
        Object.keys(grouped).forEach(sec => {
            const list = grouped[sec];
            html += `
                <div style="margin-bottom:10px; border:1px solid #d8e2f5; border-radius:8px;">
                    <div style="padding:8px 10px; background:#eef3ff; cursor:pointer; font-weight:700;" onclick="toggleSearchResults(this)">
                        ${sec} — ${list.length} match(es)
                        <span style="float:right;">▾</span>
                    </div>
                    <div class="medchest-search-results-body" style="padding:8px 10px; display:none; background:#fff;">
                        ${list.map(item => `
                            <div style="padding:6px 0; border-bottom:1px solid #eee;">
                                <div style="font-weight:700;">${item.title}</div>
                                <div style="font-size:12px; color:#444;">${item.detail || ''}</div>
                                <div style="font-size:12px; color:#666;">${item.extra || ''}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        });
        resultsBox.innerHTML = html;
    } catch (err) {
        resultsBox.innerHTML = `<div style="color:#b71c1c;">Search failed: ${err.message}</div>`;
    }
}

/**
 * Toggle search result section visibility.
 * 
 * Each category (Pharmaceuticals, Equipment, Consumables) is a
 * collapsible section. This toggles individual sections.
 * 
 * @param {HTMLElement} headerEl - Result category header element
 */
function toggleSearchResults(headerEl) {
    const body = headerEl.nextElementSibling;
    if (!body) return;
    const isShown = body.style.display === 'block';
    body.style.display = isShown ? 'none' : 'block';
    const arrow = headerEl.querySelector('span');
    if (arrow) arrow.textContent = isShown ? '▸' : '▾';
}

// expose for inline handlers
window.searchMedicalChest = searchMedicalChest;
window.toggleSearchResults = toggleSearchResults;


//

// MAINTENANCE NOTE
// Historical auto-generated note blocks were removed because they were repetitive and
// obscured real logic changes during review. Keep focused comments close to behavior-
// critical code paths (UI state hydration, async fetch lifecycle, and mode-gated
// controls) so maintenance remains actionable.
