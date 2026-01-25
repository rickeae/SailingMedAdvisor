// Pharmacy inventory management

let pharmacyCache = [];
const pharmacySaveTimers = {};
let WHO_RECOMMENDED_MEDS = [
    {
        id: 'who-1',
        genericName: 'Amoxicillin',
        alsoKnownAs: 'Trimox, Amoxil',
        formStrength: 'Capsule, 500 mg',
        indications: 'Broad-spectrum antibiotic for common infections on board',
        contraindications: 'Penicillin allergy',
        consultDoctor: 'If severe infection or allergy history',
        adultDosage: '500 mg every 8 hours for 5–7 days (per infection protocol)',
        unwantedEffects: 'Rash, diarrhoea',
        remarks: 'First-line oral antibiotic',
    },
    {
        id: 'who-2',
        genericName: 'Ciprofloxacin',
        alsoKnownAs: 'Cipro',
        formStrength: 'Tablet, 500 mg',
        indications: 'GI/urinary infections when culture not available',
        contraindications: 'Pregnancy, tendon disorders',
        consultDoctor: 'If QT risk or major comorbidities',
        adultDosage: '500 mg every 12 hours',
        unwantedEffects: 'Nausea, tendon pain',
        remarks: 'Reserve for indicated cases',
    },
    {
        id: 'who-3',
        genericName: 'Paracetamol',
        alsoKnownAs: 'Acetaminophen',
        formStrength: 'Tablet, 500 mg',
        indications: 'Pain, fever',
        contraindications: 'Severe liver disease',
        consultDoctor: 'If fever >48h or hepatic disease',
        adultDosage: '500–1000 mg every 6–8 hours (max 4 g/day)',
        unwantedEffects: 'Rare at normal dose; hepatic injury if overdosed',
        remarks: 'Preferred first-line analgesic/antipyretic',
    },
    {
        id: 'who-4',
        genericName: 'Ibuprofen',
        alsoKnownAs: 'Advil, Nurofen',
        formStrength: 'Tablet, 400 mg',
        indications: 'Pain, inflammation',
        contraindications: 'Peptic ulcer, renal impairment',
        consultDoctor: 'If renal disease or anticoagulants',
        adultDosage: '400 mg every 6–8 hours with food',
        unwantedEffects: 'GI upset, renal stress',
        remarks: 'Use with food; avoid prolonged use',
    },
    {
        id: 'who-5',
        genericName: 'Salbutamol',
        alsoKnownAs: 'Albuterol',
        formStrength: 'Inhaler, 100 mcg per dose',
        indications: 'Bronchospasm/asthma',
        contraindications: 'Severe tachyarrhythmia',
        consultDoctor: 'If no relief after 2–3 doses',
        adultDosage: '1–2 puffs every 4–6 hours as needed',
        unwantedEffects: 'Tremor, tachycardia',
        remarks: 'Ensure spacer use if available',
    },
];

function workspaceHeaders(extra = {}) {
    const label = (window.WORKSPACE_LABEL || localStorage.getItem('workspace_label') || '').trim();
    const headers = { ...extra };
    if (label) {
        headers['x-workspace'] = label;
        headers['x-workspace-slug'] = label;
    }
    return headers;
}

function fetchInventory(options = {}) {
    const headers = workspaceHeaders(options.headers || {});
    return fetch('/api/data/inventory', { credentials: 'same-origin', ...options, headers });
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

function ensurePurchaseDefaults(p) {
    return {
        id: p.id || `ph-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        date: p.date || '',
        quantity: p.quantity || '',
        notes: p.notes || '',
        photos: Array.isArray(p.photos) ? p.photos : [],
    };
}

function ensurePharmacyDefaults(item) {
    return {
        id: item.id || `med-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        genericName: item.genericName || '',
        brandName: item.brandName || '',
        form: item.form || '',
        strength: item.strength || '',
        currentQuantity: item.currentQuantity || '',
        minThreshold: item.minThreshold || '',
        unit: item.unit || '',
        storageLocation: item.storageLocation || '',
        expiryDate: item.expiryDate || '',
        batchLot: item.batchLot || '',
        controlled: !!item.controlled,
        manufacturer: item.manufacturer || '',
        primaryIndication: item.primaryIndication || '',
        allergyWarnings: item.allergyWarnings || '',
        standardDosage: item.standardDosage || '',
        photos: Array.isArray(item.photos) ? item.photos : [],
        purchaseHistory: Array.isArray(item.purchaseHistory)
            ? item.purchaseHistory.map(ensurePurchaseDefaults)
            : [ensurePurchaseDefaults({})],
        source: item.source || '',
        photoImported: !!item.photoImported,
        excludeFromResources: Boolean(item.excludeFromResources),
    };
}

function scheduleSaveMedication(id) {
    if (pharmacySaveTimers[id]) {
        clearTimeout(pharmacySaveTimers[id]);
    }
    pharmacySaveTimers[id] = setTimeout(() => {
        saveMedication(id);
    }, 400);
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
    return `${primary}${showBrand ? ' — ' + brand : ''}`;
}

function sortPharmacyItems(items) {
    const list = Array.isArray(items) ? [...items] : [];
    const sortSel = document.getElementById('pharmacy-sort');
    const mode = (sortSel && sortSel.value) || 'generic';
    const byText = (a, b, pathA, pathB) => {
        const va = (pathA || '').toLowerCase();
        const vb = (pathB || '').toLowerCase();
        return va.localeCompare(vb);
    };
    list.sort((a, b) => {
        if (mode === 'brand') {
            return byText(a, b, a.brandName || '', b.brandName || '');
        }
        if (mode === 'strength') {
            return byText(a, b, a.strength || '', b.strength || '');
        }
        if (mode === 'expiry') {
            return byText(a, b, a.expiryDate || '', b.expiryDate || '');
        }
        // default generic
        return byText(a, b, a.genericName || a.brandName || '', b.genericName || b.brandName || '');
    });
    return list;
}

async function loadPharmacy() {
    const list = document.getElementById('pharmacy-list');
    if (!list) return;
    observePharmacyList();
    list.innerHTML = '<div style="color:#666;">Loading inventory...</div>';
    try {
        const res = await fetchInventory();
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
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
    const cards = sorted.map((m) => renderMedicationCard(m, openIds.includes(m.id), textHeights)).join('');
    list.innerHTML = cards;
    // After HTML render, verify count matches actual cards
    syncPharmacyCountFromDOM();
    setTimeout(syncPharmacyCountFromDOM, 50);
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => syncPharmacyCountFromDOM());
    }
}

function renderPurchaseRows(med) {
    const rows = med.purchaseHistory.length ? med.purchaseHistory : [ensurePurchaseDefaults({})];
    return rows
        .map((p) => {
            const photos = (p.photos || []).map(
                (src, idx) => `
                    <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start; border:1px solid #e0e0e0; padding:6px; border-radius:4px; background:#f9fbff;">
                        <div style="font-size:12px; font-weight:600;">Photo ${idx + 1}</div>
                        <img src="${src}" alt="Photo ${idx + 1}" style="max-width:120px; max-height:120px; border:1px solid #ccc; border-radius:4px; cursor:pointer;" onclick="window.open('${src}','_blank')">
                        <button class="btn btn-sm" style="background:var(--red);" onclick="removePurchasePhoto('${med.id}', '${p.id}', ${idx}); return false;">🗑 Delete</button>
                    </div>`
            );
            return `
                <div class="purchase-row" data-med-id="${med.id}" data-ph-id="${p.id || ''}" style="border:1px solid #d9e5f7; padding:10px; border-radius:6px; margin-bottom:10px; background:#f5f9ff;">
                <div style="display:grid; grid-template-columns: repeat(2, minmax(200px, 1fr)); gap:10px; align-items:center; margin-bottom:10px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="ph-notes-toggle" style="cursor:pointer; font-weight:800; color:var(--dark);" onclick="togglePurchaseNotes(this)">▾</span>
                        <input type="date" class="ph-date" value="${p.date || ''}" style="padding:8px; font-size:14px; width:100%;" onchange="scheduleSaveMedication('${med.id}')" title="Expiry Date">
                    </div>
                    <input type="number" class="ph-qty" value="${p.quantity || ''}" placeholder="Qty" style="padding:8px; font-size:14px;" oninput="scheduleSaveMedication('${med.id}')" title="Quantity tied to this expiry">
                </div>
                <div class="ph-notes-container" style="margin-bottom:10px; display:block;">
                    <textarea class="ph-notes" placeholder="Notes (batch/lot/location)" style="width:100%; padding:8px; min-height:60px; font-size:14px;" oninput="scheduleSaveMedication('${med.id}')">${p.notes || ''}</textarea>
                </div>
                <div class="ph-photos-container" style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-start; margin-top:6px;">
                    ${photos.join('')}
                    <div>
                        <label style="font-size:12px; font-weight:700; display:block; margin-bottom:4px;">Add Photo</label>
                        <input type="file" accept="image/*" onchange="uploadPurchasePhoto('${med.id}', '${p.id}')" style="font-size:12px;">
                    </div>
                </div>
                <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
                    <button class="btn btn-sm" style="background:var(--red);" onclick="deletePurchaseEntry('${med.id}')">Delete Expiry Entry</button>
                </div>
            </div>`;
        })
        .join('');
}

function renderMedicationCard(med, isOpen = true, textHeights = {}) {
    const lowStock = med.minThreshold && Number(med.currentQuantity) <= Number(med.minThreshold);
    const expirySoon = med.expiryDate && daysUntil(med.expiryDate) <= 60;
    const expiryText = med.expiryDate ? `Exp: ${med.expiryDate}` : 'No expiry set';
    const headerNote = [lowStock ? 'Low Stock' : null, expirySoon ? 'Expiring Soon' : null].filter(Boolean).join(' · ');
    const displayName = getMedicationDisplayName(med);
    const strength = (med.strength || '').trim();
    const bodyDisplay = isOpen ? 'display:block;' : 'display:none;';
    const arrow = isOpen ? '▾' : '▸';
    const headerBg = med.excludeFromResources ? '#ffecef' : '#eef7ff';
    const headerBorderColor = med.excludeFromResources ? '#ffcfe0' : '#c7ddff';
    const bodyBg = med.excludeFromResources ? '#fff6f6' : '#f7fff7';
    const bodyBorderColor = med.excludeFromResources ? '#ffcfd0' : '#cfe9d5';
    const badgeColor = med.excludeFromResources ? '#d32f2f' : '#2e7d32';
    const badgeText = med.excludeFromResources ? 'Resource Currently Unavailable' : 'Resource Available';
    const availabilityBadge = `<span style="margin-left:auto; padding:2px 10px; border-radius:999px; background:${badgeColor}; color:#fff; font-size:11px; white-space:nowrap;">${badgeText}</span>`;
    const doseHeight = textHeights[`dose-${med.id}`] ? `height:${textHeights[`dose-${med.id}`]};` : '';
    const photoThumbs = (med.photos || []).map(
        (src, idx) => `
            <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start; border:1px solid #e0e0e0; padding:6px; border-radius:4px; background:#f9fbff;">
                <div style="font-size:12px; font-weight:600;">Photo ${idx + 1}</div>
                <img src="${src}" alt="Photo ${idx + 1}" style="max-width:120px; max-height:120px; border:1px solid #ccc; border-radius:4px; cursor:pointer;" onclick="window.open('${src}','_blank')">
                <button class="btn btn-sm" style="background:var(--red);" onclick="removeMedicationPhoto('${med.id}', ${idx}); return false;">🗑 Delete</button>
            </div>`
    );
    return `
            <div class="collapsible history-item">
        <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; align-items:center; background:${headerBg}; border:1px solid ${headerBorderColor}; padding:8px 12px;">
            <span class="dev-tag">dev:med-card</span>
            <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">${arrow}</span>
            <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:700;">
                ${displayName}${strength ? ' — ' + strength : ''}
            </span>
            ${headerNote ? `<span class="sidebar-pill" style="margin-right:8px; background:${lowStock ? '#ffebee' : '#fff7e0'}; color:${lowStock ? '#c62828' : '#b26a00'};">${headerNote}</span>` : ''}
            <button onclick="event.stopPropagation(); deleteMedication('${med.id}')" class="btn btn-sm history-action-btn" style="background:var(--red); visibility:hidden;">🗑 Delete Medication</button>
            ${availabilityBadge}
        </div>
        <div class="col-body" data-med-id="${med.id}" style="padding:12px; background:${bodyBg}; border:1px solid ${bodyBorderColor}; border-radius:6px; ${bodyDisplay}">
            <div class="collapsible" style="margin-bottom:10px;">
                <div class="col-header crew-med-header" onclick="toggleMedDetails(this)" style="background:#fff; justify-content:flex-start; align-items:center;">
                    <span class="dev-tag">dev:med-details</span>
                    <span class="detail-icon history-arrow" style="font-size:16px; margin-right:8px;">▾</span>
                    <span style="font-weight:700;">Medication Details</span>
                </div>
            <div class="col-body" style="padding:10px; display:block;" id="details-${med.id}">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                    <input id="exclude-${med.id}" type="checkbox" ${med.excludeFromResources ? 'checked' : ''} onchange="scheduleSaveMedication('${med.id}')">
                    <label style="font-size:12px; line-height:1.2; margin:0;">Resource Currently Unavailable</label>
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
                                <label style="font-weight:700; font-size:12px;">Current Quantity</label>
                                <input id="qty-${med.id}" type="number" value="${med.currentQuantity}" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                            </div>
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
                            <label style="font-weight:700; font-size:12px;">Expiry Date</label>
                            <input id="exp-${med.id}" type="date" value="${med.expiryDate}" style="width:100%; padding:8px;" onchange="scheduleSaveMedication('${med.id}')">
                            <div style="font-size:11px; color:${expirySoon ? '#c62828' : '#555'};">${expiryText}${expirySoon ? ' (within 60 days)' : ''}</div>
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Batch/Lot Number</label>
                            <input id="batch-${med.id}" type="text" value="${med.batchLot}" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Controlled Substance?</label>
                            <select id="ctrl-${med.id}" style="width:100%; padding:8px;" onchange="scheduleSaveMedication('${med.id}')">
                                <option value="false" ${!med.controlled ? 'selected' : ''}>No</option>
                                <option value="true" ${med.controlled ? 'selected' : ''}>Yes</option>
                            </select>
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Manufacturer</label>
                            <input id="manu-${med.id}" type="text" value="${med.manufacturer}" style="width:100%; padding:8px;" oninput="scheduleSaveMedication('${med.id}')">
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
                    <div style="margin:10px 0; border-top:1px solid #d0dff5; padding-top:10px;">
                        <div style="display:flex; gap:8px; align-items:center; font-weight:800; color:var(--dark); margin-bottom:6px;">
                            <span>Medicine Photos</span>
                            <span class="dev-tag">dev:med-photos</span>
                        </div>
                        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-start;">
                            ${photoThumbs.length ? photoThumbs.join('') : '<div style="font-size:12px; color:#666;">No photos linked.</div>'}
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
                    <button class="btn btn-sm" style="background:var(--inquiry);" onclick="addPurchaseEntry('${med.id}')">+ Add Entry</button>
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
            <label style="display:flex; gap:10px; align-items:flex-start; border:1px solid #d9e5f7; padding:10px; border-radius:8px; background:#fff;">
                <input type="checkbox" name="who-med-check" value="${id}" style="margin-top:4px;">
                <div>
                    <div style="font-weight:800; color:#1f2d3d;">${m.genericName}</div>
                    ${m.alsoKnownAs ? `<div style="font-size:12px; color:#37474f;">Also known as: ${m.alsoKnownAs}</div>` : ''}
                    ${m.formStrength ? `<div style="font-size:12px; color:#455a64;">Dosage form/strength: ${m.formStrength}</div>` : ''}
                    ${m.indications ? `<div style="font-size:12px; color:#455a64;">Indications: ${m.indications}</div>` : ''}
                    ${m.contraindications ? `<div style="font-size:12px; color:#b23b3b;">Contraindications: ${m.contraindications}</div>` : ''}
                    ${m.consultDoctor ? `<div style="font-size:12px; color:#6a1b9a;">Consult doctor: ${m.consultDoctor}</div>` : ''}
                    ${m.adultDosage ? `<div style="font-size:12px; color:#455a64;">Adult dosage: ${m.adultDosage}</div>` : ''}
                    ${m.unwantedEffects ? `<div style="font-size:12px; color:#b23b3b;">Unwanted effects: ${m.unwantedEffects}</div>` : ''}
                    ${m.remarks ? `<div style="font-size:12px; color:#455a64;">Remarks: ${m.remarks}</div>` : ''}
                </div>
            </label>
        `;
    }).join('') || '<div style="color:#666;">WHO list unavailable.</div>';
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

async function addWhoMeds() {
    const statusEl = document.getElementById('who-med-status');
    const setStatus = (msg, isErr = false) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.style.color = isErr ? 'var(--red)' : '#1f2d3d';
    };
    const checked = Array.from(document.querySelectorAll('input[name="who-med-check"]:checked'));
    if (!checked.length) {
        setStatus('Select one or more medicines to copy.', true);
        return;
    }
    try {
        const data = await (await fetchInventory()).json();
        const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
        let added = 0;
        let skipped = 0;
        checked.forEach((input, idx) => {
            const medTpl = WHO_RECOMMENDED_MEDS.find((m) => `who-${m.id || idx}` === input.value);
            if (!medTpl) return;
            const dup = meds.find(
                (m) =>
                    (m.genericName || '').trim().toLowerCase() === (medTpl.genericName || '').trim().toLowerCase() &&
                    (m.strength || '').trim().toLowerCase() === (medTpl.formStrength || '').trim().toLowerCase()
            );
            if (dup) {
                skipped += 1;
                return;
            }
            const newMed = ensurePharmacyDefaults({
                id: `med-who-${Date.now()}-${idx}`,
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
                notes: medTpl.remarks || medTpl.consultDoctor || 'WHO ship list import',
                source: 'who_recommended',
                photoImported: false,
                purchaseHistory: [],
                excludeFromResources: true,
            });
            meds.push(newMed);
            added += 1;
        });
        await fetchInventory({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(meds),
        });
        pharmacyCache = meds;
        renderPharmacy(pharmacyCache);
        setStatus(`Added ${added} item(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ''}.`);
    } catch (err) {
        setStatus(`Unable to add medicines: ${err.message}`, true);
    }
}

function daysUntil(dateStr) {
    const now = new Date();
    const target = new Date(dateStr);
    if (isNaN(target.getTime())) return 9999;
    const diff = target.getTime() - now.getTime();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function addPurchaseEntry(medId) {
    const container = document.getElementById(`ph-${medId}`);
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'purchase-row';
    row.dataset.medId = medId;
    const newPhId = `ph-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    row.dataset.phId = newPhId;
    row.style = 'border:1px solid #d9e5f7; padding:10px; border-radius:6px; margin-bottom:10px; background:#f5f9ff;';
    row.innerHTML = `
        <div style="display:grid; grid-template-columns: repeat(2, minmax(200px, 1fr)); gap:10px; align-items:center; margin-bottom:10px;">
            <div style="display:flex; align-items:center; gap:8px;">
                <span class="ph-notes-toggle" style="cursor:pointer; font-weight:800; color:var(--dark);" onclick="togglePurchaseNotes(this)">▾</span>
                <input type="date" class="ph-date" style="padding:8px; font-size:14px; width:100%;" onchange="scheduleSaveMedication('${medId}')" title="Expiry Date">
            </div>
            <input type="number" class="ph-qty" placeholder="Qty" style="padding:8px; font-size:14px;" oninput="scheduleSaveMedication('${medId}')" title="Quantity tied to this expiry">
        </div>
        <div class="ph-notes-container" style="margin-bottom:10px; display:block;">
            <textarea class="ph-notes" placeholder="Notes (batch/lot/location)" style="width:100%; padding:8px; min-height:60px; font-size:14px;" oninput="scheduleSaveMedication('${medId}')"></textarea>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-start;">
            <div>
                <label style="font-size:12px; font-weight:700; display:block; margin-bottom:4px;">Add Photo</label>
                <button class="btn btn-sm" style="background:var(--dark);" onclick="uploadPurchasePhoto('${medId}', '${newPhId}')">Upload Photo</button>
            </div>
        </div>
    `;
    container.appendChild(row);
    scheduleSaveMedication(medId);
}

async function saveMedication(id) {
    const openMedIds = getOpenMedIds();
    const textHeights = getTextareaHeights();
    const data = await (await fetchInventory()).json();
    const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
    const med = meds.find((m) => m.id === id);
    if (!med) return alert('Medication not found');
    const genericVal = (document.getElementById(`gn-${id}`)?.value || '').trim();
    const strengthVal = (document.getElementById(`str-${id}`)?.value || '').trim();
    const dup = meds.find((m) => m.id !== id && (m.genericName || '').trim().toLowerCase() === genericVal.toLowerCase() && (m.strength || '').trim().toLowerCase() === strengthVal.toLowerCase());
    if (dup) {
        alert('A medication with the same generic name and strength already exists. Please adjust to keep entries unique.');
        return;
    }
    med.genericName = document.getElementById(`gn-${id}`)?.value || '';
    med.brandName = document.getElementById(`bn-${id}`)?.value || '';
    med.form = document.getElementById(`form-${id}`)?.value || '';
    med.strength = document.getElementById(`str-${id}`)?.value || '';
    med.currentQuantity = document.getElementById(`qty-${id}`)?.value || '';
    med.minThreshold = document.getElementById(`min-${id}`)?.value || '';
    med.unit = document.getElementById(`unit-${id}`)?.value || '';
    med.storageLocation = document.getElementById(`loc-${id}`)?.value || '';
    med.expiryDate = document.getElementById(`exp-${id}`)?.value || '';
    med.batchLot = document.getElementById(`batch-${id}`)?.value || '';
    med.controlled = (document.getElementById(`ctrl-${id}`)?.value || 'false') === 'true';
    med.manufacturer = document.getElementById(`manu-${id}`)?.value || '';
    med.primaryIndication = document.getElementById(`ind-${id}`)?.value || '';
    med.allergyWarnings = document.getElementById(`alg-${id}`)?.value || '';
    med.standardDosage = document.getElementById(`dose-${id}`)?.value || '';
    med.excludeFromResources = !!document.getElementById(`exclude-${id}`)?.checked;
    med.purchaseHistory = collectPurchaseEntries(id);

    await fetchInventory({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meds),
    });
    pharmacyCache = meds;
    renderPharmacy(pharmacyCache, openMedIds, textHeights);
}

function collectPurchaseEntries(medId) {
    const container = document.getElementById(`ph-${medId}`);
    if (!container) return [];
    return Array.from(container.querySelectorAll('.purchase-row')).map((row) => {
        const phId = row.dataset.phId || `ph-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        // Preserve photos from cache if present
        const med = pharmacyCache.find((m) => m.id === container.id.replace('ph-', ''));
        const existing = (med?.purchaseHistory || []).find((p) => p.id === phId);
        return {
            id: phId,
            date: row.querySelector('.ph-date')?.value || '',
            quantity: row.querySelector('.ph-qty')?.value || '',
            notes: row.querySelector('.ph-notes')?.value || '',
            photos: existing && Array.isArray(existing.photos) ? existing.photos : [],
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
    const data = await (await fetchInventory()).json();
    const meds = Array.isArray(data) ? data : [];
    const filtered = meds.filter((m) => m.id !== id);
    await fetchInventory({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filtered),
    });
    loadPharmacy();
}

async function deletePurchaseEntry(medId) {
    const container = document.getElementById(`ph-${medId}`);
    if (!container) return;
    const rows = Array.from(container.querySelectorAll('.purchase-row'));
    if (rows.length === 0) return;
    const proceed = confirm('Delete the most recent expiry entry?');
    if (!proceed) return;
    if (rows.length === 1) {
        // Clear fields if only one row
        rows[0].querySelector('.ph-date').value = '';
        rows[0].querySelector('.ph-qty').value = '';
        rows[0].querySelector('.ph-notes').value = '';
        // Clear photos
        const phId = rows[0].dataset.phId;
        if (phId) {
            const med = pharmacyCache.find((m) => m.id === medId);
            if (med) {
                const ph = med.purchaseHistory.find((p) => p.id === phId);
                if (ph) ph.photos = [];
            }
        }
    } else {
        rows[rows.length - 1].remove();
    }
    await saveMedication(medId);
}

async function addMedication() {
    const data = await (await fetchInventory()).json();
    const meds = Array.isArray(data) ? data : [];
    const emptyName = 'Medication';
    const dup = meds.find((m) => (m.genericName || '').trim().toLowerCase() === emptyName.toLowerCase());
    if (dup) {
        alert('Please edit the existing placeholder medication before adding another blank entry (duplicate Medication).');
        return;
    }
    meds.push(ensurePharmacyDefaults({ id: `med-${Date.now()}` }));
    await fetchInventory({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meds),
    });
    loadPharmacy();
}

function uploadPurchasePhoto(medId, phId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            alert('File must be under 5MB');
            return;
        }
        const reader = new FileReader();
        reader.onload = async (e) => {
            const base64 = e.target.result;
            const data = await (await fetchInventory()).json();
            const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
            const med = meds.find((m) => m.id === medId);
            if (!med) return alert('Medication not found');
            const ph = med.purchaseHistory.find((p) => p.id === phId) || ensurePurchaseDefaults({ id: phId });
            ph.photos = ph.photos || [];
            ph.photos.push(base64);
            if (!med.purchaseHistory.find((p) => p.id === phId)) {
                med.purchaseHistory.push(ph);
            }
            await fetchInventory({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(meds),
            });
            loadPharmacy();
        };
        reader.readAsDataURL(file);
    };
    input.click();
}

async function removePurchasePhoto(medId, phId, idx) {
    const data = await (await fetchInventory()).json();
    const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
    const med = meds.find((m) => m.id === medId);
    if (!med) return;
    const ph = med.purchaseHistory.find((p) => p.id === phId);
    if (!ph) return;
    ph.photos = (ph.photos || []).filter((_, i) => i !== idx);
    await fetchInventory({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meds),
    });
    loadPharmacy();
}

async function removeMedicationPhoto(medId, idx) {
    const data = await (await fetchInventory()).json();
    const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
    const med = meds.find((m) => m.id === medId);
    if (!med) return;
    med.photos = (med.photos || []).filter((_, i) => i !== idx);
    await fetchInventory({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meds),
    });
    loadPharmacy();
}

// Expose for inline handlers
window.loadPharmacy = loadPharmacy;
window.addMedication = addMedication;
window.saveMedication = saveMedication;
window.deleteMedication = deleteMedication;
window.addPurchaseEntry = addPurchaseEntry;
window.uploadPurchasePhoto = uploadPurchasePhoto;
window.removePurchasePhoto = removePurchasePhoto;
window.removeMedicationPhoto = removeMedicationPhoto;
window.scheduleSaveMedication = scheduleSaveMedication;
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
    if (icon) icon.textContent = isExpanded ? '▸' : '▾';
};
window.deletePurchaseEntry = deletePurchaseEntry;
window.togglePurchaseNotes = function(el) {
    const row = el.closest('.purchase-row');
    if (!row) return;
    const notes = row.querySelector('.ph-notes-container');
    const photos = row.querySelector('.ph-photos-container');
    if (!notes) return;
    const isHidden = notes.style.display === 'none';
    notes.style.display = isHidden ? 'block' : 'none';
    if (photos) photos.style.display = isHidden ? 'flex' : 'none';
    el.textContent = isHidden ? '▾' : '▸';
};
window.addWhoMeds = addWhoMeds;
window.openWhoListFilePicker = openWhoListFilePicker;
window.handleWhoListFileImport = handleWhoListFileImport;
