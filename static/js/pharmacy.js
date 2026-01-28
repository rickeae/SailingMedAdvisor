/*
File: static/js/pharmacy.js
Author notes: Client-side controller for the Medical Chest (pharmaceuticals).
I handle rendering, edits, autosave, WHO imports, expiry tracking, and
single-card expansion behavior.
*/

let pharmacyCache = [];
const pharmacySaveTimers = {};
const DEFAULT_USER_LABELS = ['Antibiotic', 'Analgesic', 'Cardiac', 'Respiratory', 'Gastrointestinal', 'Endocrine', 'Emergency'];
let pharmacyLabelsCache = null;
let WHO_RECOMMENDED_MEDS = [];
let whoMedLoaded = false;

// --- Shared utilities -------------------------------------------------------

// Small, collision-resistant id generator for client-created meds/expiries.
function uid(prefix = 'id') {
    // Prefer crypto for true randomness; fallback to timestamp + random.
    if (window.crypto && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// Lightweight toast helper to surface success/error without blocking alerts.
function showToast(message, isError = false) {
    let el = document.getElementById('pharmacy-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'pharmacy-toast';
        el.style.cssText =
            'position:fixed; bottom:20px; right:20px; padding:12px 16px; border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,0.2); font-weight:800; z-index:9999; display:none; min-width:220px;';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.display = 'block';
    el.style.background = isError ? '#ffebee' : '#e8f5e9';
    el.style.color = isError ? '#c62828' : '#2e7d32';
    el.style.border = `1px solid ${isError ? '#ef5350' : '#81c784'}`;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
        el.style.display = 'none';
    }, 4000);
}

// Wrapper around /api/data/inventory with consistent error handling.
async function fetchInventory(options = {}) {
    const headers = { ...(options.headers || {}) };
    const res = await fetch('/api/data/inventory', { credentials: 'same-origin', ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        throw new Error(data.error || `Status ${res.status}`);
    }
    return data;
}

function updatePharmacyCount(count) {
    const el = document.getElementById('pharmacy-count');
    if (el) {
        el.textContent = `(${count})`;
    }
}

function syncPharmacyCountFromDOM() {
    const list = document.getElementById('pharmacy-list');
    if (!list) {
        updatePharmacyCount(0);
        return;
    }
    const domCount = list.querySelectorAll('.history-item').length;
    updatePharmacyCount(domCount);
}

function observePharmacyList() {
    const list = document.getElementById('pharmacy-list');
    if (!list || list.dataset.countObserver === 'true') return;
    const observer = new MutationObserver(() => syncPharmacyCountFromDOM());
    observer.observe(list, { childList: true, subtree: true });
    list.dataset.countObserver = 'true';
    // Initial sync
    syncPharmacyCountFromDOM();
}

function getTextareaHeights() {
    const map = {};
    document.querySelectorAll('#pharmacy-list textarea').forEach((el) => {
        if (el.id && el.style && el.style.height) {
            map[el.id] = el.style.height;
        }
    });
    return map;
}

function normalizeUserLabels(list) {
    if (!Array.isArray(list)) return [...DEFAULT_USER_LABELS];
    const seen = new Set();
    return list
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean)
        .filter((v) => {
            const key = v.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

async function ensurePharmacyLabels() {
    if (window.CACHED_SETTINGS && Array.isArray(window.CACHED_SETTINGS.pharmacy_labels)) {
        const normalized = normalizeUserLabels(window.CACHED_SETTINGS.pharmacy_labels);
        if (!pharmacyLabelsCache || normalized.join('|') !== pharmacyLabelsCache.join('|')) {
            pharmacyLabelsCache = normalized;
        }
    }
    if (pharmacyLabelsCache && pharmacyLabelsCache.length) return pharmacyLabelsCache;
    try {
        const url = '/api/data/settings';
        const data = await fetchJson(url);
        if (data && Array.isArray(data.pharmacy_labels)) {
            pharmacyLabelsCache = normalizeUserLabels(data.pharmacy_labels);
        }
    } catch (err) {
        console.warn('[pharmacy] failed to load user labels, using defaults', err);
    }
    if (!pharmacyLabelsCache || !pharmacyLabelsCache.length) {
        pharmacyLabelsCache = [...DEFAULT_USER_LABELS];
    }
    return pharmacyLabelsCache;
}

function getPharmacyLabels() {
    return pharmacyLabelsCache && pharmacyLabelsCache.length ? [...pharmacyLabelsCache] : [...DEFAULT_USER_LABELS];
}

function renderUserLabelOptions(selectedValue = '') {
    const selected = (selectedValue || '').trim();
    const labels = getPharmacyLabels();
    const isCustom = !!selected && !labels.includes(selected);
    const options = [
        '<option value="">Select...</option>',
        ...labels.map((label) => `<option value="${label}"${label === selected ? ' selected' : ''}>${label}</option>`),
        `<option value="__custom"${isCustom ? ' selected' : ''}>Custom...</option>`,
    ];
    return {
        optionsHtml: options.join(''),
        showCustom: isCustom,
        customValue: isCustom ? selected : '',
    };
}

function populateNewMedUserLabelSelect() {
    const select = document.getElementById('med-new-sort');
    const custom = document.getElementById('med-new-sort-custom');
    if (!select || !custom) return;
    const labels = getPharmacyLabels();
    const selectVal = select.value;
    const customVal = custom.value;
    const current = selectVal === '__custom' ? customVal : selectVal;
    const isCustom = !!current && !labels.includes(current);
    const opts = [
        '<option value="">Select...</option>',
        ...labels.map((label) => `<option value="${label}">${label}</option>`),
        '<option value="__custom">Custom...</option>',
    ];
    select.innerHTML = opts.join('');
    select.value = isCustom ? '__custom' : (labels.includes(current) ? current : '');
    custom.style.display = isCustom ? 'block' : 'none';
    if (isCustom) custom.value = current;
    else if (select.value !== '__custom') custom.value = '';
}

function refreshPharmacyLabelsFromSettings(list) {
    const normalized = normalizeUserLabels(Array.isArray(list) ? list : pharmacyLabelsCache || DEFAULT_USER_LABELS);
    pharmacyLabelsCache = normalized;
    populateNewMedUserLabelSelect();
    const listEl = document.getElementById('pharmacy-list');
    if (listEl && pharmacyCache && pharmacyCache.length) {
        const openIds = getOpenMedIds();
        const textHeights = getTextareaHeights();
        renderPharmacy(pharmacyCache, openIds, textHeights);
    }
}

function handleSortCategoryChange(id) {
    const select = document.getElementById(`sort-${id}`);
    const custom = document.getElementById(`sort-custom-${id}`);
    if (!select || !custom) return;
    const val = select.value;
    const isCustom = val === '__custom';
    custom.style.display = isCustom ? 'block' : 'none';
    if (!isCustom) {
        custom.value = '';
    }
    // Avoid rerender when switching to custom so the input stays visible while typing
    scheduleSaveMedication(id, !isCustom);
}

function toggleCustomSortField() {
    const sel = document.getElementById('med-new-sort');
    const custom = document.getElementById('med-new-sort-custom');
    if (!sel || !custom) return;
    const isCustom = sel.value === '__custom';
    custom.style.display = isCustom ? 'block' : 'none';
    if (!isCustom) custom.value = '';
}

function ensurePurchaseDefaults(p, open = false) {
    // Normalize a purchase/expiry entry and keep manufacturer/batch alongside the expiry.
    return {
        id: p.id || uid('ph'),
        date: p.date || '',
        quantity: p.quantity || '',
        notes: p.notes || '',
        manufacturer: p.manufacturer || '',
        batchLot: p.batchLot || '',
        _open: open
    };
}

function ensurePharmacyDefaults(item) {
    // Normalize a med record; if legacy top-level manufacturer/batch exists, push into first expiry row.
    const med = {
        id: item.id || uid('med'),
        genericName: item.genericName || '',
        brandName: item.brandName || '',
        form: item.form || '',
        strength: item.strength || '',
        formStrength: item.formStrength || '',
        currentQuantity: item.currentQuantity || '', // legacy; derived from purchase history
        minThreshold: item.minThreshold || '',
        unit: item.unit || '',
        storageLocation: item.storageLocation || '',
        expiryDate: item.expiryDate || '',
        controlled: !!item.controlled,
        primaryIndication: item.primaryIndication || '',
        allergyWarnings: item.allergyWarnings || '',
        standardDosage: item.standardDosage || '',
        notes: item.notes || '',
        sortCategory: item.sortCategory || '',
        verified: !!item.verified,
        purchaseHistory: Array.isArray(item.purchaseHistory)
            ? item.purchaseHistory.map(ensurePurchaseDefaults)
            : [ensurePurchaseDefaults({})],
        source: item.source || '',
        photoImported: !!item.photoImported,
        excludeFromResources: Boolean(item.excludeFromResources),
    };
    // If only a combined formStrength is available, backfill strength to keep validation lenient.
    if (!med.strength && med.formStrength) {
        med.strength = med.formStrength;
    }
    med.formStrength = med.formStrength || [med.form, med.strength].join(' ').trim();
    // Backfill manufacturer/batchLot into first purchase entry if present on legacy record
    if (item.manufacturer && med.purchaseHistory.length && !med.purchaseHistory[0].manufacturer) {
        med.purchaseHistory[0].manufacturer = item.manufacturer;
    }
    if (item.batchLot && med.purchaseHistory.length && !med.purchaseHistory[0].batchLot) {
        med.purchaseHistory[0].batchLot = item.batchLot;
    }
    return med;
}

function canonicalMedKey(generic, brand, strength, formStrength = '') {
    const clean = (val) => (val || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const strengthVal = clean(strength || formStrength).replace(/unspecified/g, '');
    return `${clean(generic)}|${clean(brand)}|${strengthVal}`;
}

function scheduleSaveMedication(id, rerender = false) {
    // Debounce saves so quick typing doesn't flood the backend; rerender when structure changes.
    if (pharmacySaveTimers[id]) {
        clearTimeout(pharmacySaveTimers[id]);
    }
    pharmacySaveTimers[id] = setTimeout(() => {
        saveMedication(id, rerender);
    }, 50); // very short debounce for snappier UI feedback
}

function getMedicationDisplayName(med) {
    const clean = (val) => (val || '').replace(/\s*\(photo import\)$/i, '').trim();
    const isPlaceholder = (val) => !val || /^medication\b/i.test(val);
    const generic = clean(med.genericName);
    const brand = clean(med.brandName);
    let primary = !isPlaceholder(generic) ? generic : !isPlaceholder(brand) ? brand : '';
    if (!primary) {
        primary = med.primaryIndication || med.manufacturer || 'Medication';
    }
    const showBrand = brand && !isPlaceholder(brand) && brand.toLowerCase() !== primary.toLowerCase();
    return `${primary}${showBrand ? ' - ' + brand : ''}`;
}

function getExpiryDate(med) {
    if (!med || !Array.isArray(med.purchaseHistory)) return med?.expiryDate || '';
    let earliest = null;
    med.purchaseHistory.forEach(ph => {
        if (!ph || !ph.date) return;
        const d = new Date(ph.date);
        if (isNaN(d)) return;
        if (!earliest || d < earliest) earliest = d;
    });
    return earliest ? earliest.toISOString().slice(0, 10) : (med.expiryDate || '');
}

function getCurrentQuantity(med) {
    if (!med || !Array.isArray(med.purchaseHistory)) return Number(med.currentQuantity) || 0;
    return med.purchaseHistory.reduce((sum, ph) => {
        const n = Number(ph.quantity);
        return Number.isFinite(n) ? sum + n : sum;
    }, 0);
}

function sortPharmacyItems(items) {
    const list = Array.isArray(items) ? [...items] : [];
    const sortSel = document.getElementById('pharmacy-sort');
    const mode = (sortSel && sortSel.value) || 'sortCategory';
    const byText = (a, b, pathA, pathB) => {
        const va = (pathA || '').toLowerCase();
        const vb = (pathB || '').toLowerCase();
        return va.localeCompare(vb);
    };
    list.sort((a, b) => {
        if (mode === 'sortCategory') {
            const hasA = !!(a.sortCategory || '').trim();
            const hasB = !!(b.sortCategory || '').trim();
            if (hasA && !hasB) return -1;
            if (!hasA && hasB) return 1;
            if (hasA && hasB) {
                const cat = byText(a, b, a.sortCategory, b.sortCategory);
                if (cat !== 0) return cat;
            }
        }
        if (mode === 'brand') {
            return byText(a, b, a.brandName || '', b.brandName || '');
        }
        if (mode === 'strength') {
            return byText(a, b, a.strength || '', b.strength || '');
        }
        if (mode === 'expiry') {
            return byText(a, b, getExpiryDate(a) || '', getExpiryDate(b) || '');
        }
        // default generic
        return byText(a, b, a.genericName || a.brandName || '', b.genericName || b.brandName || '');
    });
    return list;
}

// Primary loader for the Medical Chest list. Pulls server data, normalizes, renders cards,
// and keeps the count badge in sync. WHO list is lazy-loaded alongside.
async function loadPharmacy() {
    const list = document.getElementById('pharmacy-list');
    if (!list) return;
    await ensurePharmacyLabels();
    await loadWhoMedsFromServer();
    populateNewMedUserLabelSelect();
    observePharmacyList();
    list.innerHTML = '<div style="color:#666;">Loading inventory...</div>';
    try {
        const data = await fetchInventory();
        pharmacyCache = (Array.isArray(data) ? data : []).map(ensurePharmacyDefaults);
        updatePharmacyCount(pharmacyCache.length);
        renderPharmacy(pharmacyCache);
        renderWhoMedList();
        // Safety: if DOM render diverges, re-sync from DOM node count
        syncPharmacyCountFromDOM();
        setTimeout(syncPharmacyCountFromDOM, 50);
    } catch (err) {
        updatePharmacyCount(0);
        list.innerHTML = `<div style="color:red;">Error loading inventory: ${err.message}</div>`;
    }
}

function handlePharmacySortChange() {
    const openIds = getOpenMedIds();
    const textHeights = getTextareaHeights();
    renderPharmacy(pharmacyCache, openIds, textHeights);
}

function getOpenMedIds() {
    return Array.from(document.querySelectorAll('#pharmacy-list .history-item .col-body[data-med-id]'))
        .filter((el) => el.style.display !== 'none')
        .map((el) => el.dataset.medId)
        .filter(Boolean);
}

function renderPharmacy(items, openIds = [], textHeights = {}) {
    const list = document.getElementById('pharmacy-list');
    if (!list) return;
    updatePharmacyCount((items || []).length);
    if (!items || items.length === 0) {
        list.innerHTML = '<div style="color:#666; padding:12px;">No medications entered. Add your first item.</div>';
        return;
    }
    const sorted = sortPharmacyItems(items);
    list.innerHTML = '<div style="color:#666; padding:12px;">Rendering medicines…</div>';
    const chunkSize = 40;
    let idx = 0;
    list.innerHTML = ''; // clear placeholder
    const renderChunk = () => {
        if (idx >= sorted.length) {
            syncPharmacyCountFromDOM();
            setTimeout(syncPharmacyCountFromDOM, 50);
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => syncPharmacyCountFromDOM());
            }
            populateNewMedUserLabelSelect();
            return;
        }
        const slice = sorted.slice(idx, idx + chunkSize);
        const html = slice.map((m) => renderMedicationCard(m, openIds.includes(m.id), textHeights)).join('');
        list.insertAdjacentHTML('beforeend', html);
        idx += chunkSize;
        const scheduler = window.requestIdleCallback || window.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
        scheduler(renderChunk);
    };
    renderChunk();
}

function renderPurchaseRows(med) {
    // Expiry UI contract:
    //  - Rows carry stable ph-id so deletes map 1:1 to saved rows.
    //  - Manufacturer / batch live per-row (stock provenance).
    //  - We keep at least one row visible for usability.
    const rows = med.purchaseHistory.length ? med.purchaseHistory : [ensurePurchaseDefaults({}, true)];
    return rows
        .map((p) => {
            return `
                <div class="purchase-row" data-med-id="${med.id}" data-ph-id="${p.id || ''}" style="border:1px solid #d9e5f7; padding:10px; border-radius:6px; margin-bottom:10px; background:#f5f9ff;">
                <div style="display:grid; grid-template-columns: repeat(2, minmax(200px, 1fr)); gap:10px; align-items:center; margin-bottom:10px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="ph-notes-toggle" style="cursor:pointer; font-weight:800; color:var(--dark);" onclick="togglePurchaseNotes(this)">${p._open ? 'v' : '>'}</span>
                        <input type="date" class="ph-date" value="${p.date || ''}" style="padding:8px; font-size:14px; width:100%;" onchange="scheduleSaveMedication('${med.id}')" title="Expiry Date">
                    </div>
                    <input type="number" class="ph-qty" value="${p.quantity || ''}" placeholder="Qty" style="padding:8px; font-size:14px;" oninput="scheduleSaveMedication('${med.id}')" title="Quantity tied to this expiry">
                </div>
                <div style="display:grid; grid-template-columns: repeat(2, minmax(200px, 1fr)); gap:10px; align-items:center; margin-bottom:10px;">
                    <div>
                        <label style="font-weight:700; font-size:12px;">Manufacturer</label>
                        <input type="text" class="ph-manufacturer" value="${p.manufacturer || ''}" placeholder="Manufacturer" style="padding:8px; font-size:14px; width:100%;" oninput="scheduleSaveMedication('${med.id}')">
                    </div>
                    <div>
                        <label style="font-weight:700; font-size:12px;">Batch / Lot Number</label>
                        <input type="text" class="ph-batch" value="${p.batchLot || ''}" placeholder="Batch or Lot" style="padding:8px; font-size:14px; width:100%;" oninput="scheduleSaveMedication('${med.id}')">
                    </div>
                </div>
                <div class="ph-notes-container" style="margin-bottom:10px; display:${p._open ? 'block' : 'none'};">
                    <textarea class="ph-notes" placeholder="Notes (batch/lot/location)" style="width:100%; padding:8px; min-height:60px; font-size:14px;" oninput="scheduleSaveMedication('${med.id}')">${p.notes || ''}</textarea>
                </div>
                <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
                    <button class="btn btn-sm" style="background:var(--red);" onclick="deletePurchaseEntry('${med.id}','${p.id || ''}')">Delete Expiry Entry</button>
                </div>
            </div>`;
        })
        .join('');
}

function renderMedicationCard(med, isOpen = true, textHeights = {}) {
    // Render a single medication card with summary badges and collapsible details/expiry tracking.
    const currentQty = getCurrentQuantity(med);
    const lowStock = med.minThreshold && Number(currentQty) <= Number(med.minThreshold);
    const expiryDate = getExpiryDate(med);
    const days = expiryDate ? daysUntil(expiryDate) : null;
    const isExpired = Number.isFinite(days) && days < 0;
    const expirySoon = Number.isFinite(days) && days >= 0 && days <= 60;
    const expiryText = expiryDate ? `Exp: ${expiryDate}` : 'No expiry set';
    const headerNote = [
        lowStock ? 'Low Stock' : null,
        isExpired ? 'Expired' : null,
        !isExpired && expirySoon ? 'Expiring Soon' : null
    ].filter(Boolean).join(' - ');
    const displayName = getMedicationDisplayName(med);
    const strength = (med.strength || '').trim();
    const userLabelRender = renderUserLabelOptions(med.sortCategory || '');
    const labelChip = med.sortCategory && med.sortCategory.trim()
        ? `<span style="margin-left:8px; padding:2px 8px; border-radius:999px; background:rgba(46,125,50,0.12); color:var(--inquiry); font-size:11px; white-space:nowrap;">${escapeHtml(med.sortCategory.trim())}</span>`
        : '';
    const bodyDisplay = isOpen ? 'display:block;' : 'display:none;';
    const arrow = isOpen ? 'v' : '>';
    const headerBg = med.excludeFromResources ? '#ffecef' : '#eef7ff';
    const headerBorderColor = med.excludeFromResources ? '#ffcfe0' : '#c7ddff';
    const bodyBg = med.excludeFromResources ? '#fff6f6' : '#f7fff7';
    const bodyBorderColor = med.excludeFromResources ? '#ffcfd0' : '#cfe9d5';
    const badgeColor = med.excludeFromResources ? '#d32f2f' : '#2e7d32';
    const badgeText = med.excludeFromResources ? 'Resource Currently Unavailable' : 'Resource Available';
    const availabilityBadge = `<span style="padding:2px 10px; border-radius:999px; background:${badgeColor}; color:#fff; font-size:11px; white-space:nowrap;">${badgeText}</span>`;
    const verifiedBadge = med.verified
        ? `<span style="padding:2px 10px; border-radius:999px; background:var(--inquiry); color:#fff; font-size:11px; white-space:nowrap;">Verified</span>`
        : `<span style="padding:2px 10px; border-radius:999px; background:transparent; color:var(--inquiry); font-size:11px; white-space:nowrap; border:1px dashed #b2c7b5;">Not Verified</span>`;
    const doseHeight = textHeights[`dose-${med.id}`] ? `height:${textHeights[`dose-${med.id}`]};` : '';
    return `
            <div class="collapsible history-item">
        <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; align-items:center; background:${headerBg}; border:1px solid ${headerBorderColor}; padding:8px 12px;">
            <span class="dev-tag">dev:med-card</span>
            <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;" data-collapse-group="pharmacy">${arrow}</span>
            <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:700;">
                ${displayName}${strength ? ' - ' + strength : ''}
            </span>
            ${labelChip}
            ${headerNote ? `<span class="sidebar-pill" style="margin-right:8px; background:${lowStock ? '#ffebee' : '#fff7e0'}; color:${lowStock ? '#c62828' : '#b26a00'};">${headerNote}</span>` : ''}
            <button onclick="event.stopPropagation(); deleteMedication('${med.id}')" class="btn btn-sm history-action-btn" style="background:var(--red); visibility:hidden;">Delete Medication</button>
            <div style="display:flex; align-items:center; gap:6px; margin-left:8px;">${verifiedBadge}${availabilityBadge}</div>
        </div>
        <div class="col-body" data-med-id="${med.id}" style="padding:12px; background:${bodyBg}; border:1px solid ${bodyBorderColor}; border-radius:6px; ${bodyDisplay}">
            <div class="collapsible" style="margin-bottom:10px;">
                <div class="col-header crew-med-header" onclick="toggleMedDetails(this)" style="background:#fff; justify-content:flex-start; align-items:center;">
                    <span class="dev-tag">dev:med-details</span>
                    <span class="detail-icon history-arrow" style="font-size:16px; margin-right:8px;">v</span>
                    <span style="font-weight:700;">Medication Details</span>
                </div>
            <div class="col-body" style="padding:10px; display:block;" id="details-${med.id}">
                <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap;">
                    <label style="display:flex; align-items:center; gap:6px; font-size:12px; padding:6px 10px; border:1px solid #ffcfe0; border-radius:6px; background:#fff; margin:0;">
                        <input id="exclude-${med.id}" type="checkbox" ${med.excludeFromResources ? 'checked' : ''} onchange="scheduleSaveMedication('${med.id}', true)">
                        Resource Currently Unavailable
                    </label>
                    <label style="display:flex; align-items:center; gap:6px; font-size:12px; padding:6px 10px; border:1px solid #c7ddff; border-radius:6px; background:#fff; margin:0;">
                        <input id="ver-${med.id}" type="checkbox" ${med.verified ? 'checked' : ''} onchange="scheduleSaveMedication('${med.id}', true); event.stopPropagation();">
                        Verified
                    </label>
                    <label style="display:flex; align-items:center; gap:6px; font-size:12px; padding:6px 10px; border:1px solid #c7ddff; border-radius:6px; background:#fff; margin:0;">
                        <span style="font-weight:700;">User Label</span>
                        <select id="sort-${med.id}" style="padding:6px 8px;" onchange="handleSortCategoryChange('${med.id}')">
                            ${userLabelRender.optionsHtml}
                        </select>
                        <input id="sort-custom-${med.id}" type="text" value="${userLabelRender.customValue}" placeholder="Custom label" style="width:160px; padding:6px; margin-left:6px; ${userLabelRender.showCustom ? '' : 'display:none;'}" oninput="scheduleSaveMedication('${med.id}', false)">
                    </label>
                </div>
                        <div style="display:grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap:10px; margin-bottom:10px;">
                        <div>
                            <label style="font-weight:700; font-size:12px;">Generic Name</label>
                            <input id="gn-${med.id}" type="text" value="${med.genericName}" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Brand Name</label>
                            <input id="bn-${med.id}" type="text" value="${med.brandName}" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Form</label>
                            <input id="form-${med.id}" type="text" value="${med.form}" placeholder="Tablet, Capsule, etc." style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Strength</label>
                            <input id="str-${med.id}" type="text" value="${med.strength}" placeholder="500mg, 10mg/ml" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                        </div>
                        <div style="grid-column: 1 / span 2; display:grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap:10px;">
                            <div>
                                <label style="font-weight:700; font-size:12px;">Minimum Threshold</label>
                                <input id="min-${med.id}" type="number" value="${med.minThreshold}" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                            </div>
                            <div>
                                <label style="font-weight:700; font-size:12px;">Unit of Measure</label>
                                <input id="unit-${med.id}" type="text" value="${med.unit}" placeholder="Bottle, Box, Blister" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                            </div>
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Storage Location</label>
                            <input id="loc-${med.id}" type="text" value="${med.storageLocation}" placeholder="Locker A, Fridge" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Controlled Substance?</label>
                            <select id="ctrl-${med.id}" style="width:100%; padding:8px;" onchange="scheduleSaveMedication('${med.id}')">
                                <option value="false" ${!med.controlled ? 'selected' : ''}>No</option>
                                <option value="true" ${med.controlled ? 'selected' : ''}>Yes</option>
                            </select>
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Primary Indication</label>
                            <input id="ind-${med.id}" type="text" value="${med.primaryIndication}" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Allergy Warnings</label>
                            <input id="alg-${med.id}" type="text" value="${med.allergyWarnings}" placeholder="e.g., Contains Sulfa" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                        </div>
                        <div style="grid-column: span 2;">
                            <label style="font-weight:700; font-size:12px;">Standard Dosage (adult reference)</label>
                            <textarea id="dose-${med.id}" style="width:100%; padding:8px; min-height:60px; ${doseHeight}" oninput="scheduleSaveMedication('${med.id}')">${med.standardDosage || ''}</textarea>
                        </div>
                    </div>
                </div>
            </div>
            <div style="margin:10px 0; border-top:1px solid #d0dff5; padding-top:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; gap:8px;">
                    <div style="display:flex; align-items:center; gap:6px; font-weight:800; color:var(--dark);">
                        <span>Expiry Tracking</span>
                        <span class="dev-tag">dev:med-expiry</span>
                    </div>
                    <button class="btn btn-sm" style="background:var(--inquiry);" onclick="addPurchaseEntry('${med.id}')">Add Entry</button>
                </div>
                <div id="ph-${med.id}">${renderPurchaseRows(med)}</div>
            </div>
        </div>
    </div>`;
}

function renderWhoMedList() {
    const container = document.getElementById('who-med-list');
    if (!container) return;
    container.innerHTML = WHO_RECOMMENDED_MEDS.map((m, idx) => {
        const id = `who-${m.id || idx}`;
        return `
            <label style="position:relative; display:block; border:1px solid #d9e5f7; padding:12px 10px 10px 42px; border-radius:8px; background:#fff; transition:background 120ms ease, border-color 120ms ease;">
                <input type="checkbox" name="who-med-check" value="${id}" style="position:absolute; top:10px; left:10px;" onchange="handleWhoTileSelect(this)">
                <div style="display:flex; gap:10px; width:100%; align-items:flex-start;">
                    <div style="flex:1; min-width:0;">
                        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px; flex-wrap:wrap;">
                            <div style="font-weight:800; color:#1f2d3d;">${m.genericName}</div>
                            <button type="button" class="btn btn-xs" style="background:#0b8457; color:#fff; padding:4px 8px; line-height:1.2;" onclick="event.preventDefault(); event.stopPropagation(); addWhoMeds('${id}')">Add</button>
                        </div>
                        ${m.alsoKnownAs ? `<div style="font-size:12px; color:#37474f;">Also known as: ${m.alsoKnownAs}</div>` : ''}
                        ${m.formStrength ? `<div style="font-size:12px; color:#455a64;">Dosage form/strength: ${m.formStrength}</div>` : ''}
                        ${m.indications ? `<div style="font-size:12px; color:#455a64;">Indications: ${m.indications}</div>` : ''}
                        ${m.contraindications ? `<div style="font-size:12px; color:#b23b3b;">Contraindications: ${m.contraindications}</div>` : ''}
                        ${m.consultDoctor ? `<div style="font-size:12px; color:#6a1b9a;">Consult doctor: ${m.consultDoctor}</div>` : ''}
                        ${m.adultDosage ? `<div style="font-size:12px; color:#455a64;">Adult dosage: ${m.adultDosage}</div>` : ''}
                        ${m.unwantedEffects ? `<div style="font-size:12px; color:#b23b3b;">Unwanted effects: ${m.unwantedEffects}</div>` : ''}
                        ${m.remarks ? `<div style="font-size:12px; color:#455a64;">Remarks: ${m.remarks}</div>` : ''}
                    </div>
                </div>
            </label>
        `;
    }).join('') || '<div style="color:#666;">WHO list unavailable.</div>';
}

async function loadWhoMedsFromServer() {
    if (whoMedLoaded) return;
    setWhoMedStatus('Loading WHO ship medicine list...');
    try {
        const res = await fetch('/api/who/medicines', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        WHO_RECOMMENDED_MEDS = Array.isArray(data) ? data : [];
        whoMedLoaded = true;
        renderWhoMedList();
        setWhoMedStatus(`Loaded ${WHO_RECOMMENDED_MEDS.length} WHO medicine(s).`);
    } catch (err) {
        whoMedLoaded = false;
        renderWhoMedList();
        setWhoMedStatus(`WHO list unavailable: ${err.message}`, true);
    }
}

function parseWHOListText(text) {
    if (typeof text !== 'string') return [];
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const now = Date.now();
    return lines
        .map((line, idx) => {
            const cols = line.split('\t');
            if (idx === 0 && /generic\s+name/i.test(cols[0] || '')) {
                return null;
            }
            return {
                id: `who-import-${now}-${idx}`,
                genericName: (cols[0] || '').trim(),
                alsoKnownAs: (cols[1] || '').trim(),
                formStrength: (cols[2] || '').trim(),
                indications: (cols[3] || '').trim(),
                contraindications: (cols[4] || '').trim(),
                consultDoctor: (cols[5] || '').trim(),
                adultDosage: (cols[6] || '').trim(),
                unwantedEffects: (cols[7] || '').trim(),
                remarks: (cols[8] || '').trim(),
            };
        })
        .filter((entry) => entry && entry.genericName);
}

function setWhoMedStatus(message, isError = false) {
    const statusEl = document.getElementById('who-med-status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.style.color = isError ? 'var(--red)' : '#1f2d3d';
}

function openWhoListFilePicker() {
    const input = document.getElementById('who-list-import-file');
    if (!input) return;
    input.value = '';
    input.click();
}

async function handleWhoListFileImport(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
        const text = await file.text();
        const entries = parseWHOListText(text);
        if (!entries.length) {
            setWhoMedStatus('No valid WHO medicines found in the file.', true);
            return;
        }
        WHO_RECOMMENDED_MEDS = entries;
        renderWhoMedList();
        setWhoMedStatus(`Loaded ${entries.length} WHO medicine(s).`);
    } catch (err) {
        setWhoMedStatus(`Unable to load WHO list: ${err.message}`, true);
    } finally {
        if (event?.target) event.target.value = '';
    }
}

async function addWhoMeds(triggerId = null) {
    const statusEl = document.getElementById('who-med-status');
    const setStatus = (msg, isErr = false) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.style.color = isErr ? 'var(--red)' : '#1f2d3d';
    };
    const checked = Array.from(document.querySelectorAll('input[name="who-med-check"]:checked')).map((el) => el.value);
    const targetIds = new Set(checked);
    if (triggerId) targetIds.add(triggerId);
    if (!targetIds.size) {
        setStatus('Select one or more medicines to copy, or use an Add button.', true);
        return;
    }
    try {
        const data = await fetchInventory();
        const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
        let added = 0;
        let skipped = 0;
        const addedNames = [];
        const timestamp = new Date().toISOString();
        Array.from(targetIds).forEach((targetVal) => {
            const medTpl = WHO_RECOMMENDED_MEDS.find((m, idx) => `who-${m.id || idx}` === targetVal);
            if (!medTpl) return;
            const tplBrand = (medTpl.alsoKnownAs || '').trim().toLowerCase();
            const tplStrengthRaw = medTpl.formStrength || '';
            const tplStrengthParts = tplStrengthRaw.split(',');
            const tplStrength = (tplStrengthParts[1] || tplStrengthParts[0] || '').trim().toLowerCase();
            const dup = meds.find((m) => {
                const g = (m.genericName || '').trim().toLowerCase();
                const b = (m.brandName || '').trim().toLowerCase();
                const s = (m.strength || '').trim().toLowerCase();
                return g === (medTpl.genericName || '').trim().toLowerCase() && b === tplBrand && s === tplStrength;
            });
            if (dup) {
                skipped += 1;
                return;
            }
            const newMed = ensurePharmacyDefaults({
                id: uid('med-who'),
                genericName: medTpl.genericName || '',
                brandName: medTpl.alsoKnownAs || '',
                form: medTpl.formStrength ? medTpl.formStrength.split(',')[0].trim() : '',
                strength: medTpl.formStrength ? (medTpl.formStrength.split(',')[1] || '').trim() : '',
                currentQuantity: '',
                minThreshold: '',
                unit: '',
                storageLocation: 'Medical Locker',
                expiryDate: '',
                batchLot: '',
                controlled: false,
                manufacturer: '',
                primaryIndication: medTpl.indications || '',
                allergyWarnings: medTpl.contraindications || medTpl.unwantedEffects || '',
                standardDosage: medTpl.adultDosage || '',
                notes: `${medTpl.remarks || medTpl.consultDoctor || 'WHO ship list import'} | Added from WHO list on ${timestamp}`,
                source: 'who_recommended',
                photoImported: false,
                purchaseHistory: [],
                excludeFromResources: true,
            });
            meds.push(newMed);
            added += 1;
            addedNames.push(medTpl.genericName || 'Unknown');
        });
        await fetchInventory({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(meds),
        });
        pharmacyCache = meds;
        renderPharmacy(pharmacyCache);
        const summaryMsg = `Added ${added} item(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ''}.`;
        setStatus(summaryMsg);
        if (addedNames.length) {
            alert(`Added to inventory:\\n- ${addedNames.join('\\n- ')}`);
        }
    } catch (err) {
        setStatus(`Unable to add medicines: ${err.message}`, true);
    }
}

function handleWhoTileSelect(checkbox) {
    const tile = checkbox?.closest('label');
    if (!tile) return;
    const isChecked = !!checkbox.checked;
    tile.style.background = isChecked ? '#f1fff4' : '#fff';
    tile.style.borderColor = isChecked ? '#9fd7ac' : '#d9e5f7';
}

function daysUntil(dateStr) {
    const now = new Date();
    const target = new Date(dateStr);
    if (isNaN(target.getTime())) return 9999;
    const diff = target.getTime() - now.getTime();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function addPurchaseEntry(medId) {
    // Adds a fresh expiry row with new ph-id; values remain empty so validation can catch missing dates/qty.
    const container = document.getElementById(`ph-${medId}`);
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'purchase-row';
    row.dataset.medId = medId;
    const newPhId = uid('ph');
    row.dataset.phId = newPhId;
    row.style = 'border:1px solid #d9e5f7; padding:10px; border-radius:6px; margin-bottom:10px; background:#f5f9ff;';
    row.innerHTML = `
        <div style="display:grid; grid-template-columns: repeat(2, minmax(200px, 1fr)); gap:10px; align-items:center; margin-bottom:10px;">
            <div style="display:flex; align-items:center; gap:8px;">
                <span class="ph-notes-toggle" style="cursor:pointer; font-weight:800; color:var(--dark);" onclick="togglePurchaseNotes(this)">v</span>
                <input type="date" class="ph-date" style="padding:8px; font-size:14px; width:100%;" onchange="scheduleSaveMedication('${medId}')" title="Expiry Date">
            </div>
            <input type="number" class="ph-qty" placeholder="Qty" style="padding:8px; font-size:14px;" oninput="scheduleSaveMedication('${medId}')" title="Quantity tied to this expiry">
        </div>
        <div style="display:grid; grid-template-columns: repeat(2, minmax(200px, 1fr)); gap:10px; align-items:center; margin-bottom:10px;">
            <div>
                <label style="font-weight:700; font-size:12px;">Manufacturer</label>
                <input type="text" class="ph-manufacturer" placeholder="Manufacturer" style="padding:8px; font-size:14px; width:100%;" oninput="scheduleSaveMedication('${medId}')">
            </div>
            <div>
                <label style="font-weight:700; font-size:12px;">Batch / Lot Number</label>
                <input type="text" class="ph-batch" placeholder="Batch or Lot" style="padding:8px; font-size:14px; width:100%;" oninput="scheduleSaveMedication('${medId}')">
            </div>
        </div>
        <div class="ph-notes-container" style="margin-bottom:10px; display:block;">
            <textarea class="ph-notes" placeholder="Notes (batch/lot/location)" style="width:100%; padding:8px; min-height:60px; font-size:14px;" oninput="scheduleSaveMedication('${medId}')"></textarea>
        </div>
    `;
    container.appendChild(row);
    scheduleSaveMedication(medId);
}

// Persist a single medication after client-side validation. Pulls latest list to avoid
// editing stale data, performs optimistic UI update, then attempts save; on failure it
// reloads from server to keep UI consistent.
async function saveMedication(id, rerender = false) {
    const openMedIds = getOpenMedIds();
    const textHeights = getTextareaHeights();
    let data;
    try {
        data = await fetchInventory();
    } catch (err) {
        showToast(`Unable to load inventory before saving: ${err.message}`, true);
        return;
    }
    const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
    const med = meds.find((m) => m.id === id);
    if (!med) {
        showToast('Medication not found (stale view). Reloading...', true);
        return loadPharmacy();
    }
    // Duplicate guard stays client-side so the user gets immediate feedback before POST.
    const genericVal = (document.getElementById(`gn-${id}`)?.value || '').trim();
    const strengthVal = (document.getElementById(`str-${id}`)?.value || '').trim();
    const brandVal = (document.getElementById(`bn-${id}`)?.value || '').trim();
    const targetKey = canonicalMedKey(genericVal, brandVal, strengthVal, `${formVal} ${strengthVal}`.trim());
    const dup = meds.find((m) => {
        if (m.id === id) return false;
        return canonicalMedKey(m.genericName, m.brandName, m.strength, m.formStrength) === targetKey;
    });
    if (dup) {
        alert('A medication with the same Generic + Brand + Strength already exists. Please adjust to keep entries unique.');
        return;
    }
    med.genericName = document.getElementById(`gn-${id}`)?.value || '';
    med.brandName = document.getElementById(`bn-${id}`)?.value || '';
    med.form = document.getElementById(`form-${id}`)?.value || '';
    med.strength = document.getElementById(`str-${id}`)?.value || '';
    med.minThreshold = document.getElementById(`min-${id}`)?.value || '';
    med.unit = document.getElementById(`unit-${id}`)?.value || '';
    med.storageLocation = document.getElementById(`loc-${id}`)?.value || '';
    med.controlled = (document.getElementById(`ctrl-${id}`)?.value || 'false') === 'true';
    med.primaryIndication = document.getElementById(`ind-${id}`)?.value || '';
    med.allergyWarnings = document.getElementById(`alg-${id}`)?.value || '';
    med.standardDosage = document.getElementById(`dose-${id}`)?.value || '';
    med.excludeFromResources = !!document.getElementById(`exclude-${id}`)?.checked;
    const sortVal = document.getElementById(`sort-${id}`)?.value || '';
    const sortCustom = document.getElementById(`sort-custom-${id}`)?.value || '';
    med.sortCategory = sortVal === '__custom' ? sortCustom : sortVal || sortCustom || '';
    med.verified = !!document.getElementById(`ver-${id}`)?.checked;
    med.purchaseHistory = collectPurchaseEntries(id);
    med.formStrength = [med.form, med.strength].join(' ').trim();
    // Keep top-level manufacturer/batch in sync with first purchase entry for compatibility
    if (med.purchaseHistory.length) {
        const first = med.purchaseHistory[0];
        med.manufacturer = first.manufacturer || '';
        med.batchLot = first.batchLot || '';
    } else {
        med.manufacturer = '';
        med.batchLot = '';
    }

    // Optimistic rerender before saving to backend for instant UI feedback
    pharmacyCache = meds;
    if (rerender) {
        // Only rerender when layout/structure changes (reduces cursor jumps while typing).
        renderPharmacy(pharmacyCache, openMedIds, textHeights);
    }

    // Validate and persist with error handling; on failure, reload from server to avoid stale UI.
    const validation = validateMedication(med);
    if (!validation.ok) {
        showToast(validation.message, true);
        return;
    }
    try {
        await fetchInventory({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(meds),
        });
        showToast('Medication saved');
    } catch (err) {
        showToast(`Save failed: ${err.message}`, true);
        await loadPharmacy();
    }
}

// Basic client-side guardrails before hitting the backend.
function validateMedication(med) {
    // Keep this in sync with backend ensure_item_schema/_validate_expiry for consistent rejection reasons.
    if (!med.genericName || !med.genericName.trim()) {
        return { ok: false, message: 'Generic name is required.' };
    }
    const hasStrengthHint = /\d/.test(med.formStrength || med.form || '');
    // Allow strength embedded in the form field (e.g., "Tablet 500 mg"). If not present,
    // backfill a placeholder so legacy items without strength can still be saved/removed.
    if ((!med.strength || !med.strength.trim()) && !hasStrengthHint) {
        med.strength = med.strength || 'unspecified';
        med.formStrength = med.formStrength || (med.form ? `${med.form} ${med.strength}` : med.strength);
    }
    // Validate purchase entries for negative quantities / bad dates
    const badQty = (med.purchaseHistory || []).find((p) => {
        const q = Number(p.quantity);
        return p.quantity !== '' && (Number.isNaN(q) || q < 0);
    });
    if (badQty) {
        return { ok: false, message: 'Expiry rows must have non-negative numeric quantities.' };
    }
    const badDate = (med.purchaseHistory || []).find((p) => p.date && Number.isNaN(new Date(p.date).getTime()));
    if (badDate) {
        return { ok: false, message: 'Expiry rows must use a valid date (YYYY-MM-DD).' };
    }
    // Encourage at least one expiry entry; keep UI permissive but warn in the future if needed.
    return { ok: true };
}

function collectPurchaseEntries(medId) {
    const container = document.getElementById(`ph-${medId}`);
    if (!container) return [];
    // Serialize every row back into a stable structure; ids are preserved so backend upserts map correctly.
    return Array.from(container.querySelectorAll('.purchase-row')).map((row) => {
        const phId = row.dataset.phId || uid('ph');
        return {
            id: phId,
            date: row.querySelector('.ph-date')?.value || '',
            quantity: row.querySelector('.ph-qty')?.value || '',
            notes: row.querySelector('.ph-notes')?.value || '',
            manufacturer: row.querySelector('.ph-manufacturer')?.value || '',
            batchLot: row.querySelector('.ph-batch')?.value || '',
        };
    });
}

async function deleteMedication(id) {
    if (!confirm('Delete this medication from the inventory?')) return;
    const confirmText = prompt('Type DELETE to confirm:');
    if (confirmText !== 'DELETE') {
        alert('Deletion cancelled.');
        return;
    }
    try {
        const res = await fetch(`/api/data/inventory/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
            throw new Error(data.error || `Status ${res.status}`);
        }
        showToast('Medication deleted');
        await loadPharmacy();
    } catch (err) {
        console.error('[pharmacy] delete failed', err);
        showToast(`Unable to delete medication: ${err.message}`, true);
    }
}

async function deletePurchaseEntry(medId, phId) {
    const container = document.getElementById(`ph-${medId}`);
    if (!container) return;
    const rows = Array.from(container.querySelectorAll('.purchase-row'));
    if (!rows.length) return;
    const target = phId ? rows.find((r) => r.dataset.phId === phId) : rows[rows.length - 1];
    if (!target) return;
    const proceed = confirm('Delete this expiry entry?');
    if (!proceed) return;
    if (rows.length === 1) {
        // Keep a single empty row for UX; clear instead of remove.
        target.querySelector('.ph-date').value = '';
        target.querySelector('.ph-qty').value = '';
        target.querySelector('.ph-notes').value = '';
        const manu = target.querySelector('.ph-manufacturer');
        const batch = target.querySelector('.ph-batch');
        if (manu) manu.value = '';
        if (batch) batch.value = '';
    } else {
        target.remove();
    }
    await saveMedication(medId);
}

async function addMedication() {
    let data;
    try {
        data = await fetchInventory();
    } catch (err) {
        return showToast(`Unable to load inventory: ${err.message}`, true);
    }
    const meds = Array.isArray(data) ? data : [];
    const newId = uid('med');
    const placeholderName = `New medicine ${newId.slice(-6)}`;
    meds.push(
        ensurePharmacyDefaults({
            id: newId,
            genericName: placeholderName,
            strength: '',
            purchaseHistory: [],
            verified: false,
        })
    );
    try {
        await fetchInventory({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(meds),
        });
        showToast('Draft medication added — please fill required fields.');
        loadPharmacy();
    } catch (err) {
        showToast(`Unable to add medication: ${err.message}`, true);
    }
}

// Expose for inline handlers
window.loadPharmacy = loadPharmacy;
window.addMedication = addMedication;
window.saveMedication = saveMedication;
window.deleteMedication = deleteMedication;
window.addPurchaseEntry = addPurchaseEntry;
window.scheduleSaveMedication = scheduleSaveMedication;
window.refreshPharmacyLabelsFromSettings = refreshPharmacyLabelsFromSettings;
window.sortPharmacyList = function(mode) {
    const openMedIds = getOpenMedIds();
    const textHeights = getTextareaHeights();
    renderPharmacy(pharmacyCache, openMedIds, textHeights);
};
window.toggleMedDetails = function(el) {
    const body = el.nextElementSibling;
    const icon = el.querySelector('.detail-icon');
    const isExpanded = body && body.style.display === 'block';
    if (body) body.style.display = isExpanded ? 'none' : 'block';
    if (icon) icon.textContent = isExpanded ? '>' : 'v';
};
window.deletePurchaseEntry = deletePurchaseEntry;
window.togglePurchaseNotes = function(el) {
    const row = el.closest('.purchase-row');
    if (!row) return;
    const notes = row.querySelector('.ph-notes-container');
    if (!notes) return;
    const isHidden = notes.style.display === 'none';
    notes.style.display = isHidden ? 'block' : 'none';
    el.textContent = isHidden ? 'v' : '>';
};
window.addWhoMeds = addWhoMeds;
window.openWhoListFilePicker = openWhoListFilePicker;
window.handleWhoListFileImport = handleWhoListFileImport;
