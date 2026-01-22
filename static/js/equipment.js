// Equipment management for onboard medical gear

let equipmentCache = [];
let medPhotoQueue = [];
let medPhotoProcessing = false;
const equipmentSaveTimers = {};

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
    };
}

async function loadEquipment(expandId = null) {
    const list = document.getElementById('equipment-list');
    if (!list) return;
    list.innerHTML = '';
    try {
        const res = await fetch('/api/data/tools', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        equipmentCache = (Array.isArray(data) ? data : []).map(ensureEquipmentDefaults);
        renderEquipment(equipmentCache, expandId);
    } catch (err) {
        list.innerHTML = `<div style="color:red;">Error loading equipment: ${err.message}</div>`;
    }
}

function classifyEquipment(item) {
    const type = (item.type || '').toLowerCase();
    const category = (item.category || '').toLowerCase();
    if (type === 'medication' || category.includes('medication')) return 'medication';
    if (type === 'consumable') return 'consumable';
    return 'equipment';
}

async function loadMedPhotoQueue() {
    const container = document.getElementById('med-photo-queue');
    if (!container) return;
    container.innerHTML = '<div style="color:#666;">Loading photo queue...</div>';
    try {
        const res = await fetch('/api/medicines/queue', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        medPhotoQueue = Array.isArray(data.queue) ? data.queue : [];
        renderMedPhotoQueue();
    } catch (err) {
        container.innerHTML = `<div style="color:red;">Unable to load queue: ${err.message}</div>`;
    }
}

function renderMedPhotoQueue() {
    const container = document.getElementById('med-photo-queue');
    if (!container) return;
    if (!medPhotoQueue || medPhotoQueue.length === 0) {
        container.innerHTML = '<div style="color:#666; padding:8px; border:1px dashed #ccc; border-radius:6px;">Queue is empty. Add medicine photos to import into inventory.</div>';
        return;
    }
    container.innerHTML = medPhotoQueue.map(renderMedQueueCard).join('');
}

function renderMedQueueCard(item) {
    const statusColors = {
        queued: { bg: '#fff7e0', color: '#a66b00', label: 'Queued' },
        processing: { bg: '#e3f2fd', color: '#1565c0', label: 'Processing' },
        completed: { bg: '#e8f5e9', color: '#1b5e20', label: 'Completed' },
        failed: { bg: '#ffebee', color: '#c62828', label: 'Failed' },
    };
    const status = statusColors[item.status] || statusColors.queued;
    const summary = item.result || {};
    const detected = [summary.genericName, summary.brandName, summary.strength].filter(Boolean).join(' · ');
    const expiry = summary.expiryDate ? `Exp: ${summary.expiryDate}` : '';
    const indicator = detected || expiry ? `${detected}${detected && expiry ? ' — ' : ''}${expiry}` : '';
    const primary = indicator || 'Awaiting processing';
    const disableRun = medPhotoProcessing || item.status === 'processing';
    const runBtn =
        item.status === 'queued' || item.status === 'failed'
            ? `<button class="btn btn-sm" style="background:var(--inquiry);" onclick="processQueuedPhoto('${item.id}')" ${disableRun ? 'disabled' : ''}>Run with Qwen2.5-VL-7B</button>`
            : '';
    const viewLink = item.url
        ? `<button class="btn btn-sm" style="background:#444;" onclick="window.open('${item.url}', '_blank')">View Photo</button>`
        : '';
    const recordLink =
        item.status === 'completed' && item.inventory_id
            ? `<span style="font-size:12px; color:#1b5e20;">Added to inventory #${item.inventory_id}</span>`
            : '';
    const rawPreview =
        item.status === 'completed' && summary.raw
            ? `<div style="font-size:12px; color:#444; margin-top:6px; background:#f4f7fb; padding:8px; border-radius:6px;">${summary.raw.slice(0, 320)}${summary.raw.length > 320 ? '…' : ''}</div>`
            : '';
    return `
        <div style="display:flex; gap:12px; padding:10px; border:1px solid #d9e5f7; border-radius:8px; background:#fff;">
            <div style="width:82px; height:82px; background:#f4f4f4; border:1px solid #ddd; border-radius:6px; overflow:hidden; flex-shrink:0; display:flex; align-items:center; justify-content:center;">
                ${item.url ? `<img src="${item.url}" alt="Medicine photo" style="width:100%; height:100%; object-fit:cover;">` : '<span style="color:#999; font-size:12px;">No photo</span>'}
            </div>
            <div style="flex:1; min-width:0;">
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:4px; flex-wrap:wrap;">
                    <span style="font-weight:800; color:${status.color}; background:${status.bg}; padding:3px 8px; border-radius:999px; font-size:12px;">${status.label}</span>
                    ${recordLink || ''}
                </div>
                <div style="font-weight:700; color:#1f2d3d;">${primary}</div>
                <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px;">
                    ${runBtn || ''}
                    ${viewLink || ''}
                </div>
                ${rawPreview}
            </div>
        </div>
    `;
}

async function queueMedicinePhotos() {
    const input = document.getElementById('med-photo-input');
    if (!input || !input.files || !input.files.length) {
        alert('Select one or more medicine photos first.');
        return;
    }
    const fd = new FormData();
    Array.from(input.files).forEach((file) => fd.append('files', file));
    try {
        const res = await fetch('/api/medicines/photos', { method: 'POST', body: fd, credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
        medPhotoQueue = Array.isArray(data.queue) ? data.queue : medPhotoQueue;
        renderMedPhotoQueue();
        input.value = '';
    } catch (err) {
        alert(`Unable to queue photos: ${err.message}`);
    }
}

async function processQueuedPhoto(id) {
    if (medPhotoProcessing) return;
    medPhotoProcessing = true;
    try {
        const res = await fetch(`/api/medicines/photos/${id}/process`, { method: 'POST', credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || data.error) {
            alert(`Processing failed: ${data.error || res.status}`);
        }
        await loadMedPhotoQueue();
        if (typeof loadPharmacy === 'function') {
            loadPharmacy();
        }
    } catch (err) {
        alert(`Unable to process photo: ${err.message}`);
    } finally {
        medPhotoProcessing = false;
    }
}

async function processQueuedMedicinePhotos() {
    for (const item of medPhotoQueue) {
        if (item.status === 'completed') continue;
        await processQueuedPhoto(item.id);
    }
}

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

    if (storeList) {
        storeList.innerHTML = stores.length ? stores.map((item) => renderEquipmentCard(item, expandId)).join('') : '';
    }
    if (medicationList) {
        medicationList.innerHTML = meds.length ? meds.map((item) => renderEquipmentCard(item, expandId)).join('') : '';
    }
    if (consumablesList) {
        consumablesList.innerHTML = cons.length ? cons.map((item) => renderEquipmentCard(item, expandId)).join('') : '';
    }
}

function renderEquipmentCard(item, expandId = null) {
    const lowStock = item.minPar && Number(item.totalQty) <= Number(item.minPar);
    const expirySoon = item.expiryDate && daysUntil(item.expiryDate) <= 60;
    const headerNote = [lowStock ? 'Low Stock' : null, expirySoon ? 'Expiring Soon' : null, item.status && item.status !== 'In Stock' ? item.status : null]
        .filter(Boolean)
        .join(' · ');
    const isOpen = expandId && item.id === expandId;
    const bodyDisplay = isOpen ? 'display:block;' : '';
    const arrow = isOpen ? '▾' : '▸';
    return `
        <div class="collapsible history-item">
            <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; align-items:center;">
                <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">${arrow}</span>
                <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:700;">
                ${item.name || 'Medical Equipment'} ${item.category ? '— ' + item.category : ''}
            </span>
            ${headerNote ? `<span class="sidebar-pill" style="margin-right:8px; background:${lowStock ? '#ffebee' : '#fff7e0'}; color:${lowStock ? '#c62828' : '#b26a00'};">${headerNote}</span>` : ''}
        </div>
        <div class="col-body" style="padding:12px; background:#e8f4ff; border:1px solid #c7ddff; border-radius:6px; ${bodyDisplay}">
            <div class="collapsible" style="margin-bottom:10px;">
                <div class="col-header crew-med-header" onclick="toggleMedDetails(this)" style="background:#fff; justify-content:flex-start; align-items:center; gap:8px;">
                    <span class="detail-icon history-arrow" style="font-size:16px; margin-right:8px;">▾</span>
                    <span style="font-weight:700;">Medical Equipment Detail</span>
                    <button onclick="event.stopPropagation(); deleteEquipment('${item.id}')" class="btn btn-sm" style="background:var(--red); margin-left:auto;">🗑 Delete Medical Equipment Item</button>
                </div>
                <div class="col-body" style="padding:10px; display:block;">
                    <div style="display:grid; grid-template-columns: repeat(2, minmax(240px, 1fr)); gap:10px; margin-bottom:10px;">
                        <div>
                            <label style="font-weight:700; font-size:12px;">Medical Equipment Name</label>
                            <input id="eq-name-${item.id}" type="text" value="${item.name}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Category</label>
                            <input id="eq-cat-${item.id}" type="text" value="${item.category}" placeholder="Diagnostic, Surgical, etc." style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Type</label>
                            <select id="eq-type-${item.id}" style="width:100%; padding:8px;" onchange="scheduleSaveEquipment('${item.id}')">
                                <option value="durable" ${item.type === 'durable' ? 'selected' : ''}>Durable (reusable)</option>
                                <option value="consumable" ${item.type === 'consumable' ? 'selected' : ''}>Consumable (one-time)</option>
                                <option value="medication" ${item.type === 'medication' ? 'selected' : ''}>Medication</option>
                            </select>
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Storage Location</label>
                            <input id="eq-loc-${item.id}" type="text" value="${item.storageLocation}" placeholder="Medical Bag 1, Locker B" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Sub-Location / Kit</label>
                            <input id="eq-subloc-${item.id}" type="text" value="${item.subLocation}" placeholder="Inside Airway pouch" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Parent Kit ID</label>
                            <input id="eq-parent-${item.id}" type="text" value="${item.parentId}" placeholder="Medical Bag 1" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Current Status</label>
                            <select id="eq-status-${item.id}" style="width:100%; padding:8px;" onchange="scheduleSaveEquipment('${item.id}')">
                                <option ${item.status === 'In Stock' ? 'selected' : ''}>In Stock</option>
                                <option ${item.status === 'In Use' ? 'selected' : ''}>In Use</option>
                                <option ${item.status === 'Sterilizing' ? 'selected' : ''}>Sterilizing</option>
                                <option ${item.status === 'Damaged/Out of Service' ? 'selected' : ''}>Damaged/Out of Service</option>
                            </select>
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Sterilization / Expiry Date</label>
                            <input id="eq-exp-${item.id}" type="date" value="${item.expiryDate}" style="width:100%; padding:8px;" onchange="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Last Inspection Date</label>
                            <input id="eq-inspect-${item.id}" type="date" value="${item.lastInspection}" style="width:100%; padding:8px;" onchange="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Battery Type & Status</label>
                            <input id="eq-batt-${item.id}" type="text" value="${item.batteryType}" placeholder="2x AAA; changed Jan 2026" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Calibration Due Date</label>
                            <input id="eq-cal-${item.id}" type="date" value="${item.calibrationDue}" style="width:100%; padding:8px;" onchange="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Total Quantity</label>
                            <input id="eq-qty-${item.id}" type="number" value="${item.totalQty}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Minimum Par Level</label>
                            <input id="eq-par-${item.id}" type="number" value="${item.minPar}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div>
                            <label style="font-weight:700; font-size:12px;">Supplier / Manufacturer</label>
                            <input id="eq-sup-${item.id}" type="text" value="${item.supplier}" placeholder="Who to contact" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                        </div>
                        <div style="grid-column: span 2;">
                            <label style="font-weight:700; font-size:12px;">Notes</label>
                            <textarea id="eq-notes-${item.id}" style="width:100%; padding:8px; min-height:60px;" oninput="scheduleSaveEquipment('${item.id}')">${item.notes || ''}</textarea>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
}

function scheduleSaveEquipment(id) {
    if (equipmentSaveTimers[id]) clearTimeout(equipmentSaveTimers[id]);
    equipmentSaveTimers[id] = setTimeout(() => saveEquipment(id), 600);
}

async function saveEquipment(id) {
    const res = await fetch('/api/data/tools', { credentials: 'same-origin' });
    const data = await res.json();
    const items = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    const eq = items.find((i) => i.id === id);
    if (!eq) return;
    eq.name = document.getElementById(`eq-name-${id}`)?.value || '';
    eq.category = document.getElementById(`eq-cat-${id}`)?.value || '';
    eq.type = document.getElementById(`eq-type-${id}`)?.value || 'durable';
    eq.storageLocation = document.getElementById(`eq-loc-${id}`)?.value || '';
    eq.subLocation = document.getElementById(`eq-subloc-${id}`)?.value || '';
    eq.parentId = document.getElementById(`eq-parent-${id}`)?.value || '';
    eq.status = document.getElementById(`eq-status-${id}`)?.value || 'In Stock';
    eq.expiryDate = document.getElementById(`eq-exp-${id}`)?.value || '';
    eq.lastInspection = document.getElementById(`eq-inspect-${id}`)?.value || '';
    eq.batteryType = document.getElementById(`eq-batt-${id}`)?.value || '';
    eq.calibrationDue = document.getElementById(`eq-cal-${id}`)?.value || '';
    eq.totalQty = document.getElementById(`eq-qty-${id}`)?.value || '';
    eq.minPar = document.getElementById(`eq-par-${id}`)?.value || '';
    eq.supplier = document.getElementById(`eq-sup-${id}`)?.value || '';
    eq.notes = document.getElementById(`eq-notes-${id}`)?.value || '';

    await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
        credentials: 'same-origin',
    });
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

async function addMedicalStore() {
    const name = getNewEquipmentVal('eq-new-name');
    if (!name) {
        alert('Please enter a Medical Equipment name');
        const nameField = document.getElementById('eq-new-name');
        if (nameField) nameField.focus();
        return;
    }
    const category = getNewEquipmentVal('eq-new-cat');
    if (!category) {
        alert('Please enter a category');
        const catField = document.getElementById('eq-new-cat');
        if (catField) catField.focus();
        return;
    }
    const newId = `eq-${Date.now()}`;
    const newItem = ensureEquipmentDefaults({
        id: newId,
        name,
        category,
        type: document.getElementById('eq-new-type')?.value || 'durable',
        storageLocation: getNewEquipmentVal('eq-new-loc'),
        subLocation: getNewEquipmentVal('eq-new-subloc'),
        parentId: getNewEquipmentVal('eq-new-parent'),
        status: document.getElementById('eq-new-status')?.value || 'In Stock',
        expiryDate: document.getElementById('eq-new-exp')?.value || '',
        lastInspection: document.getElementById('eq-new-inspect')?.value || '',
        batteryType: getNewEquipmentVal('eq-new-batt'),
        calibrationDue: document.getElementById('eq-new-cal')?.value || '',
        totalQty: getNewEquipmentVal('eq-new-qty'),
        minPar: getNewEquipmentVal('eq-new-par'),
        supplier: getNewEquipmentVal('eq-new-sup'),
        notes: document.getElementById('eq-new-notes')?.value || '',
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

    // Clear the add form for the next entry
    ['eq-new-name','eq-new-cat','eq-new-loc','eq-new-subloc','eq-new-parent','eq-new-exp','eq-new-inspect','eq-new-batt','eq-new-cal','eq-new-qty','eq-new-par','eq-new-sup','eq-new-notes']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    const typeSel = document.getElementById('eq-new-type');
    if (typeSel) typeSel.value = 'durable';
    const statusSel = document.getElementById('eq-new-status');
    if (statusSel) statusSel.value = 'In Stock';

    loadEquipment(newId);
}

async function addMedicationItem() {
    const name = getNewEquipmentVal('med-new-name');
    if (!name) {
        alert('Please enter a Medication name');
        const nameField = document.getElementById('med-new-name');
        if (nameField) nameField.focus();
        return;
    }
    const category = getNewEquipmentVal('med-new-cat') || 'Medication';
    const newId = `eq-${Date.now()}`;
    const newItem = ensureEquipmentDefaults({
        id: newId,
        name,
        category,
        type: document.getElementById('med-new-type')?.value || 'medication',
        storageLocation: getNewEquipmentVal('med-new-loc'),
        subLocation: getNewEquipmentVal('med-new-subloc'),
        parentId: getNewEquipmentVal('med-new-parent'),
        status: document.getElementById('med-new-status')?.value || 'In Stock',
        expiryDate: document.getElementById('med-new-exp')?.value || '',
        lastInspection: document.getElementById('med-new-inspect')?.value || '',
        batteryType: getNewEquipmentVal('med-new-batt'),
        calibrationDue: document.getElementById('med-new-cal')?.value || '',
        totalQty: getNewEquipmentVal('med-new-qty'),
        minPar: getNewEquipmentVal('med-new-par'),
        supplier: getNewEquipmentVal('med-new-sup'),
        notes: document.getElementById('med-new-notes')?.value || '',
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

    ['med-new-name','med-new-cat','med-new-loc','med-new-subloc','med-new-parent','med-new-exp','med-new-inspect','med-new-batt','med-new-cal','med-new-qty','med-new-par','med-new-sup','med-new-notes']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    const typeSel = document.getElementById('med-new-type');
    if (typeSel) typeSel.value = 'medication';
    const statusSel = document.getElementById('med-new-status');
    if (statusSel) statusSel.value = 'In Stock';

    loadEquipment(newId);
}

async function addConsumableItem() {
    const name = getNewEquipmentVal('cons-new-name');
    if (!name) {
        alert('Please enter a Medical Supply name');
        const nameField = document.getElementById('cons-new-name');
        if (nameField) nameField.focus();
        return;
    }
    const category = getNewEquipmentVal('cons-new-cat') || 'Consumable';
    const newId = `eq-${Date.now()}`;
    const newItem = ensureEquipmentDefaults({
        id: newId,
        name,
        category,
        type: document.getElementById('cons-new-type')?.value || 'consumable',
        storageLocation: getNewEquipmentVal('cons-new-loc'),
        subLocation: getNewEquipmentVal('cons-new-subloc'),
        parentId: getNewEquipmentVal('cons-new-parent'),
        status: document.getElementById('cons-new-status')?.value || 'In Stock',
        expiryDate: document.getElementById('cons-new-exp')?.value || '',
        lastInspection: document.getElementById('cons-new-inspect')?.value || '',
        batteryType: getNewEquipmentVal('cons-new-batt'),
        calibrationDue: document.getElementById('cons-new-cal')?.value || '',
        totalQty: getNewEquipmentVal('cons-new-qty'),
        minPar: getNewEquipmentVal('cons-new-par'),
        supplier: getNewEquipmentVal('cons-new-sup'),
        notes: document.getElementById('cons-new-notes')?.value || '',
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

    ['cons-new-name','cons-new-cat','cons-new-loc','cons-new-subloc','cons-new-parent','cons-new-exp','cons-new-inspect','cons-new-batt','cons-new-cal','cons-new-qty','cons-new-par','cons-new-sup','cons-new-notes']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    const typeSel = document.getElementById('cons-new-type');
    if (typeSel) typeSel.value = 'consumable';
    const statusSel = document.getElementById('cons-new-status');
    if (statusSel) statusSel.value = 'In Stock';

    loadEquipment(newId);
}

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
window.loadMedPhotoQueue = loadMedPhotoQueue;
window.queueMedicinePhotos = queueMedicinePhotos;
window.processQueuedMedicinePhotos = processQueuedMedicinePhotos;
window.processQueuedPhoto = processQueuedPhoto;
