// Crew management functionality

// Reuse the chat dropdown storage key without redefining the global constant
const CREW_LAST_PATIENT_KEY = typeof LAST_PATIENT_KEY !== 'undefined' ? LAST_PATIENT_KEY : 'sailingmed:lastPatient';
let historyStore = [];
let historyStoreById = {};

// Calculate age from birthdate
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

// Toggle individual log entries (query/response)
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

// Get display name for crew member
function getCrewDisplayName(crew) {
    if (crew.firstName && crew.lastName) {
        return `${crew.lastName}, ${crew.firstName}`;
    }
    return crew.name || 'Unknown';
}

// Get full name for crew member
function getCrewFullName(crew) {
    if (crew.firstName && crew.lastName) {
        return `${crew.firstName} ${crew.lastName}`;
    }
    return crew.name || 'Unknown';
}

function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function groupHistoryByPatient(history) {
    const map = {};
    history.forEach((item) => {
        if (item && item.id) {
            historyStoreById[item.id] = item;
        }
        let key = (item.patient || '').trim();
        if (!key) key = 'Unnamed Crew';
        if (key.toLowerCase() === 'inquiry') key = 'Inquiry History';
        if (!map[key]) map[key] = [];
        map[key].push(item);
    });
    return map;
}

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
                        <span class="toggle-label history-arrow" style="font-size:16px; margin-right:8px;">▸</span>
                        <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600; font-size:13px;">${date || 'Entry'}${preview ? ' — ' + preview : ''}</span>
                        <div style="display:flex; gap:6px; align-items:center;">
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

function renderHistorySection(label, entries, defaultOpen = true) {
    const bodyStyle = defaultOpen ? 'display:block;' : '';
    const arrow = defaultOpen ? '▾' : '▸';
    const count = Array.isArray(entries) ? entries.length : 0;
    return `
        <div class="collapsible history-item" style="margin-top:10px;">
            <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; align-items:center;">
                <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">${arrow}</span>
                <span style="flex:1; font-weight:600; font-size:14px;">${escapeHtml(label)}${count ? ` (${count} entries)` : ''}</span>
            </div>
            <div class="col-body" style="padding:10px; ${bodyStyle}">
                ${renderHistoryEntries(entries)}
            </div>
        </div>`;
}

function getHistoryForCrew(p, historyMap) {
    const keys = [];
    const fullName = getCrewFullName(p);
    if (fullName) keys.push(fullName);
    if (p.name) keys.push(p.name);
    if (p.firstName || p.lastName) keys.push(`${p.firstName || ''} ${p.lastName || ''}`.trim());
    for (const k of keys) {
        if (historyMap[k]) return historyMap[k];
    }
    return [];
}

// Load crew data for both medical and vessel/crew info
function loadCrewData(data, history = []) {
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
        const previousSelection = pSelect.value || localStorage.getItem(CREW_LAST_PATIENT_KEY) || 'Unnamed Crew';
        pSelect.innerHTML = `<option>Unnamed Crew</option>` + data.map(p=> `<option>${getCrewFullName(p)}</option>`).join('');
        const hasPrev = Array.from(pSelect.options).some(opt => opt.value === previousSelection);
        pSelect.value = hasPrev ? previousSelection : 'Unnamed Crew';
        console.log('[DEBUG] p-select options', pSelect.options.length, 'prev', previousSelection, 'hasPrev', hasPrev);
        pSelect.onchange = (e) => {
            try { localStorage.setItem(CREW_LAST_PATIENT_KEY, e.target.value); } catch (err) { /* ignore */ }
            console.log('[DEBUG] p-select changed to', e.target.value);
            if (typeof refreshPromptPreview === 'function') {
                refreshPromptPreview();
            }
        };
        if (typeof refreshPromptPreview === 'function') {
            refreshPromptPreview();
        }
    }
    
    // Medical histories list
    const medicalContainer = document.getElementById('crew-medical-list');
    if (medicalContainer) {
        const medicalBlocks = data.map(p => {
            const displayName = getCrewDisplayName(p);
            const crewHistory = getHistoryForCrew(p, historyMap);
            const historySection = renderHistorySection(`${displayName} Log`, crewHistory, true);
            return `
            <div class="collapsible history-item">
                <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start;">
                    <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">▸</span>
                    <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:700;">${displayName}</span>
                    <button onclick="event.stopPropagation(); exportCrew('${p.id}', '${getCrewFullName(p).replace(/'/g, "\\'")}')" class="btn btn-sm history-action-btn" style="background:var(--inquiry); visibility:hidden;">📤 Export</button>
                </div>
                <div class="col-body" style="padding:12px; background:#e8f4ff; border:1px solid #c7ddff; border-radius:6px;">
                    <textarea id="h-${p.id}" class="compact-textarea" placeholder="Medical history, conditions, allergies, medications, etc." onchange="autoSaveProfile('${p.id}')">${p.history || ''}</textarea>
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

        medicalContainer.innerHTML = medicalBlocks.join('');
    }
    
    // Vessel & crew info list
    const infoContainer = document.getElementById('crew-info-list');
    if (infoContainer) {
        infoContainer.innerHTML = data.map(p => {
        const displayName = getCrewDisplayName(p);
        const ageStr = calculateAge(p.birthdate);
        const posInfo = p.position ? ` • ${p.position}` : '';
        const info = `${displayName}${ageStr}${posInfo}`;
        
        // Check if crew has data to determine default collapse state
        const hasData = p.firstName && p.lastName && p.citizenship;
        
        return `
        <div class="collapsible history-item">
            <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start;">
                <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">▸</span>
                <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:700;">${info}</span>
                <button onclick="event.stopPropagation(); importCrewData('${p.id}')" class="btn btn-sm history-action-btn" style="background:var(--inquiry); visibility:hidden;">📁 Import</button>
                <button onclick="event.stopPropagation(); exportCrew('${p.id}', '${getCrewFullName(p).replace(/'/g, "\\'")}')" class="btn btn-sm history-action-btn" style="background:var(--inquiry); visibility:hidden;">📤 Export</button>
                <button onclick="event.stopPropagation(); deleteCrewMember('patients','${p.id}', '${getCrewFullName(p).replace(/'/g, "\\'")}')" class="btn btn-sm history-action-btn" style="background:var(--red); visibility:hidden;">🗑 Delete</button>
            </div>
            <div class="col-body" style="padding:10px;">
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
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:8px; margin-bottom:8px; font-size:13px;">
                    <input type="text" id="cit-${p.id}" value="${p.citizenship || ''}" placeholder="Citizenship" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
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
                <div style="margin-bottom:10px; font-size:12px; border-top:1px solid #ddd; padding-top:8px;">
                    <label style="font-weight:bold; margin-bottom:4px; display:block;">Contact & Documents</label>
                </div>
                <div style="margin-bottom:8px; font-size:13px;">
                    <input type="text" id="phone-${p.id}" value="${p.phoneNumber || ''}" placeholder="Cell/WhatsApp Number" onchange="autoSaveProfile('${p.id}')" style="padding:5px; width:100%;">
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:8px;">
                    <div style="border:1px solid #ddd; padding:8px; border-radius:4px; background:#f9f9f9;">
                        <label style="margin-bottom:4px; display:block; font-weight:bold; font-size:11px;">Passport Photo:</label>
                        ${p.passportPhoto ? (p.passportPhoto.startsWith('data:image/') ? `<div style="margin-bottom:4px;"><img src="${p.passportPhoto}" style="max-width:100%; max-height:120px; border:1px solid #ccc; border-radius:4px; cursor:pointer;" onclick="window.open('${p.passportPhoto}', '_blank')"><div style="margin-top:4px;"><button onclick="deleteDocument('${p.id}', 'passportPhoto')" style="background:var(--red); color:white; border:none; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px;">🗑 Delete</button></div></div>` : `<div style="margin-bottom:4px;"><a href="${p.passportPhoto}" target="_blank" style="color:var(--inquiry); font-size:11px;">📎 View PDF</a> | <button onclick="deleteDocument('${p.id}', 'passportPhoto')" style="background:none; border:none; color:var(--red); cursor:pointer; font-size:10px;">🗑</button></div>`) : ''}
                        <input type="file" id="pp-${p.id}" accept="image/*,.pdf" onchange="uploadDocument('${p.id}', 'passportPhoto', this)" style="font-size:10px; width:100%;">
                    </div>
                    <div style="border:1px solid #ddd; padding:8px; border-radius:4px; background:#f9f9f9;">
                        <label style="margin-bottom:4px; display:block; font-weight:bold; font-size:11px;">Passport Page Photo:</label>
                        ${p.passportPage ? (p.passportPage.startsWith('data:image/') ? `<div style="margin-bottom:4px;"><img src="${p.passportPage}" style="max-width:100%; max-height:120px; border:1px solid #ccc; border-radius:4px; cursor:pointer;" onclick="window.open('${p.passportPage}', '_blank')"><div style="margin-top:4px;"><button onclick="deleteDocument('${p.id}', 'passportPage')" style="background:var(--red); color:white; border:none; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px;">🗑 Delete</button></div></div>` : `<div style="margin-bottom:4px;"><a href="${p.passportPage}" target="_blank" style="color:var(--inquiry); font-size:11px;">📎 View PDF</a> | <button onclick="deleteDocument('${p.id}', 'passportPage')" style="background:none; border:none; color:var(--red); cursor:pointer; font-size:10px;">🗑</button></div>`) : ''}
                        <input type="file" id="ppg-${p.id}" accept="image/*,.pdf" onchange="uploadDocument('${p.id}', 'passportPage', this)" style="font-size:10px; width:100%;">
                    </div>
                </div>
                    </div>
                </div>
            </div>
        </div>`}).join('');
    }
}

// Expose for other scripts that call loadData() before bundling
window.loadCrewData = loadCrewData;
console.log('[DEBUG] crew.js loaded and loadCrewData attached');

// Debug immediately after attach
if (typeof window.loadCrewData === 'function') {
    console.log('[DEBUG] window.loadCrewData is available');
} else {
    console.error('[DEBUG] window.loadCrewData is NOT available after attach');
}

// Add new crew member
async function addCrew() {
    const firstName = document.getElementById('cn-first').value.trim();
    const middleName = document.getElementById('cn-middle').value.trim();
    const lastName = document.getElementById('cn-last').value.trim();
    const sex = document.getElementById('cn-sex').value;
    const birthdate = document.getElementById('cn-birthdate').value;
    const position = document.getElementById('cn-position').value;
    const citizenship = document.getElementById('cn-citizenship').value.trim();
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
    if (!sex) {
        alert('Please select sex');
        return;
    }
    if (!birthdate) {
        alert('Please enter birthdate');
        return;
    }
    if (!position) {
        alert('Please select position');
        return;
    }
    if (!citizenship) {
        alert('Please enter citizenship');
        return;
    }
    if (!passportNumber) {
        alert('Please enter passport number');
        return;
    }
    
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
        passportNumber: passportNumber,
        passportIssue: passportIssue,
        passportExpiry: passportExpiry,
        emergencyContactName: emergencyContactName,
        emergencyContactRelation: emergencyContactRelation,
        emergencyContactPhone: emergencyContactPhone,
        emergencyContactEmail: emergencyContactEmail,
        emergencyContactNotes: emergencyContactNotes,
        phoneNumber: phoneNumber,
        passportPhoto: '',
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

// Auto-save profile (debounced to prevent excessive saves)
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
        }
    }, 1000);
}

// Copy emergency contact from another crew member
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

// Upload document (passport photo or passport page)
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
        
        // Save to crew member data
        const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
        const patient = data.find(p => p.id === id);
        if (patient) {
            patient[fieldName] = base64Data;
            await fetch('/api/data/patients', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data), credentials:'same-origin'});
            loadData(); // Refresh to show the new document
            alert('Document uploaded successfully!');
        }
    };
    reader.readAsDataURL(file);
}

// Delete document
async function deleteDocument(id, fieldName) {
    if (!confirm('Are you sure you want to delete this document?')) return;
    
    const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
    const patient = data.find(p => p.id === id);
    if (patient) {
        patient[fieldName] = '';
        await fetch('/api/data/patients', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data), credentials:'same-origin'});
        loadData();
        alert('Document deleted.');
    }
}

// Import crew data from text file
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

// Export individual crew member data
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

// Export all crew data
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

// Export all medical histories into one text file
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

// Delete crew member with double confirmation
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

// Export Crew List (CSV for border crossings)
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
    csv += `No.,Name,Birth Date,Position,Citizenship,Passport No.,Issue Date,Expiry Date\n`;
    
    data.forEach((crew, index) => {
        const name = getCrewFullName(crew);
        const bd = crew.birthdate || '';
        const pos = crew.position || '';
        const cit = crew.citizenship || '';
        const pass = crew.passportNumber || '';
        const issue = crew.passportIssue || '';
        const expiry = crew.passportExpiry || '';
        
        csv += `${index + 1},${name},${bd},${pos},${cit},${pass},${issue},${expiry}\n`;
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

// Vessel info load/save
async function loadVesselInfo() {
    const v = await (await fetch('/api/data/vessel', {credentials:'same-origin'})).json();
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('vessel-name', v.vesselName);
    setVal('vessel-registration', v.registrationNumber);
    setVal('vessel-flag', v.flagCountry);
    setVal('vessel-homeport', v.homePort);
    setVal('vessel-callsign', v.callSign);
    setVal('vessel-tonnage', v.tonnage);
    setVal('vessel-crewcap', v.crewCapacity);
}

async function saveVesselInfo() {
    const v = {
        vesselName: document.getElementById('vessel-name')?.value || '',
        registrationNumber: document.getElementById('vessel-registration')?.value || '',
        flagCountry: document.getElementById('vessel-flag')?.value || '',
        homePort: document.getElementById('vessel-homeport')?.value || '',
        callSign: document.getElementById('vessel-callsign')?.value || '',
        tonnage: document.getElementById('vessel-tonnage')?.value || '',
        crewCapacity: document.getElementById('vessel-crewcap')?.value || ''
    };
    await fetch('/api/data/vessel', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(v), credentials:'same-origin'});
    alert('Vessel information saved.');
}
