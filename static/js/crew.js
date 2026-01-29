/*
File: static/js/crew.js
Author notes: Client-side controller for Crew & Vessel information management.
I handle crew member profiles, medical histories, vaccine tracking, document uploads,
vessel information, and integration with the chat system for patient selection.

Key Responsibilities:
- Crew member CRUD operations (add, edit, delete crew profiles)
- Vaccine record management with customizable vaccine types
- Document upload/storage for passport photos and identification
- Medical history tracking and export functionality
- Emergency contact management with copy-between-crew feature
- Vessel information management with auto-save
- Integration with chat system for patient/crew selection
- Chat history tracking and display per crew member
- Export capabilities for crew lists, medical histories, and individual records

Data Flow:
- Crew data stored in /data/patients.json via /api/data/patients endpoint
- Vessel data stored in /data/vessel.json via /api/data/vessel endpoint  
- Chat history stored separately and grouped by patient for display
- Documents stored as base64 in crew records (passportHeadshot, passportPage)

Integration Points:
- Chat system: Updates #p-select dropdown for patient selection
- Settings: Uses customizable vaccine types from settings
- Main.js: Called by loadData() for initial load and refreshes
*/

// Reuse the chat dropdown storage key without redefining the global constant
const CREW_LAST_PATIENT_KEY = typeof LAST_PATIENT_KEY !== 'undefined' ? LAST_PATIENT_KEY : 'sailingmed:lastPatient';
/**
 * Default vaccine types used when settings don't provide custom types.
 * These represent common vaccinations tracked for maritime crew health records.
 * Can be overridden via Settings → Vaccine Types configuration.
 */
const DEFAULT_VACCINE_TYPES = [
    'Diphtheria, Tetanus, and Pertussis (DTaP/Tdap)',
    'Polio (IPV/OPV)',
    'Measles, Mumps, Rubella (MMR)',
    'HPV (Human Papillomavirus)',
    'Influenza',
    'Haemophilus influenzae type b (Hib)',
    'Hepatitis B',
    'Varicella (Chickenpox)',
    'Pneumococcal (PCV)',
    'Rotavirus',
    'COVID-19',
    'Yellow Fever',
    'Typhoid',
    'Hepatitis A',
    'Japanese Encephalitis',
    'Rabies',
    'Cholera',
];

// In-memory caches for crew history tracking
let historyStore = [];           // Array of all chat history entries
let historyStoreById = {};        // Map of history entries by ID for quick lookup

/**
 * Calculate age from birthdate string.
 * 
 * @param {string} birthdate - ISO date string (YYYY-MM-DD)
 * @returns {string} Age string in format " (XX yo)" or empty string if invalid
 * 
 * @example
 * calculateAge("1990-05-15")  // Returns " (35 yo)" in 2026
 * calculateAge("")            // Returns ""
 * calculateAge(null)          // Returns ""
 */
function calculateAge(birthdate) {
    if (!birthdate) return '';
    const today = new Date();
    const birth = new Date(birthdate);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
    }
    return age >= 0 ? ` (${age} yo)` : '';
}

/**
 * Toggle visibility of individual chat log entry (query/response pair).
 * Also shows/hides action buttons (Reactivate, Export, Delete) when expanded.
 * 
 * @param {HTMLElement} el - The header element that was clicked
 */
function toggleLogEntry(el) {
    const body = el.nextElementSibling;
    const arrow = el.querySelector('.history-arrow');
    const buttons = el.querySelectorAll('.history-entry-action');
    const isExpanded = body.style.display === 'block';
    body.style.display = isExpanded ? 'none' : 'block';
    if (arrow) arrow.textContent = isExpanded ? '▸' : '▾';
    buttons.forEach((btn) => {
        btn.style.visibility = isExpanded ? 'hidden' : 'visible';
    });
}

/**
 * Export a single chat history entry as a text file.
 * 
 * Creates a formatted text file with the query and response from a specific
 * chat log entry. Useful for sharing specific medical consultations or
 * keeping offline records of important interactions.
 * 
 * @param {string} id - The unique ID of the history entry to export
 * 
 * File Format:
 * ```
 * Date: [ISO timestamp]
 * Patient: [Crew member name]
 * Title: [Optional title]
 * 
 * Query:
 * [User's question/input]
 * 
 * Response:
 * [AI's response]
 * ```
 */
function exportHistoryItemById(id) {
    if (!id || !historyStoreById[id]) {
        alert('Unable to export: entry not found.');
        return;
    }
    const item = historyStoreById[id];
    const name = (item.patient || 'Unknown').replace(/[^a-z0-9]/gi, '_');
    const date = (item.date || '').replace(/[^0-9T:-]/g, '_');
    const filename = `history_${name}_${date || 'entry'}.txt`;
    const parts = [];
    parts.push(`Date: ${item.date || ''}`);
    parts.push(`Patient: ${item.patient || 'Unknown'}`);
    if (item.title) parts.push(`Title: ${item.title}`);
    parts.push('');
    parts.push('Query:');
    parts.push(item.query || '');
    parts.push('');
    parts.push('Response:');
    parts.push(item.response || '');
    const blob = new Blob([parts.join('\\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Delete a specific chat history entry with double confirmation.
 * 
 * Implements a two-step confirmation process:
 * 1. Confirm dialog with crew member name
 * 2. Type "DELETE" prompt for final confirmation
 * 
 * After deletion, reloads the entire history list to update UI.
 * 
 * @param {string} id - The unique ID of the history entry to delete
 */
async function deleteHistoryItemById(id) {
    if (!id) {
        alert('Unable to delete: entry not found.');
        return;
    }
    const label = historyStoreById[id]?.patient || 'entry';
    const first = confirm(`Delete this log entry for ${label}?`);
    if (!first) return;
    const confirmText = prompt('Type DELETE to confirm deletion:');
    if (confirmText !== 'DELETE') {
        alert('Deletion cancelled.');
        return;
    }
    try {
        const res = await fetch('/api/data/history', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(res.statusText || 'Failed to load history');
        const data = await res.json();
        const filtered = Array.isArray(data) ? data.filter((h) => h.id !== id) : [];
        const saveRes = await fetch('/api/data/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(filtered),
            credentials: 'same-origin',
        });
        if (!saveRes.ok) throw new Error(saveRes.statusText || 'Failed to delete');
        loadData(); // refresh UI with new history
    } catch (err) {
        alert(`Failed to delete: ${err.message}`);
    }
}

/**
 * Get display name for crew member in "Last, First" format.
 * Used in lists and headers where formal display is preferred.
 * 
 * @param {Object} crew - Crew member object
 * @returns {string} Display name in "Last, First" format or fallback
 * 
 * @example
 * getCrewDisplayName({firstName: "John", lastName: "Smith"})  // "Smith, John"
 * getCrewDisplayName({name: "John Smith"})                     // "John Smith"
 * getCrewDisplayName({})                                        // "Unknown"
 */
function getCrewDisplayName(crew) {
    if (crew.firstName && crew.lastName) {
        return `${crew.lastName}, ${crew.firstName}`;
    }
    return crew.name || 'Unknown';
}

/**
 * Get full name for crew member in "First Last" format.
 * Used in conversational contexts and chat system.
 * 
 * @param {Object} crew - Crew member object
 * @returns {string} Full name in "First Last" format or fallback
 * 
 * @example
 * getCrewFullName({firstName: "John", lastName: "Smith"})  // "John Smith"
 * getCrewFullName({name: "John Smith"})                     // "John Smith"
 * getCrewFullName({})                                        // "Unknown"
 */
function getCrewFullName(crew) {
    if (crew.firstName && crew.lastName) {
        return `${crew.firstName} ${crew.lastName}`;
    }
    return crew.name || 'Unknown';
}

/**
 * Group chat history entries by patient/crew member.
 * 
 * Creates multiple lookup keys per entry to handle various matching scenarios:
 * - By patient name (text)
 * - By patient ID (id:xxx)
 * - "Unnamed Crew" for entries without patient info
 * - "Inquiry History" for general medical inquiries
 * 
 * Also populates historyStoreById map for quick ID-based lookups.
 * 
 * @param {Array<Object>} history - Array of chat history entries
 * @returns {Object} Map of patient keys to arrays of history entries
 * 
 * @example
 * groupHistoryByPatient([
 *   {id: "h1", patient: "John Smith", patient_id: "123", ...},
 *   {id: "h2", patient: "Inquiry", ...}
 * ])
 * // Returns:
 * {
 *   "John Smith": [{id: "h1", ...}],
 *   "id:123": [{id: "h1", ...}],
 *   "Inquiry History": [{id: "h2", ...}]
 * }
 */
function groupHistoryByPatient(history) {
    const map = {};
    history.forEach((item) => {
        if (item && item.id) {
            historyStoreById[item.id] = item;
        }
        const keys = [];
        const patientName = (item.patient || '').trim();
        if (patientName) keys.push(patientName);
        if (item.patient_id) keys.push(`id:${item.patient_id}`);
        if (!patientName && !item.patient_id) keys.push('Unnamed Crew');
        if (patientName && patientName.toLowerCase() === 'inquiry') keys.push('Inquiry History');
        keys.forEach((k) => {
            if (!map[k]) map[k] = [];
            map[k].push(item);
        });
    });
    return map;
}

/**
 * Render HTML for a list of chat history entries.
 * 
 * Each entry is displayed as a collapsible card with:
 * - Date and preview of first line of query
 * - Expandable query/response details
 * - Action buttons: Reactivate, Export, Delete (visible when expanded)
 * 
 * @param {Array<Object>} entries - Array of history entry objects
 * @returns {string} HTML markup for all entries
 */
function renderHistoryEntries(entries) {
    if (!entries || entries.length === 0) {
        return '<div style="color:#666;">No chat history recorded.</div>';
    }
    const sorted = [...entries].sort((a, b) => (a.date || '').localeCompare(b.date || '')).reverse();
    return sorted
        .map((item, idx) => {
            const q = escapeHtml(item.query || '').replace(/\n/g, '<br>');
            const r = escapeHtml(item.response || '').replace(/\n/g, '<br>');
            const date = escapeHtml(item.date || '');
            const previewRaw = (item.query || '').split('\n')[0] || '';
            let preview = escapeHtml(previewRaw);
            if (preview.length > 80) preview = preview.slice(0, 80) + '...';
            return `
                <div class="collapsible" style="margin-bottom:6px;">
                    <div class="col-header crew-med-header" onclick="toggleLogEntry(this)" style="justify-content:flex-start; align-items:center;">
                        <span class="dev-tag">dev:crew-history-entry</span>
                        <span class="toggle-label history-arrow" style="font-size:16px; margin-right:8px;">▸</span>
                        <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600; font-size:13px;">${date || 'Entry'}${preview ? ' — ' + preview : ''}</span>
                        <div style="display:flex; gap:6px; align-items:center;">
                            <button class="btn btn-sm history-entry-action" style="background:#3949ab; visibility:hidden;" onclick="event.stopPropagation(); reactivateChat('${item.id || ''}')">↩ Reactivate</button>
                            <button class="btn btn-sm history-entry-action" style="background:var(--inquiry); visibility:hidden;" onclick="event.stopPropagation(); exportHistoryItemById('${item.id || ''}')">Export</button>
                            <button class="btn btn-sm history-entry-action" style="background:var(--red); visibility:hidden;" onclick="event.stopPropagation(); deleteHistoryItemById('${item.id || ''}')">Delete</button>
                        </div>
                    </div>
                    <div class="col-body" style="padding:8px; font-size:13px; display:none;">
                        <div style="margin-bottom:6px;"><strong>Query:</strong><br>${q}</div>
                        <div><strong>Response:</strong><br>${r}</div>
                    </div>
                </div>`;
        })
        .join('');
}

/**
 * Render a collapsible section containing grouped history entries.
 * 
 * @param {string} label - Section header label (e.g., "Smith, John Log")
 * @param {Array<Object>} entries - History entries for this section
 * @param {boolean} defaultOpen - Whether section starts expanded (default: true)
 * @returns {string} HTML markup for the entire section
 */
function renderHistorySection(label, entries, defaultOpen = true) {
    const bodyStyle = defaultOpen ? 'display:block;' : '';
    const arrow = defaultOpen ? '▾' : '▸';
    const count = Array.isArray(entries) ? entries.length : 0;
    return `
        <div class="collapsible history-item" style="margin-top:10px;">
            <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; align-items:center;">
                <span class="dev-tag">dev:crew-history-section</span>
                <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">${arrow}</span>
                <span style="flex:1; font-weight:600; font-size:14px;">${escapeHtml(label)}${count ? ` (${count} entries)` : ''}</span>
            </div>
            <div class="col-body" style="padding:10px; ${bodyStyle}">
                ${renderHistoryEntries(entries)}
            </div>
        </div>`;
}

/**
 * Retrieve chat history entries for a specific crew member.
 * 
 * Tries multiple lookup strategies to find matching history:
 * 1. Full name from getCrewFullName()
 * 2. Legacy name field
 * 3. Constructed name from firstName/lastName
 * 4. Patient ID lookup (id:xxx)
 * 
 * @param {Object} p - Crew member object
 * @param {Object} historyMap - Map from groupHistoryByPatient()
 * @returns {Array<Object>} Array of history entries or empty array
 */
function getHistoryForCrew(p, historyMap) {
    const keys = [];
    const fullName = getCrewFullName(p);
    if (fullName) keys.push(fullName);
    if (p.name) keys.push(p.name);
    if (p.firstName || p.lastName) keys.push(`${p.firstName || ''} ${p.lastName || ''}`.trim());
    if (p.id) keys.push(`id:${p.id}`);
    for (const k of keys) {
        if (historyMap[k]) return historyMap[k];
    }
    return [];
}

/**
 * Get vaccine type options from settings or defaults.
 * 
 * Normalizes and deduplicates vaccine types, preferring settings values
 * when available. Case-insensitive duplicate detection ensures clean lists.
 * 
 * @param {Object} settings - Settings object with optional vaccine_types array
 * @returns {Array<string>} Normalized, deduplicated vaccine type names
 */
function getVaccineOptions(settings = {}) {
    const raw = Array.isArray(settings.vaccine_types) ? settings.vaccine_types : DEFAULT_VACCINE_TYPES;
    const seen = new Set();
    return raw
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
 * Render detailed information for a single vaccine record.
 * 
 * Displays all available fields for a vaccine entry including dates,
 * manufacturer info, batch numbers, provider details, and reactions.
 * Only shows fields that have values.
 * 
 * @param {Object} v - Vaccine record object
 * @returns {string} HTML markup with labeled field details
 */
function renderVaccineDetails(v) {
    const fields = [
        ['Vaccine Type/Disease', v.vaccineType],
        ['Date Administered', v.dateAdministered],
        ['Dose Number', v.doseNumber],
        ['Next Dose Due Date', v.nextDoseDue],
        ['Trade Name & Manufacturer', v.tradeNameManufacturer],
        ['Lot/Batch Number', v.lotNumber],
        ['Administering Clinic/Provider', v.provider],
        ['Clinic/Provider Country', v.providerCountry],
        ['Expiration Date (dose)', v.expirationDate],
        ['Site & Route', v.siteRoute],
        ['Allergic Reactions', v.reactions],
        ['Remarks', v.remarks],
    ];
    const rows = fields
        .filter(([, val]) => val)
        .map(([label, val]) => `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(val)}</div>`)
        .join('');
    return rows || '<div style="color:#666;">No details recorded for this dose.</div>';
}

/**
 * Render a list of vaccine records for a crew member.
 * 
 * Each vaccine is shown as a collapsible card with:
 * - Header: vaccine type and date administered
 * - Body: Full details when expanded
 * - Delete button (visible when expanded)
 * 
 * @param {Array<Object>} vaccines - Array of vaccine records
 * @param {string} crewId - Crew member ID for scoping delete operations
 * @returns {string} HTML markup for vaccine list or "no vaccines" message
 */
function renderVaccineList(vaccines = [], crewId) {
    if (!Array.isArray(vaccines) || vaccines.length === 0) {
        return '<div style="font-size:12px; color:#666;">No vaccines recorded.</div>';
    }
    return vaccines
        .map((v) => {
            const vid = escapeHtml(v.id || '');
            const label = escapeHtml(v.vaccineType || 'Vaccine');
            const date = escapeHtml(v.dateAdministered || '');
            return `
                <div class="collapsible" style="margin-bottom:8px;">
                    <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; background:#fff;">
                        <span class="dev-tag">dev:crew-vax-entry</span>
                        <span class="toggle-label history-arrow" style="font-size:16px; margin-right:8px;">▸</span>
                        <span style="flex:1; font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${label}${date ? ' — ' + date : ''}</span>
                        <button onclick="event.stopPropagation(); deleteVaccine('${crewId}', '${vid}')" class="btn btn-sm history-action-btn" style="background:var(--red); visibility:hidden;">🗑 Delete</button>
                    </div>
                    <div class="col-body" style="padding:10px; display:none; font-size:12px; background:#f9fbff; border:1px solid #e0e7ff; border-top:none;">
                        ${renderVaccineDetails(v)}
                    </div>
                </div>`;
        })
        .join('');
}

/**
 * Clear all vaccine input fields after successful add operation.
 * Also hides the "other" vaccine type input field.
 * 
 * @param {string} crewId - Crew member ID for field identification
 */
function clearVaccineInputs(crewId) {
    const ids = [
        `vx-type-${crewId}`,
        `vx-type-other-${crewId}`,
        `vx-date-${crewId}`,
        `vx-dose-${crewId}`,
        `vx-trade-${crewId}`,
        `vx-lot-${crewId}`,
        `vx-provider-${crewId}`,
        `vx-provider-country-${crewId}`,
        `vx-next-${crewId}`,
        `vx-exp-${crewId}`,
        `vx-site-${crewId}`,
        `vx-remarks-${crewId}`,
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.value = '';
            if (id.includes('type-other')) {
                el.style.display = 'none';
            }
        }
    });
    const rx = document.getElementById(`vx-reactions-${crewId}`);
    if (rx) rx.value = '';
    const typeSelect = document.getElementById(`vx-type-${crewId}`);
    if (typeSelect) typeSelect.value = '';
}

/**
 * Handle vaccine type dropdown change to show/hide "Other" input field.
 * 
 * When "__other__" option is selected, displays a text input for custom
 * vaccine types. Otherwise hides it and clears any custom value.
 * 
 * @param {string} crewId - Crew member ID for field identification
 */
function handleVaccineTypeChange(crewId) {
    const select = document.getElementById(`vx-type-${crewId}`);
    const other = document.getElementById(`vx-type-other-${crewId}`);
    if (!select || !other) return;
    const showOther = select.value === '__other__';
    other.style.display = showOther ? 'block' : 'none';
    if (!showOther) {
        other.value = '';
    } else {
        other.focus();
    }
}

/**
 * Primary data loading and rendering function for crew management.
 * 
 * This is the main controller function that orchestrates rendering of:
 * - Patient selection dropdown in chat interface
 * - Crew medical history list with chat logs
 * - Crew information list with editable profiles
 * - Vaccine tracking sections
 * 
 * Data Flow:
 * 1. Receives crew data, history, and settings from main loadData()
 * 2. Groups history by patient for efficient lookup
 * 3. Sorts crew based on user preference (last name, first name, age)
 * 4. Updates chat system's patient selector dropdown
 * 5. Renders medical histories with grouped chat logs
 * 6. Renders editable crew profile cards with all fields
 * 7. Renders vaccine tracking UI for each crew member
 * 
 * Called By:
 * - main.js loadData() on initial page load
 * - main.js loadData() after any crew data changes
 * - Internally after crew additions/deletions
 * 
 * @param {Array<Object>} data - Array of crew member objects
 * @param {Array<Object>} history - Array of chat history entries
 * @param {Object} settings - Settings object with vaccine_types, etc.
 */
function loadCrewData(data, history = [], settings = {}) {
    if (!Array.isArray(data)) {
        console.warn('loadCrewData expected array, got', data);
        return;
    }
    console.log('[DEBUG] loadCrewData called with', data.length, 'entries');
    historyStore = Array.isArray(history) ? history : [];
    historyStoreById = {};
    const historyMap = groupHistoryByPatient(historyStore);
    // Sort crew data
    const sortBy = document.getElementById('crew-sort')?.value || 'last';
    data.sort((a, b) => {
        if (sortBy === 'last') {
            const aLast = a.lastName || a.name || '';
            const bLast = b.lastName || b.name || '';
            return aLast.localeCompare(bLast);
        } else if (sortBy === 'first') {
            const aFirst = a.firstName || a.name || '';
            const bFirst = b.firstName || b.name || '';
            return aFirst.localeCompare(bFirst);
        } else if (sortBy === 'birthdate-asc') {
            // Youngest first = most recent birthdates first
            const aDate = a.birthdate || '0000-01-01';
            const bDate = b.birthdate || '0000-01-01';
            return bDate.localeCompare(aDate);
        } else if (sortBy === 'birthdate-desc') {
            // Oldest first = earliest birthdates first
            const aDate = a.birthdate || '9999-12-31';
            const bDate = b.birthdate || '9999-12-31';
            return aDate.localeCompare(bDate);
        }
        return 0;
    });

    // Update patient select dropdown
    const pSelect = document.getElementById('p-select');
    if (pSelect) {
        let storedValue = null;
        try {
            storedValue = localStorage.getItem(CREW_LAST_PATIENT_KEY);
        } catch (err) {
            console.warn('[DEBUG] Unable to read last patient from storage:', err);
        }
        const options = data
            .map((p) => {
                const fullName = escapeHtml(getCrewFullName(p) || 'Unnamed Crew');
                const value = escapeHtml(p.id || '');
                return `<option value="${value}">${fullName}</option>`;
            })
            .join('');
        pSelect.innerHTML = `<option value="">Unnamed Crew</option>` + options;
        const hasPrevId = storedValue && Array.from(pSelect.options).some(opt => opt.value === storedValue);
        if (hasPrevId) {
            pSelect.value = storedValue;
        } else if (storedValue) {
            const matchingByText = Array.from(pSelect.options).find(opt => opt.textContent === storedValue);
            if (matchingByText) {
                pSelect.value = matchingByText.value || '';
            } else {
                pSelect.value = '';
            }
        } else {
            pSelect.value = '';
        }
        console.log('[DEBUG] p-select options', pSelect.options.length, 'stored', storedValue, 'selected', pSelect.value);
        pSelect.onchange = (e) => {
            try { localStorage.setItem(CREW_LAST_PATIENT_KEY, e.target.value); } catch (err) { /* ignore */ }
            console.log('[DEBUG] p-select changed to', e.target.value);
            if (typeof refreshPromptPreview === 'function') {
                refreshPromptPreview();
            }
        };
        if (typeof refreshPromptPreview === 'function') {
            refreshPromptPreview(true);
        }
    }
    
    // Medical histories list
    const medicalContainer = document.getElementById('crew-medical-list');
    if (medicalContainer) {
        const medicalBlocks = data.map(p => {
            const displayName = getCrewDisplayName(p);
            const crewHistory = getHistoryForCrew(p, historyMap);
            const historyCount = Array.isArray(crewHistory) ? crewHistory.length : 0;
            const historySection = renderHistorySection(`${displayName} Log`, crewHistory, true);
            return `
            <div class="collapsible history-item">
                <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start;">
                    <span class="dev-tag">dev:crew-entry</span>
                    <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">▸</span>
                    <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:700;">
                        ${displayName}${historyCount ? ` (${historyCount})` : ''}
                    </span>
                    <button onclick="event.stopPropagation(); exportCrew('${p.id}', '${getCrewFullName(p).replace(/'/g, "\\'")}')" class="btn btn-sm history-action-btn" style="background:var(--inquiry); visibility:hidden;">📤 Export</button>
                </div>
                <div class="col-body" style="padding:12px; background:#e8f4ff; border:1px solid #c7ddff; border-radius:6px;">
                    ${historySection}
                </div>
            </div>`;
        });

        // Add pseudo entries for unnamed and inquiry history
        if (historyMap['Unnamed Crew']) {
            medicalBlocks.push(renderHistorySection('Unnamed Crew Log', historyMap['Unnamed Crew'], true));
        }
        if (historyMap['Inquiry History']) {
            medicalBlocks.push(renderHistorySection('Inquiry History', historyMap['Inquiry History'], true));
        }

        medicalContainer.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                <span class="dev-tag">dev:crew-medical-wrapper</span>
            </div>
            ${medicalBlocks.join('')}
        `;
    }

    // Vessel & crew info list
    const infoContainer = document.getElementById('crew-info-list');
    if (infoContainer) {
        infoContainer.innerHTML = `<div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;"><span class="dev-tag">dev:crew-info-list</span></div>` + data.map(p => {
        const displayName = getCrewDisplayName(p);
        const ageStr = calculateAge(p.birthdate);
        const posInfo = p.position ? ` • ${p.position}` : '';
        const info = `${displayName}${ageStr}${posInfo}`;
        const vaccines = Array.isArray(p.vaccines) ? p.vaccines : [];
        const vaccineOptions = getVaccineOptions(settings);
        const vaccineOptionMarkup = vaccineOptions.map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('');
        const vaccineList = renderVaccineList(vaccines, p.id);
        
        // Check if crew has data to determine default collapse state
        const hasData = p.firstName && p.lastName && p.citizenship;
        
        return `
        <div class="collapsible history-item" data-crew-id="${p.id}">
            <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start;">
                <span class="dev-tag">dev:crew-profile</span>
                <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">▸</span>
                <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:700;">${info}</span>
                <button onclick="event.stopPropagation(); importCrewData('${p.id}')" class="btn btn-sm history-action-btn" style="background:var(--inquiry); visibility:hidden;">📁 Import</button>
                <button onclick="event.stopPropagation(); exportCrew('${p.id}', '${getCrewFullName(p).replace(/'/g, "\\'")}')" class="btn btn-sm history-action-btn" style="background:var(--inquiry); visibility:hidden;">📤 Export</button>
                <button onclick="event.stopPropagation(); deleteCrewMember('patients','${p.id}', '${getCrewFullName(p).replace(/'/g, "\\'")}')" class="btn btn-sm history-action-btn" style="background:var(--red); visibility:hidden;">🗑 Delete</button>
            </div>
            <div class="col-body" style="padding:10px; display:none;">
                <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                    <span class="dev-tag">dev:crew-profile-fields</span>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px; margin-bottom:8px; font-size:13px;">
                    <input type="text" id="fn-${p.id}" value="${p.firstName || ''}" placeholder="First name" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                    <input type="text" id="mn-${p.id}" value="${p.middleName || ''}" placeholder="Middle name(s)" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                    <input type="text" id="ln-${p.id}" value="${p.lastName || ''}" placeholder="Last name" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px; margin-bottom:8px; font-size:13px;">
                    <select id="sx-${p.id}" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                        <option value="">Sex</option>
                        <option value="Male" ${p.sex === 'Male' ? 'selected' : ''}>Male</option>
                        <option value="Female" ${p.sex === 'Female' ? 'selected' : ''}>Female</option>
                        <option value="Non-binary" ${p.sex === 'Non-binary' ? 'selected' : ''}>Non-binary</option>
                        <option value="Other" ${p.sex === 'Other' ? 'selected' : ''}>Other</option>
                        <option value="Prefer not to say" ${p.sex === 'Prefer not to say' ? 'selected' : ''}>Prefer not to say</option>
                    </select>
                    <input type="date" id="bd-${p.id}" value="${p.birthdate || ''}" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                    <select id="pos-${p.id}" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                        <option value="">Position</option>
                        <option value="Captain" ${p.position === 'Captain' ? 'selected' : ''}>Captain</option>
                        <option value="Crew" ${p.position === 'Crew' ? 'selected' : ''}>Crew</option>
                        <option value="Passenger" ${p.position === 'Passenger' ? 'selected' : ''}>Passenger</option>
                    </select>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr 1fr; gap:8px; margin-bottom:8px; font-size:13px;">
                    <input type="text" id="cit-${p.id}" value="${p.citizenship || ''}" placeholder="Citizenship" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                    <input type="text" id="bp-${p.id}" value="${p.birthplace || ''}" placeholder="Birthplace" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                    <input type="text" id="pass-${p.id}" value="${p.passportNumber || ''}" placeholder="Passport #" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                    <input type="date" id="piss-${p.id}" value="${p.passportIssue || ''}" title="Issue date" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                    <input type="date" id="pexp-${p.id}" value="${p.passportExpiry || ''}" title="Expiry date" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                </div>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; font-size:12px;">
                    <span style="font-weight:bold;">Emergency Contact:</span>
                    <select onchange="copyEmergencyContact('${p.id}', this.value); this.value='';" style="padding:4px; font-size:11px;">
                        <option value="">Copy from crew member...</option>
                        ${data.filter(c => c.id !== p.id).map(c => `<option value="${c.id}">${getCrewFullName(c)}</option>`).join('')}
                    </select>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:8px; margin-bottom:8px; font-size:13px;">
                    <input type="text" id="ename-${p.id}" value="${p.emergencyContactName || ''}" placeholder="Emergency name" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                    <input type="text" id="erel-${p.id}" value="${p.emergencyContactRelation || ''}" placeholder="Relationship" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                    <input type="text" id="ephone-${p.id}" value="${p.emergencyContactPhone || ''}" placeholder="Phone" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                    <input type="email" id="eemail-${p.id}" value="${p.emergencyContactEmail || ''}" placeholder="Email" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                </div>
                <div style="margin-bottom:8px; font-size:13px;">
                    <input type="text" id="enotes-${p.id}" value="${p.emergencyContactNotes || ''}" placeholder="Emergency contact notes" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                </div>
                <div style="margin-bottom:10px; font-size:13px;">
                    <div class="dev-tag">dev:crew-health-notes</div>
                    <label style="font-weight:bold; margin-bottom:4px; display:block;">Health / Medical Notes</label>
                    <textarea id="h-${p.id}" class="compact-textarea" placeholder="Medical history, conditions, allergies, medications, etc." onchange="autoSaveProfile('${p.id}')" style="width:100%; min-height:70px;">${p.history || ''}</textarea>
                </div>
                <div style="margin-bottom:10px; font-size:12px; border-top:1px solid #ddd; padding-top:8px;">
                    <label style="font-weight:bold; margin-bottom:4px; display:block;">Contact & Documents</label>
                </div>
                <div style="margin-bottom:8px; font-size:13px;">
                    <input type="text" id="phone-${p.id}" value="${p.phoneNumber || ''}" placeholder="Cell/WhatsApp Number" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                </div>
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:8px;">
                        <div style="border:1px solid #ddd; padding:8px; border-radius:4px; background:#f9f9f9;">
                            <label style="margin-bottom:4px; display:block; font-weight:bold; font-size:11px;">Passport Head Shot Photo:</label>
                            ${p.passportHeadshot ? (p.passportHeadshot.startsWith('data:image/') ? `<div style="margin-bottom:4px;"><img src="${p.passportHeadshot}" style="max-width:100%; max-height:120px; border:1px solid #ccc; border-radius:4px; cursor:pointer;" onclick="window.open('${p.passportHeadshot}', '_blank')"><div style="margin-top:4px;"><button onclick="deleteDocument('${p.id}', 'passportHeadshot')" style="background:var(--red); color:white; border:none; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px;">🗑 Delete</button></div></div>` : `<div style="margin-bottom:4px;"><a href="${p.passportHeadshot}" target="_blank" style="color:var(--inquiry); font-size:11px;">📎 View PDF</a> | <button onclick="deleteDocument('${p.id}', 'passportHeadshot')" style="background:none; border:none; color:var(--red); cursor:pointer; font-size:10px;">🗑</button></div>`) : ''}
                            <input type="file" id="pp-${p.id}" accept="image/*,.pdf" onchange="uploadDocument('${p.id}', 'passportHeadshot', this)" style="font-size:10px; width:100%;">
                        </div>
                        <div style="border:1px solid #ddd; padding:8px; border-radius:4px; background:#f9f9f9;">
                            <label style="margin-bottom:4px; display:block; font-weight:bold; font-size:11px;">Passport Page Photo:</label>
                            ${p.passportPage ? (p.passportPage.startsWith('data:image/') ? `<div style="margin-bottom:4px;"><img src="${p.passportPage}" style="max-width:100%; max-height:120px; border:1px solid #ccc; border-radius:4px; cursor:pointer;" onclick="window.open('${p.passportPage}', '_blank')"><div style="margin-top:4px;"><button onclick="deleteDocument('${p.id}', 'passportPage')" style="background:var(--red); color:white; border:none; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px;">🗑 Delete</button></div></div>` : `<div style="margin-bottom:4px;"><a href="${p.passportPage}" target="_blank" style="color:var(--inquiry); font-size:11px;">📎 View PDF</a> | <button onclick="deleteDocument('${p.id}', 'passportPage')" style="background:none; border:none; color:var(--red); cursor:pointer; font-size:10px;">🗑</button></div>`) : ''}
                            <input type="file" id="ppg-${p.id}" accept="image/*,.pdf" onchange="uploadDocument('${p.id}', 'passportPage', this)" style="font-size:10px; width:100%;">
                        </div>
                    </div>
                    <div class="collapsible" style="margin-top:12px;">
                        <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="background:#fff6e8; border:1px solid #f0d9a8; justify-content:flex-start;">
                            <span class="dev-tag">dev:crew-vax-shell</span>
                            <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">▸</span>
                            <span style="font-weight:700;">Crew Vaccines</span>
                            <span style="font-size:12px; color:#6a5b3a; margin-left:8px;">${vaccines.length} recorded</span>
                        </div>
                        <div class="col-body" style="padding:10px; background:#fffdf7; border:1px solid #f0d9a8; border-top:none; display:none;">
                            <div class="dev-tag" style="margin-bottom:6px;">dev:crew-vax-form</div>
                            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:8px; margin-bottom:8px; font-size:12px;">
                                <div style="grid-column: span 2;">
                                    <label style="font-weight:700; font-size:12px;">Vaccine Type/Disease *</label>
                                    <select id="vx-type-${p.id}" onchange="handleVaccineTypeChange('${p.id}')" style="width:100%; padding:6px;">
                                        <option value="">Select or choose Other…</option>
                                        ${vaccineOptionMarkup}
                                        <option value="__other__">Other (type below)</option>
                                    </select>
                                    <input id="vx-type-other-${p.id}" type="text" style="width:100%; padding:6px; margin-top:6px; display:none;" placeholder="Enter other vaccine type">
                                </div>
                                <div><label style="font-weight:700; font-size:12px;">Date Administered</label><input id="vx-date-${p.id}" type="text" style="width:100%; padding:6px;" placeholder="26-Jan-2026"></div>
                                <div><label style="font-weight:700; font-size:12px;">Dose Number</label><input id="vx-dose-${p.id}" type="text" style="width:100%; padding:6px;" placeholder="Dose 1 of 3"></div>
                                <div><label style="font-weight:700; font-size:12px;">Next Dose Due Date</label><input id="vx-next-${p.id}" type="text" style="width:100%; padding:6px;" placeholder="e.g., 10-Feb-2026"></div>
                                <div style="grid-column: span 2;"><label style="font-weight:700; font-size:12px;">Trade Name & Manufacturer</label><input id="vx-trade-${p.id}" type="text" style="width:100%; padding:6px;" placeholder="Adacel by Sanofi Pasteur"></div>
                                <div><label style="font-weight:700; font-size:12px;">Lot/Batch Number</label><input id="vx-lot-${p.id}" type="text" style="width:100%; padding:6px;" placeholder="Batch #12345X"></div>
                                <div><label style="font-weight:700; font-size:12px;">Administering Clinic/Provider</label><input id="vx-provider-${p.id}" type="text" style="width:100%; padding:6px;" placeholder="Harbor Medical Clinic, Dock 3"></div>
                                <div><label style="font-weight:700; font-size:12px;">Clinic/Provider Country</label><input id="vx-provider-country-${p.id}" type="text" style="width:100%; padding:6px;" placeholder="Spain"></div>
                                <div><label style="font-weight:700; font-size:12px;">Expiration Date (dose)</label><input id="vx-exp-${p.id}" type="text" style="width:100%; padding:6px;" placeholder="e.g., 30-Dec-2026"></div>
                                <div><label style="font-weight:700; font-size:12px;">Site & Route</label><input id="vx-site-${p.id}" type="text" style="width:100%; padding:6px;" placeholder="Left Arm - IM"></div>
                                <div style="grid-column: 1 / -1; display:grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap:8px;">
                                    <div><label style="font-weight:700; font-size:12px;">Allergic Reactions</label><textarea id="vx-reactions-${p.id}" style="width:100%; padding:6px; min-height:60px;" placeholder="Redness, fever, swelling..."></textarea></div>
                                    <div><label style="font-weight:700; font-size:12px;">Remarks</label><textarea id="vx-remarks-${p.id}" style="width:100%; padding:6px; min-height:60px;" placeholder="Notes, special handling, country requirements, follow-up instructions..."></textarea></div>
                                </div>
                            </div>
                            <button onclick="addVaccine('${p.id}')" class="btn btn-sm" style="background:var(--dark); width:100%;"><span class="dev-tag">dev:crew-vax-add</span>Add Vaccine</button>
                            <div class="dev-tag" style="margin:10px 0 6px;">dev:crew-vax-list</div>
                            <div id="vax-list-${p.id}">${vaccineList}</div>
                        </div>
                    </div>
                    </div>
                </div>
            </div>
        </div>`}).join('');
    }
}

// Expose for other scripts during startup
window.loadCrewData = loadCrewData;

// Ensure availability for other scripts that call it during startup
window.loadCrewData = loadCrewData;

// Expose for other scripts that call loadData() before bundling
window.loadCrewData = loadCrewData;
console.log('[DEBUG] crew.js loaded and loadCrewData attached');

// Debug immediately after attach
if (typeof window.loadCrewData === 'function') {
    console.log('[DEBUG] window.loadCrewData is available');
} else {
    console.error('[DEBUG] window.loadCrewData is NOT available after attach');
}

/**
 * Add a new crew member from the "Add New Crew Member" form.
 * 
 * Validation:
 * - First name and last name are required
 * - All other fields are optional
 * 
 * After successful addition:
 * - Clears all form fields
 * - Calls loadData() to refresh UI
 * - New crew appears in all crew lists and patient selector
 * 
 * Data Structure Created:
 * ```javascript
 * {
 *   id: string,              // Timestamp-based unique ID
 *   firstName: string,       // Required
 *   middleName: string,
 *   lastName: string,        // Required
 *   sex: string,
 *   birthdate: string,       // ISO date
 *   position: string,        // Captain | Crew | Passenger
 *   citizenship: string,
 *   birthplace: string,
 *   passportNumber: string,
 *   passportIssue: string,
 *   passportExpiry: string,
 *   emergencyContactName: string,
 *   emergencyContactRelation: string,
 *   emergencyContactPhone: string,
 *   emergencyContactEmail: string,
 *   emergencyContactNotes: string,
 *   phoneNumber: string,
 *   vaccines: [],            // Empty array, vaccines added separately
 *   passportHeadshot: '',    // Base64 or URL, uploaded separately
 *   passportPage: '',        // Base64 or URL, uploaded separately
 *   history: ''              // Medical notes, edited separately
 * }
 * ```
 */
async function addCrew() {
    const firstName = document.getElementById('cn-first').value.trim();
    const middleName = document.getElementById('cn-middle').value.trim();
    const lastName = document.getElementById('cn-last').value.trim();
    const sex = document.getElementById('cn-sex').value;
    const birthdate = document.getElementById('cn-birthdate').value;
    const position = document.getElementById('cn-position').value;
    const citizenship = document.getElementById('cn-citizenship').value.trim();
    const birthplace = document.getElementById('cn-birthplace').value.trim();
    const passportNumber = document.getElementById('cn-passport').value.trim();
    const passportIssue = document.getElementById('cn-pass-issue').value;
    const passportExpiry = document.getElementById('cn-pass-expiry').value;
    const emergencyContactName = document.getElementById('cn-emerg-name').value.trim();
    const emergencyContactRelation = document.getElementById('cn-emerg-rel').value.trim();
    const emergencyContactPhone = document.getElementById('cn-emerg-phone').value.trim();
    const emergencyContactEmail = document.getElementById('cn-emerg-email').value.trim();
    const emergencyContactNotes = document.getElementById('cn-emerg-notes').value.trim();
    const phoneNumber = document.getElementById('cn-phone').value.trim();
    
    // Validate required fields
    if (!firstName || !lastName) {
        alert('Please enter first name and last name');
        return;
    }
    // All other fields are optional
    
    const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
    data.push({ 
        id: Date.now().toString(), 
        firstName: firstName,
        middleName: middleName,
        lastName: lastName,
        sex: sex,
        birthdate: birthdate,
        position: position,
        citizenship: citizenship,
        birthplace: birthplace,
        passportNumber: passportNumber,
        passportIssue: passportIssue,
        passportExpiry: passportExpiry,
        emergencyContactName: emergencyContactName,
        emergencyContactRelation: emergencyContactRelation,
        emergencyContactPhone: emergencyContactPhone,
        emergencyContactEmail: emergencyContactEmail,
        emergencyContactNotes: emergencyContactNotes,
        phoneNumber: phoneNumber,
        vaccines: [],
        passportHeadshot: '',
        passportPage: '',
        history: '' 
    });
    await fetch('/api/data/patients', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data), credentials:'same-origin'});
    
    // Clear form
    document.getElementById('cn-first').value = '';
    document.getElementById('cn-middle').value = '';
    document.getElementById('cn-last').value = '';
    document.getElementById('cn-sex').value = '';
    document.getElementById('cn-birthdate').value = '';
    document.getElementById('cn-position').value = '';
    document.getElementById('cn-citizenship').value = '';
    document.getElementById('cn-birthplace').value = '';
    document.getElementById('cn-passport').value = '';
    document.getElementById('cn-pass-issue').value = '';
    document.getElementById('cn-pass-expiry').value = '';
    document.getElementById('cn-emerg-name').value = '';
    document.getElementById('cn-emerg-rel').value = '';
    document.getElementById('cn-emerg-phone').value = '';
    document.getElementById('cn-emerg-email').value = '';
    document.getElementById('cn-emerg-notes').value = '';
    document.getElementById('cn-phone').value = '';
    document.getElementById('cn-passport-photo').value = '';
    document.getElementById('cn-passport-page').value = '';
    
    loadData();
}

/**
 * Add a new vaccine record to a crew member's profile.
 * 
 * Validation:
 * - Vaccine type/disease is required (either from dropdown or custom input)
 * - All other fields are optional
 * 
 * The vaccine record is sent to the backend API which appends it to the
 * crew member's vaccines array. After successful save, the form is cleared
 * and the UI is refreshed to show the new vaccine entry.
 * 
 * Vaccine Record Structure:
 * ```javascript
 * {
 *   id: string,                      // "vax-[timestamp]"
 *   vaccineType: string,             // Required
 *   dateAdministered: string,
 *   doseNumber: string,              // e.g., "Dose 1 of 3"
 *   tradeNameManufacturer: string,
 *   lotNumber: string,
 *   provider: string,                // Clinic/provider name
 *   providerCountry: string,
 *   nextDoseDue: string,
 *   expirationDate: string,          // Expiry of the dose
 *   siteRoute: string,               // e.g., "Left Arm - IM"
 *   reactions: string,               // Allergic reactions or side effects
 *   remarks: string                  // Additional notes
 * }
 * ```
 * 
 * @param {string} crewId - The crew member's unique ID
 */
async function addVaccine(crewId) {
    const getVal = (suffix) => document.getElementById(`vx-${suffix}-${crewId}`)?.value.trim() || '';
    const typeSelect = document.getElementById(`vx-type-${crewId}`);
    const selectedType = typeSelect ? typeSelect.value : '';
    const otherVal = getVal('type-other');
    const vaccineType = selectedType === '__other__' ? otherVal : selectedType;
    if (!vaccineType) {
        alert('Please enter Vaccine Type/Disease');
        if (selectedType === '__other__') {
            const otherField = document.getElementById(`vx-type-other-${crewId}`);
            if (otherField) otherField.focus();
        } else if (typeSelect) {
            typeSelect.focus();
        }
        return;
    }
    const entry = {
        id: `vax-${Date.now()}`,
        vaccineType,
        dateAdministered: getVal('date'),
        doseNumber: getVal('dose'),
        tradeNameManufacturer: getVal('trade'),
        lotNumber: getVal('lot'),
        provider: getVal('provider'),
        providerCountry: getVal('provider-country'),
        nextDoseDue: getVal('next'),
        expirationDate: getVal('exp'),
        siteRoute: getVal('site'),
        reactions: document.getElementById(`vx-reactions-${crewId}`)?.value.trim() || '',
        remarks: document.getElementById(`vx-remarks-${crewId}`)?.value.trim() || ''
    };

    try {
        const res = await fetch('/api/crew/vaccine', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ crew_id: crewId, vaccine: entry })
        });
        const text = await res.text();
        if (!res.ok) throw new Error(text || `Status ${res.status}`);
    } catch (err) {
        alert(`Failed to save vaccine: ${err.message}`);
        return;
    }
    clearVaccineInputs(crewId);
    loadData();
}

/**
 * Delete a vaccine record from a crew member's profile.
 * 
 * Single confirmation dialog before deletion. After successful delete,
 * refreshes the UI to remove the vaccine entry from display.
 * 
 * @param {string} crewId - The crew member's unique ID
 * @param {string} vaccineId - The vaccine record's unique ID
 */
async function deleteVaccine(crewId, vaccineId) {
    if (!vaccineId) return;
    if (!confirm('Delete this vaccine record?')) return;
    try {
        const res = await fetch(`/api/crew/vaccine/${crewId}/${vaccineId}`, {
            method: 'DELETE',
            credentials: 'same-origin'
        });
        const text = await res.text();
        if (!res.ok) throw new Error(text || `Status ${res.status}`);
    } catch (err) {
        alert(`Failed to delete vaccine: ${err.message}`);
        return;
    }
    loadData();
}

/**
 * Auto-save crew profile changes with debouncing.
 * 
 * Debouncing Strategy:
 * - Waits 1 second after last change before saving
 * - Each crew member has independent save timer
 * - Prevents excessive API calls during rapid typing
 * 
 * After Save:
 * - Updates chat system patient dropdown if name changed
 * - Refreshes prompt preview in chat if needed
 * - Logs confirmation to console
 * 
 * Fields Saved:
 * All profile fields including names, dates, passport info, emergency contacts,
 * and medical history notes. Document uploads are handled separately.
 * 
 * @param {string} id - Crew member's unique ID
 */
let saveTimers = {};
async function autoSaveProfile(id) {
    // Clear any existing timer for this crew member
    if (saveTimers[id]) {
        clearTimeout(saveTimers[id]);
    }
    
    // Set new timer to save after 1 second of no changes
    saveTimers[id] = setTimeout(async () => {
        const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
        const patient = data.find(p => p.id === id);
        const val = (prefix) => {
            const el = document.getElementById(prefix + id);
            return el ? el.value : undefined;
        };
        if (patient) {
            const setters = {
                firstName: val('fn-'),
                middleName: val('mn-'),
                lastName: val('ln-'),
                sex: val('sx-'),
                birthdate: val('bd-'),
                position: val('pos-'),
                citizenship: val('cit-'),
                birthplace: val('bp-'),
                passportNumber: val('pass-'),
                passportIssue: val('piss-'),
                passportExpiry: val('pexp-'),
                emergencyContactName: val('ename-'),
                emergencyContactRelation: val('erel-'),
                emergencyContactPhone: val('ephone-'),
                emergencyContactEmail: val('eemail-'),
                emergencyContactNotes: val('enotes-'),
                phoneNumber: val('phone-'),
                history: val('h-')
            };
            Object.entries(setters).forEach(([k,v]) => {
                if (v !== undefined) patient[k] = k === 'history' ? v : (typeof v === 'string' ? v.trim() : v);
            });
            
            await fetch('/api/data/patients', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data), credentials:'same-origin'});
            console.log(`Auto-saved profile for ${patient.firstName || ''} ${patient.lastName || ''}`);
            const pSelect = document.getElementById('p-select');
            if (pSelect) {
                const option = pSelect.querySelector(`option[value="${id}"]`);
                if (option) {
                    const displayName = getCrewFullName(patient) || 'Unnamed Crew';
                    option.textContent = displayName;
                    if (pSelect.value === id) {
                        try { localStorage.setItem(CREW_LAST_PATIENT_KEY, id); } catch (err) { /* ignore */ }
                    }
                }
            }
            if (typeof refreshPromptPreview === 'function') {
                refreshPromptPreview(true);
            }
        }
    }, 1000);
}

/**
 * Copy emergency contact information from one crew member to another.
 * 
 * Useful Feature:
 * Family members traveling together often share the same emergency contact.
 * This function copies all emergency contact fields and auto-saves.
 * 
 * Important:
 * Shows alert reminding user to check the RELATIONSHIP field, as it likely
 * needs adjustment (e.g., "spouse" for one person might be "parent" for another).
 * 
 * Fields Copied:
 * - Emergency contact name
 * - Relationship
 * - Phone number
 * - Email address
 * - Notes
 * 
 * @param {string} targetId - Crew member receiving the copied contact info
 * @param {string} sourceId - Crew member whose contact info to copy from
 */
async function copyEmergencyContact(targetId, sourceId) {
    if (!sourceId) return;
    
    const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
    const source = data.find(p => p.id === sourceId);
    
    if (source) {
        document.getElementById('ename-' + targetId).value = source.emergencyContactName || '';
        document.getElementById('erel-' + targetId).value = source.emergencyContactRelation || '';
        document.getElementById('ephone-' + targetId).value = source.emergencyContactPhone || '';
        document.getElementById('eemail-' + targetId).value = source.emergencyContactEmail || '';
        document.getElementById('enotes-' + targetId).value = source.emergencyContactNotes || '';
        
        // Auto-save after copy
        await autoSaveProfile(targetId);
        
        alert(`Emergency contact copied from ${getCrewFullName(source)}.\n\n⚠️ Please check the RELATIONSHIP field - it may need to be updated for this crew member!`);
    }
}

/**
 * Upload and store a document (passport photo or passport page) for a crew member.
 * 
 * Process:
 * 1. Validates file size (max 5MB)
 * 2. Converts file to base64 data URL using FileReader
 * 3. Sends to backend API for storage in crew record
 * 4. Refreshes UI to display uploaded document
 * 
 * Storage:
 * Documents are stored as base64-encoded strings directly in the crew member's
 * JSON record. Images display inline; PDFs show as links.
 * 
 * Limitations:
 * - 5MB max file size
 * - Base64 storage increases data size by ~33%
 * - Large documents may cause performance issues with JSON parsing
 * 
 * @param {string} id - Crew member's unique ID
 * @param {string} fieldName - Field name ("passportHeadshot" or "passportPage")
 * @param {HTMLInputElement} inputElement - The file input element
 */
async function uploadDocument(id, fieldName, inputElement) {
    const file = inputElement.files[0];
    if (!file) return;
    
    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
        alert('File size must be less than 5MB');
        inputElement.value = '';
        return;
    }
    
    // Convert to base64
    const reader = new FileReader();
    reader.onload = async function(e) {
        const base64Data = e.target.result;
        try { localStorage.setItem('sailingmed:lastOpenCrew', id); } catch (err) { /* ignore */ }
        try {
            const resp = await fetch('/api/crew/photo', {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({id, field: fieldName, data: base64Data}),
                credentials:'same-origin'
            });
            const txt = await resp.text();
            if (!resp.ok) {
                console.warn('[crew] uploadDocument failed', resp.status, txt.slice(0,200));
                alert('Upload failed. Please try again.');
                return;
            }
            loadData(); // Refresh to show the new document
        } catch (err) {
            console.warn('[crew] uploadDocument error', err);
            alert('Upload failed. Please try again.');
        }
    };
    reader.readAsDataURL(file);
}

/**
 * Delete a document (passport photo or passport page) from crew record.
 * 
 * Single confirmation dialog before deletion. Sets the document field to
 * empty string and refreshes UI to remove display.
 * 
 * @param {string} id - Crew member's unique ID
 * @param {string} fieldName - Field name ("passportHeadshot" or "passportPage")
 */
async function deleteDocument(id, fieldName) {
    if (!confirm('Are you sure you want to delete this document?')) return;
    
    try {
        const resp = await fetch('/api/crew/photo', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({id, field: fieldName, data: ''}),
            credentials:'same-origin'
        });
        const txt = await resp.text();
        if (!resp.ok) {
            console.warn('[crew] delete document failed', resp.status, txt.slice(0,200));
            alert('Delete failed. Please try again.');
            return;
        }
        try { localStorage.setItem('sailingmed:lastOpenCrew', id); } catch (err) { /* ignore */ }
        const card = document.querySelector(`.collapsible[data-crew-id="${id}"]`);
        if (card) {
            const img = card.querySelector('img[src]');
            if (img && img.parentElement) img.parentElement.innerHTML = '';
            const link = card.querySelector('a[target="_blank"]');
            if (link && link.parentElement) link.parentElement.innerHTML = '';
        }
        loadData();
    } catch (err) {
        console.warn('[crew] delete document error', err);
        alert('Delete failed. Please try again.');
    }
}

/**
 * Import medical history data from a text file into crew member's notes.
 * 
 * Use Case:
 * Allows importing pre-existing medical records, doctor's notes, or
 * previous health history from external text files.
 * 
 * Behavior:
 * - Appends imported content to existing medical history notes
 * - Separates with double newlines for readability
 * - User must manually save after reviewing import
 * 
 * @param {string} id - Crew member's unique ID
 */
async function importCrewData(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt';
    
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const text = await file.text();
        const textarea = document.getElementById('h-' + id);
        
        // Append with newline separator
        const currentContent = textarea.value.trim();
        textarea.value = currentContent ? currentContent + '\n\n' + text : text;
        
        alert(`Imported ${file.name} successfully! Don't forget to Save.`);
    };
    
    input.click();
}

/**
 * Export individual crew member's medical history to text file.
 * 
 * Exports only the medical history/notes field. For complete crew profiles
 * including passport info and emergency contacts, use exportCrewList().
 * 
 * Filename Format: crew_[Name]_[YYYY-MM-DD].txt
 * 
 * @param {string} id - Crew member's unique ID
 * @param {string} name - Crew member's name for filename
 */
function exportCrew(id, name) {
    const textarea = document.getElementById('h-' + id);
    const content = textarea.value;
    
    if (!content.trim()) {
        alert('No data to export for ' + name);
        return;
    }
    
    const date = new Date().toISOString().split('T')[0];
    const filename = `crew_${name.replace(/[^a-z0-9]/gi, '_')}_${date}.txt`;
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    
    alert(`Exported ${name}'s data to ${filename}`);
}

/**
 * Export all crew members' intake information to a single text file.
 * 
 * Creates a formatted document with:
 * - Header with export date
 * - Each crew member's complete history notes
 * - Separator lines between entries
 * 
 * Filename Format: all_crew_[YYYY-MM-DD].txt
 * 
 * Use Case:
 * Creating backup of all crew medical information for offline access
 * or transfer to shore-based medical facility.
 */
async function exportAllCrew() {
    const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
    
    if (data.length === 0) {
        alert('No crew data to export');
        return;
    }
    
    const date = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const fileDate = new Date().toISOString().split('T')[0];
    
    let content = '==========================================\n';
    content += 'CREW INTAKE INFORMATION EXPORT\n';
    content += `Date: ${date}\n`;
    content += '==========================================\n\n';
    
    data.forEach((crew, index) => {
        content += `--- ${crew.name} ---\n`;
        content += (crew.history || '(No data recorded)') + '\n';
        if (index < data.length - 1) content += '\n';
    });
    
    const filename = `all_crew_${fileDate}.txt`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    
    alert(`Exported all crew data (${data.length} members) to ${filename}`);
}

/**
 * Export all crew medical histories to a single text file.
 * 
 * Similar to exportAllCrew() but specifically labeled as "MEDICAL HISTORY EXPORT".
 * Contains the same data (history notes for each crew member).
 * 
 * Filename Format: all_crew_medical_[YYYY-MM-DD].txt
 */
async function exportAllMedical() {
    const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
    
    if (data.length === 0) {
        alert('No crew data to export');
        return;
    }
    
    const date = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const fileDate = new Date().toISOString().split('T')[0];
    
    let content = '==========================================\n';
    content += 'CREW MEDICAL HISTORY EXPORT\n';
    content += `Date: ${date}\n`;
    content += '==========================================\n\n';
    
    data.forEach((crew, index) => {
        const name = getCrewFullName(crew);
        content += `--- ${name} ---\n`;
        content += (crew.history || '(No history recorded)') + '\n';
        if (index < data.length - 1) content += '\n';
    });
    
    const filename = `all_crew_medical_${fileDate}.txt`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    
    alert(`Exported all crew medical histories (${data.length} members) to ${filename}`);
}

/**
 * Delete a crew member with double confirmation process.
 * 
 * Two-Step Confirmation:
 * 1. Standard confirm dialog with warning message
 * 2. Type "DELETE" prompt for final confirmation
 * 
 * Safety:
 * - Requires exact text "DELETE" (all caps)
 * - Shows multiple warnings about permanent data loss
 * - Cancels if confirmation text doesn't match
 * 
 * After Deletion:
 * - Removes from patients.json
 * - Refreshes all crew displays
 * - Shows confirmation alert
 * 
 * Note: This does NOT delete associated chat history, which remains in
 * history.json but becomes orphaned.
 * 
 * @param {string} category - Data category ("patients")
 * @param {string} id - Crew member's unique ID
 * @param {string} name - Crew member's name for confirmation messages
 */
async function deleteCrewMember(category, id, name) {
    // First warning
    if (!confirm(`Are you sure you want to delete ${name}'s intake information?`)) return;
    
    // Second warning with typed confirmation
    const confirmText = prompt(
        `⚠️ FINAL WARNING: This action CANNOT be undone.\n\n` +
        `All data for ${name} will be permanently deleted.\n\n` +
        `Type "DELETE" (all caps) to confirm:`
    );
    
    if (confirmText !== 'DELETE') {
        alert('Deletion cancelled. Confirmation text did not match.');
        return;
    }
    
    // Proceed with deletion
    const data = await (await fetch(`/api/data/${category}`, {credentials:'same-origin'})).json();
    const filtered = data.filter(item => item.id !== id);
    await fetch(`/api/data/${category}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(filtered), credentials:'same-origin'});
    loadData();
    alert(`${name}'s data has been permanently deleted.`);
}

/**
 * Export crew list in CSV format for official use (border crossings, port authorities).
 * 
 * CSV Structure:
 * - Header with vessel name and date
 * - Table with columns: No., Name, Birth Date, Position, Citizenship, Birthplace,
 *   Passport No., Issue Date, Expiry Date
 * - Footer with captain name and signature line
 * 
 * Use Case:
 * Required documentation for:
 * - International border crossings
 * - Port authority check-ins
 * - Maritime customs declarations
 * - Crew change documentation
 * 
 * Filename Format: crew_list_[YYYY-MM-DD].csv
 */
async function exportCrewList() {
    const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
    const vessel = await (await fetch('/api/data/vessel', {credentials:'same-origin'})).json();
    
    if (data.length === 0) {
        alert('No crew data to export');
        return;
    }
    
    const date = new Date().toISOString().split('T')[0];
    const vesselName = vessel.vesselName || '[Vessel Name]';
    
    // Find captain
    const captain = data.find(c => c.position === 'Captain');
    const captainName = captain ? getCrewFullName(captain) : '[Captain Name]';
    
    // Build CSV content
    let csv = `CREW LIST\n`;
    csv += `Vessel: ${vesselName}\n`;
    csv += `Date: ${date}\n\n`;
    csv += `No.,Name,Birth Date,Position,Citizenship,Birthplace,Passport No.,Issue Date,Expiry Date\n`;
    
    data.forEach((crew, index) => {
        const name = getCrewFullName(crew);
        const bd = crew.birthdate || '';
        const pos = crew.position || '';
        const cit = crew.citizenship || '';
        const birth = crew.birthplace || '';
        const pass = crew.passportNumber || '';
        const issue = crew.passportIssue || '';
        const expiry = crew.passportExpiry || '';
        
        csv += `${index + 1},${name},${bd},${pos},${cit},${birth},${pass},${issue},${expiry}\n`;
    });
    
    csv += `\n\nCaptain: ${captainName}\n`;
    csv += `Signature: _________________________\n`;
    
    // Download
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crew_list_${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    alert(`Crew list exported to crew_list_${date}.csv`);
}

/**
 * Load vessel information from server and populate form fields.
 * 
 * Two-Stage Loading:
 * 1. Uses server-rendered prefill data (window.VESSEL_PREFILL) if available
 * 2. Fetches latest data from API to ensure current values
 * 
 * This dual approach provides instant UI population (from prefill) while
 * ensuring accuracy (from API fetch).
 * 
 * Vessel Fields:
 * - vesselName, registrationNumber, flagCountry, homePort
 * - callSign, mmsi, hullNumber
 * - tonnage, netTonnage
 * - Engine info: starboardEngine, starboardEngineSn, portEngine, portEngineSn
 * - ribSn (tender/dinghy serial number)
 * 
 * Integration:
 * Called by ensureVesselLoaded() on tab navigation to Vessel & Crew section.
 */
async function loadVesselInfo() {
    console.log('[VESSEL] loadVesselInfo invoked');
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };

    // 1) use preloaded data if present (server-rendered)
    if (window.VESSEL_PREFILL && typeof window.VESSEL_PREFILL === 'object') {
        console.log('[VESSEL] prefill available', window.VESSEL_PREFILL);
        const p = window.VESSEL_PREFILL;
        const map = {
            'vessel-name': p.vesselName,
            'vessel-registration': p.registrationNumber,
            'vessel-flag': p.flagCountry,
            'vessel-homeport': p.homePort,
            'vessel-callsign': p.callSign,
            'vessel-tonnage': p.tonnage,
            'vessel-net-tonnage': p.netTonnage,
            'vessel-mmsi': p.mmsi,
            'vessel-hull-number': p.hullNumber,
            'vessel-starboard-engine': p.starboardEngine,
            'vessel-starboard-sn': p.starboardEngineSn,
            'vessel-port-engine': p.portEngine,
            'vessel-port-sn': p.portEngineSn,
            'vessel-rib-sn': p.ribSn,
        };
        Object.entries(map).forEach(([id, val]) => {
            setVal(id, val);
            console.log('[VESSEL] prefill set', id, '->', val);
        });
    }

    // 2) fetch latest from API (overwrites prefill)
    try {
        const resp = await fetch('/api/data/vessel', {credentials:'same-origin'});
        const text = await resp.text();
        console.log('[VESSEL] loadVesselInfo fetch status', resp.status, 'body', text.slice(0,200));
        const v = text ? JSON.parse(text) : {};
        const map = {
            'vessel-name': v.vesselName,
            'vessel-registration': v.registrationNumber,
            'vessel-flag': v.flagCountry,
            'vessel-homeport': v.homePort,
            'vessel-callsign': v.callSign,
            'vessel-tonnage': v.tonnage,
            'vessel-net-tonnage': v.netTonnage,
            'vessel-mmsi': v.mmsi,
            'vessel-hull-number': v.hullNumber,
            'vessel-starboard-engine': v.starboardEngine,
            'vessel-starboard-sn': v.starboardEngineSn,
            'vessel-port-engine': v.portEngine,
            'vessel-port-sn': v.portEngineSn,
            'vessel-rib-sn': v.ribSn,
        };
        Object.entries(map).forEach(([id, val]) => {
            setVal(id, val);
            console.log('[VESSEL] API load set', id, '->', val);
        });
    } catch (err) {
        console.warn('[VESSEL] loadVesselInfo fetch failed', err);
    }
}

/**
 * Save vessel information to server.
 * 
 * Process:
 * 1. Collects all vessel field values from form
 * 2. POSTs to /api/data/vessel endpoint
 * 3. Fetches back latest data to ensure UI matches database
 * 4. Shows save confirmation with timestamp
 * 5. Clears user-edited flags to allow future refreshes
 * 
 * User Feedback:
 * Displays "Saved at [time]" message in green for 4 seconds.
 * 
 * Called By:
 * - scheduleVesselSave() (debounced auto-save)
 * - Direct user action (Save button)
 * - mouseleave events on fields with pending changes
 */
async function saveVesselInfo() {
    console.log('[VESSEL] saveVesselInfo start');
    const v = {
        vesselName: document.getElementById('vessel-name')?.value || '',
        registrationNumber: document.getElementById('vessel-registration')?.value || '',
        flagCountry: document.getElementById('vessel-flag')?.value || '',
        homePort: document.getElementById('vessel-homeport')?.value || '',
        callSign: document.getElementById('vessel-callsign')?.value || '',
        tonnage: document.getElementById('vessel-tonnage')?.value || '',
        netTonnage: document.getElementById('vessel-net-tonnage')?.value || '',
        mmsi: document.getElementById('vessel-mmsi')?.value || '',
        hullNumber: document.getElementById('vessel-hull-number')?.value || '',
        starboardEngine: document.getElementById('vessel-starboard-engine')?.value || '',
        starboardEngineSn: document.getElementById('vessel-starboard-sn')?.value || '',
        portEngine: document.getElementById('vessel-port-engine')?.value || '',
        portEngineSn: document.getElementById('vessel-port-sn')?.value || '',
        ribSn: document.getElementById('vessel-rib-sn')?.value || ''
    };
    console.log('[VESSEL] saveVesselInfo payload', v);
    const resp = await fetch('/api/data/vessel', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(v), credentials:'same-origin'});
    const respText = await resp.text();
    console.log('[VESSEL] saveVesselInfo resp', resp.status, respText.slice(0,200));
    if (!resp.ok) {
        console.warn('[VESSEL] saveVesselInfo failed', resp.status, respText);
        throw new Error(`Save failed (${resp.status})`);
    }
    const statusEl = document.getElementById('vessel-save-status');
    if (statusEl) {
        statusEl.textContent = 'Saved at ' + new Date().toLocaleTimeString();
        statusEl.style.color = '#2e7d32';
        setTimeout(() => { statusEl.textContent = ''; }, 4000);
    }
    // After save, pull latest to ensure UI matches persisted state
    try {
        const latestResp = await fetch('/api/data/vessel', {credentials:'same-origin'});
        const latestText = await latestResp.text();
        console.log('[VESSEL] post-save fetch status', latestResp.status, 'body', latestText.slice(0,200));
        const latest = latestText ? JSON.parse(latestText) : {};
        const map = {
            'vessel-name': latest.vesselName,
            'vessel-registration': latest.registrationNumber,
            'vessel-flag': latest.flagCountry,
            'vessel-homeport': latest.homePort,
            'vessel-callsign': latest.callSign,
            'vessel-tonnage': latest.tonnage,
            'vessel-net-tonnage': latest.netTonnage,
            'vessel-mmsi': latest.mmsi,
            'vessel-hull-number': latest.hullNumber,
            'vessel-starboard-engine': latest.starboardEngine,
            'vessel-starboard-sn': latest.starboardEngineSn,
            'vessel-port-engine': latest.portEngine,
            'vessel-port-sn': latest.portEngineSn,
            'vessel-rib-sn': latest.ribSn,
        };
        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
        Object.entries(map).forEach(([id, val]) => {
            setVal(id, val);
            console.log('[VESSEL] post-save set', id, '->', val);
        });
    } catch (err) {
        console.warn('[VESSEL] post-save refresh failed', err);
    }
    // Clear user-edited flags after successful save so subsequent loads can refresh
    ['vessel-name','vessel-registration','vessel-flag','vessel-homeport','vessel-callsign','vessel-tonnage','vessel-net-tonnage','vessel-mmsi','vessel-hull-number','vessel-starboard-engine','vessel-starboard-sn','vessel-port-engine','vessel-port-sn','vessel-rib-sn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.dataset.userEdited = '';
    });
}

/**
 * Schedule a debounced auto-save for vessel information.
 * 
 * Debounce Period: 200ms
 * 
 * Triggered by:
 * - input events on vessel fields
 * - change events on vessel fields
 * 
 * Shorter debounce than crew profiles (200ms vs 1000ms) because vessel
 * edits are typically less frequent and users expect faster feedback.
 */
let vesselSaveTimer = null;
function scheduleVesselSave() {
    if (vesselSaveTimer) clearTimeout(vesselSaveTimer);
    vesselSaveTimer = setTimeout(() => {
        console.log('[VESSEL] autosave triggered');
        saveVesselInfo().catch(err => console.warn('[VESSEL] autosave failed', err));
    }, 200);
}

/**
 * Bind auto-save event listeners to all vessel input fields.
 * 
 * Event Strategy:
 * - input: Triggers debounced save, marks field as edited
 * - change: Triggers debounced save, marks field as edited  
 * - mouseleave: Immediate save if field has pending edits
 * 
 * The mouseleave trigger ensures changes are saved when user moves away
 * from a field, even if they haven't triggered change event (e.g., by
 * clicking outside instead of tabbing away).
 * 
 * Idempotent:
 * Uses data-vesselAutosave flag to prevent duplicate binding on repeated calls.
 */
function bindVesselAutosave() {
    const ids = [
        'vessel-name','vessel-registration','vessel-flag','vessel-homeport','vessel-callsign',
        'vessel-tonnage','vessel-net-tonnage','vessel-mmsi','vessel-hull-number',
        'vessel-starboard-engine','vessel-starboard-sn','vessel-port-engine','vessel-port-sn','vessel-rib-sn'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.dataset.vesselAutosave) {
            el.dataset.vesselAutosave = '1';
            const logVal = (evType) => console.log('[VESSEL] field event', evType, id, 'value=', el.value);
            el.addEventListener('input', () => { el.dataset.userEdited = '1'; logVal('input'); scheduleVesselSave(); });
            el.addEventListener('change', () => { el.dataset.userEdited = '1'; logVal('change'); scheduleVesselSave(); });
            el.addEventListener('mouseleave', () => {
                if (el.dataset.userEdited) {
                    logVal('mouseleave');
                    console.log('[VESSEL] mouseleave -> immediate save');
                    saveVesselInfo().catch(err => console.warn('[VESSEL] mouseleave save failed', err));
                }
            });
            console.log('[VESSEL] autosave bound to', id);
        }
    });
}

/**
 * Ensure vessel information is loaded and auto-save is enabled.
 * 
 * One-Time Initialization:
 * Uses vesselLoaded flag to prevent redundant setup on repeated tab navigation.
 * 
 * Setup Process:
 * 1. Binds auto-save event listeners to all vessel fields
 * 2. Loads initial vessel data from server
 * 3. Exposes debug helpers on window object
 * 
 * Debug Helpers:
 * - window.VESSEL_DEBUG = true (enables verbose logging)
 * - window.forceSaveVessel() (manual save trigger for debugging)
 * 
 * Called By:
 * Tab navigation handlers when user switches to Vessel & Crew tab.
 */
let vesselLoaded = false;
async function ensureVesselLoaded() {
    if (vesselLoaded) return;
    vesselLoaded = true;
    bindVesselAutosave();
    if (typeof loadVesselInfo === 'function') {
        try {
            await loadVesselInfo();
        } catch (err) {
            console.warn('[VESSEL] initial loadVesselInfo failed:', err);
        }
    }
    window.VESSEL_DEBUG = true;
    window.forceSaveVessel = saveVesselInfo;
    console.log('[VESSEL] ensureVesselLoaded complete; VESSEL_DEBUG=true');
}

// Expose for other scripts
window.loadVesselInfo = loadVesselInfo;
window.saveVesselInfo = saveVesselInfo;
window.ensureVesselLoaded = ensureVesselLoaded;
