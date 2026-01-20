// Main utilities and navigation - Cleaned up

// Toggle collapsible sections
function toggleSection(el) {
    const body = el.nextElementSibling;
    const icon = el.querySelector('.detail-icon');
    const isExpanded = body.style.display === "block";
    body.style.display = isExpanded ? "none" : "block";
    if (icon) icon.textContent = isExpanded ? "▸" : "▾";
}

// Toggle detail section with icon change
function toggleDetailSection(el) {
    const body = el.nextElementSibling;
    const icon = el.querySelector('.detail-icon');
    const isExpanded = body.style.display === "block";
    
    body.style.display = isExpanded ? "none" : "block";
    icon.textContent = isExpanded ? "▸" : "▾";
}

// Crew-specific toggle with icon change
function toggleCrewSection(el) {
    const body = el.nextElementSibling;
    const icon = el.querySelector('.toggle-label');
    const actionBtns = el.querySelectorAll('.history-action-btn');
    const isExpanded = body.style.display === "block";
    
    body.style.display = isExpanded ? "none" : "block";
    icon.textContent = isExpanded ? "▸" : "▾";
    actionBtns.forEach(btn => { btn.style.visibility = isExpanded ? "hidden" : "visible"; });
}

// Tab navigation
async function showTab(e, n) {
    document.querySelectorAll('.content').forEach(c=>c.style.display='none');
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.getElementById(n).style.display='flex'; 
    e.currentTarget.classList.add('active');
    toggleBannerControls(n);
    if (n === 'Chat') updateUI();
    
    if(n === 'Settings') {
        const s = await (await fetch('/api/data/settings')).json();
        Object.keys(s).forEach(k => { 
            if(document.getElementById(k)) document.getElementById(k).value = s[k]; 
        });
        if (typeof loadCrewCredentials === 'function') {
            loadCrewCredentials();
        }
    } else if(n === 'CrewMedical' || n === 'VesselCrewInfo') { 
        loadData(); 
        if (typeof loadVesselInfo === 'function') {
            loadVesselInfo();
        }
    } else if(n === 'ChatHistory') {
        loadHistory();
    }
}

// Load crew data only
async function loadData() {
    const data = await (await fetch('/api/data/patients')).json();
    loadCrewData(data);
}

function toggleBannerControls(activeTab) {
    const triageControls = document.getElementById('banner-controls-triage');
    const crewControls = document.getElementById('banner-controls-crew');
    const historyControls = document.getElementById('banner-controls-history');
    const medExportAll = document.getElementById('crew-med-export-all-btn');
    const crewCsvBtn = document.getElementById('crew-csv-btn');
    if (triageControls) triageControls.style.display = activeTab === 'Chat' ? 'flex' : 'none';
    if (crewControls) crewControls.style.display = (activeTab === 'CrewMedical' || activeTab === 'VesselCrewInfo') ? 'flex' : 'none';
    if (historyControls) historyControls.style.display = activeTab === 'ChatHistory' ? 'flex' : 'none';
    if (medExportAll) medExportAll.style.display = activeTab === 'CrewMedical' ? 'inline-flex' : 'none';
    if (crewCsvBtn) crewCsvBtn.style.display = activeTab === 'VesselCrewInfo' ? 'inline-flex' : 'none';
}

// Load and render chat history
async function loadHistory() {
    const container = document.getElementById('history-list');
    if (!container) return;
    container.innerHTML = '<div style="color:#666;">Loading history...</div>';
    try {
        let data = await (await fetch('/api/data/history')).json();
        if (!data || data.length === 0) {
            container.innerHTML = '<div style="color:#666;">No history yet.</div>';
            return;
        }
        // Search filter
        const q = document.getElementById('history-search')?.value?.toLowerCase() || '';
        if (q) {
            data = data.filter(item => {
                const fields = [item.patient, item.query, item.response, item.title, item.date].join(' ').toLowerCase();
                return fields.includes(q);
            });
        }
        // Sorting
        const sortVal = document.getElementById('history-sort')?.value || 'date';
        data.sort((a,b) => {
            if (sortVal === 'first') {
                return (a.patient || '').localeCompare(b.patient || '');
            } else if (sortVal === 'last') {
                const al = (a.patient || '').split(' ').slice(-1)[0] || '';
                const bl = (b.patient || '').split(' ').slice(-1)[0] || '';
                return al.localeCompare(bl);
            } else if (sortVal === 'query') {
                return (a.query || '').localeCompare(b.query || '');
            } else { // date default
                return (a.date || '').localeCompare(b.date || '');
            }
        }).reverse(); // latest first
        container.innerHTML = '';
        const parse = (s) => (window.marked ? window.marked.parse(s || '') : (s || '').replace(/\\n/g, '<br>'));
        const escInline = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        data.forEach(item => {
            const wrap = document.createElement('div');
            wrap.className = 'history-item';

            const header = document.createElement('div');
            header.className = 'history-header';
            const firstLine = (item.query || '').split('\\n')[0];
            let preview = escInline(firstLine);
            if (preview.length > 120) preview = preview.slice(0, 120) + '...';
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-sm history-action-btn';
            deleteBtn.style.background = 'var(--red)';
            deleteBtn.textContent = 'Delete';
            deleteBtn.style.visibility = 'hidden';
            deleteBtn.onclick = (e) => { e.stopPropagation(); deleteHistory(item.id); };
            const exportBtn = document.createElement('button');
            exportBtn.className = 'btn btn-sm history-action-btn';
            exportBtn.style.background = 'var(--blue)';
            exportBtn.textContent = 'Export';
            exportBtn.style.visibility = 'hidden';
            exportBtn.onclick = (e) => { e.stopPropagation(); exportHistoryItem(item); };
            const rightSpan = document.createElement('span');
            rightSpan.className = 'history-arrow';
            rightSpan.textContent = '▸';
            const titleSpan = document.createElement('span');
            titleSpan.className = 'history-title';
            titleSpan.innerHTML = `${item.patient || 'Unknown'} — ${item.date || ''}${item.title ? ' — ' + escInline(item.title) : ''}${preview ? ' — ' + preview : ''}`;
            header.appendChild(rightSpan);
            header.appendChild(titleSpan);
            header.appendChild(deleteBtn);
            header.appendChild(exportBtn);

            const body = document.createElement('div');
            body.className = 'history-body';
            const queryHtml = parse(item.query);
            const respHtml = parse(item.response);
            const block = document.createElement('div');
            block.className = 'response-block history-response';
            block.innerHTML = `<div style="margin-bottom:8px;"><strong>Query:</strong><br>${queryHtml}</div><div><strong>Response:</strong><br>${respHtml}</div>`;
            body.appendChild(block);

            header.addEventListener('click', () => {
                const isOpen = body.style.display === 'block';
                const nextOpen = !isOpen;
                body.style.display = nextOpen ? 'block' : 'none';
                rightSpan.textContent = nextOpen ? '▾' : '▸';
                exportBtn.style.visibility = nextOpen ? 'visible' : 'hidden';
                deleteBtn.style.visibility = nextOpen ? 'visible' : 'hidden';
            });

            wrap.appendChild(header);
            wrap.appendChild(body);
            container.appendChild(wrap);
        });
    } catch (err) {
        container.innerHTML = `<div style="color:red;">Error loading history: ${err.message}</div>`;
    }
}

async function deleteHistory(id) {
    if (!id) return;
    const first = confirm('Delete this chat entry?');
    if (!first) return;
    const confirmText = prompt('Type DELETE to confirm deletion:');
    if (confirmText !== 'DELETE') {
        alert('Deletion cancelled.');
        return;
    }
    try {
        const data = await (await fetch('/api/data/history')).json();
        const filtered = data.filter(item => item.id !== id);
        await fetch('/api/data/history', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(filtered)});
        loadHistory();
    } catch (err) {
        alert(`Failed to delete: ${err.message}`);
    }
}

function resetHistorySearch() {
    const search = document.getElementById('history-search');
    if (search) search.value = '';
    const sort = document.getElementById('history-sort');
    if (sort) sort.value = 'date';
    loadHistory();
}

function exportHistoryItem(item) {
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
    const blob = new Blob([parts.join('\n')], {type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// Initialize on page load
window.onload = () => { 
    loadData(); 
    updateUI(); 
    toggleBannerControls('Chat');
};
