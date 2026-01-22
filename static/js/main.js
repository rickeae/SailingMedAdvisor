// Main utilities and navigation - Cleaned up

const SIDEBAR_STATE_KEY = 'sailingmed:sidebarCollapsed';
let globalSidebarCollapsed = false;

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
    body.style.display = isExpanded ? "none" : "block";
    if (icon) icon.textContent = isExpanded ? "▸" : "▾";
    if (el.dataset && el.dataset.sidebarId) {
        syncSidebarSections(el.dataset.sidebarId, !isExpanded);
    }
    if (el.dataset && el.dataset.prefKey) {
        try { localStorage.setItem(el.dataset.prefKey, (!isExpanded).toString()); } catch (err) { /* ignore */ }
    }
}

// Toggle detail section with icon change
function toggleDetailSection(el) {
    const body = el.nextElementSibling;
    const icon = el.querySelector('.detail-icon');
    const isExpanded = body.style.display === "block";
    
    body.style.display = isExpanded ? "none" : "block";
    icon.textContent = isExpanded ? "▸" : "▾";
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
        loadContext('Settings');
    } else if(n === 'CrewMedical' || n === 'VesselCrewInfo') { 
        loadData(); 
        if (typeof loadVesselInfo === 'function') {
            loadVesselInfo();
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
        loadContext('Chat');
        restoreCollapsibleState('query-form-header', true);
        // Prefetch prompt preview so it is ready when expanded
        if (typeof refreshPromptPreview === 'function') {
            refreshPromptPreview();
        }
    }
}

// Load crew data only
async function loadData() {
    console.log('[DEBUG] loadData: start');
    try {
        const [res, historyRes] = await Promise.all([
            fetch('/api/data/patients', { credentials: 'same-origin' }),
            fetch('/api/data/history', { credentials: 'same-origin' }),
        ]);
        console.log('[DEBUG] loadData: status patients', res.status, 'history', historyRes.status);
        if (!res.ok) throw new Error(`Patients request failed: ${res.status}`);
        if (!historyRes.ok) throw new Error(`History request failed: ${historyRes.status}`);
        const data = await res.json();
        const history = await historyRes.json();
        console.log('[DEBUG] loadData: patients length', Array.isArray(data) ? data.length : 'n/a');
        if (!Array.isArray(data)) throw new Error('Unexpected patients data format');
        loadCrewData(data, Array.isArray(history) ? history : []);
    } catch (err) {
        console.error('[DEBUG] Failed to load crew data', err);
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
    loadData(); 
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
}

// Context loader
async function loadContext(tabName) {
    try {
        const res = await fetch('/api/context', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Context load failed: ${res.status}`);
        const data = await res.json();
        const tabData = data[tabName];
        if (!tabData || !tabData.sections) return;
        tabData.sections.forEach((section) => {
            const el = document.querySelector(`[data-sidebar-section="${section.id}"] .sidebar-body`);
            if (el) {
                el.textContent = section.body || '';
                const titleEl = el.parentElement.querySelector('.sidebar-title');
                if (titleEl && section.title) {
                    titleEl.childNodes.forEach(node => {
                        if (node.nodeType === Node.TEXT_NODE) {
                            node.textContent = ` ${section.title}`;
                        }
                    });
                }
            }
        });
    } catch (err) {
        console.warn('Context load error', err);
    }
}

// Restore last chat so the triage page shows the most recent response on load
async function restoreLastChatView() {
    try {
        const display = document.getElementById('display');
        if (!display || display.children.length > 0) return;
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
