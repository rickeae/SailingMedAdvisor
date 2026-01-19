// Chat/Triage functionality

let isPrivate = false;
let lastPrompt = '';
let isProcessing = false;

function updateUI() {
    const mode = document.getElementById('mode-select').value;
    const banner = document.getElementById('banner');
    const bText = document.getElementById('banner-mode');
    
    // Remove both classes first
    banner.classList.remove('inquiry-mode', 'private-mode');
    
    // Add appropriate mode class
    if (mode === 'inquiry') {
        banner.classList.add('inquiry-mode');
    }
    
    // Add private-mode class if privacy is enabled
    if (isPrivate) {
        banner.classList.add('private-mode');
    }
    
    bText.innerText = mode === 'triage' ? "TRIAGE MODE: ACTIVE" : "INQUIRY MODE: ACTIVE";
    document.getElementById('p-select').style.visibility = mode === 'triage' ? 'visible' : 'hidden';
}

function togglePriv() {
    isPrivate = !isPrivate;
    const btn = document.getElementById('priv-btn');
    btn.style.background = isPrivate ? 'var(--red)' : '#555';
    btn.innerText = isPrivate ? 'PRIVACY: ON' : 'PRIVACY: OFF';
    document.getElementById('banner-priv').innerText = isPrivate ? 'PRIVACY MODE: ON' : 'LOGGING: ENABLED';
    updateUI();
}

async function runChat(promptText = null) {
    const txt = promptText || document.getElementById('msg').value;
    if(!txt || isProcessing) return;
    
    isProcessing = true;
    lastPrompt = txt;
    
    // Show loading indicator
    const display = document.getElementById('display');
    const loadingDiv = document.createElement('div');
    loadingDiv.id = 'loading-indicator';
    loadingDiv.className = 'loading-indicator';
    loadingDiv.innerHTML = '🔄 Analyzing...';
    display.appendChild(loadingDiv);
    display.scrollTop = display.scrollHeight;
    
    // Disable buttons
    document.getElementById('run-btn').disabled = true;
    document.getElementById('repeat-btn').disabled = true;
    
    try {
        const fd = new FormData();
        fd.append('message', txt);
        fd.append('patient', document.getElementById('p-select').value);
        fd.append('mode', document.getElementById('mode-select').value);
        fd.append('private', isPrivate);
        fd.append('model_choice', document.getElementById('model-select').value);
        
        const res = await (await fetch('/api/chat', {method:'POST', body:fd})).json();
        
        // Remove loading indicator
        loadingDiv.remove();
        
        if (res.error) {
            display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>ERROR:</b> ${res.error}</div>`;
        } else {
            display.innerHTML += `<div class="response-block"><b>[${res.model}]</b><br>${marked.parse(res.response)}</div>`;
        }
        
        if (!promptText) {
            document.getElementById('msg').value = '';
        }
        display.lastElementChild.scrollIntoView();
    } catch (error) {
        loadingDiv.remove();
        display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>ERROR:</b> ${error.message}</div>`;
    } finally {
        isProcessing = false;
        document.getElementById('run-btn').disabled = false;
        document.getElementById('repeat-btn').disabled = false;
    }
}

function repeatLast() {
    if (lastPrompt) {
        runChat(lastPrompt);
    } else {
        alert('No previous prompt to repeat');
    }
}

// Handle Enter key for submission
document.addEventListener('DOMContentLoaded', () => {
    const msgTextarea = document.getElementById('msg');
    if (msgTextarea) {
        msgTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                runChat();
            }
        });
    }
});
