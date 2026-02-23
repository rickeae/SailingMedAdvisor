/* =============================================================================
 * Author: Rick Escher
 * Project: SilingMedAdvisor (SailingMedAdvisor)
 * Context: Google HAI-DEF Framework
 * Models: Google MedGemmas
 * Program: Kaggle Impact Challenge
 * ========================================================================== */
/*
Fallback interactivity recovery layer.
Keeps core UI controls usable if inline handlers fail due stale cache or script load issues.
*/

(function installUiRecovery() {
    let crewDataRecoveryPromise = null;

    async function ensureCrewDataFallback() {
        if (crewDataRecoveryPromise) return crewDataRecoveryPromise;
        crewDataRecoveryPromise = (async () => {
            const [patientsRes, historyRes, settingsRes] = await Promise.all([
                fetch('/api/data/patients', { credentials: 'same-origin' }),
                fetch('/api/data/history', { credentials: 'same-origin' }),
                fetch('/api/data/settings', { credentials: 'same-origin' }),
            ]);
            if (!patientsRes.ok) {
                throw new Error(`Patients request failed: ${patientsRes.status}`);
            }
            const patients = await patientsRes.json();
            const history = historyRes.ok ? await historyRes.json().catch(() => []) : [];
            const settings = settingsRes.ok ? await settingsRes.json().catch(() => ({})) : {};
            if (typeof window.loadCrewData === 'function' && Array.isArray(patients)) {
                window.loadCrewData(
                    patients,
                    Array.isArray(history) ? history : [],
                    settings && typeof settings === 'object' ? settings : {}
                );
                return true;
            }
            return false;
        })().finally(() => {
            crewDataRecoveryPromise = null;
        });
        return crewDataRecoveryPromise;
    }

    /**
     * applyBannerControlsFallback: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function applyBannerControlsFallback(activeTab) {
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

    /**
     * parseTabTargetFromOnclick: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function parseTabTargetFromOnclick(onclickValue) {
        const raw = (onclickValue || '').toString();
        const match = raw.match(/'([^']+)'/);
        return match ? match[1] : '';
    }

    /**
     * emergencyShowTab: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function emergencyShowTab(tabName, triggerEl) {
        if (!tabName) return;
        document.querySelectorAll('.content').forEach((section) => {
            section.style.display = 'none';
        });
        const target = document.getElementById(tabName);
        if (target) target.style.display = 'flex';
        document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
        if (triggerEl && triggerEl.classList) triggerEl.classList.add('active');
        if (typeof window.toggleBannerControls === 'function') {
            window.toggleBannerControls(tabName);
        } else {
            applyBannerControlsFallback(tabName);
        }
        if (tabName === 'Chat' || tabName === 'CrewMedical' || tabName === 'VesselCrewInfo') {
            ensureCrewDataFallback().catch(() => {});
        }
        if (tabName === 'Chat' && typeof window.updateUI === 'function') {
            window.updateUI();
        }
    }

    /**
     * bindTabRecovery: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function bindTabRecovery() {
        document.querySelectorAll('.nav .tab').forEach((btn) => {
            if (btn.dataset.recoveryBound === '1') return;
            btn.dataset.recoveryBound = '1';
            btn.addEventListener('click', (ev) => {
                const tabName = btn.dataset.tabTarget || parseTabTargetFromOnclick(btn.getAttribute('onclick'));
                if (!tabName) return;
                ev.preventDefault();
                ev.stopImmediatePropagation();
                if (typeof window.showTab === 'function') {
                    try {
                        const maybePromise = window.showTab(btn, tabName);
                        if (maybePromise && typeof maybePromise.then === 'function') {
                            maybePromise.catch(() => {
                                emergencyShowTab(tabName, btn);
                            });
                        }
                    } catch (err) {
                        emergencyShowTab(tabName, btn);
                    }
                } else {
                    emergencyShowTab(tabName, btn);
                }
            }, true);
        });
    }

    /**
     * bindSidebarRecovery: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function bindSidebarRecovery() {
        document.querySelectorAll('.page-sidebar').forEach((sidebar) => {
            if (sidebar.dataset.recoveryBound === '1') return;
            sidebar.dataset.recoveryBound = '1';
            sidebar.addEventListener('click', (ev) => {
                const toggleBtn = sidebar.querySelector('.sidebar-toggle');
                if (toggleBtn && !toggleBtn.contains(ev.target)) return;
                ev.preventDefault();
                ev.stopImmediatePropagation();
                if (typeof window.toggleSidebar === 'function') {
                    window.toggleSidebar(sidebar);
                    return;
                }
                const nextCollapsed = !sidebar.classList.contains('collapsed');
                document.querySelectorAll('.page-sidebar').forEach((node) => {
                    node.classList.toggle('collapsed', nextCollapsed);
                });
                document.querySelectorAll('.page-body').forEach((body) => {
                    body.classList.toggle('sidebar-collapsed', nextCollapsed);
                    body.classList.toggle('sidebar-open', !nextCollapsed);
                });
            }, true);
        });
    }

    /**
     * buildCrewLabel: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function buildCrewLabel(crew) {
        const first = (crew && crew.firstName) ? String(crew.firstName).trim() : '';
        const last = (crew && crew.lastName) ? String(crew.lastName).trim() : '';
        const full = `${first} ${last}`.trim();
        if (full) return full;
        if (crew && crew.name) return String(crew.name).trim();
        return 'Unnamed Crew';
    }

    async function ensureCrewDropdownFallback() {
        const select = document.getElementById('p-select');
        if (!select) return;
        const hasRealOptions = Array.from(select.options || []).some((opt) => (opt.value || '').toString().trim());
        if (hasRealOptions) return;
        try {
            const res = await fetch('/api/data/patients', { credentials: 'same-origin' });
            if (!res.ok) return;
            const patients = await res.json();
            if (!Array.isArray(patients)) return;
            const current = select.value || '';
            select.innerHTML = '<option value="">Unnamed Crew Member</option>';
            patients.forEach((crew) => {
                const opt = document.createElement('option');
                opt.value = String((crew && crew.id) || '');
                opt.textContent = buildCrewLabel(crew);
                select.appendChild(opt);
            });
            if (current) select.value = current;
        } catch (err) {
            // Best-effort fallback only.
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        bindTabRecovery();
        bindSidebarRecovery();
        ensureCrewDataFallback().catch(() => {});
        ensureCrewDropdownFallback();
        if (typeof window.toggleBannerControls === 'function') {
            window.toggleBannerControls('Chat');
        } else {
            applyBannerControlsFallback('Chat');
        }
    });
})();
