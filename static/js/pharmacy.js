// Pharmacy inventory management

let pharmacyCache = [];
const pharmacySaveTimers = {};

function ensurePurchaseDefaults(p) {
    return {
        id: p.id || `ph-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        date: p.date || '',
        quantity: p.quantity || '',
        price: p.price || '',
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

async function loadPharmacy() {
    const list = document.getElementById('pharmacy-list');
    if (!list) return;
    list.innerHTML = '<div style="color:#666;">Loading inventory...</div>';
    try {
        const res = await fetch('/api/data/inventory', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        pharmacyCache = (Array.isArray(data) ? data : []).map(ensurePharmacyDefaults);
        renderPharmacy(pharmacyCache);
    } catch (err) {
        list.innerHTML = `<div style="color:red;">Error loading inventory: ${err.message}</div>`;
    }
}

function renderPharmacy(items) {
    const list = document.getElementById('pharmacy-list');
    if (!list) return;
    if (!items || items.length === 0) {
        list.innerHTML = '<div style="color:#666; padding:12px;">No medications logged. Add your first item.</div>';
        return;
    }
    const cards = items.map(renderMedicationCard).join('');
    list.innerHTML = cards;
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
                <div style="display:grid; grid-template-columns: repeat(3, minmax(200px, 1fr)); gap:10px; align-items:center; margin-bottom:10px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="ph-notes-toggle" style="cursor:pointer; font-weight:800; color:var(--dark);" onclick="togglePurchaseNotes(this)">▾</span>
                        <input type="date" class="ph-date" value="${p.date || ''}" style="padding:8px; font-size:14px; width:100%;" onchange="scheduleSaveMedication('${med.id}')">
                    </div>
                    <input type="number" class="ph-qty" value="${p.quantity || ''}" placeholder="Qty" style="padding:8px; font-size:14px;" oninput="scheduleSaveMedication('${med.id}')">
                    <input type="text" class="ph-price" value="${p.price || ''}" placeholder="Price" style="padding:8px; font-size:14px;" oninput="scheduleSaveMedication('${med.id}')">
                </div>
                <div class="ph-notes-container" style="margin-bottom:10px; display:block;">
                    <textarea class="ph-notes" placeholder="Notes/Vendor" style="width:100%; padding:8px; min-height:60px; font-size:14px;" oninput="scheduleSaveMedication('${med.id}')">${p.notes || ''}</textarea>
                </div>
                <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-start;">
                    ${photos.join('')}
                    <div>
                        <label style="font-size:12px; font-weight:700; display:block; margin-bottom:4px;">Add Photo</label>
                        <input type="file" accept="image/*" onchange="uploadPurchasePhoto('${med.id}', '${p.id}')" style="font-size:12px;">
                    </div>
                </div>
            </div>`;
        })
        .join('');
}

function renderMedicationCard(med) {
    const lowStock = med.minThreshold && Number(med.currentQuantity) <= Number(med.minThreshold);
    const expirySoon = med.expiryDate && daysUntil(med.expiryDate) <= 60;
    const expiryText = med.expiryDate ? `Exp: ${med.expiryDate}` : 'No expiry set';
    const headerNote = [lowStock ? 'Low Stock' : null, expirySoon ? 'Expiring Soon' : null].filter(Boolean).join(' · ');
    const displayName = getMedicationDisplayName(med);
    const strength = (med.strength || '').trim();
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
        <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; align-items:center;">
            <span class="dev-tag">dev:med-card</span>
            <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">▸</span>
            <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:700;">
                ${displayName}${strength ? ' — ' + strength : ''}
            </span>
            ${headerNote ? `<span class="sidebar-pill" style="margin-right:8px; background:${lowStock ? '#ffebee' : '#fff7e0'}; color:${lowStock ? '#c62828' : '#b26a00'};">${headerNote}</span>` : ''}
            <button onclick="event.stopPropagation(); deleteMedication('${med.id}')" class="btn btn-sm history-action-btn" style="background:var(--red); visibility:hidden;">🗑 Delete Medication</button>
        </div>
        <div class="col-body" style="padding:12px; background:#e8f4ff; border:1px solid #c7ddff; border-radius:6px;">
            <div class="collapsible" style="margin-bottom:10px;">
                <div class="col-header crew-med-header" onclick="toggleMedDetails(this)" style="background:#fff; justify-content:flex-start; align-items:center;">
                    <span class="dev-tag">dev:med-details</span>
                    <span class="detail-icon history-arrow" style="font-size:16px; margin-right:8px;">▾</span>
                    <span style="font-weight:700;">Medication Details</span>
                </div>
                <div class="col-body" style="padding:10px; display:block;" id="details-${med.id}">
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
                            <textarea id="dose-${med.id}" style="width:100%; padding:8px; min-height:60px;" oninput="scheduleSaveMedication('${med.id}')">${med.standardDosage || ''}</textarea>
                        </div>
                    </div>
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
            <div style="margin:10px 0; border-top:1px solid #d0dff5; padding-top:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; gap:8px;">
                    <div style="display:flex; align-items:center; gap:6px; font-weight:800; color:var(--dark);">
                        <span>Purchase History</span>
                        <span class="dev-tag">dev:med-purchase</span>
                    </div>
                    <button class="btn btn-sm" style="background:var(--inquiry);" onclick="addPurchaseEntry('${med.id}')">+ Add Purchase</button>
                </div>
                <div id="ph-${med.id}">${renderPurchaseRows(med)}</div>
            </div>
            <div style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;">
                <button class="btn btn-sm" style="background:var(--red);" onclick="deletePurchaseEntry('${med.id}')">Delete Medication Purchase</button>
            </div>
        </div>
    </div>`;
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
        <div style="display:grid; grid-template-columns: repeat(3, minmax(200px, 1fr)); gap:10px; align-items:center; margin-bottom:10px;">
            <div style="display:flex; align-items:center; gap:8px;">
                <span class="ph-notes-toggle" style="cursor:pointer; font-weight:800; color:var(--dark);" onclick="togglePurchaseNotes(this)">▾</span>
                <input type="date" class="ph-date" style="padding:8px; font-size:14px; width:100%;" onchange="scheduleSaveMedication('${medId}')">
            </div>
            <input type="number" class="ph-qty" placeholder="Qty" style="padding:8px; font-size:14px;" oninput="scheduleSaveMedication('${medId}')">
            <input type="text" class="ph-price" placeholder="Price" style="padding:8px; font-size:14px;" oninput="scheduleSaveMedication('${medId}')">
        </div>
        <div class="ph-notes-container" style="margin-bottom:10px; display:block;">
            <textarea class="ph-notes" placeholder="Notes/Vendor" style="width:100%; padding:8px; min-height:60px; font-size:14px;" oninput="scheduleSaveMedication('${medId}')"></textarea>
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
    const data = await (await fetch('/api/data/inventory', { credentials: 'same-origin' })).json();
    const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
    const med = meds.find((m) => m.id === id);
    if (!med) return alert('Medication not found');
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
    med.purchaseHistory = collectPurchaseEntries(id);

    await fetch('/api/data/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meds),
        credentials: 'same-origin',
    });
    loadPharmacy();
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
            price: row.querySelector('.ph-price')?.value || '',
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
    const data = await (await fetch('/api/data/inventory', { credentials: 'same-origin' })).json();
    const meds = Array.isArray(data) ? data : [];
    const filtered = meds.filter((m) => m.id !== id);
    await fetch('/api/data/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filtered),
        credentials: 'same-origin',
    });
    loadPharmacy();
}

async function deletePurchaseEntry(medId) {
    const container = document.getElementById(`ph-${medId}`);
    if (!container) return;
    const rows = Array.from(container.querySelectorAll('.purchase-row'));
    if (rows.length === 0) return;
    const proceed = confirm('Delete the most recent purchase entry?');
    if (!proceed) return;
    if (rows.length === 1) {
        // Clear fields if only one row
        rows[0].querySelector('.ph-date').value = '';
        rows[0].querySelector('.ph-qty').value = '';
        rows[0].querySelector('.ph-price').value = '';
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
    const data = await (await fetch('/api/data/inventory', { credentials: 'same-origin' })).json();
    const meds = Array.isArray(data) ? data : [];
    meds.push(ensurePharmacyDefaults({ id: `med-${Date.now()}` }));
    await fetch('/api/data/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meds),
        credentials: 'same-origin',
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
            const data = await (await fetch('/api/data/inventory', { credentials: 'same-origin' })).json();
            const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
            const med = meds.find((m) => m.id === medId);
            if (!med) return alert('Medication not found');
            const ph = med.purchaseHistory.find((p) => p.id === phId) || ensurePurchaseDefaults({ id: phId });
            ph.photos = ph.photos || [];
            ph.photos.push(base64);
            if (!med.purchaseHistory.find((p) => p.id === phId)) {
                med.purchaseHistory.push(ph);
            }
            await fetch('/api/data/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(meds),
                credentials: 'same-origin',
            });
            loadPharmacy();
        };
        reader.readAsDataURL(file);
    };
    input.click();
}

async function removePurchasePhoto(medId, phId, idx) {
    const data = await (await fetch('/api/data/inventory', { credentials: 'same-origin' })).json();
    const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
    const med = meds.find((m) => m.id === medId);
    if (!med) return;
    const ph = med.purchaseHistory.find((p) => p.id === phId);
    if (!ph) return;
    ph.photos = (ph.photos || []).filter((_, i) => i !== idx);
    await fetch('/api/data/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meds),
        credentials: 'same-origin',
    });
    loadPharmacy();
}

async function removeMedicationPhoto(medId, idx) {
    const data = await (await fetch('/api/data/inventory', { credentials: 'same-origin' })).json();
    const meds = Array.isArray(data) ? data.map(ensurePharmacyDefaults) : [];
    const med = meds.find((m) => m.id === medId);
    if (!med) return;
    med.photos = (med.photos || []).filter((_, i) => i !== idx);
    await fetch('/api/data/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meds),
        credentials: 'same-origin',
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
    if (!notes) return;
    const isHidden = notes.style.display === 'none';
    notes.style.display = isHidden ? 'block' : 'none';
    el.textContent = isHidden ? '▾' : '▸';
};
