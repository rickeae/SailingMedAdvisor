/*
File: static/js/equipment.js
Author notes: Equipment and medical supplies management.

Key Responsibilities:
- Medical equipment inventory (durable goods: AED, blood pressure cuff, etc.)
- Consumables tracking (bandages, gauze, gloves, syringes, etc.)
- Import/export functionality for equipment lists (TSV format)
- Resource availability trackiang (in-stock vs unavailable)
- Equipment classification and categorization

Equipment Classification:
- 'durable': Medical equipment (reusable, tracked equipment)
- 'consumable': Single-use supplies (tracked by quantity)
- 'medication': Medicines (redirects to pharmacy module)

Data Flow:
- Equipment: /api/data/tools (tools.json)
- Medications: /api/data/inventory (inventory.json)
- Import/Export: TSV files for bulk updates

Integration Points:
- pharmacy.js: Medication management
- main.js: Tab navigation, initial data load
*/

// Utility function imports from utils.js (with fallbacks)
const workspaceHeaders = (window.Utils && window.Utils.workspaceHeaders) ? window.Utils.workspaceHeaders : (extra = {}) => extra;
const fetchJson = (window.Utils && window.Utils.fetchJson) ? window.Utils.fetchJson : async (url, options = {}) => {
    const res = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
    return data;
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let equipmentCache = [];              // Cached equipment/consumables from server
const equipmentSaveTimers = {};       // Debounce timers for auto-save

const eqWorkspaceHeaders = workspaceHeaders;

const DEFAULT_EQUIPMENT_CATEGORIES = [
    'Diagnostics & monitoring',
    'Instruments & tools',
    'Airway & breathing',
    'Splints & supports',
    'Eye care',
    'Dental',
    'PPE',
    'Survival & utility',
    'Other'
];
const DEFAULT_CONSUMABLE_CATEGORIES = [
    'Wound care & dressings',
    'Burn care',
    'Antiseptics & hygiene',
    'Irrigation & syringes',
    'Splints & supports',
    'PPE',
    'Survival & utility',
    'Other'
];

function getEquipmentCategoryList() {
    const list = window.CACHED_SETTINGS && Array.isArray(window.CACHED_SETTINGS.equipment_categories)
        ? window.CACHED_SETTINGS.equipment_categories
        : DEFAULT_EQUIPMENT_CATEGORIES;
    return list.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

function getConsumableCategoryList() {
    const list = window.CACHED_SETTINGS && Array.isArray(window.CACHED_SETTINGS.consumable_categories)
        ? window.CACHED_SETTINGS.consumable_categories
        : DEFAULT_CONSUMABLE_CATEGORIES;
    return list.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

function buildCategoryOptions(list, selected) {
    const opts = ['<option value="">Uncategorized</option>'];
    const selectedNorm = (selected || '').trim().toLowerCase();
    list.forEach((cat) => {
        const value = cat;
        const isSel = selectedNorm && selectedNorm === cat.trim().toLowerCase();
        opts.push(`<option value="${value.replace(/\"/g, '&quot;')}" ${isSel ? 'selected' : ''}>${value}</option>`);
    });
    return opts.join('');
}

function refreshEquipmentCategoryOptions() {
    const eqSelect = document.getElementById('eq-new-category');
    if (eqSelect) eqSelect.innerHTML = buildCategoryOptions(getEquipmentCategoryList(), eqSelect.value);
    const consSelect = document.getElementById('cons-new-category');
    if (consSelect) consSelect.innerHTML = buildCategoryOptions(getConsumableCategoryList(), consSelect.value);
}

window.refreshEquipmentCategoriesFromSettings = function () {
    refreshEquipmentCategoryOptions();
    if (equipmentCache.length) {
        renderEquipment(equipmentCache);
    }
};

/**
 * Update section header count badges.
 * 
 * Displays item counts in section headers (e.g., "Medical Equipment (12)").
 * 
 * @param {string} id - Element ID of the count badge
 * @param {number} count - Number of items to display
 */
function updateSectionCount(id, count) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = `(${count})`;
    }
}

/**
 * Normalize equipment item with default values.
 * 
 * Ensures all expected fields exist with appropriate defaults.
 * Similar to pharmacy's ensurePharmacyDefaults but for equipment/consumables.
 * 
 * Equipment Structure:
 * ```javascript
 * {
 *   id: string,                    // Unique ID (eq-timestamp-random)
 *   name: string,                  // Equipment/consumable name
 *   category: string,              // Category for grouping
 *   type: string,                  // 'durable' | 'consumable' | 'medication'
 *   storageLocation: string,       // Where it's stored
 *   subLocation: string,           // Specific location details
 *   status: string,                // 'In Stock' | 'Out of Stock' | 'Maintenance'
 *   expiryDate: string,            // ISO date for consumables
 *   lastInspection: string,        // ISO date of last inspection
 *   batteryType: string,           // For powered equipment
 *   batteryStatus: string,         // Battery condition
 *   calibrationDue: string,        // ISO date for next calibration
 *   totalQty: string,              // Current quantity
 *   minPar: string,                // Minimum stock level
 *   supplier: string,              // Supplier name
 *   parentId: string,              // For nested equipment (e.g., kit contents)
 *   requiresPower: boolean,        // Needs batteries/power
 *   notes: string,                 // Additional information
 *   excludeFromResources: boolean  // Hide from public resource lists
 * }
 * ```
 * 
 * @param {Object} item - Raw equipment data
 * @returns {Object} Normalized equipment object with all fields
 */
function ensureEquipmentDefaults(item) {
    return {
        id: item.id || `eq-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: item.name || '',
        category: item.category || '',
        type: item.type || 'durable', // durable | consumable
        storageLocation: item.storageLocation || '',
        subLocation: item.subLocation || '',
        status: item.status || 'In Stock',
        expiryDate: item.expiryDate || '',
        lastInspection: item.lastInspection || '',
        batteryType: item.batteryType || '',
        batteryStatus: item.batteryStatus || '',
        calibrationDue: item.calibrationDue || '',
        totalQty: item.totalQty || '',
        minPar: item.minPar || '',
        supplier: item.supplier || '',
        parentId: item.parentId || '',
        requiresPower: item.requiresPower || false,
        notes: item.notes || '',
        excludeFromResources: Boolean(item.excludeFromResources),
    };
}

/**
 * Load and render all equipment from server.
 * 
 * Loading Process:
 * 1. Fetches from /api/data/tools
 * 2. Normalizes all items
 * 3. Classifies into equipment/consumables/medications
 * 4. Renders to appropriate lists
 * 5. Updates section count badges
 * 
 * @param {string} expandId - Optional ID of item to auto-expand after render
 */
async function loadEquipment(expandId = null) {
    const list = document.getElementById('equipment-list');
    if (!list) return;
    list.innerHTML = '';
    try {
        refreshEquipmentCategoryOptions();
        const data = await fetchJson('/api/data/tools');
        equipmentCache = (Array.isArray(data) ? data : []).map(ensureEquipmentDefaults);
        renderEquipment(equipmentCache, expandId);
    } catch (err) {
        updateSectionCount('equipment-count', 0);
        updateSectionCount('consumables-count', 0);
        list.innerHTML = `<div style="color:red;">Error loading equipment: ${err.message}</div>`;
    }
}

/**
 * Classify equipment into category buckets.
 * 
 * Classification Rules:
 * 1. type='medication' OR category contains 'medication' → 'medication'
 * 2. type='consumable' → 'consumable'  
 * 3. Otherwise → 'equipment' (durable goods)
 * 
 * Used to route items to correct display lists and apply appropriate styling.
 * 
 * @param {Object} item - Equipment item to classify
 * @returns {string} 'medication' | 'consumable' | 'equipment'
 */
function classifyEquipment(item) {
    const type = (item.type || '').toLowerCase();
    const category = (item.category || '').toLowerCase();
    if (type === 'medication' || category.includes('medication')) return 'medication';
    if (type === 'consumable') return 'consumable';
    return 'equipment';
}

function showImportStatus(id, message, isError = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? 'var(--red)' : '#1f2d3d';
}

async function ensureEquipmentCacheLoaded() {
    if (equipmentCache.length) return equipmentCache;
    const data = await fetchJson('/api/data/tools');
    equipmentCache = (Array.isArray(data) ? data : []).map(ensureEquipmentDefaults);
    return equipmentCache;
}

/**
 * Sanitize value for tab-delimited (TSV) export.
 * 
 * TSV Requirements:
 * - No tab characters (field delimiter)
 * - No newlines (row delimiter)
 * - Consistent whitespace
 * 
 * Transformations:
 * - Tabs → spaces
 * - Newlines → spaces  
 * - Trim leading/trailing whitespace
 * - Null/undefined → empty string
 * 
 * @param {any} value - Value to sanitize
 * @returns {string} TSV-safe string
 */
function sanitizeTSVField(value) {
    const text = value == null ? '' : value.toString();
    return text.replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
}

/**
 * Build tab-delimited (TSV) content from equipment items.
 * 
 * TSV Format (3 columns):
 * Name    Quantity    Comment
 * 
 * Features:
 * - Alphabetically sorted by name
 * - Sanitized fields (no tabs/newlines)
 * - Customizable comment column via commentFn
 * - Filters empty rows
 * 
 * Compatible with Excel, Google Sheets, Numbers, and text editors.
 * 
 * @param {Array<Object>} items - Equipment items to export
 * @param {Function} commentFn - Function to extract comment from item
 * @returns {string} TSV-formatted text
 */
function buildTabDelimitedContent(items, commentFn) {
    const rows = [...items]
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
        .map((item) => {
            const name = sanitizeTSVField(item.name);
            const quantity = sanitizeTSVField(item.totalQty);
            const comment = sanitizeTSVField(typeof commentFn === 'function' ? commentFn(item) : item.notes);
            return [name, quantity, comment].join('\t');
        })
        .filter((line) => line.trim());
    return rows.join('\n');
}

/**
 * Trigger browser download of TSV file.
 * 
 * Process:
 * 1. Creates Blob with TSV MIME type
 * 2. Generates object URL
 * 3. Creates temporary <a> element
 * 4. Triggers click to start download
 * 5. Cleans up object URL after 1.5s
 * 
 * MIME Type: text/tab-separated-values
 * 
 * @param {string} filename - Suggested filename for download
 * @param {string} content - TSV-formatted content
 */
function downloadTabDelimitedFile(filename, content) {
    const blob = new Blob([content], { type: 'text/tab-separated-values' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function exportConsumables() {
    try {
        const items = await ensureEquipmentCacheLoaded();
        const consumables = items.filter((item) => classifyEquipment(item) === 'consumable');
        if (!consumables.length) {
            showImportStatus('consumables-import-status', 'No consumables available to export.', true);
            return;
        }
        const content = buildTabDelimitedContent(consumables, (item) => item.notes);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadTabDelimitedFile(`consumables-${timestamp}.tsv`, content);
        showImportStatus('consumables-import-status', `Prepared ${consumables.length} consumable(s) for download.`);
    } catch (err) {
        showImportStatus('consumables-import-status', err.message, true);
    }
}

function parseTabDelimitedRows(text) {
    if (typeof text !== 'string') return [];
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const cols = line.split('\t');
            return {
                name: (cols[0] || '').trim(),
                quantity: (cols[1] || '').trim(),
                comment: cols.length > 2 ? cols.slice(2).join('\t').trim() : '',
            };
        })
        .filter((row) => row.name);
}

function parseConsumableFileText(text) {
    return parseTabDelimitedRows(text).map((row) => ({
        name: row.name,
        totalQty: row.quantity,
        notes: row.comment,
        type: 'consumable',
    }));
}

function parseEquipmentFileText(text) {
    return parseTabDelimitedRows(text).map((row) => ({
        name: row.name,
        totalQty: row.quantity,
        notes: row.comment,
        type: 'durable',
    }));
}

function entryNameKey(name) {
    return (name || '').trim().toLowerCase();
}

function buildEntryMap(entries) {
    const map = new Map();
    entries.forEach((entry) => {
        const key = entryNameKey(entry.name);
        if (!key) return;
        map.set(key, entry);
    });
    return map;
}

function mergeEntriesByName(existing, entryMap, targetClassifier) {
    const result = [];
    const usedKeys = new Set();
    (existing || []).forEach((item) => {
        const category = classifyEquipment(item);
        if (category === targetClassifier) {
            const key = entryNameKey(item.name);
            if (entryMap.has(key)) {
                result.push(entryMap.get(key));
                usedKeys.add(key);
                return;
            }
        }
        result.push(item);
    });
    entryMap.forEach((entry, key) => {
        if (!usedKeys.has(key)) {
            result.push(entry);
        }
    });
    return result;
}

async function mergeConsumableImports(entries, statusId) {
    if (!entries.length) {
        showImportStatus(statusId, 'No consumables found in file.', true);
        return;
    }
    const normalized = entries.map((entry) => ensureEquipmentDefaults({ ...entry, type: 'consumable' }));
    const data = await fetchJson('/api/data/tools');
    const existing = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    const entryMap = buildEntryMap(normalized);
    const merged = mergeEntriesByName(existing, entryMap, 'consumable');

    const saveRes = await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
        credentials: 'same-origin',
    });
    if (!saveRes.ok) {
        let detail = '';
        try {
            const err = await saveRes.json();
            detail = err?.error ? `: ${err.error}` : '';
        } catch (_) {}
        throw new Error(`Save failed (${saveRes.status})${detail}`);
    }

    equipmentCache = merged;
    renderEquipment(equipmentCache);
    showImportStatus(statusId, `Imported ${entryMap.size} consumable(s) from file.`);
}

async function mergeEquipmentImports(entries, statusId) {
    if (!entries.length) {
        showImportStatus(statusId, 'No equipment entries found in file.', true);
        return;
    }
    const normalized = entries.map((entry) => ensureEquipmentDefaults({ ...entry, type: 'durable' }));
    const data = await fetchJson('/api/data/tools');
    const existing = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    const entryMap = buildEntryMap(normalized);
    const merged = mergeEntriesByName(existing, entryMap, 'equipment');

    const saveRes = await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
        credentials: 'same-origin',
    });
    if (!saveRes.ok) {
        let detail = '';
        try {
            const err = await saveRes.json();
            detail = err?.error ? `: ${err.error}` : '';
        } catch (_) {}
        throw new Error(`Save failed (${saveRes.status})${detail}`);
    }

    equipmentCache = merged;
    renderEquipment(equipmentCache);
    showImportStatus(statusId, `Imported ${entryMap.size} equipment item(s) from file.`);
}

function openConsumablesFilePicker() {
    const input = document.getElementById('consumables-import-file');
    if (!input) return;
    input.value = '';
    input.click();
}

async function handleConsumablesFileImport(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
        const content = await file.text();
        const entries = parseConsumableFileText(content);
        await mergeConsumableImports(entries, 'consumables-import-status');
    } catch (err) {
        showImportStatus('consumables-import-status', err.message, true);
    } finally {
        if (event?.target) event.target.value = '';
    }
}

function openEquipmentFilePicker() {
    const input = document.getElementById('equipment-import-file');
    if (!input) return;
    input.value = '';
    input.click();
}

async function handleEquipmentFileImport(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
        const content = await file.text();
        const entries = parseEquipmentFileText(content);
        await mergeEquipmentImports(entries, 'equipment-import-status');
    } catch (err) {
        showImportStatus('equipment-import-status', err.message, true);
    } finally {
        if (event?.target) event.target.value = '';
    }
}

async function exportEquipmentItems() {
    try {
        const items = await ensureEquipmentCacheLoaded();
        const equipment = items.filter((item) => classifyEquipment(item) === 'equipment');
        if (!equipment.length) {
            showImportStatus('equipment-import-status', 'No equipment available to export.', true);
            return;
        }
        const content = buildTabDelimitedContent(equipment, (item) => item.notes || item.storageLocation);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadTabDelimitedFile(`equipment-${timestamp}.tsv`, content);
        showImportStatus('equipment-import-status', `Prepared ${equipment.length} equipment item(s) for download.`);
    } catch (err) {
        showImportStatus('equipment-import-status', err.message, true);
    }
}

/**
 * Render all equipment items to appropriate lists.
 * 
 * Classification and Routing:
 * 1. Classifies each item (equipment/consumable/medication)
 * 2. Routes to correct list container:
 *    - equipment → #equipment-list
 *    - consumable → #consumables-list  
 *    - medication → #medication-list
 * 3. Sorts alphabetically within each category
 * 4. Updates section count badges
 * 
 * Expansion Feature:
 * If expandId provided, auto-expands that specific item's card
 * (useful after adding new item to show it immediately).
 * 
 * @param {Array<Object>} items - All equipment/consumables to render
 * @param {string} expandId - Optional ID of item to auto-expand
 */
function renderEquipment(items, expandId = null) {
    const storeList = document.getElementById('equipment-list');
    const medicationList = document.getElementById('medication-list');
    const consumablesList = document.getElementById('consumables-list');

    const stores = [];
    const meds = [];
    const cons = [];
    (items || []).forEach((item) => {
        const bucket = classifyEquipment(item);
        if (bucket === 'medication') meds.push(item);
        else if (bucket === 'consumable') cons.push(item);
        else stores.push(item);
    });

    const sortByName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    stores.sort(sortByName);
    cons.sort(sortByName);

    if (storeList) {
        storeList.innerHTML = stores.length ? stores.map((item) => renderEquipmentCard(item, expandId)).join('') : '';
    }
    if (medicationList) {
        medicationList.innerHTML = meds.length ? meds.map((item) => renderEquipmentCard(item, expandId)).join('') : '';
    }
    if (consumablesList) {
        consumablesList.innerHTML = cons.length ? cons.map((item) => renderEquipmentCard(item, expandId)).join('') : '';
    }
    updateSectionCount('equipment-count', stores.length);
    updateSectionCount('consumables-count', cons.length);
}

function renderEquipmentCard(item, expandId = null) {
    const itemType = (item.type || '').toLowerCase() || 'durable';
    const isConsumable = itemType === 'consumable';
    const isEquipment = itemType === 'durable';
    const equipmentCategories = getEquipmentCategoryList();
    const consumableCategories = getConsumableCategoryList();
    const lowStock = item.minPar && Number(item.totalQty) <= Number(item.minPar);
    const expirySoon = item.expiryDate && daysUntil(item.expiryDate) <= 60;
    const headerNote = [lowStock ? 'Low Stock' : null, expirySoon ? 'Expiring Soon' : null, item.status && item.status !== 'In Stock' ? item.status : null]
        .filter(Boolean)
        .join(' · ');
    const title = isConsumable
        ? `${item.name || 'Consumable'}${item.totalQty ? ` — ${item.totalQty}` : ''}`
        : `${item.name || 'Medical Equipment'}${item.totalQty ? ` — ${item.totalQty}` : ''}`;
    const isOpen = expandId && item.id === expandId;
    const bodyDisplay = isOpen ? 'display:block;' : '';
    const arrow = isOpen ? '▾' : '▸';
    // Palette: equipment stays green; consumables match pink shell (#f7eefc / #fcf7ff).
    const headerBg = isConsumable
        ? (item.excludeFromResources ? '#ffecef' : '#f7eefc')
        : (item.excludeFromResources ? '#ffecef' : '#e8fdef');
    const headerBorderColor = isConsumable
        ? (item.excludeFromResources ? '#ffcbd3' : '#dec9f7')
        : (item.excludeFromResources ? '#ffbfbf' : '#bde8c8');
    const bodyBg = isConsumable
        ? (item.excludeFromResources ? '#fff7f8' : '#fcf7ff')
        : (item.excludeFromResources ? '#fff6f6' : '#f7fff7');
    const bodyBorderColor = isConsumable
        ? (item.excludeFromResources ? '#ffdbe2' : '#e6d7fb')
        : (item.excludeFromResources ? '#ffcfd0' : '#cfe9d5');
    const badgeColor = item.excludeFromResources ? '#d32f2f' : '#2e7d32';
    const badgeText = item.excludeFromResources ? 'Resource Currently Unavailable' : 'Resource Available';
    const availabilityBadge = `<span style="margin-left:auto; padding:2px 10px; border-radius:999px; background:${badgeColor}; color:#fff; font-size:11px; white-space:nowrap;">${badgeText}</span>`;
    const consumableDetail = `
            <div style="padding:10px; background:#fff; border:1px solid #dbe6f8; border-radius:6px;">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                    <span class="dev-tag">dev:consumable-detail-header</span>
                    <span style="font-weight:700;">Consumable Detail</span>
                    <button onclick="event.stopPropagation(); deleteEquipment('${item.id}')" class="btn btn-sm" style="background:var(--red); margin-left:auto;">🗑 Delete Consumble</button>
                </div>
                <div style="display:grid; grid-template-columns: 2fr 1fr; gap:10px; margin-bottom:10px; align-items:end;">
                    <div>
                        <div class="dev-tag">dev:consumable-detail-name</div>
                        <label style="font-weight:700; font-size:12px;">Consumable Name</label>
                        <input id="eq-name-${item.id}" type="text" value="${item.name}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                    </div>
                    <div>
                        <div class="dev-tag">dev:consumable-detail-qty</div>
                        <label style="font-weight:700; font-size:12px;">Quantity</label>
                        <input id="eq-qty-${item.id}" type="text" value="${item.totalQty}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                    </div>
                    <div style="grid-column: span 2;">
                        <label style="font-weight:700; font-size:12px;">Category</label>
                        <select id="eq-cat-${item.id}" style="width:100%; padding:8px;" onchange="scheduleSaveEquipment('${item.id}')">
                            ${buildCategoryOptions(consumableCategories, item.category)}
                        </select>
                    </div>
                    <div style="grid-column: span 2;">
                        <div class="dev-tag">dev:consumable-detail-notes</div>
                        <label style="font-weight:700; font-size:12px;">Notes</label>
                        <textarea id="eq-notes-${item.id}" style="width:100%; padding:8px; min-height:60px;" oninput="scheduleSaveEquipment('${item.id}')">${item.notes || ''}</textarea>
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                    <input id="eq-exclude-${item.id}" type="checkbox" ${item.excludeFromResources ? 'checked' : ''} onchange="scheduleSaveEquipment('${item.id}')">
                    <label style="font-size:12px; line-height:1.2; margin:0;">Resource Currently Unavailable</label>
                </div>
            </div>`;

    const equipmentDetail = `
        <div class="collapsible history-item">
            <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; align-items:center; background:${headerBg}; border:1px solid ${headerBorderColor}; padding:8px 12px;">
                <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">${arrow}</span>
                <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${title}</span>
            ${headerNote ? `<span class="sidebar-pill" style="margin-right:8px; background:${lowStock ? '#ffebee' : '#fff7e0'}; color:${lowStock ? '#c62828' : '#b26a00'};">${headerNote}</span>` : ''}
            ${availabilityBadge}
        </div>
        <div class="col-body" style="padding:12px; background:${bodyBg}; border:1px solid ${bodyBorderColor}; border-radius:6px; ${bodyDisplay}">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                <span style="font-weight:700;">${isEquipment ? 'Medical Equipment Detail' : 'Equipment Detail'}</span>
                <button onclick="event.stopPropagation(); deleteEquipment('${item.id}')" class="btn btn-sm" style="background:var(--red); margin-left:auto;">🗑 Delete Medical Equipment Item</button>
            </div>
            <div style="display:grid; grid-template-columns: 2fr 1fr; gap:10px; margin-bottom:10px; align-items:end;">
                <div>
                    <label style="font-weight:700; font-size:12px;">Medical Equipment Name</label>
                    <input id="eq-name-${item.id}" type="text" value="${item.name}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                </div>
                <div>
                    <label style="font-weight:700; font-size:12px;">Quantity</label>
                    <input id="eq-qty-${item.id}" type="text" value="${item.totalQty}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                </div>
                <div style="grid-column: span 2;">
                    <label style="font-weight:700; font-size:12px;">Category</label>
                    <select id="eq-cat-${item.id}" style="width:100%; padding:8px;" onchange="scheduleSaveEquipment('${item.id}')">
                        ${buildCategoryOptions(equipmentCategories, item.category)}
                    </select>
                </div>
                <div style="grid-column: span 2;">
                    <label style="font-weight:700; font-size:12px;">Storage Location</label>
                    <input id="eq-loc-${item.id}" type="text" value="${item.storageLocation}" placeholder="Medical Bag 1, Locker B" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                </div>
                <div style="grid-column: span 2;">
                    <label style="font-weight:700; font-size:12px;">Notes</label>
                    <textarea id="eq-notes-${item.id}" style="width:100%; padding:8px; min-height:60px;" oninput="scheduleSaveEquipment('${item.id}')">${item.notes || ''}</textarea>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <input id="eq-exclude-${item.id}" type="checkbox" ${item.excludeFromResources ? 'checked' : ''} onchange="scheduleSaveEquipment('${item.id}')">
                <label style="font-size:12px; line-height:1.2; margin:0;">Resource Currently Unavailable</label>
            </div>
        </div>
    </div>`;

    if (isConsumable) {
        return `
        <div class="collapsible history-item">
        <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; align-items:center; background:${headerBg}; border:1px solid ${headerBorderColor}; padding:8px 12px;">
                <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">${arrow}</span>
                <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${title}</span>
                ${headerNote ? `<span class="sidebar-pill" style="margin-right:8px; background:${lowStock ? '#ffebee' : '#fff7e0'}; color:${lowStock ? '#c62828' : '#b26a00'};">${headerNote}</span>` : ''}
                ${availabilityBadge}
            </div>
            <div class="col-body" style="padding:12px; background:${bodyBg}; border:1px solid ${bodyBorderColor}; border-radius:6px; ${bodyDisplay}">
                ${consumableDetail}
            </div>
        </div>`;
    }

    return equipmentDetail;
}

/**
 * Schedule debounced auto-save for equipment item.
 * 
 * Debounce Period: 600ms
 * 
 * Allows rapid typing/editing without flooding the backend with saves.
 * Each equipment item has independent timer.
 * 
 * Triggered by: Input/change events on equipment form fields
 * 
 * @param {string} id - Equipment item ID to save
 */
function scheduleSaveEquipment(id) {
    if (equipmentSaveTimers[id]) clearTimeout(equipmentSaveTimers[id]);
    equipmentSaveTimers[id] = setTimeout(() => saveEquipment(id), 600);
}

/**
 * Save equipment item changes to server.
 * 
 * Save Process:
 * 1. Loads full equipment list
 * 2. Finds item by ID
 * 3. Updates fields from form inputs
 * 4. Writes entire list back to server
 * 5. Updates cache and re-renders with item expanded
 * 
 * Fields Saved:
 * - name, category, type, storage location
 * - status, dates (expiry, inspection, calibration)
 * - quantities (total, min PAR)
 * - battery info, supplier, notes
 * - excludeFromResources flag
 * 
 * Re-render Strategy:
 * After save, re-renders with saved item expanded so user can verify
 * changes persisted correctly.
 * 
 * @param {string} id - Equipment item ID to save
 */
async function saveEquipment(id) {
    const getVal = (elementId, fallback = '') => {
        const el = document.getElementById(elementId);
        return el ? el.value : fallback;
    };
    const data = await fetchJson('/api/data/tools');
    const items = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    const eq = items.find((i) => i.id === id);
    if (!eq) return;
    eq.name = getVal(`eq-name-${id}`, eq.name);
    eq.category = getVal(`eq-cat-${id}`, eq.category);
    eq.type = getVal(`eq-type-${id}`, eq.type || 'durable');
    eq.storageLocation = getVal(`eq-loc-${id}`, eq.storageLocation);
    eq.subLocation = getVal(`eq-subloc-${id}`, eq.subLocation);
    eq.parentId = getVal(`eq-parent-${id}`, eq.parentId);
    eq.status = getVal(`eq-status-${id}`, eq.status || 'In Stock');
    eq.expiryDate = getVal(`eq-exp-${id}`, eq.expiryDate);
    eq.lastInspection = getVal(`eq-inspect-${id}`, eq.lastInspection);
    eq.batteryType = getVal(`eq-batt-${id}`, eq.batteryType);
    eq.calibrationDue = getVal(`eq-cal-${id}`, eq.calibrationDue);
    eq.totalQty = getVal(`eq-qty-${id}`, eq.totalQty);
    eq.minPar = getVal(`eq-par-${id}`, eq.minPar);
    eq.supplier = getVal(`eq-sup-${id}`, eq.supplier);
    eq.notes = getVal(`eq-notes-${id}`, eq.notes);
    const excludeEl = document.getElementById(`eq-exclude-${id}`);
    eq.excludeFromResources = !!(excludeEl && excludeEl.checked);

    await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
        credentials: 'same-origin',
    });
    equipmentCache = items;
    renderEquipment(equipmentCache, id);
}

function openEquipmentAddForm() {
    // Ensure both outer and inner collapsibles are open so the add button is visible.
    const outerHeader = document.querySelector('#equipment-section-header');
    if (outerHeader) {
        const outerBody = outerHeader.nextElementSibling;
        if (outerBody && outerBody.style.display !== 'block') {
            toggleSection(outerHeader);
        }
    }
    const header = document.getElementById('equipment-add-header');
    if (header) {
        const body = header.nextElementSibling;
        if (body && body.style.display !== 'block') {
            toggleSection(header);
        }
    }
    setTimeout(() => {
        const nameField = document.getElementById('eq-new-name');
        if (nameField) nameField.focus();
    }, 30);
}

function getNewEquipmentVal(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

/**
 * Add new medical equipment item from form.
 * 
 * Validation:
 * - Name is required (focuses field if missing)
 * - All other fields optional
 * 
 * Process:
 * 1. Collects form values
 * 2. Creates new item with generated ID
 * 3. Adds to equipment list
 * 4. Saves to server
 * 5. Clears form for next entry
 * 6. Reloads with new item expanded
 * 
 * Item Type: 'durable' (reusable equipment)
 * Category: 'Medical Equipment'
 * 
 * Use Cases:
 * - AED, blood pressure cuff, thermometer
 * - Stethoscope, pulse oximeter, glucometer
 * - Trauma shears, splints, suction devices
 */
async function addMedicalStore() {
    const name = getNewEquipmentVal('eq-new-name');
    if (!name) {
        alert('Please enter a Medical Equipment name');
        const nameField = document.getElementById('eq-new-name');
        if (nameField) nameField.focus();
        return;
    }
    const quantity = getNewEquipmentVal('eq-new-qty');
    const location = getNewEquipmentVal('eq-new-loc');
    const notes = document.getElementById('eq-new-notes')?.value || '';
    const exclude = document.getElementById('eq-new-exclude')?.checked || false;
    const category = getNewEquipmentVal('eq-new-category');
    const newId = `eq-${Date.now()}`;
    const newItem = ensureEquipmentDefaults({
        id: newId,
        name,
        category,
        type: 'durable',
        storageLocation: location,
        totalQty: quantity,
        notes,
        status: 'In Stock',
        excludeFromResources: exclude,
    });

    const data = await fetchJson('/api/data/tools');
    const items = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    items.push(newItem);
    await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
        credentials: 'same-origin',
    });

    // Clear the add form for the next entry
    ['eq-new-name','eq-new-loc','eq-new-qty','eq-new-notes','eq-new-category']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    const newExclude = document.getElementById('eq-new-exclude');
    if (newExclude) newExclude.checked = false;

    loadEquipment(newId);
}

function canonicalMedKey(generic, brand, strength, formStrength = '') {
    const clean = (val) => (val || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const strengthVal = clean(strength || formStrength).replace(/unspecified/g, '');
    return `${clean(generic)}|${clean(brand)}|${strengthVal}`;
}

async function addMedicationItem() {
    const name = getNewEquipmentVal('med-new-name');
    if (!name) {
        alert('Please enter a Medication name');
        const nameField = document.getElementById('med-new-name');
        if (nameField) nameField.focus();
        return;
    }
    const sortSel = document.getElementById('med-new-sort');
    const sortCustom = document.getElementById('med-new-sort-custom');
    const sortCategoryRaw = sortSel ? (sortSel.value === '__custom' ? (sortCustom?.value || '') : (sortSel.value || '')) : '';
    const sortCategory = (sortCategoryRaw || '').trim();
    const verified = !!document.getElementById('med-new-verified')?.checked;
    const exclude = document.getElementById('med-new-exclude')?.checked || false;
    const controlled = document.getElementById('med-new-ctrl')?.value === 'true';
    const dosage = document.getElementById('med-new-dose')?.value || '';
    const expiryDate = document.getElementById('med-new-exp')?.value || '';
    const expiryQty = getNewEquipmentVal('med-new-exp-qty') || '';
    const expiryBatch = getNewEquipmentVal('med-new-exp-batch') || '';
    const notes = document.getElementById('med-new-notes')?.value || '';
    const newId = `med-${Date.now()}`;
    const purchaseHistory = [];
    if (expiryDate) {
        purchaseHistory.push({
            id: `ph-${Date.now()}`,
            date: expiryDate,
            quantity: expiryQty || getNewEquipmentVal('med-new-qty') || '',
            notes: '',
            manufacturer: getNewEquipmentVal('med-new-sup') || '',
            batchLot: expiryBatch || '',
        });
    }
    const newMed = {
        id: newId,
        genericName: name,
        brandName: getNewEquipmentVal('med-new-brand'),
        form: getNewEquipmentVal('med-new-form'),
        strength: getNewEquipmentVal('med-new-strength'),
        formStrength: [getNewEquipmentVal('med-new-form'), getNewEquipmentVal('med-new-strength')].join(' ').trim(),
        currentQuantity: getNewEquipmentVal('med-new-qty') || '',
        minThreshold: getNewEquipmentVal('med-new-par') || '',
        unit: getNewEquipmentVal('med-new-unit') || '',
        storageLocation: getNewEquipmentVal('med-new-loc') || '',
        expiryDate: document.getElementById('med-new-exp')?.value || '',
        batchLot: '',
        controlled,
        manufacturer: getNewEquipmentVal('med-new-sup') || '',
        primaryIndication: getNewEquipmentVal('med-new-indication') || '',
        allergyWarnings: getNewEquipmentVal('med-new-allergy') || '',
        standardDosage: dosage,
        sortCategory,
        verified,
        notes,
        purchaseHistory,
        source: 'manual_entry',
        excludeFromResources: exclude,
    };

    const data = await fetchJson('/api/data/inventory');
    const items = Array.isArray(data) ? data : [];
    const g = (newMed.genericName || '').trim().toLowerCase();
    const b = (newMed.brandName || '').trim().toLowerCase();
    const targetKey = canonicalMedKey(g, b, newMed.strength, newMed.formStrength);
    const dup = items.find((m) => {
        const mg = (m.genericName || '').trim().toLowerCase();
        const mb = (m.brandName || '').trim().toLowerCase();
        return canonicalMedKey(mg, mb, m.strength, m.formStrength) === targetKey;
    });
    if (dup) {
        alert('A medication with the same Generic + Brand + Strength already exists. Please adjust to keep entries unique.');
        return;
    }
    items.push(newMed);
    await fetch('/api/data/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
        credentials: 'same-origin',
    });

    ['med-new-name','med-new-brand','med-new-form','med-new-strength','med-new-loc','med-new-exp','med-new-exp-qty','med-new-exp-batch','med-new-qty','med-new-par','med-new-unit','med-new-sup','med-new-indication','med-new-allergy','med-new-dose','med-new-notes']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    const sortSelect = document.getElementById('med-new-sort');
    const sortCustomInput = document.getElementById('med-new-sort-custom');
    if (sortSelect) sortSelect.value = '';
    if (sortCustomInput) { sortCustomInput.value = ''; sortCustomInput.style.display = 'none'; }
    const medVerified = document.getElementById('med-new-verified');
    if (medVerified) medVerified.checked = false;
    const medExclude = document.getElementById('med-new-exclude');
    if (medExclude) medExclude.checked = false;
    const ctrlSel = document.getElementById('med-new-ctrl');
    if (ctrlSel) ctrlSel.value = 'false';

    if (typeof loadPharmacy === 'function') {
        loadPharmacy();
    }
}

/**
 * Add new consumable item from form.
 * 
 * Validation:
 * - Name is required (focuses field if missing)
 * - Quantity and notes optional
 * 
 * Process:
 * 1. Collects form values  
 * 2. Creates new item with generated ID
 * 3. Adds to equipment list
 * 4. Saves to server
 * 5. Clears form for next entry
 * 6. Reloads with new item expanded
 * 
 * Item Type: 'consumable' (single-use supplies)
 * Category: 'Consumable'
 * 
 * Use Cases:
 * - Bandages, gauze pads, tape
 * - Gloves, masks, syringes
 * - Alcohol wipes, antiseptic
 * - Sutures, IV supplies
 */
async function addConsumableItem() {
    const name = getNewEquipmentVal('cons-new-name');
    if (!name) {
        alert('Please enter a Consumable name');
        const nameField = document.getElementById('cons-new-name');
        if (nameField) nameField.focus();
        return;
    }
    const quantity = getNewEquipmentVal('cons-new-qty');
    const notes = document.getElementById('cons-new-notes')?.value || '';
    const exclude = document.getElementById('cons-new-exclude')?.checked || false;
    const category = getNewEquipmentVal('cons-new-category');
    const newId = `eq-${Date.now()}`;
    const newItem = ensureEquipmentDefaults({
        id: newId,
        name,
        category,
        type: 'consumable',
        totalQty: quantity,
        notes,
        status: 'In Stock',
        excludeFromResources: exclude,
    });

    const res = await fetch('/api/data/tools', { credentials: 'same-origin' });
    const data = await res.json();
    const items = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    items.push(newItem);
    await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
        credentials: 'same-origin',
    });

    ['cons-new-name','cons-new-qty','cons-new-notes','cons-new-category']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    const consumableExclude = document.getElementById('cons-new-exclude');
    if (consumableExclude) consumableExclude.checked = false;

    loadEquipment(newId);
}

/**
 * Delete equipment item with double confirmation.
 * 
 * Two-Step Safety:
 * 1. Confirm dialog
 * 2. Type "DELETE" prompt (exact match required)
 * 
 * Process:
 * 1. Loads full equipment list
 * 2. Filters out deleted item
 * 3. Writes remaining items to server
 * 4. Reloads equipment display
 * 
 * Permanent Action:
 * No undo available. Data is permanently removed from tools.json.
 * 
 * @param {string} id - Equipment item ID to delete
 */
async function deleteEquipment(id) {
    if (!confirm('Delete this equipment item?')) return;
    const confirmText = prompt('Type DELETE to confirm:');
    if (confirmText !== 'DELETE') {
        alert('Deletion cancelled.');
        return;
    }
    const res = await fetch('/api/data/tools', { credentials: 'same-origin' });
    const data = await res.json();
    const items = Array.isArray(data) ? data : [];
    const filtered = items.filter((i) => i.id !== id);
    await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filtered),
        credentials: 'same-origin',
    });
    loadEquipment();
}

/**
 * Calculate days until a future date.
 * 
 * Used for:
 * - Expiry warnings (items expiring soon)
 * - Calibration due dates
 * - Maintenance schedules
 * 
 * Returns:
 * - Positive number: Days in future
 * - Negative number: Days in past (expired)
 * - 9999: Invalid date (parsing failed)
 * 
 * Thresholds:
 * - ≤ 60 days: Show "Expiring Soon" warning
 * - < 0 days: Show "Expired" warning
 * 
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {number} Days until date (or 9999 if invalid)
 */
function daysUntil(dateStr) {
    const now = new Date();
    const target = new Date(dateStr);
    if (isNaN(target.getTime())) return 9999;
    return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

// Expose handlers
window.loadEquipment = loadEquipment;
window.addEquipment = openEquipmentAddForm;
window.openEquipmentAddForm = openEquipmentAddForm;
window.addMedicalStore = addMedicalStore;
window.addMedicationItem = addMedicationItem;
window.addConsumableItem = addConsumableItem;
window.deleteEquipment = deleteEquipment;
window.scheduleSaveEquipment = scheduleSaveEquipment;
window.exportConsumables = exportConsumables;
window.openConsumablesFilePicker = openConsumablesFilePicker;
window.handleConsumablesFileImport = handleConsumablesFileImport;
window.exportEquipmentItems = exportEquipmentItems;
window.openEquipmentFilePicker = openEquipmentFilePicker;
window.handleEquipmentFileImport = handleEquipmentFileImport;
window.forceClearCache = function forceClearCache() {
    if (confirm('Force a hard reload and clear cached assets?')) {
        const url = new URL(window.location.href);
        url.searchParams.set('cache', Date.now().toString());
        window.location.replace(url.toString());
    }
};
