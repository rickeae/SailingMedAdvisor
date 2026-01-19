// Crew management functionality

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

// Load crew data
function loadCrewData(data) {
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
    document.getElementById('p-select').innerHTML = `<option>Unnamed Crew</option>` + data.map(p=> `<option>${getCrewFullName(p)}</option>`).join('');
    
    // Build crew list with structured data
    document.getElementById('crew-list').innerHTML = data.map(p => {
        const displayName = getCrewDisplayName(p);
        const ageStr = calculateAge(p.birthdate);
        const posInfo = p.position ? ` • ${p.position}` : '';
        const info = `${displayName}${ageStr}${posInfo}`;
        
        // Check if crew has data to determine default collapse state
        const hasData = p.firstName && p.lastName && p.citizenship;
        
        return `
        <div class="collapsible">
            <div class="col-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start;"><span class="toggle-label" style="font-size:14px; margin-right:8px;">➕</span><span>${info}</span></div>
            <div class="col-body">
                <div class="collapsible" style="margin-bottom:10px; border:1px solid #ddd;">
                    <div class="col-header" onclick="toggleDetailSection(this)" style="background:#f0f8ff; padding:6px 10px; font-size:12px; justify-content:flex-start; gap:8px; align-items:center;">
                        <span class="detail-icon" style="font-size:14px; line-height:1;">${hasData ? '➕' : '➖'}</span><span>Personal Details</span>
                    </div>
                    <div class="col-body" style="${hasData ? 'display:none;' : 'display:block;'} padding:10px;">
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
                        ${p.passportPhoto ? (p.passportPhoto.startsWith('data:image/') ? `<div style="margin-bottom:4px;"><img src="${p.passportPhoto}" style="max-width:100%; max-height:120px; border:1px solid #ccc; border-radius:4px; cursor:pointer;" onclick="window.open('${p.passportPhoto}', '_blank')"><div style="margin-top:4px;"><button onclick="deleteDocument('${p.id}', 'passportPhoto')" style="background:var(--red); color:white; border:none; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px;">🗑 Delete</button></div></div>` : `<div style="margin-bottom:4px;"><a href="${p.passportPhoto}" target="_blank" style="color:var(--blue); font-size:11px;">📎 View PDF</a> | <button onclick="deleteDocument('${p.id}', 'passportPhoto')" style="background:none; border:none; color:var(--red); cursor:pointer; font-size:10px;">🗑</button></div>`) : ''}
                        <input type="file" id="pp-${p.id}" accept="image/*,.pdf" onchange="uploadDocument('${p.id}', 'passportPhoto', this)" style="font-size:10px; width:100%;">
                    </div>
                    <div style="border:1px solid #ddd; padding:8px; border-radius:4px; background:#f9f9f9;">
                        <label style="margin-bottom:4px; display:block; font-weight:bold; font-size:11px;">Passport Page Photo:</label>
                        ${p.passportPage ? (p.passportPage.startsWith('data:image/') ? `<div style="margin-bottom:4px;"><img src="${p.passportPage}" style="max-width:100%; max-height:120px; border:1px solid #ccc; border-radius:4px; cursor:pointer;" onclick="window.open('${p.passportPage}', '_blank')"><div style="margin-top:4px;"><button onclick="deleteDocument('${p.id}', 'passportPage')" style="background:var(--red); color:white; border:none; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px;">🗑 Delete</button></div></div>` : `<div style="margin-bottom:4px;"><a href="${p.passportPage}" target="_blank" style="color:var(--blue); font-size:11px;">📎 View PDF</a> | <button onclick="deleteDocument('${p.id}', 'passportPage')" style="background:none; border:none; color:var(--red); cursor:pointer; font-size:10px;">🗑</button></div>`) : ''}
                        <input type="file" id="ppg-${p.id}" accept="image/*,.pdf" onchange="uploadDocument('${p.id}', 'passportPage', this)" style="font-size:10px; width:100%;">
                    </div>
                </div>
                    </div>
                </div>
                <label style="font-weight:bold; font-size:12px; margin-bottom:4px; display:block;">Medical History & Notes:</label>
                <textarea id="h-${p.id}" class="compact-textarea" placeholder="Medical history, conditions, allergies, medications, etc." onchange="autoSaveProfile('${p.id}')">${p.history || ''}</textarea>
                <div class="btn-row">
                    <button onclick="importCrewData('${p.id}')" class="btn btn-sm" style="background:var(--blue)">📁 Import</button>
                    <button onclick="exportCrew('${p.id}', '${getCrewFullName(p).replace(/'/g, "\\'")}')" class="btn btn-sm" style="background:var(--blue)">📤 Export</button>
                    <button onclick="deleteCrewMember('patients','${p.id}', '${getCrewFullName(p).replace(/'/g, "\\'")}')" class="btn btn-sm" style="background:var(--red)">🗑 Delete</button>
                </div>
            </div>
        </div>`}).join('');
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
    
    const data = await (await fetch('/api/data/patients')).json();
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
    await fetch('/api/data/patients', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
    
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
        const data = await (await fetch('/api/data/patients')).json();
        const patient = data.find(p => p.id === id);
        if (patient) {
            patient.firstName = document.getElementById('fn-' + id).value.trim();
            patient.middleName = document.getElementById('mn-' + id).value.trim();
            patient.lastName = document.getElementById('ln-' + id).value.trim();
            patient.sex = document.getElementById('sx-' + id).value;
            patient.birthdate = document.getElementById('bd-' + id).value;
            patient.position = document.getElementById('pos-' + id).value;
            patient.citizenship = document.getElementById('cit-' + id).value.trim();
            patient.passportNumber = document.getElementById('pass-' + id).value.trim();
            patient.passportIssue = document.getElementById('piss-' + id).value;
            patient.passportExpiry = document.getElementById('pexp-' + id).value;
            patient.emergencyContactName = document.getElementById('ename-' + id).value.trim();
            patient.emergencyContactRelation = document.getElementById('erel-' + id).value.trim();
            patient.emergencyContactPhone = document.getElementById('ephone-' + id).value.trim();
            patient.emergencyContactEmail = document.getElementById('eemail-' + id).value.trim();
            patient.emergencyContactNotes = document.getElementById('enotes-' + id).value.trim();
            patient.phoneNumber = document.getElementById('phone-' + id).value.trim();
            patient.history = document.getElementById('h-' + id).value;
            
            await fetch('/api/data/patients', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
            console.log(`Auto-saved profile for ${patient.firstName} ${patient.lastName}`);
        }
    }, 1000);
}

// Copy emergency contact from another crew member
async function copyEmergencyContact(targetId, sourceId) {
    if (!sourceId) return;
    
    const data = await (await fetch('/api/data/patients')).json();
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
        const data = await (await fetch('/api/data/patients')).json();
        const patient = data.find(p => p.id === id);
        if (patient) {
            patient[fieldName] = base64Data;
            await fetch('/api/data/patients', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
            loadData(); // Refresh to show the new document
            alert('Document uploaded successfully!');
        }
    };
    reader.readAsDataURL(file);
}

// Delete document
async function deleteDocument(id, fieldName) {
    if (!confirm('Are you sure you want to delete this document?')) return;
    
    const data = await (await fetch('/api/data/patients')).json();
    const patient = data.find(p => p.id === id);
    if (patient) {
        patient[fieldName] = '';
        await fetch('/api/data/patients', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});
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
    const data = await (await fetch('/api/data/patients')).json();
    
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
    const data = await (await fetch(`/api/data/${category}`)).json();
    const filtered = data.filter(item => item.id !== id);
    await fetch(`/api/data/${category}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(filtered)});
    loadData();
    alert(`${name}'s data has been permanently deleted.`);
}

// Export Crew List (CSV for border crossings)
async function exportCrewList() {
    const data = await (await fetch('/api/data/patients')).json();
    const vessel = await (await fetch('/api/data/vessel')).json();
    
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
