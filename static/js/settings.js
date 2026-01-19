// Settings and configuration management

async function saveSettings() {
    const s = {};
    ['triage_instruction','inquiry_instruction','tr_temp','tr_tok','tr_p','in_temp','in_tok','in_p','mission_context'].forEach(k => {
        s[k] = document.getElementById(k).value;
    });
    await fetch('/api/data/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(s)});
    alert("Configuration Synchronized.");
}
