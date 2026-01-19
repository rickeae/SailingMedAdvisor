// Main utilities and navigation - Cleaned up

// Toggle collapsible sections
function toggleSection(el) {
    const body = el.nextElementSibling;
    body.style.display = body.style.display === "block" ? "none" : "block";
}

// Toggle detail section with icon change
function toggleDetailSection(el) {
    const body = el.nextElementSibling;
    const icon = el.querySelector('.detail-icon');
    const isExpanded = body.style.display === "block";
    
    body.style.display = isExpanded ? "none" : "block";
    icon.textContent = isExpanded ? "➕" : "➖";
}

// Crew-specific toggle with icon change
function toggleCrewSection(el) {
    const body = el.nextElementSibling;
    const icon = el.querySelector('.toggle-label');
    const isExpanded = body.style.display === "block";
    
    body.style.display = isExpanded ? "none" : "block";
    icon.textContent = isExpanded ? "➕" : "➖";
}

// Tab navigation
async function showTab(e, n) {
    document.querySelectorAll('.content').forEach(c=>c.style.display='none');
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.getElementById(n).style.display='block'; 
    e.currentTarget.classList.add('active');
    
    if(n === 'Settings') {
        const s = await (await fetch('/api/data/settings')).json();
        Object.keys(s).forEach(k => { 
            if(document.getElementById(k)) document.getElementById(k).value = s[k]; 
        });
    } else if(n === 'Crew') { 
        loadData(); 
    }
}

// Load crew data only
async function loadData() {
    const data = await (await fetch('/api/data/patients')).json();
    loadCrewData(data);
}

// Initialize on page load
window.onload = () => { 
    loadData(); 
    updateUI(); 
};
