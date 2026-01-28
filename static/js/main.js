/*
File: static/js/main.js
Author notes: Core UI utilities (tab switching, collapsibles, sidebar) shared
across pages. Keeps global behaviors lightweight and reusable.
*/

const SIDEBAR_STATE_KEY = 'sailingmed:sidebarCollapsed';
let globalSidebarCollapsed = false;
let crewDataLoaded = false;
let crewDataPromise = null;

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

// Toggle collapsible sections
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
    // Show inline triage sample selector only when expanded AND in advanced/developer mode
    const sampleInline = el.querySelector('.triage-sample-inline');
    if (sampleInline) {
        const isAdvanced = document.body.classList.contains('mode-advanced') || document.body.classList.contains('mode-developer');
        sampleInline.style.display = (nextExpanded && isAdvanced) ? "flex" : "none";
    }
    if (el.dataset && el.dataset.sidebarId) {
        syncSidebarSections(el.dataset.sidebarId, nextExpanded);
    }
    if (el.dataset && el.dataset.prefKey) {
        try { localStorage.setItem(el.dataset.prefKey, (!nextExpanded).toString()); } catch (err) { /* ignore */ }
    }
}

// Toggle detail section with icon change
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

// Crew-specific toggle with icon change
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

// Sidebar expand/collapse
function toggleSidebar(btn) {
    const sidebar = btn.closest ? btn.closest('.page-sidebar') : btn;
    if (!sidebar) return;
    // Toggle global state and apply to all sidebars
    const nextCollapsed = !globalSidebarCollapsed;
    setSidebarState(nextCollapsed);
}

// Show/hide matching sidebar sections
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

// Initialize sidebar visibility based on current collapsible state
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

async function ensureCrewData() {
    if (crewDataLoaded) return;
    if (crewDataPromise) return crewDataPromise;
    crewDataPromise = loadData()
        .then(() => { crewDataLoaded = true; crewDataPromise = null; })
        .catch((err) => { crewDataPromise = null; throw err; });
    return crewDataPromise;
}

// Tab navigation
async function showTab(e, n) {
    console.log('[DEBUG] showTab ->', n);
    document.querySelectorAll('.content').forEach(c=>c.style.display='none');
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.getElementById(n).style.display='flex'; 
    e.currentTarget.classList.add('active');
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
        if (typeof loadEquipment === 'function') {
            loadEquipment();
        }
        if (typeof loadMedPhotoQueue === 'function') {
            loadMedPhotoQueue();
        }
        if (typeof loadPharmacy === 'function') {
            loadPharmacy();
        }
        loadContext(n);
    }
    if (n === 'Chat') {
        try {
            await ensureCrewData();
        } catch (err) {
            console.warn('[DEBUG] Chat crew load failed:', err);
        }
        loadContext('Chat');
        restoreCollapsibleState('query-form-header', true);
        // Prefetch prompt preview so it is ready when expanded
        if (typeof refreshPromptPreview === 'function') {
            refreshPromptPreview(true);
        }
    }
}

// Load crew data only
async function loadData() {
    console.log('[DEBUG] loadData: start');
    try {
        const [res, historyRes, settingsRes] = await Promise.all([
            fetch('/api/data/patients', { credentials: 'same-origin' }),
            fetch('/api/data/history', { credentials: 'same-origin' }),
            fetch('/api/data/settings', { credentials: 'same-origin' })
        ]);
        console.log('[DEBUG] loadData: status patients', res.status, 'history', historyRes.status, 'settings', settingsRes.status);
        if (!res.ok) throw new Error(`Patients request failed: ${res.status}`);
        if (!settingsRes.ok) console.warn('Settings request failed:', settingsRes.status);

        // Parse patients (hard requirement)
        const data = await res.json();

        // Parse history, but never block crew rendering if it fails
        let history = [];
        if (historyRes.ok) {
            try {
                const parsedHistory = await historyRes.json();
                history = Array.isArray(parsedHistory) ? parsedHistory : [];
            } catch (err) {
                console.warn('History parse failed; continuing without history.', err);
                history = [];
            }
        } else {
            console.warn('History request failed; continuing without history. Status:', historyRes.status);
        }

        // Parse settings (optional)
        let settings = {};
        try {
            settings = settingsRes.ok ? await settingsRes.json() : {};
        } catch (err) {
            console.warn('Settings parse failed, using defaults.', err);
        }
        window.CACHED_SETTINGS = settings || {};
        console.log('[DEBUG] loadData: patients length', Array.isArray(data) ? data.length : 'n/a');
        if (!Array.isArray(data)) throw new Error('Unexpected patients data format');

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
        if (pSelect) pSelect.innerHTML = '<option>Unnamed Crew</option>';
        const medicalContainer = document.getElementById('crew-medical-list');
        if (medicalContainer) medicalContainer.innerHTML = `<div style="color:#666;">Unable to load crew data. ${err.message}</div>`;
        const infoContainer = document.getElementById('crew-info-list');
        if (infoContainer) infoContainer.innerHTML = `<div style="color:#666;">Unable to load crew data. ${err.message}</div>`;
    }
}

function toggleBannerControls(activeTab) {
    const triageControls = document.getElementById('banner-controls-triage');
    const crewControls = document.getElementById('banner-controls-crew');
    const medExportAll = document.getElementById('crew-med-export-all-btn');
    const crewCsvBtn = document.getElementById('crew-csv-btn');
    if (triageControls) triageControls.style.display = activeTab === 'Chat' ? 'flex' : 'none';
    if (crewControls) crewControls.style.display = (activeTab === 'CrewMedical' || activeTab === 'VesselCrewInfo') ? 'flex' : 'none';
    if (medExportAll) medExportAll.style.display = activeTab === 'CrewMedical' ? 'inline-flex' : 'none';
    if (crewCsvBtn) crewCsvBtn.style.display = activeTab === 'VesselCrewInfo' ? 'inline-flex' : 'none';
}

// Initialize on page load
window.onload = () => { 
    console.log('[DEBUG] window.onload: start');
    ensureCrewData();
    // Preload Medical Chest data so tab opens instantly.
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
    updateUI(); 
    toggleBannerControls('Chat');
    initSidebarSync();
    restoreCollapsibleState('query-form-header', true);
    restoreLastChatView();
};

// Ensure loadCrewData exists before any calls (safety for race conditions)
if (typeof window.loadCrewData !== 'function') {
    console.error('[DEBUG] window.loadCrewData is not defined at main.js load time.');
}

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

// Context loader
async function loadContext(tabName) {
    // Sidebars are now fully static HTML; no remote context to fetch.
    return;
}

// Restore last chat so the triage page shows the most recent response on load
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
        const last = history[history.length - 1];
        const parse = (txt) => (window.marked && typeof window.marked.parse === 'function')
            ? window.marked.parse(txt || '')
            : (txt || '').replace(/\\n/g, '<br>');
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
    }
}

// Medical Chest search across pharma/equipment/consumables
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
