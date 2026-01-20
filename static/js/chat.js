// Chat/Triage functionality

let isPrivate = false;
let lastPrompt = '';
let isProcessing = false;
let currentMode = 'triage';
const LAST_PROMPT_KEY = 'sailingmed:lastPrompt';
const LAST_PATIENT_KEY = 'sailingmed:lastPatient';

function updateUI() {
    const banner = document.getElementById('banner');
    const modeBtn = document.getElementById('mode-toggle');
    const privBtn = document.getElementById('priv-btn');
    const msg = document.getElementById('msg');
    
    // Remove both classes first
    banner.classList.remove('inquiry-mode', 'private-mode', 'no-privacy');
    
    // Add appropriate mode class
    if (currentMode === 'inquiry') {
        banner.classList.add('inquiry-mode');
    }
    
    // Privacy visuals
    if (isPrivate) {
        banner.classList.add('private-mode');
    } else {
        banner.classList.add('no-privacy');
    }
    
    if (modeBtn) {
        modeBtn.innerText = currentMode === 'triage' ? '🚨 TRIAGE CHAT' : '📘 INQUIRY CHAT';
        modeBtn.style.background = 'white';
        modeBtn.style.color = 'var(--dark)';
    }

    if (privBtn) {
        privBtn.classList.toggle('is-private', isPrivate);
        privBtn.innerText = isPrivate ? 'LOGGING: OFF' : 'LOGGING: ON';
        privBtn.style.background = isPrivate ? 'var(--triage)' : '#333';
        privBtn.style.border = isPrivate ? '2px solid #fff' : '1px solid #222';
    }

    if (msg) {
        msg.placeholder = currentMode === 'triage' ? "Describe what's happening" : "Ask your question";
    }
}

function togglePriv() {
    isPrivate = !isPrivate;
    const btn = document.getElementById('priv-btn');
    btn.style.background = isPrivate ? 'var(--triage)' : '#333';
    btn.style.border = isPrivate ? '2px solid #fff' : '1px solid #222';
    btn.innerText = isPrivate ? 'LOGGING: OFF' : 'LOGGING: ON';
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
        const patientVal = document.getElementById('p-select').value;
        try { localStorage.setItem(LAST_PATIENT_KEY, patientVal); } catch (err) { /* ignore */ }
        fd.append('patient', patientVal);
        fd.append('mode', currentMode);
        fd.append('private', isPrivate);
        fd.append('model_choice', document.getElementById('model-select').value);
        
        const res = await (await fetch('/api/chat', {method:'POST', body:fd, credentials:'same-origin'})).json();
        
        // Remove loading indicator
        loadingDiv.remove();
        
        if (res.error) {
            display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>ERROR:</b> ${res.error}</div>`;
        } else {
            const parsed = (window.marked && typeof window.marked.parse === 'function')
                ? window.marked.parse(res.response || '')
                : (res.response || '').replace(/\n/g, '<br>');
            display.innerHTML += `<div class="response-block"><b>[${res.model}]</b><br>${parsed}</div>`;
        }
        
        if (!promptText) {
            document.getElementById('msg').value = '';
        }
        try { localStorage.setItem(LAST_PROMPT_KEY, lastPrompt); } catch (err) { /* ignore storage issues */ }
        if (display.lastElementChild) display.lastElementChild.scrollIntoView({behavior:'smooth'});
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
    console.log('[DEBUG] chat.js DOMContentLoaded');
    const msgTextarea = document.getElementById('msg');
    if (msgTextarea) {
        msgTextarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                runChat();
            }
        });
    }
    const savedPrompt = localStorage.getItem(LAST_PROMPT_KEY);
    if (savedPrompt) lastPrompt = savedPrompt;

    // Debug current patient select state
    const pSelect = document.getElementById('p-select');
    if (pSelect) {
        console.log('[DEBUG] p-select initial options', pSelect.options.length, Array.from(pSelect.options).map(o => o.value));
    } else {
        console.warn('[DEBUG] p-select not found on DOMContentLoaded');
    }
});

function toggleMode() {
    currentMode = currentMode === 'triage' ? 'inquiry' : 'triage';
    updateUI();
}
