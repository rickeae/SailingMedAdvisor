// Chat/Triage functionality

let isPrivate = false;
let lastPrompt = '';
let isProcessing = false;
let currentMode = 'triage';
const LAST_PROMPT_KEY = 'sailingmed:lastPrompt';
const LAST_PATIENT_KEY = 'sailingmed:lastPatient';
const PROMPT_PREVIEW_STATE_KEY = 'sailingmed:promptPreviewOpen';
const PROMPT_PREVIEW_CONTENT_KEY = 'sailingmed:promptPreviewContent';

function setupPromptInjectionPanel() {
    const promptHeader = document.getElementById('prompt-preview-header');
    const promptBox = document.getElementById('prompt-preview');
    if (promptHeader && !promptHeader.dataset.bound) {
        promptHeader.dataset.bound = 'true';
        promptHeader.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePromptPreviewArrow(promptHeader);
        });
        promptHeader.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                togglePromptPreviewArrow(promptHeader);
            }
        });
    }

    if (promptBox && !promptBox.dataset.inputBound) {
        promptBox.dataset.inputBound = 'true';
        promptBox.addEventListener('input', () => {
            promptBox.dataset.autofilled = 'false';
            try { localStorage.setItem(PROMPT_PREVIEW_CONTENT_KEY, promptBox.value || ''); } catch (err) { /* ignore */ }
        });
    }

    if (promptHeader) {
        let shouldOpen = false;
        try {
            shouldOpen = localStorage.getItem(PROMPT_PREVIEW_STATE_KEY) === 'true';
        } catch (err) { /* ignore */ }
        togglePromptPreviewArrow(promptHeader, shouldOpen);
    }

    // Pre-populate with the default prompt from settings so users can edit immediately
    if (promptBox) {
        try {
            const cached = localStorage.getItem(PROMPT_PREVIEW_CONTENT_KEY);
            if (cached && promptBox.dataset.autofilled !== 'false') {
                promptBox.value = cached;
                promptBox.dataset.autofilled = 'false';
            }
        } catch (err) { /* ignore */ }
    }
    if (promptBox && promptBox.dataset.autofilled !== 'false' && (!promptBox.value || !promptBox.value.trim())) {
        refreshPromptPreview();
    }
}

if (document.readyState !== 'loading') {
    setupPromptInjectionPanel();
} else {
    document.addEventListener('DOMContentLoaded', setupPromptInjectionPanel, { once: true });
}

function updateUI() {
    const banner = document.getElementById('banner');
    const modeBtn = document.getElementById('mode-toggle');
    const privBtn = document.getElementById('priv-btn');
    const msg = document.getElementById('msg');
    const queryTitle = document.getElementById('query-form-title');
    const runBtn = document.getElementById('run-btn');
    const triageMeta = document.getElementById('triage-meta-row');
    
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
    if (queryTitle) {
        queryTitle.innerText = currentMode === 'triage' ? 'New Triage Chat' : 'New Inquiry Chat';
    }

    if (privBtn) {
        privBtn.classList.toggle('is-private', isPrivate);
        privBtn.innerText = isPrivate ? 'LOGGING: OFF' : 'LOGGING: ON';
        privBtn.style.background = isPrivate ? 'var(--triage)' : '#333';
        privBtn.style.border = isPrivate ? '2px solid #fff' : '1px solid #222';
    }

    if (msg) {
        msg.placeholder = currentMode === 'triage' ? "What is the situation?" : "Ask your question";
    }
    if (runBtn) {
        runBtn.innerText = currentMode === 'triage' ? 'SUBMIT FOR TRIAGE' : 'SUBMIT INQUIRY';
        runBtn.style.background = currentMode === 'triage' ? 'var(--triage)' : 'var(--inquiry)';
    }
    if (triageMeta) {
        triageMeta.style.display = currentMode === 'triage' ? 'flex' : 'none';
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

async function runChat(promptText = null, force28b = false) {
    const txt = promptText || document.getElementById('msg').value;
    if(!txt || isProcessing) return;
    
    isProcessing = true;
    lastPrompt = txt;
    const startTime = Date.now();
    
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
        fd.append('force_28b', force28b ? 'true' : 'false');
        if (currentMode === 'triage') {
            fd.append('triage_status', document.getElementById('triage-patient-status')?.value || '');
            fd.append('triage_breathing', document.getElementById('triage-breathing')?.value || '');
            fd.append('triage_bleeding', document.getElementById('triage-bleeding')?.value || '');
            fd.append('triage_incident', document.getElementById('triage-incident')?.value || '');
        }
        const promptEditor = document.getElementById('prompt-preview-container');
        const promptTextarea = document.getElementById('prompt-preview');
        if (promptEditor && promptEditor.style.display === 'block' && promptTextarea && promptTextarea.value.trim()) {
            const composedPrompt = buildOverridePrompt(promptTextarea.value, txt, currentMode);
            if (composedPrompt) {
                fd.append('override_prompt', composedPrompt);
            }
        }
        
        const res = await (await fetch('/api/chat', {method:'POST', body:fd, credentials:'same-origin'})).json();
        const endTime = Date.now();
        
        // Remove loading indicator
        loadingDiv.remove();
        
        if (res.confirm_28b) {
            const ok = confirm(res.error || 'The 28B model on CPU can take an hour or more. Continue?');
            if (ok) {
                isProcessing = false;
                document.getElementById('run-btn').disabled = false;
                document.getElementById('repeat-btn').disabled = false;
                return runChat(promptText || txt, true);
            }
            display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>INFO:</b> ${res.error || 'Cancelled running 28B model.'}</div>`;
        } else if (res.error) {
            display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>ERROR:</b> ${res.error}</div>`;
        } else {
            const durationMs = endTime - startTime;
            const parsed = (window.marked && typeof window.marked.parse === 'function')
                ? window.marked.parse(res.response || '')
                : (res.response || '').replace(/\n/g, '<br>');
            const meta = res.model ? `[${res.model}${res.duration_ms ? ` · ${Math.round(res.duration_ms)} ms` : ` · ${Math.round(durationMs)} ms`}]` : '';
            display.innerHTML += `<div class="response-block"><b>${meta}</b><br>${parsed}</div>`;
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
    setupPromptInjectionPanel();
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
    const container = document.getElementById('prompt-preview-container');
    if (container && container.style.display === 'block') {
        refreshPromptPreview();
    }
}

function cleanPromptWhitespace(text) {
    return (text || '').replace(/\n{3,}/g, '\n\n').trim();
}

function stripUserMessageFromPrompt(promptText, userMessage, mode = currentMode) {
    if (!promptText) return '';
    const msg = (userMessage || '').trim();
    const label = mode === 'inquiry' ? 'QUERY:' : 'SITUATION:';
    const lines = promptText.split('\n');
    const idx = lines.findIndex(line => line.trimStart().startsWith(label));
    if (idx !== -1) {
        const labelPos = lines[idx].indexOf(label);
        const prefix = labelPos >= 0 ? lines[idx].slice(0, labelPos) : '';
        lines[idx] = `${prefix}${label} `;
        return cleanPromptWhitespace(lines.join('\n'));
    }
    if (msg && promptText.includes(msg)) {
        return cleanPromptWhitespace(promptText.replace(msg, ''));
    }
    return cleanPromptWhitespace(promptText);
}

function buildOverridePrompt(basePrompt, userMessage, mode = currentMode) {
    const base = cleanPromptWhitespace(basePrompt);
    const msg = (userMessage || '').trim();
    if (!base) return '';
    if (!msg) return base;
    const label = mode === 'inquiry' ? 'QUERY:' : 'SITUATION:';
    const lines = base.split('\n');
    const idx = lines.findIndex(line => line.trimStart().startsWith(label));
    if (idx !== -1) {
        const labelPos = lines[idx].indexOf(label);
        const prefix = labelPos >= 0 ? lines[idx].slice(0, labelPos) : '';
        lines[idx] = `${prefix}${label} ${msg}`;
        return lines.join('\n');
    }
    return `${base}\n\n${label} ${msg}`;
}

async function refreshPromptPreview(force = false) {
    const msgVal = document.getElementById('msg')?.value || '';
    const patientVal = document.getElementById('p-select')?.value || '';
    const promptBox = document.getElementById('prompt-preview');
    if (!promptBox) return;
    if (!force && promptBox.dataset.autofilled === 'false') return;
    const fd = new FormData();
    fd.append('message', msgVal);
    fd.append('patient', patientVal);
    fd.append('mode', currentMode);
    try {
        const res = await fetch('/api/chat/preview', { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Preview failed (${res.status})`);
        const data = await res.json();
        promptBox.value = stripUserMessageFromPrompt(data.prompt || '', msgVal, data.mode || currentMode);
        promptBox.dataset.autofilled = 'true';
        try { localStorage.setItem(PROMPT_PREVIEW_CONTENT_KEY, promptBox.value); } catch (err) { /* ignore */ }
    } catch (err) {
        promptBox.value = `Unable to build prompt: ${err.message}`;
        promptBox.dataset.autofilled = 'true';
    }
}

function togglePromptPreviewArrow(btn, forceOpen = null) {
    const header = btn || document.getElementById('prompt-preview-header');
    const container = document.getElementById('prompt-preview-container') || header?.nextElementSibling;
    const refreshRow = document.getElementById('prompt-refresh-row') || container?.querySelector('#prompt-refresh-row');
    const icon = header?.querySelector('.detail-icon');
    if (!container || !header) return;
    const shouldOpen = forceOpen === null ? container.style.display !== 'block' : !!forceOpen;
    container.style.display = shouldOpen ? 'block' : 'none';
    if (icon) icon.textContent = shouldOpen ? '▾' : '▸';
    header.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    if (refreshRow) refreshRow.style.display = shouldOpen ? 'flex' : 'none';
    try { localStorage.setItem(PROMPT_PREVIEW_STATE_KEY, shouldOpen ? 'true' : 'false'); } catch (err) { /* ignore */ }
    if (shouldOpen) {
        refreshPromptPreview();
        const promptBox = document.getElementById('prompt-preview') || container.querySelector('#prompt-preview');
        if (promptBox) promptBox.focus();
    }
}

function clearDisplay() {
    const display = document.getElementById('display');
    if (!display) return;
    if (isPrivate) {
        const confirmed = confirm('Logging is OFF. Clear this response? It has not been saved.');
        if (!confirmed) return;
    } else {
        alert('Cleared. Logged responses are available under the crew member in Crew Log & Health.');
    }
    display.innerHTML = '';
}

// Expose inline handlers
window.togglePromptPreviewArrow = togglePromptPreviewArrow;
window.clearDisplay = clearDisplay;
window.refreshPromptPreview = refreshPromptPreview;
