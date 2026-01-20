// Settings and configuration management

async function saveSettings() {
    const s = {};
    ['triage_instruction','inquiry_instruction','tr_temp','tr_tok','tr_p','in_temp','in_tok','in_p','mission_context'].forEach(k => {
        s[k] = document.getElementById(k).value;
    });
    await fetch('/api/data/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(s)});
    alert("Configuration Synchronized.");
}

// Load crew credentials list
async function loadCrewCredentials() {
    const container = document.getElementById('crew-credentials');
    if (!container) return;
    container.innerHTML = 'Loading crew...';
    try {
        const data = await (await fetch('/api/data/patients')).json();
        if (!data || data.length === 0) {
            container.innerHTML = '<div style="color:#666;">No crew members found.</div>';
            return;
        }
        const hasCreds = data.some(p => p.username || p.password);
        if (!hasCreds) {
            container.innerHTML = '<div style="color:#666;">No credentials assigned yet. To enable username/password login per crew, assign them below.</div>' +
                data.map(p => `
                    <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                        <div style="min-width:180px; font-weight:bold;">${p.firstName || ''} ${p.lastName || p.name || ''}</div>
                        <input type="text" id="cred-user-${p.id}" value="${p.username || ''}" placeholder="Username" style="padding:8px; flex:1; min-width:140px;">
                        <input type="text" id="cred-pass-${p.id}" value="${p.password || ''}" placeholder="Password" style="padding:8px; flex:1; min-width:140px;">
                        <button class="btn btn-sm" style="background:var(--blue);" onclick="saveCrewCredential('${p.id}')">Save</button>
                    </div>
                `).join('');
            return;
        }
        container.innerHTML = data.map(p => `
            <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                <div style="min-width:180px; font-weight:bold;">${p.firstName || ''} ${p.lastName || p.name || ''}</div>
                <input type="text" id="cred-user-${p.id}" value="${p.username || ''}" placeholder="Username" style="padding:8px; flex:1; min-width:140px;">
                <input type="text" id="cred-pass-${p.id}" value="${p.password || ''}" placeholder="Password" style="padding:8px; flex:1; min-width:140px;">
                <button class="btn btn-sm" style="background:var(--blue);" onclick="saveCrewCredential('${p.id}')">Save</button>
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = `<div style="color:red;">Error loading crew: ${err.message}</div>`;
    }
}

// Save a single crew credential
async function saveCrewCredential(id) {
    const userEl = document.getElementById(`cred-user-${id}`);
    const passEl = document.getElementById(`cred-pass-${id}`);
    if (!userEl || !passEl) return;
    try {
        const data = await (await fetch('/api/data/patients', {credentials:'same-origin'})).json();
        const patient = data.find(p => p.id === id);
        if (!patient) throw new Error('Crew member not found');
        patient.username = userEl.value;
        patient.password = passEl.value;
        const res = await fetch('/api/data/patients', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data), credentials:'same-origin'});
        if (!res.ok) throw new Error(res.statusText || 'Save failed');
        alert('Saved credentials for crew member.');
    } catch (err) {
        alert(`Failed to save credentials: ${err.message}`);
    }
}
