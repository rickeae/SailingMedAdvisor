// Chat/Triage functionality

let isPrivate = false;
let lastPrompt = '';
let isProcessing = false;
let currentMode = 'triage';
const LAST_PROMPT_KEY = 'sailingmed:lastPrompt';
const LAST_PATIENT_KEY = 'sailingmed:lastPatient';
const LAST_CHAT_MODE_KEY = 'sailingmed:lastChatMode';
const LOGGING_MODE_KEY = 'sailingmed:loggingOff';
const PROMPT_PREVIEW_STATE_KEY = 'sailingmed:promptPreviewOpen';
const PROMPT_PREVIEW_CONTENT_KEY = 'sailingmed:promptPreviewContent';
const CHAT_STATE_KEY = 'sailingmed:chatState';
let triageSamples = [];
let chatMetrics = {}; // { model: {count, total_ms, avg_ms}}

async function loadChatMetrics() {
    try {
        const res = await fetch('/api/chat/metrics', { credentials: 'same-origin' });
        const data = await res.json();
        if (res.ok && data && typeof data.metrics === 'object') {
            chatMetrics = data.metrics || {};
        }
    } catch (err) {
        console.warn('[chat] unable to load chat metrics', err);
    }
}

function escapeHtml(str) {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function loadTriageSamples() {
    if (triageSamples.length) return triageSamples;
    try {
        const res = await fetch('/static/data/triage_samples.json', { cache: 'no-store' });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        triageSamples = await res.json();
        const select = document.getElementById('triage-sample-select');
        if (select && Array.isArray(triageSamples)) {
            triageSamples.forEach((s) => {
                const opt = document.createElement('option');
                opt.value = String(s.id);
                opt.textContent = `${s.id}. ${s.situation}`;
                select.appendChild(opt);
            });
        }
    } catch (err) {
        console.warn('Unable to load triage samples', err);
    }
    return triageSamples;
}

function setSelectValue(selectEl, value) {
    if (!selectEl) return;
    const match = Array.from(selectEl.options).find(o => o.value === value || o.textContent === value);
    if (match) {
        selectEl.value = match.value;
        return;
    }
    const opt = new Option(value, value, true, true);
    selectEl.add(opt);
    selectEl.value = value;
}

function applyTriageSample(sampleId) {
    if (!sampleId) return;
    const sample = triageSamples.find((s) => String(s.id) === String(sampleId));
    if (!sample) return;
    const msgTextarea = document.getElementById('msg');
    if (msgTextarea) {
        msgTextarea.value = sample.chat_text || '';
        msgTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setSelectValue(document.getElementById('triage-consciousness'), sample.responsive || '');
    setSelectValue(document.getElementById('triage-breathing-status'), sample.breathing || '');
    setSelectValue(document.getElementById('triage-pain-level'), sample.pain || '');
    setSelectValue(document.getElementById('triage-main-problem'), sample.main_problem || '');
    setSelectValue(document.getElementById('triage-temperature'), sample.temp || '');
    setSelectValue(document.getElementById('triage-circulation'), sample.circulation || '');
    setSelectValue(document.getElementById('triage-cause'), sample.cause || '');
    persistChatState();
}

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
    const msgTextarea = document.getElementById('msg');
    if (msgTextarea && !msgTextarea.dataset.stateBound) {
        msgTextarea.dataset.stateBound = 'true';
        msgTextarea.addEventListener('input', () => {
            persistChatState();
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
    bindTriageMetaRefresh();
    applyChatState(currentMode);
    loadChatMetrics().catch(() => {});
} else {
    document.addEventListener('DOMContentLoaded', setupPromptInjectionPanel, { once: true });
    document.addEventListener('DOMContentLoaded', bindTriageMetaRefresh, { once: true });
    document.addEventListener('DOMContentLoaded', () => applyChatState(currentMode), { once: true });
    document.addEventListener('DOMContentLoaded', () => loadChatMetrics().catch(() => {}), { once: true });
}

document.addEventListener('DOMContentLoaded', () => {
    try {
        const stored = localStorage.getItem(LOGGING_MODE_KEY);
        if (stored === '1') {
            isPrivate = true;
        }
    } catch (err) { /* ignore */ }
    const btn = document.getElementById('priv-btn');
    if (btn) {
        btn.style.background = isPrivate ? 'var(--triage)' : '#333';
        btn.style.border = isPrivate ? '2px solid #fff' : '1px solid #222';
        btn.innerText = isPrivate ? 'LOGGING: OFF' : 'LOGGING: ON';
    }
});

function updateUI() {
    const banner = document.getElementById('banner');
    const modeSelect = document.getElementById('mode-select');
    const privBtn = document.getElementById('priv-btn');
    const msg = document.getElementById('msg');
    const queryTitle = document.getElementById('query-form-title');
    const runBtn = document.getElementById('run-btn');
    const modelSelect = document.getElementById('model-select');
    
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
    
    if (modeSelect) {
        modeSelect.value = currentMode;
        modeSelect.style.background = currentMode === 'triage' ? '#ffecec' : '#e6f5ec';
    }
    const triageMeta = document.getElementById('triage-meta-selects');
    if (triageMeta) {
        triageMeta.style.display = currentMode === 'triage' ? 'grid' : 'none';
    }
    if (queryTitle) {
        queryTitle.innerText = currentMode === 'triage' ? 'Triage Chat Prompt Detail' : 'Inquiry Chat Prompt Detail';
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
    // Default model to 4B on load
    if (modelSelect && !modelSelect.value) {
        modelSelect.value = 'google/medgemma-1.5-4b-it';
    }
}

function bindTriageMetaRefresh() {
    const ids = [
        'triage-consciousness',
        'triage-breathing-status',
        'triage-pain-level',
        'triage-main-problem',
        'triage-temperature',
        'triage-circulation',
        'triage-cause',
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el && !el.dataset.tmodeBound) {
            el.dataset.tmodeBound = 'true';
            el.addEventListener('change', () => {
                persistChatState();
                refreshPromptPreview(true);
            });
        }
    });
}

function loadChatState() {
    try {
        const raw = localStorage.getItem(CHAT_STATE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed ? parsed : {};
    } catch (err) {
        return {};
    }
}

function persistChatState(modeOverride) {
    const mode = modeOverride || currentMode;
    const state = loadChatState();
    const msgEl = document.getElementById('msg');
    state[mode] = state[mode] || {};
    state[mode].msg = msgEl ? msgEl.value : '';
    if (mode === 'triage') {
        const ids = [
            'triage-consciousness',
            'triage-breathing-status',
            'triage-pain-level',
            'triage-main-problem',
            'triage-temperature',
            'triage-circulation',
            'triage-cause',
        ];
        state[mode].fields = {};
        ids.forEach((id) => {
            const el = document.getElementById(id);
            if (el) state[mode].fields[id] = el.value || '';
        });
    }
    try { localStorage.setItem(CHAT_STATE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
}

function applyChatState(modeOverride) {
    const mode = modeOverride || currentMode;
    const state = loadChatState();
    const modeState = state[mode] || {};
    const msgEl = document.getElementById('msg');
    if (msgEl && typeof modeState.msg === 'string') {
        msgEl.value = modeState.msg;
    }
    if (mode === 'triage' && modeState.fields && typeof modeState.fields === 'object') {
        Object.entries(modeState.fields).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el) el.value = val;
        });
    }
}

function togglePriv() {
    isPrivate = !isPrivate;
    const btn = document.getElementById('priv-btn');
    btn.style.background = isPrivate ? 'var(--triage)' : '#333';
    btn.style.border = isPrivate ? '2px solid #fff' : '1px solid #222';
    btn.innerText = isPrivate ? 'LOGGING: OFF' : 'LOGGING: ON';
    try { localStorage.setItem(LOGGING_MODE_KEY, isPrivate ? '1' : '0'); } catch (err) { /* ignore */ }
    updateUI();
}

async function runChat(promptText = null, force28b = false) {
    const txt = promptText || document.getElementById('msg').value;
    if(!txt || isProcessing) return;
    
    isProcessing = true;
    lastPrompt = txt;
    const startTime = Date.now();
    const blocker = document.getElementById('chat-blocker');
    const modelName = document.getElementById('model-select').value || 'google/medgemma-1.5-4b-it';
    if (blocker) {
        const title = blocker.querySelector('h3');
        if (title) title.textContent = currentMode === 'triage' ? 'Processing Triage Chat…' : 'Processing Inquiry Chat…';
        const modelLine = document.getElementById('chat-model-line');
        const etaLine = document.getElementById('chat-eta-line');
        if (modelLine) modelLine.textContent = `Model: ${modelName}`;
        const avgMs = (chatMetrics[modelName]?.avg_ms) || (modelName.toLowerCase().includes('27b') ? 60000 : 20000);
        const eta = new Date(Date.now() + avgMs);
        if (etaLine) etaLine.textContent = `Expected finish: ~${eta.toLocaleTimeString()} (avg ${Math.round(avgMs/1000)}s)`;
        blocker.style.display = 'flex';
    }
    
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
        fd.append('model_choice', modelName);
        fd.append('force_28b', force28b ? 'true' : 'false');
        if (currentMode === 'triage') {
            fd.append('triage_consciousness', document.getElementById('triage-consciousness')?.value || '');
            fd.append('triage_breathing_status', document.getElementById('triage-breathing-status')?.value || '');
            fd.append('triage_pain_level', document.getElementById('triage-pain-level')?.value || '');
            fd.append('triage_main_problem', document.getElementById('triage-main-problem')?.value || '');
            fd.append('triage_temperature', document.getElementById('triage-temperature')?.value || '');
            fd.append('triage_circulation', document.getElementById('triage-circulation')?.value || '');
            fd.append('triage_cause', document.getElementById('triage-cause')?.value || '');
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
            if (res.model && res.model_metrics) {
                chatMetrics[res.model] = res.model_metrics;
            }
            if (typeof loadData === 'function') {
                loadData(); // refresh crew history/logs after a chat completes
            }
        }
        
        // Keep user-entered text so they can tweak/re-run
        persistChatState();
        try {
            localStorage.setItem(LAST_PROMPT_KEY, lastPrompt);
            localStorage.setItem(LAST_CHAT_MODE_KEY, currentMode);
        } catch (err) { /* ignore storage issues */ }
        if (display.lastElementChild) display.lastElementChild.scrollIntoView({behavior:'smooth'});
    } catch (error) {
        loadingDiv.remove();
        display.innerHTML += `<div class="response-block" style="border-left-color:var(--red);"><b>ERROR:</b> ${error.message}</div>`;
    } finally {
        isProcessing = false;
        const blocker = document.getElementById('chat-blocker');
        if (blocker) blocker.style.display = 'none';
        document.getElementById('run-btn').disabled = false;
        document.getElementById('repeat-btn').disabled = false;
    }
}

function restoreLast() {
    // Restore last mode used
    let modeToRestore = currentMode;
    try {
        const storedMode = localStorage.getItem(LAST_CHAT_MODE_KEY);
        if (storedMode) modeToRestore = storedMode;
    } catch (_) { /* ignore */ }
    if (modeToRestore !== currentMode) {
        setMode(modeToRestore);
    }
    const state = loadChatState();
    const modeState = state[modeToRestore] || {};
    const msgEl = document.getElementById('msg');
    if (msgEl && typeof modeState.msg === 'string') {
        msgEl.value = modeState.msg;
        msgEl.focus();
    }
    if (modeToRestore === 'triage' && modeState.fields && typeof modeState.fields === 'object') {
        Object.entries(modeState.fields).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el) el.value = val;
        });
    }
    // Restore patient selection
    const patientSelect = document.getElementById('p-select');
    if (patientSelect) {
        const savedPatient = (() => {
            try { return localStorage.getItem(LAST_PATIENT_KEY) || ''; } catch (_) { return ''; }
        })();
        if (savedPatient && Array.from(patientSelect.options).some(o => o.value === savedPatient)) {
            patientSelect.value = savedPatient;
        }
    }
    // Restore prompt preview if cached
    const promptBox = document.getElementById('prompt-preview');
    const promptHeader = document.getElementById('prompt-preview-header');
    if (promptBox) {
        try {
            const cached = localStorage.getItem(PROMPT_PREVIEW_CONTENT_KEY);
            if (cached) {
                promptBox.value = cached;
                promptBox.dataset.autofilled = 'false';
                if (promptHeader) togglePromptPreviewArrow(promptHeader, true);
            }
        } catch (_) { /* ignore */ }
    }
    alert('Last chat restored to editor. You can revise and resend.');
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
    loadTriageSamples().catch(() => {});

    // Debug current patient select state
    const pSelect = document.getElementById('p-select');
    if (pSelect) {
        console.log('[DEBUG] p-select initial options', pSelect.options.length, Array.from(pSelect.options).map(o => o.value));
    } else {
        console.warn('[DEBUG] p-select not found on DOMContentLoaded');
    }
});

async function reactivateChat(historyId) {
    try {
        const res = await fetch('/api/data/history', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`History load failed (${res.status})`);
        const data = await res.json();
        const entry = Array.isArray(data) ? data.find((h) => h.id === historyId) : null;
        if (!entry) {
            alert('Unable to reactivate: history entry not found.');
            return;
        }
        const sameThread = Array.isArray(data)
            ? data
                .filter((h) => {
                    const samePatient = (entry.patient_id && h.patient_id === entry.patient_id) || (entry.patient && h.patient === entry.patient);
                    const sameMode = (entry.mode || 'triage') === (h.mode || 'triage');
                    return samePatient && sameMode;
                })
                .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
            : [entry];
        const transcript = sameThread
            .map((h, idx) => {
                const title = h.date ? `Entry ${idx + 1} — ${h.date}` : `Entry ${idx + 1}`;
                return `${title}\nQUERY:\n${h.query || ''}\nRESPONSE:\n${h.response || ''}`;
            })
            .join('\n\n----\n\n');
        // Set mode based on stored value if present
        if (entry.mode) {
            setMode(entry.mode);
        }
        // Navigate to the correct tab
        const triageTabBtn = document.querySelector('.tab.tab-triage');
        if (triageTabBtn) {
            triageTabBtn.click();
        }
        // Attempt to restore patient selection using patient_id first, then name
        const patientSelect = document.getElementById('p-select');
        if (patientSelect) {
            let targetVal = entry.patient_id || '';
            if (targetVal && Array.from(patientSelect.options).some((o) => o.value === targetVal)) {
                patientSelect.value = targetVal;
            } else if (entry.patient) {
                const matchByName = Array.from(patientSelect.options).find((o) => o.textContent === entry.patient);
                if (matchByName) patientSelect.value = matchByName.value;
            }
            try { localStorage.setItem(LAST_PATIENT_KEY, patientSelect.value || ''); } catch (err) { /* ignore */ }
        }
        // Restore chat area with previous exchange
        const display = document.getElementById('display');
        if (display) {
            const queryHtml = escapeHtml(entry.query || '').replace(/\n/g, '<br>');
            const respHtml = escapeHtml(entry.response || '').replace(/\n/g, '<br>');
            display.innerHTML = `
                <div class="response-block" style="border-left-color:var(--inquiry);">
                    <b>Reactivated Chat</b><br>
                    <div style="margin-top:6px;"><strong>Query:</strong><br>${queryHtml}</div>
                    <div style="margin-top:6px;"><strong>Response:</strong><br>${respHtml}</div>
                </div>`;
            display.scrollTop = display.scrollHeight;
        }
        // Prefill message box with last query so user can continue
        const msgTextarea = document.getElementById('msg');
        if (msgTextarea) {
            msgTextarea.value = entry.query || '';
            msgTextarea.focus();
        }
        // Restore prompt (injected) view if available
        const promptBox = document.getElementById('prompt-preview');
        const promptHeader = document.getElementById('prompt-preview-header');
        if (promptBox && entry.prompt) {
            promptBox.value = entry.prompt;
            promptBox.dataset.autofilled = 'false';
            try { localStorage.setItem(PROMPT_PREVIEW_CONTENT_KEY, entry.prompt); } catch (err) { /* ignore */ }
            if (promptHeader) {
                togglePromptPreviewArrow(promptHeader, true);
            }
        }
        // Inject transcript into prompt preview so the model sees prior context
        if (promptBox) {
            const transcriptBlock = transcript ? `Previous chat transcript:\n${transcript}` : '';
            const combined = [transcriptBlock, promptBox.value].filter(Boolean).join('\n\n');
            promptBox.value = combined;
            promptBox.dataset.autofilled = 'false';
            try { localStorage.setItem(PROMPT_PREVIEW_CONTENT_KEY, combined); } catch (err) { /* ignore */ }
            if (promptHeader) {
                togglePromptPreviewArrow(promptHeader, true);
            }
            const container = document.getElementById('prompt-preview-container');
            if (container) container.style.display = 'block';
        }
        // Persist last prompt locally
        if (entry.query) {
            lastPrompt = entry.query;
            try { localStorage.setItem(LAST_PROMPT_KEY, entry.query); } catch (err) { /* ignore */ }
        }
        alert('Chat restored. You can continue the conversation.');
    } catch (err) {
        alert(`Unable to reactivate chat: ${err.message}`);
    }
}

window.reactivateChat = reactivateChat;
window.applyTriageSample = applyTriageSample;

function setMode(mode) {
    const target = mode === 'inquiry' ? 'inquiry' : 'triage';
    if (target === currentMode) return;
    // Save current mode state before switching
    persistChatState(currentMode);
    currentMode = target;
    updateUI();
    const select = document.getElementById('mode-select');
    if (select) {
        select.value = target;
    }
    applyChatState(target);
    const container = document.getElementById('prompt-preview-container');
    if (container && container.style.display === 'block') {
        refreshPromptPreview();
    }
}

function toggleMode() {
    setMode(currentMode === 'triage' ? 'inquiry' : 'triage');
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
    if (currentMode === 'triage') {
        fd.append('triage_consciousness', document.getElementById('triage-consciousness')?.value || '');
        fd.append('triage_breathing_status', document.getElementById('triage-breathing-status')?.value || '');
        fd.append('triage_pain_level', document.getElementById('triage-pain-level')?.value || '');
        fd.append('triage_main_problem', document.getElementById('triage-main-problem')?.value || '');
        fd.append('triage_temperature', document.getElementById('triage-temperature')?.value || '');
        fd.append('triage_circulation', document.getElementById('triage-circulation')?.value || '');
        fd.append('triage_cause', document.getElementById('triage-cause')?.value || '');
    }
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
