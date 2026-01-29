/*
File: static/js/equipment.js
Author notes: Equipment and medical supplies management.

Key Responsibilities:
- Medical equipment inventory (durable goods: AED, blood pressure cuff, etc.)
- Consumables tracking (bandages, gauze, gloves, syringes, etc.)
- Import/export functionality for equipment lists (TSV format)
- Resource availability trackiang (in-stock vs unavailable)
- Equipment classification and categorization

Equipment Classification:
- 'durable': Medical equipment (reusable, tracked equipment)
- 'consumable': Single-use supplies (tracked by quantity)
- 'medication': Medicines (redirects to pharmacy module)

Data Flow:
- Equipment: /api/data/tools (tools.json)
- Medications: /api/data/inventory (inventory.json)
- Import/Export: TSV files for bulk updates

Integration Points:
- pharmacy.js: Medication management
- main.js: Tab navigation, initial data load
*/

// Utility function imports from utils.js (with fallbacks)
const workspaceHeaders = (window.Utils && window.Utils.workspaceHeaders) ? window.Utils.workspaceHeaders : (extra = {}) => extra;
const fetchJson = (window.Utils && window.Utils.fetchJson) ? window.Utils.fetchJson : async (url, options = {}) => {
    const res = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
    return data;
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

let equipmentCache = [];              // Cached equipment/consumables from server
const equipmentSaveTimers = {};       // Debounce timers for auto-save
let phoneSelectedFiles = [];          // Staged photos from mobile camera
let desktopSelectedFiles = [];        // Staged photos from desktop (drag-drop or picker)
let medPhotoJobs = [];                // Active photo processing jobs
let medPhotoPollTimer = null;         // Polling interval for job status updates
let syncedInventoryJobIds = new Set(); // Track which jobs already synced to pharmacy
let medPhotoDropBound = false;        // Photo drop handler bound flag
let medPhotoMode = 'single';          // Photo import mode

const eqWorkspaceHeaders = workspaceHeaders;

/**
 * Update section header count badges.
 * 
 * Displays item counts in section headers (e.g., "Medical Equipment (12)").
 * 
 * @param {string} id - Element ID of the count badge
 * @param {number} count - Number of items to display
 */
function updateSectionCount(id, count) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = `(${count})`;
    }
}

/**
 * Open mobile photo import overlay.
 * 
 * Mobile-Optimized Flow:
 * 1. Displays full-screen overlay with camera access
 * 2. Shows file input (triggers camera on mobile devices)
 * 3. Provides photo preview and staging area
 * 4. Allows mode selection (single vs grouped)
 * 5. Submits batch to processing queue
 * 
 * Called by phone-only buttons (hidden on desktop via CSS media queries).
 */
async function openPhoneImportView() {
    const overlay = document.getElementById('phone-import-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    // ensure input is present for iOS
    const input = document.getElementById('phone-med-photo-input');
    if (input) input.style.display = 'block';
    bindPhoneInput();
    renderPhonePreview();
}

/**
 * Close mobile photo import overlay.
 * Restores body scroll and hides overlay.
 */
function closePhoneImportView() {
    const overlay = document.getElementById('phone-import-overlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
}

/**
 * Normalize equipment item with default values.
 * 
 * Ensures all expected fields exist with appropriate defaults.
 * Similar to pharmacy's ensurePharmacyDefaults but for equipment/consumables.
 * 
 * Equipment Structure:
 * ```javascript
 * {
 *   id: string,                    // Unique ID (eq-timestamp-random)
 *   name: string,                  // Equipment/consumable name
 *   category: string,              // Category for grouping
 *   type: string,                  // 'durable' | 'consumable' | 'medication'
 *   storageLocation: string,       // Where it's stored
 *   subLocation: string,           // Specific location details
 *   status: string,                // 'In Stock' | 'Out of Stock' | 'Maintenance'
 *   expiryDate: string,            // ISO date for consumables
 *   lastInspection: string,        // ISO date of last inspection
 *   batteryType: string,           // For powered equipment
 *   batteryStatus: string,         // Battery condition
 *   calibrationDue: string,        // ISO date for next calibration
 *   totalQty: string,              // Current quantity
 *   minPar: string,                // Minimum stock level
 *   supplier: string,              // Supplier name
 *   parentId: string,              // For nested equipment (e.g., kit contents)
 *   requiresPower: boolean,        // Needs batteries/power
 *   notes: string,                 // Additional information
 *   excludeFromResources: boolean  // Hide from public resource lists
 * }
 * ```
 * 
 * @param {Object} item - Raw equipment data
 * @returns {Object} Normalized equipment object with all fields
 */
function ensureEquipmentDefaults(item) {
    return {
        id: item.id || `eq-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: item.name || '',
        category: item.category || '',
        type: item.type || 'durable', // durable | consumable
        storageLocation: item.storageLocation || '',
        subLocation: item.subLocation || '',
        status: item.status || 'In Stock',
        expiryDate: item.expiryDate || '',
        lastInspection: item.lastInspection || '',
        batteryType: item.batteryType || '',
        batteryStatus: item.batteryStatus || '',
        calibrationDue: item.calibrationDue || '',
        totalQty: item.totalQty || '',
        minPar: item.minPar || '',
        supplier: item.supplier || '',
        parentId: item.parentId || '',
        requiresPower: item.requiresPower || false,
        notes: item.notes || '',
        excludeFromResources: Boolean(item.excludeFromResources),
    };
}

/**
 * Load and render all equipment from server.
 * 
 * Loading Process:
 * 1. Fetches from /api/data/tools
 * 2. Normalizes all items
 * 3. Classifies into equipment/consumables/medications
 * 4. Renders to appropriate lists
 * 5. Updates section count badges
 * 
 * @param {string} expandId - Optional ID of item to auto-expand after render
 */
async function loadEquipment(expandId = null) {
    const list = document.getElementById('equipment-list');
    if (!list) return;
    list.innerHTML = '';
    try {
        const data = await fetchJson('/api/data/tools');
        equipmentCache = (Array.isArray(data) ? data : []).map(ensureEquipmentDefaults);
        renderEquipment(equipmentCache, expandId);
    } catch (err) {
        updateSectionCount('equipment-count', 0);
        updateSectionCount('consumables-count', 0);
        list.innerHTML = `<div style="color:red;">Error loading equipment: ${err.message}</div>`;
    }
}

/**
 * Classify equipment into category buckets.
 * 
 * Classification Rules:
 * 1. type='medication' OR category contains 'medication' → 'medication'
 * 2. type='consumable' → 'consumable'  
 * 3. Otherwise → 'equipment' (durable goods)
 * 
 * Used to route items to correct display lists and apply appropriate styling.
 * 
 * @param {Object} item - Equipment item to classify
 * @returns {string} 'medication' | 'consumable' | 'equipment'
 */
function classifyEquipment(item) {
    const type = (item.type || '').toLowerCase();
    const category = (item.category || '').toLowerCase();
    if (type === 'medication' || category.includes('medication')) return 'medication';
    if (type === 'consumable') return 'consumable';
    return 'equipment';
}

/**
 * Bind change handler to mobile photo input.
 * 
 * On mobile devices, file input with accept="image/*" automatically
 * triggers the device camera. This handler stages captured photos
 * in the preview area for batch submission.
 * 
 * Uses dataset flag to prevent duplicate binding.
 */
function bindPhoneInput() {
    const input = document.getElementById('phone-med-photo-input');
    if (!input || input.dataset.bound) return;
    input.dataset.bound = 'true';
    input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        phoneSelectedFiles.push(...files);
        renderPhonePreview();
        input.value = '';
    });
}

/**
 * Set medicine photo import mode.
 * 
 * Modes:
 * - 'single': Each photo → separate medication (default)
 * - 'grouped': All photos → one medication (multiple angles)
 * 
 * Updates UI labels to explain current mode behavior.
 * 
 * @param {string} mode - 'single' or 'grouped'
 */
function setMedPhotoMode(mode) {
    medPhotoMode = mode === 'grouped' ? 'grouped' : 'single';
    const labels = document.querySelectorAll('[data-med-photo-mode-label]');
    labels.forEach((el) => {
        if (medPhotoMode === 'grouped') {
            el.textContent = 'Import these photos as one medicine record';
        } else {
            el.textContent = 'Import each photo as its own medicine';
        }
    });
}

/**
 * Render preview of staged mobile photos.
 * 
 * Creates thumbnail cards for each photo with:
 * - Photo number label
 * - Image preview (160px height)
 * - Remove button
 * 
 * Updates count badge showing total photos ready for import.
 */
function renderPhonePreview() {
    const preview = document.getElementById('phone-photo-preview');
    const count = document.getElementById('phone-photo-count');
    if (count) count.textContent = phoneSelectedFiles.length ? `${phoneSelectedFiles.length} photo(s) ready` : 'No photos selected.';
    if (!preview) return;
    preview.innerHTML = '';
    phoneSelectedFiles.forEach((file, idx) => {
        const url = URL.createObjectURL(file);
        const box = document.createElement('div');
        box.style.cssText = 'border:1px solid #d0d7e2; border-radius:6px; padding:12px; background:#fff; display:flex; flex-direction:column; gap:8px; width:200px;';
        box.innerHTML = `<div style="font-weight:700;">Photo ${idx + 1}</div><img src="${url}" style="width:100%; height:160px; object-fit:cover; border-radius:4px;"><button class="btn btn-sm" style="background:var(--red); width:100%;" onclick="removePhonePhoto(${idx})">Remove</button>`;
        preview.appendChild(box);
    });
}

/**
 * Render preview of staged desktop photos.
 * 
 * Similar to renderPhonePreview but smaller cards (90px height) optimized
 * for desktop layout where multiple photos appear side-by-side.
 */
function renderDesktopPreview() {
    const preview = document.getElementById('med-photo-preview');
    const sel = document.getElementById('med-photo-selected');
    if (sel) sel.textContent = desktopSelectedFiles.length ? `${desktopSelectedFiles.length} file(s) selected` : 'No files selected.';
    if (!preview) return;
    preview.innerHTML = '';
    desktopSelectedFiles.forEach((file, idx) => {
        const url = URL.createObjectURL(file);
        const box = document.createElement('div');
        box.style.cssText = 'border:1px solid #d0d7e2; border-radius:6px; padding:6px; background:#fff; display:flex; flex-direction:column; gap:6px; width:140px;';
        box.innerHTML = `<div style="font-size:11px; font-weight:700;">Photo ${idx + 1}</div><img src="${url}" style="width:100%; height:90px; object-fit:cover; border-radius:4px;"><button class="btn btn-sm" style="background:var(--red); width:100%;" onclick="removeDesktopPhoto(${idx})">Remove</button>`;
        preview.appendChild(box);
    });
}

/**
 * Render medicine photo processing job queue.
 * 
 * Displays all active jobs (queued, processing, completed, failed) with:
 * - Status badge (color-coded by state)
 * - Photo thumbnails
 * - Extracted medication info (when available)
 * - Model used for extraction
 * - Retry button (for failed jobs)
 * - Delete button (all jobs)
 * 
 * Renders to both desktop and mobile containers for consistent experience.
 * 
 * Job Status States:
 * - queued: Yellow badge, awaiting processing
 * - processing: Blue badge, AI model actively extracting
 * - completed: Green badge, synced to inventory
 * - failed: Red badge, extraction error (can retry)
 * 
 * Auto-sync Feature:
 * Completed jobs with inventory_id automatically trigger pharmacy reload
 * to show newly imported medications.
 */
function renderMedPhotoJobs() {
    const container = document.getElementById('med-photo-queue');
    const phoneContainer = document.getElementById('phone-import-queue');
    const renderTarget = (el) => {
        if (!el) return;
        if (!medPhotoJobs.length) {
            el.innerHTML =
                '<div style="padding:8px; border:1px dashed #d8e0f0; border-radius:8px; color:#555; background:#f9fbff;">No photo jobs yet.</div>';
            return;
        }
        const statusColors = {
            queued: { bg: '#fff7e0', color: '#a66b00', label: 'Queued' },
            processing: { bg: '#e3f2fd', color: '#1565c0', label: 'Processing' },
            completed: { bg: 'var(--inquiry)', color: '#fff', label: 'Done' },
            failed: { bg: '#ffebee', color: '#c62828', label: 'Failed' },
        };
        el.innerHTML = medPhotoJobs
            .map((job) => {
                const status = statusColors[job.status] || statusColors.queued;
                const thumbs = Array.isArray(job.urls) ? job.urls : [];
                const thumbHtml =
                    thumbs && thumbs.length
                        ? thumbs
                              .map(
                                  (u, idx) =>
                                      `<img src="${u}" alt="Photo ${idx + 1}" style="width:60px; height:60px; object-fit:cover; border:1px solid #ccc; border-radius:6px;">`
                              )
                              .join('<span style="width:6px;"></span>')
                        : '';
                const summary = job.result || {};
                const title =
                    [summary.genericName, summary.brandName, summary.strength].filter(Boolean).join(' · ') ||
                    summary.raw ||
                    'Awaiting processing';
                const modelLabel = job.used_model || job.preferred_model || '';
                const modelLine = modelLabel ? `<div style="font-size:12px; color:#555;">Model: ${modelLabel}</div>` : '';
                const err = job.error ? `<div style="font-size:12px; color:#c62828; margin-top:4px;">${job.error}</div>` : '';
                const retryBtn =
                    job.status === 'failed'
                        ? `<button class="btn btn-sm" style="background:var(--dark);" onclick="retryMedPhotoJob('${job.id}')">Retry</button>`
                        : '';
                const deleteBtn = `<button class="btn btn-sm" style="background:var(--red);" onclick="deleteMedPhotoJob('${job.id}')">Delete</button>`;
                return `
                <div style="border:1px solid #d9e5f7; border-radius:8px; padding:10px; background:#fff; margin-bottom:8px;">
                    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px;">
                        <span style="font-size:12px; font-weight:800; padding:2px 8px; border-radius:999px; background:${status.bg}; color:${status.color};">${status.label}</span>
                        <span style="font-size:12px; color:#555;">Mode: ${job.mode || 'single'}</span>
                        ${modelLabel ? `<span style="font-size:12px; color:#555;">Model: ${modelLabel}</span>` : ''}
                        ${job.inventory_id ? `<span style="font-size:12px; color:var(--inquiry);">Added to inventory</span>` : ''}
                    </div>
                    <div style="display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap;">
                        ${thumbHtml}
                        <div style="font-weight:700; color:#1f2d3d;">${title}</div>
                    </div>
                    ${modelLine}
                    ${err}
                    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:6px;">
                        ${retryBtn}
                        ${deleteBtn}
                    </div>
                </div>
                `;
            })
            .join('');
    };
    renderTarget(container);
    renderTarget(phoneContainer);
}

/**
 * Load and monitor medicine photo processing queue.
 * 
 * Initialization:
 * 1. Binds drag-and-drop handlers (if not already bound)
 * 2. Fetches current job list from server
 * 3. Renders job status cards
 * 4. Checks for newly completed jobs
 * 5. Auto-syncs completed jobs to pharmacy inventory
 * 6. Starts polling timer (5-second intervals)
 * 
 * Polling Strategy:
 * Continuously polls /api/medicines/jobs every 5 seconds to update
 * job statuses in real-time. Shows progress as AI model processes photos.
 * 
 * Auto-Sync Logic:
 * Tracks which jobs have already been synced (syncedInventoryJobIds set).
 * When a job completes and has inventory_id, triggers loadPharmacy() once
 * to refresh medication list with newly imported items.
 * 
 * Called By:
 * - Equipment tab initialization
 * - After submitting new photo batch
 * - Manual refresh requests
 */
async function loadMedPhotoQueue() {
    bindMedPhotoDrop();
    const fetchJobs = async () => {
        try {
            const data = await fetchJson('/api/medicines/jobs', { headers: eqWorkspaceHeaders() });
            medPhotoJobs = Array.isArray(data.jobs) ? data.jobs : [];
            renderMedPhotoJobs();
            const newlyCompleted = medPhotoJobs.filter((j) => j.status === 'completed' && j.inventory_id && !syncedInventoryJobIds.has(j.id));
            if (newlyCompleted.length && typeof loadPharmacy === 'function') {
                loadPharmacy();
                newlyCompleted.forEach((j) => syncedInventoryJobIds.add(j.id));
            }
        } catch (err) {
            const container = document.getElementById('med-photo-queue');
            if (container) {
                container.innerHTML = `<div style="color:red;">Unable to load photo jobs: ${err.message}</div>`;
            }
            const phoneQueue = document.getElementById('phone-import-queue');
            if (phoneQueue) {
                phoneQueue.innerHTML = `<div style="color:red;">Unable to load photo jobs: ${err.message}</div>`;
            }
        }
    };
    await fetchJobs();
    if (!medPhotoPollTimer) {
        medPhotoPollTimer = setInterval(fetchJobs, 5000);
    }
}

/**
 * Check if file is an image based on MIME type or extension.
 * 
 * Detection Strategy:
 * 1. Check MIME type starts with "image/"
 * 2. Check filename extension (.png, .jpg, .jpeg, .webp, .bmp, .heic, .heif)
 * 
 * Handles edge cases:
 * - Files without MIME type (some mobile browsers)
 * - HEIC/HEIF formats (iOS camera default)
 * - Missing file type metadata
 * 
 * @param {File} file - File object to check
 * @returns {boolean} True if likely an image
 */
function isLikelyImage(file) {
    if (!file) return false;
    const type = (file.type || '').toLowerCase();
    if (type.startsWith('image/')) return true;
    const name = (file.name || '').toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.heic', '.heif'].some((ext) => name.endsWith(ext));
}

function clearDesktopPhotoSelection() {
    const input = document.getElementById('med-photo-input');
    if (input) input.value = '';
    desktopSelectedFiles = [];
    renderDesktopPreview();
}

/**
 * Generate ASCII-safe filename for upload.
 * 
 * Some backend systems struggle with non-ASCII characters (Unicode, emojis)
 * in filenames. This ensures safe transmission and storage.
 * 
 * Strategy:
 * - If filename is pure ASCII (0x20-0x7E), use original
 * - Otherwise, generate: phone-photo-[timestamp]-[index].jpg
 * 
 * Use Cases:
 * - iOS photos with special characters
 * - Filenames with non-Latin scripts
 * - Files with emojis or symbols
 * 
 * @param {File} file - File to generate name for
 * @param {number} idx - Index in batch (for uniqueness)
 * @returns {string} ASCII-safe filename
 */
function safeAsciiName(file, idx) {
    const hasAsciiName = file && typeof file.name === 'string' && /^[\x20-\x7E]+$/.test(file.name);
    return hasAsciiName ? file.name : `phone-photo-${Date.now()}-${idx + 1}.jpg`;
}

/**
 * Convert File object to base64 data URL.
 * 
 * Used as fallback when multipart/form-data upload fails (some proxies,
 * firewalls, or network conditions). Allows sending images as JSON strings.
 * 
 * Process:
 * 1. Creates FileReader
 * 2. Reads file as data URL (base64)
 * 3. Returns promise that resolves with data URL string
 * 
 * Format: "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
 * 
 * Trade-off: ~33% larger than binary but more universally compatible.
 * 
 * @param {File} file - File to convert
 * @returns {Promise<string>} Resolves with base64 data URL
 */
function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(file);
    });
}

/**
 * Queue photos using JSON/base64 fallback endpoint.
 * 
 * Fallback Strategy:
 * When multipart/form-data upload fails (corporate proxies, restrictive
 * firewalls, or API gateway limitations), this endpoint accepts photos
 * as base64-encoded JSON payload.
 * 
 * Process:
 * 1. Converts each File to base64 data URL
 * 2. Builds JSON payload with file metadata
 * 3. POSTs to /api/medicines/photos/base64
 * 4. Returns job IDs for tracking
 * 
 * Trade-offs:
 * ✓ Works through restrictive networks
 * ✓ No multipart parsing issues
 * ✗ ~33% larger payload
 * ✗ Higher memory usage
 * ✗ Slower for large batches
 * 
 * @param {Array<File>} images - Image files to queue
 * @param {Object} opts - Options including mode ('single'|'grouped')
 * @returns {Promise<Object>} API response with job IDs
 */
async function queuePhotosViaJson(images, opts = {}) {
    const payload = {
        files: await Promise.all(
            images.map(async (file, idx) => ({
                name: safeAsciiName(file, idx),
                type: file.type || '',
                data: await fileToDataUrl(file),
            }))
        ),
    };
    const res = await fetch(`/api/medicines/photos/base64?mode=${opts.mode || 'single'}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: eqWorkspaceHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
    });
    const rawText = await res.text();
    let data = {};
    try {
        data = rawText ? JSON.parse(rawText) : {};
    } catch (err) {
        data = {};
    }
    if (!res.ok || data.error) throw new Error(data.error || rawText || `Status ${res.status}`);
    return data;
}

/**
 * Import medicine photos with automatic fallback handling.
 * 
 * Primary Import Path (Multipart Upload):
 * 1. Filters to image files only
 * 2. Generates safe ASCII filenames
 * 3. Builds FormData with files
 * 4. POSTs to /api/medicines/photos
 * 5. Creates job entries in processing queue
 * 
 * Automatic Fallback (Base64/JSON):
 * If multipart upload fails, automatically retries using queuePhotosViaJson()
 * which sends photos as base64-encoded JSON. Most networks accept this.
 * 
 * Status Updates:
 * If statusEl provided, shows progress messages:
 * - "Importing photos…"
 * - "Queued N job(s) from M photo(s)."
 * - "Unable to import: [error]"
 * 
 * Side Effects:
 * - Triggers loadMedPhotoQueue() to start polling
 * - Triggers loadPharmacy() to prepare for new medications
 * 
 * @param {Array<File>} files - Files to import
 * @param {Object} opts - Options: mode, statusEl, __triedJson
 * @returns {Promise<Object>} {success: boolean, jobs: Array}
 */
async function importPhotosFromFiles(files, opts = {}) {
    const images = Array.from(files || []).filter(isLikelyImage);
    if (!images.length) {
        alert('Please select image files.');
        return { success: false };
    }
    const total = images.length;
    const mode = opts.mode || 'single';
    const statusEl = opts.statusEl || null;
    const setStatus = (msg, isError = false) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.style.color = isError ? 'var(--red)' : '#1f2d3d';
    };
    const fd = new FormData();
    images.forEach((file, idx) => {
        const safeName = safeAsciiName(file, idx);
        fd.append('files', file, safeName);
    });
    setStatus('Importing photos…');
    try {
        const res = await fetch(`/api/medicines/photos?mode=${mode}`, {
            method: 'POST',
            body: fd,
            credentials: 'same-origin',
            headers: eqWorkspaceHeaders(),
        });
        const rawText = await res.text();
        let data = {};
        try {
            data = rawText ? JSON.parse(rawText) : {};
        } catch (err) {
            data = {};
        }
        if (!res.ok || data.error) throw new Error(data.error || rawText || `Status ${res.status}`);
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        const count = jobs.length;
        setStatus(`Queued ${count} job(s) from ${total} photo(s).`);
        await loadMedPhotoQueue();
        if (typeof loadPharmacy === 'function') {
            loadPharmacy();
        }
        return { success: true, jobs };
    } catch (err) {
        console.error('Photo import failed', err);
        setStatus(`Unable to import ${total} photo(s): ${err.message}`, true);
        // fallback to JSON if multipart fails
        if (!opts.__triedJson) {
            try {
                const data = await queuePhotosViaJson(images, { mode, __triedJson: true });
                const jobs = Array.isArray(data.jobs) ? data.jobs : [];
                setStatus(`Queued ${jobs.length} job(s) from ${total} photo(s).`);
                await loadMedPhotoQueue();
                if (typeof loadPharmacy === 'function') {
                    loadPharmacy();
                }
                return { success: true, jobs };
            } catch (err2) {
                setStatus(`Unable to import ${total} photo(s): ${err2.message}`, true);
            }
        }
        return { success: false };
    }
}

function removePhonePhoto(idx) {
    phoneSelectedFiles = phoneSelectedFiles.filter((_, i) => i !== idx);
    renderPhonePreview();
}

function removeDesktopPhoto(idx) {
    desktopSelectedFiles = desktopSelectedFiles.filter((_, i) => i !== idx);
    renderDesktopPreview();
}

function getSelectedPhotoMode(prefix = '') {
    const name = prefix ? `${prefix}-med-photo-mode` : 'med-photo-mode';
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    return checked ? checked.value : medPhotoMode;
}

function showImportStatus(id, message, isError = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? 'var(--red)' : '#1f2d3d';
}

async function ensureEquipmentCacheLoaded() {
    if (equipmentCache.length) return equipmentCache;
    const data = await fetchJson('/api/data/tools');
    equipmentCache = (Array.isArray(data) ? data : []).map(ensureEquipmentDefaults);
    return equipmentCache;
}

/**
 * Sanitize value for tab-delimited (TSV) export.
 * 
 * TSV Requirements:
 * - No tab characters (field delimiter)
 * - No newlines (row delimiter)
 * - Consistent whitespace
 * 
 * Transformations:
 * - Tabs → spaces
 * - Newlines → spaces  
 * - Trim leading/trailing whitespace
 * - Null/undefined → empty string
 * 
 * @param {any} value - Value to sanitize
 * @returns {string} TSV-safe string
 */
function sanitizeTSVField(value) {
    const text = value == null ? '' : value.toString();
    return text.replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
}

/**
 * Build tab-delimited (TSV) content from equipment items.
 * 
 * TSV Format (3 columns):
 * Name    Quantity    Comment
 * 
 * Features:
 * - Alphabetically sorted by name
 * - Sanitized fields (no tabs/newlines)
 * - Customizable comment column via commentFn
 * - Filters empty rows
 * 
 * Compatible with Excel, Google Sheets, Numbers, and text editors.
 * 
 * @param {Array<Object>} items - Equipment items to export
 * @param {Function} commentFn - Function to extract comment from item
 * @returns {string} TSV-formatted text
 */
function buildTabDelimitedContent(items, commentFn) {
    const rows = [...items]
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
        .map((item) => {
            const name = sanitizeTSVField(item.name);
            const quantity = sanitizeTSVField(item.totalQty);
            const comment = sanitizeTSVField(typeof commentFn === 'function' ? commentFn(item) : item.notes);
            return [name, quantity, comment].join('\t');
        })
        .filter((line) => line.trim());
    return rows.join('\n');
}

/**
 * Trigger browser download of TSV file.
 * 
 * Process:
 * 1. Creates Blob with TSV MIME type
 * 2. Generates object URL
 * 3. Creates temporary <a> element
 * 4. Triggers click to start download
 * 5. Cleans up object URL after 1.5s
 * 
 * MIME Type: text/tab-separated-values
 * 
 * @param {string} filename - Suggested filename for download
 * @param {string} content - TSV-formatted content
 */
function downloadTabDelimitedFile(filename, content) {
    const blob = new Blob([content], { type: 'text/tab-separated-values' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function importDesktopMedicinePhotos() {
    const input = document.getElementById('med-photo-input');
    const statusEl = document.getElementById('med-photo-status');
    if (!desktopSelectedFiles.length) {
        alert('Select one or more medicine photos first.');
        return;
    }
    const mode = getSelectedPhotoMode('desktop');
    await importPhotosFromFiles(desktopSelectedFiles, { mode, statusEl });
    clearDesktopPhotoSelection();
}

async function importPhoneMedicinePhotos() {
    const statusEl = document.getElementById('phone-photo-status');
    if (!phoneSelectedFiles.length) {
        alert('Tap to take one or more medicine photos first.');
        return;
    }
    const mode = getSelectedPhotoMode('phone');
    await importPhotosFromFiles(phoneSelectedFiles, { mode, statusEl });
    phoneSelectedFiles = [];
    renderPhonePreview();
}

async function retryMedPhotoJob(id) {
    try {
        const res = await fetch(`/api/medicines/jobs/${id}/retry`, { method: 'POST', credentials: 'same-origin', headers: eqWorkspaceHeaders() });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
        medPhotoJobs = Array.isArray(data.jobs) ? data.jobs : medPhotoJobs;
        renderMedPhotoJobs();
    } catch (err) {
        alert(`Unable to retry job: ${err.message}`);
    }
}

async function deleteMedPhotoJob(id) {
    try {
        const res = await fetch(`/api/medicines/jobs/${id}`, { method: 'DELETE', credentials: 'same-origin', headers: eqWorkspaceHeaders() });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `Status ${res.status}`);
        medPhotoJobs = Array.isArray(data.jobs) ? data.jobs : medPhotoJobs.filter((j) => j.id !== id);
        renderMedPhotoJobs();
    } catch (err) {
        alert(`Unable to delete job: ${err.message}`);
    }
}

async function exportConsumables() {
    try {
        const items = await ensureEquipmentCacheLoaded();
        const consumables = items.filter((item) => classifyEquipment(item) === 'consumable');
        if (!consumables.length) {
            showImportStatus('consumables-import-status', 'No consumables available to export.', true);
            return;
        }
        const content = buildTabDelimitedContent(consumables, (item) => item.notes);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadTabDelimitedFile(`consumables-${timestamp}.tsv`, content);
        showImportStatus('consumables-import-status', `Prepared ${consumables.length} consumable(s) for download.`);
    } catch (err) {
        showImportStatus('consumables-import-status', err.message, true);
    }
}

function parseTabDelimitedRows(text) {
    if (typeof text !== 'string') return [];
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const cols = line.split('\t');
            return {
                name: (cols[0] || '').trim(),
                quantity: (cols[1] || '').trim(),
                comment: cols.length > 2 ? cols.slice(2).join('\t').trim() : '',
            };
        })
        .filter((row) => row.name);
}

function parseConsumableFileText(text) {
    return parseTabDelimitedRows(text).map((row) => ({
        name: row.name,
        totalQty: row.quantity,
        notes: row.comment,
        type: 'consumable',
    }));
}

function parseEquipmentFileText(text) {
    return parseTabDelimitedRows(text).map((row) => ({
        name: row.name,
        totalQty: row.quantity,
        notes: row.comment,
        type: 'durable',
    }));
}

function entryNameKey(name) {
    return (name || '').trim().toLowerCase();
}

function buildEntryMap(entries) {
    const map = new Map();
    entries.forEach((entry) => {
        const key = entryNameKey(entry.name);
        if (!key) return;
        map.set(key, entry);
    });
    return map;
}

function mergeEntriesByName(existing, entryMap, targetClassifier) {
    const result = [];
    const usedKeys = new Set();
    (existing || []).forEach((item) => {
        const category = classifyEquipment(item);
        if (category === targetClassifier) {
            const key = entryNameKey(item.name);
            if (entryMap.has(key)) {
                result.push(entryMap.get(key));
                usedKeys.add(key);
                return;
            }
        }
        result.push(item);
    });
    entryMap.forEach((entry, key) => {
        if (!usedKeys.has(key)) {
            result.push(entry);
        }
    });
    return result;
}

async function mergeConsumableImports(entries, statusId) {
    if (!entries.length) {
        showImportStatus(statusId, 'No consumables found in file.', true);
        return;
    }
    const normalized = entries.map((entry) => ensureEquipmentDefaults({ ...entry, type: 'consumable' }));
    const data = await fetchJson('/api/data/tools');
    const existing = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    const entryMap = buildEntryMap(normalized);
    const merged = mergeEntriesByName(existing, entryMap, 'consumable');

    const saveRes = await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
        credentials: 'same-origin',
    });
    if (!saveRes.ok) {
        let detail = '';
        try {
            const err = await saveRes.json();
            detail = err?.error ? `: ${err.error}` : '';
        } catch (_) {}
        throw new Error(`Save failed (${saveRes.status})${detail}`);
    }

    equipmentCache = merged;
    renderEquipment(equipmentCache);
    showImportStatus(statusId, `Imported ${entryMap.size} consumable(s) from file.`);
}

async function mergeEquipmentImports(entries, statusId) {
    if (!entries.length) {
        showImportStatus(statusId, 'No equipment entries found in file.', true);
        return;
    }
    const normalized = entries.map((entry) => ensureEquipmentDefaults({ ...entry, type: 'durable' }));
    const data = await fetchJson('/api/data/tools');
    const existing = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    const entryMap = buildEntryMap(normalized);
    const merged = mergeEntriesByName(existing, entryMap, 'equipment');

    const saveRes = await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
        credentials: 'same-origin',
    });
    if (!saveRes.ok) {
        let detail = '';
        try {
            const err = await saveRes.json();
            detail = err?.error ? `: ${err.error}` : '';
        } catch (_) {}
        throw new Error(`Save failed (${saveRes.status})${detail}`);
    }

    equipmentCache = merged;
    renderEquipment(equipmentCache);
    showImportStatus(statusId, `Imported ${entryMap.size} equipment item(s) from file.`);
}

function openConsumablesFilePicker() {
    const input = document.getElementById('consumables-import-file');
    if (!input) return;
    input.value = '';
    input.click();
}

async function handleConsumablesFileImport(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
        const content = await file.text();
        const entries = parseConsumableFileText(content);
        await mergeConsumableImports(entries, 'consumables-import-status');
    } catch (err) {
        showImportStatus('consumables-import-status', err.message, true);
    } finally {
        if (event?.target) event.target.value = '';
    }
}

function openEquipmentFilePicker() {
    const input = document.getElementById('equipment-import-file');
    if (!input) return;
    input.value = '';
    input.click();
}

async function handleEquipmentFileImport(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    try {
        const content = await file.text();
        const entries = parseEquipmentFileText(content);
        await mergeEquipmentImports(entries, 'equipment-import-status');
    } catch (err) {
        showImportStatus('equipment-import-status', err.message, true);
    } finally {
        if (event?.target) event.target.value = '';
    }
}

async function exportEquipmentItems() {
    try {
        const items = await ensureEquipmentCacheLoaded();
        const equipment = items.filter((item) => classifyEquipment(item) === 'equipment');
        if (!equipment.length) {
            showImportStatus('equipment-import-status', 'No equipment available to export.', true);
            return;
        }
        const content = buildTabDelimitedContent(equipment, (item) => item.notes || item.storageLocation);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadTabDelimitedFile(`equipment-${timestamp}.tsv`, content);
        showImportStatus('equipment-import-status', `Prepared ${equipment.length} equipment item(s) for download.`);
    } catch (err) {
        showImportStatus('equipment-import-status', err.message, true);
    }
}

function bindMedPhotoDrop() {
    if (medPhotoDropBound) return;
    const dropZone = document.getElementById('med-photo-drop');
    const input = document.getElementById('med-photo-input');
    const sel = document.getElementById('med-photo-selected');
    const preview = document.getElementById('med-photo-preview');
    if (!dropZone || !input) return;

    const resetStyle = () => {
        dropZone.style.borderColor = '#ccc';
        dropZone.style.background = 'rgba(46, 125, 50, 0.08)';
    };

    dropZone.addEventListener('click', () => input.click());
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--inquiry)';
        dropZone.style.background = 'rgba(46, 125, 50, 0.16)';
    });
    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        resetStyle();
    });
    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        resetStyle();
        if (e.dataTransfer && e.dataTransfer.files) {
            const files = Array.from(e.dataTransfer.files || []).filter(isLikelyImage);
            if (!files.length) {
                alert('Please drop image files only.');
                return;
            }
            desktopSelectedFiles.push(...files);
            renderDesktopPreview();
        }
    });
    input.addEventListener('change', () => {
        const files = Array.from(input.files || []).filter(isLikelyImage);
        if (files.length) {
            desktopSelectedFiles.push(...files);
        }
        renderDesktopPreview();
    });
    medPhotoDropBound = true;
}

/**
 * Render all equipment items to appropriate lists.
 * 
 * Classification and Routing:
 * 1. Classifies each item (equipment/consumable/medication)
 * 2. Routes to correct list container:
 *    - equipment → #equipment-list
 *    - consumable → #consumables-list  
 *    - medication → #medication-list
 * 3. Sorts alphabetically within each category
 * 4. Updates section count badges
 * 
 * Expansion Feature:
 * If expandId provided, auto-expands that specific item's card
 * (useful after adding new item to show it immediately).
 * 
 * @param {Array<Object>} items - All equipment/consumables to render
 * @param {string} expandId - Optional ID of item to auto-expand
 */
function renderEquipment(items, expandId = null) {
    const storeList = document.getElementById('equipment-list');
    const medicationList = document.getElementById('medication-list');
    const consumablesList = document.getElementById('consumables-list');

    const stores = [];
    const meds = [];
    const cons = [];
    (items || []).forEach((item) => {
        const bucket = classifyEquipment(item);
        if (bucket === 'medication') meds.push(item);
        else if (bucket === 'consumable') cons.push(item);
        else stores.push(item);
    });

    const sortByName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    stores.sort(sortByName);
    cons.sort(sortByName);

    if (storeList) {
        storeList.innerHTML = stores.length ? stores.map((item) => renderEquipmentCard(item, expandId)).join('') : '';
    }
    if (medicationList) {
        medicationList.innerHTML = meds.length ? meds.map((item) => renderEquipmentCard(item, expandId)).join('') : '';
    }
    if (consumablesList) {
        consumablesList.innerHTML = cons.length ? cons.map((item) => renderEquipmentCard(item, expandId)).join('') : '';
    }
    updateSectionCount('equipment-count', stores.length);
    updateSectionCount('consumables-count', cons.length);
}

function renderEquipmentCard(item, expandId = null) {
    const itemType = (item.type || '').toLowerCase() || 'durable';
    const isConsumable = itemType === 'consumable';
    const isEquipment = itemType === 'durable';
    const lowStock = item.minPar && Number(item.totalQty) <= Number(item.minPar);
    const expirySoon = item.expiryDate && daysUntil(item.expiryDate) <= 60;
    const headerNote = [lowStock ? 'Low Stock' : null, expirySoon ? 'Expiring Soon' : null, item.status && item.status !== 'In Stock' ? item.status : null]
        .filter(Boolean)
        .join(' · ');
    const title = isConsumable
        ? `${item.name || 'Consumable'}${item.totalQty ? ` — ${item.totalQty}` : ''}`
        : `${item.name || 'Medical Equipment'}${item.totalQty ? ` — ${item.totalQty}` : ''}`;
    const isOpen = expandId && item.id === expandId;
    const bodyDisplay = isOpen ? 'display:block;' : '';
    const arrow = isOpen ? '▾' : '▸';
    // Palette: equipment stays green; consumables match pink shell (#f7eefc / #fcf7ff).
    const headerBg = isConsumable
        ? (item.excludeFromResources ? '#ffecef' : '#f7eefc')
        : (item.excludeFromResources ? '#ffecef' : '#e8fdef');
    const headerBorderColor = isConsumable
        ? (item.excludeFromResources ? '#ffcbd3' : '#dec9f7')
        : (item.excludeFromResources ? '#ffbfbf' : '#bde8c8');
    const bodyBg = isConsumable
        ? (item.excludeFromResources ? '#fff7f8' : '#fcf7ff')
        : (item.excludeFromResources ? '#fff6f6' : '#f7fff7');
    const bodyBorderColor = isConsumable
        ? (item.excludeFromResources ? '#ffdbe2' : '#e6d7fb')
        : (item.excludeFromResources ? '#ffcfd0' : '#cfe9d5');
    const badgeColor = item.excludeFromResources ? '#d32f2f' : '#2e7d32';
    const badgeText = item.excludeFromResources ? 'Resource Currently Unavailable' : 'Resource Available';
    const availabilityBadge = `<span style="margin-left:auto; padding:2px 10px; border-radius:999px; background:${badgeColor}; color:#fff; font-size:11px; white-space:nowrap;">${badgeText}</span>`;
    const consumableDetail = `
            <div style="padding:10px; background:#fff; border:1px solid #dbe6f8; border-radius:6px;">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                    <span class="dev-tag">dev:consumable-detail-header</span>
                    <span style="font-weight:700;">Consumable Detail</span>
                    <button onclick="event.stopPropagation(); deleteEquipment('${item.id}')" class="btn btn-sm" style="background:var(--red); margin-left:auto;">🗑 Delete Consumble</button>
                </div>
                <div style="display:grid; grid-template-columns: 2fr 1fr; gap:10px; margin-bottom:10px; align-items:end;">
                    <div>
                        <div class="dev-tag">dev:consumable-detail-name</div>
                        <label style="font-weight:700; font-size:12px;">Consumable Name</label>
                        <input id="eq-name-${item.id}" type="text" value="${item.name}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                    </div>
                    <div>
                        <div class="dev-tag">dev:consumable-detail-qty</div>
                        <label style="font-weight:700; font-size:12px;">Quantity</label>
                        <input id="eq-qty-${item.id}" type="text" value="${item.totalQty}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                    </div>
                    <div style="grid-column: span 2;">
                        <div class="dev-tag">dev:consumable-detail-notes</div>
                        <label style="font-weight:700; font-size:12px;">Notes</label>
                        <textarea id="eq-notes-${item.id}" style="width:100%; padding:8px; min-height:60px;" oninput="scheduleSaveEquipment('${item.id}')">${item.notes || ''}</textarea>
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                    <input id="eq-exclude-${item.id}" type="checkbox" ${item.excludeFromResources ? 'checked' : ''} onchange="scheduleSaveEquipment('${item.id}')">
                    <label style="font-size:12px; line-height:1.2; margin:0;">Resource Currently Unavailable</label>
                </div>
            </div>`;

    const equipmentDetail = `
        <div class="collapsible history-item">
            <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; align-items:center; background:${headerBg}; border:1px solid ${headerBorderColor}; padding:8px 12px;">
                <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">${arrow}</span>
                <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${title}</span>
            ${headerNote ? `<span class="sidebar-pill" style="margin-right:8px; background:${lowStock ? '#ffebee' : '#fff7e0'}; color:${lowStock ? '#c62828' : '#b26a00'};">${headerNote}</span>` : ''}
            ${availabilityBadge}
        </div>
        <div class="col-body" style="padding:12px; background:${bodyBg}; border:1px solid ${bodyBorderColor}; border-radius:6px; ${bodyDisplay}">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                <span style="font-weight:700;">${isEquipment ? 'Medical Equipment Detail' : 'Equipment Detail'}</span>
                <button onclick="event.stopPropagation(); deleteEquipment('${item.id}')" class="btn btn-sm" style="background:var(--red); margin-left:auto;">🗑 Delete Medical Equipment Item</button>
            </div>
            <div style="display:grid; grid-template-columns: 2fr 1fr; gap:10px; margin-bottom:10px; align-items:end;">
                <div>
                    <label style="font-weight:700; font-size:12px;">Medical Equipment Name</label>
                    <input id="eq-name-${item.id}" type="text" value="${item.name}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                </div>
                <div>
                    <label style="font-weight:700; font-size:12px;">Quantity</label>
                    <input id="eq-qty-${item.id}" type="text" value="${item.totalQty}" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                </div>
                <div style="grid-column: span 2;">
                    <label style="font-weight:700; font-size:12px;">Storage Location</label>
                    <input id="eq-loc-${item.id}" type="text" value="${item.storageLocation}" placeholder="Medical Bag 1, Locker B" style="width:100%; padding:8px;" oninput="scheduleSaveEquipment('${item.id}')">
                </div>
                <div style="grid-column: span 2;">
                    <label style="font-weight:700; font-size:12px;">Notes</label>
                    <textarea id="eq-notes-${item.id}" style="width:100%; padding:8px; min-height:60px;" oninput="scheduleSaveEquipment('${item.id}')">${item.notes || ''}</textarea>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                <input id="eq-exclude-${item.id}" type="checkbox" ${item.excludeFromResources ? 'checked' : ''} onchange="scheduleSaveEquipment('${item.id}')">
                <label style="font-size:12px; line-height:1.2; margin:0;">Resource Currently Unavailable</label>
            </div>
        </div>
    </div>`;

    if (isConsumable) {
        return `
        <div class="collapsible history-item">
        <div class="col-header crew-med-header" onclick="toggleCrewSection(this)" style="justify-content:flex-start; align-items:center; background:${headerBg}; border:1px solid ${headerBorderColor}; padding:8px 12px;">
                <span class="toggle-label history-arrow" style="font-size:18px; margin-right:8px;">${arrow}</span>
                <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${title}</span>
                ${headerNote ? `<span class="sidebar-pill" style="margin-right:8px; background:${lowStock ? '#ffebee' : '#fff7e0'}; color:${lowStock ? '#c62828' : '#b26a00'};">${headerNote}</span>` : ''}
                ${availabilityBadge}
            </div>
            <div class="col-body" style="padding:12px; background:${bodyBg}; border:1px solid ${bodyBorderColor}; border-radius:6px; ${bodyDisplay}">
                ${consumableDetail}
            </div>
        </div>`;
    }

    return equipmentDetail;
}

/**
 * Schedule debounced auto-save for equipment item.
 * 
 * Debounce Period: 600ms
 * 
 * Allows rapid typing/editing without flooding the backend with saves.
 * Each equipment item has independent timer.
 * 
 * Triggered by: Input/change events on equipment form fields
 * 
 * @param {string} id - Equipment item ID to save
 */
function scheduleSaveEquipment(id) {
    if (equipmentSaveTimers[id]) clearTimeout(equipmentSaveTimers[id]);
    equipmentSaveTimers[id] = setTimeout(() => saveEquipment(id), 600);
}

/**
 * Save equipment item changes to server.
 * 
 * Save Process:
 * 1. Loads full equipment list
 * 2. Finds item by ID
 * 3. Updates fields from form inputs
 * 4. Writes entire list back to server
 * 5. Updates cache and re-renders with item expanded
 * 
 * Fields Saved:
 * - name, category, type, storage location
 * - status, dates (expiry, inspection, calibration)
 * - quantities (total, min PAR)
 * - battery info, supplier, notes
 * - excludeFromResources flag
 * 
 * Re-render Strategy:
 * After save, re-renders with saved item expanded so user can verify
 * changes persisted correctly.
 * 
 * @param {string} id - Equipment item ID to save
 */
async function saveEquipment(id) {
    const getVal = (elementId, fallback = '') => {
        const el = document.getElementById(elementId);
        return el ? el.value : fallback;
    };
    const data = await fetchJson('/api/data/tools');
    const items = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    const eq = items.find((i) => i.id === id);
    if (!eq) return;
    eq.name = getVal(`eq-name-${id}`, eq.name);
    eq.category = getVal(`eq-cat-${id}`, eq.category);
    eq.type = getVal(`eq-type-${id}`, eq.type || 'durable');
    eq.storageLocation = getVal(`eq-loc-${id}`, eq.storageLocation);
    eq.subLocation = getVal(`eq-subloc-${id}`, eq.subLocation);
    eq.parentId = getVal(`eq-parent-${id}`, eq.parentId);
    eq.status = getVal(`eq-status-${id}`, eq.status || 'In Stock');
    eq.expiryDate = getVal(`eq-exp-${id}`, eq.expiryDate);
    eq.lastInspection = getVal(`eq-inspect-${id}`, eq.lastInspection);
    eq.batteryType = getVal(`eq-batt-${id}`, eq.batteryType);
    eq.calibrationDue = getVal(`eq-cal-${id}`, eq.calibrationDue);
    eq.totalQty = getVal(`eq-qty-${id}`, eq.totalQty);
    eq.minPar = getVal(`eq-par-${id}`, eq.minPar);
    eq.supplier = getVal(`eq-sup-${id}`, eq.supplier);
    eq.notes = getVal(`eq-notes-${id}`, eq.notes);
    const excludeEl = document.getElementById(`eq-exclude-${id}`);
    eq.excludeFromResources = !!(excludeEl && excludeEl.checked);

    await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
        credentials: 'same-origin',
    });
    equipmentCache = items;
    renderEquipment(equipmentCache, id);
}

function openEquipmentAddForm() {
    // Ensure both outer and inner collapsibles are open so the add button is visible.
    const outerHeader = document.querySelector('#equipment-section-header');
    if (outerHeader) {
        const outerBody = outerHeader.nextElementSibling;
        if (outerBody && outerBody.style.display !== 'block') {
            toggleSection(outerHeader);
        }
    }
    const header = document.getElementById('equipment-add-header');
    if (header) {
        const body = header.nextElementSibling;
        if (body && body.style.display !== 'block') {
            toggleSection(header);
        }
    }
    setTimeout(() => {
        const nameField = document.getElementById('eq-new-name');
        if (nameField) nameField.focus();
    }, 30);
}

function getNewEquipmentVal(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

/**
 * Add new medical equipment item from form.
 * 
 * Validation:
 * - Name is required (focuses field if missing)
 * - All other fields optional
 * 
 * Process:
 * 1. Collects form values
 * 2. Creates new item with generated ID
 * 3. Adds to equipment list
 * 4. Saves to server
 * 5. Clears form for next entry
 * 6. Reloads with new item expanded
 * 
 * Item Type: 'durable' (reusable equipment)
 * Category: 'Medical Equipment'
 * 
 * Use Cases:
 * - AED, blood pressure cuff, thermometer
 * - Stethoscope, pulse oximeter, glucometer
 * - Trauma shears, splints, suction devices
 */
async function addMedicalStore() {
    const name = getNewEquipmentVal('eq-new-name');
    if (!name) {
        alert('Please enter a Medical Equipment name');
        const nameField = document.getElementById('eq-new-name');
        if (nameField) nameField.focus();
        return;
    }
    const quantity = getNewEquipmentVal('eq-new-qty');
    const location = getNewEquipmentVal('eq-new-loc');
    const notes = document.getElementById('eq-new-notes')?.value || '';
    const exclude = document.getElementById('eq-new-exclude')?.checked || false;
    const category = 'Medical Equipment';
    const newId = `eq-${Date.now()}`;
    const newItem = ensureEquipmentDefaults({
        id: newId,
        name,
        category,
        type: 'durable',
        storageLocation: location,
        totalQty: quantity,
        notes,
        status: 'In Stock',
        excludeFromResources: exclude,
    });

    const data = await fetchJson('/api/data/tools');
    const items = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    items.push(newItem);
    await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
        credentials: 'same-origin',
    });

    // Clear the add form for the next entry
    ['eq-new-name','eq-new-loc','eq-new-qty','eq-new-notes']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    const newExclude = document.getElementById('eq-new-exclude');
    if (newExclude) newExclude.checked = false;

    loadEquipment(newId);
}

function canonicalMedKey(generic, brand, strength, formStrength = '') {
    const clean = (val) => (val || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const strengthVal = clean(strength || formStrength).replace(/unspecified/g, '');
    return `${clean(generic)}|${clean(brand)}|${strengthVal}`;
}

async function addMedicationItem() {
    const name = getNewEquipmentVal('med-new-name');
    if (!name) {
        alert('Please enter a Medication name');
        const nameField = document.getElementById('med-new-name');
        if (nameField) nameField.focus();
        return;
    }
    const sortSel = document.getElementById('med-new-sort');
    const sortCustom = document.getElementById('med-new-sort-custom');
    const sortCategoryRaw = sortSel ? (sortSel.value === '__custom' ? (sortCustom?.value || '') : (sortSel.value || '')) : '';
    const sortCategory = (sortCategoryRaw || '').trim();
    const verified = !!document.getElementById('med-new-verified')?.checked;
    const exclude = document.getElementById('med-new-exclude')?.checked || false;
    const controlled = document.getElementById('med-new-ctrl')?.value === 'true';
    const dosage = document.getElementById('med-new-dose')?.value || '';
    const expiryDate = document.getElementById('med-new-exp')?.value || '';
    const expiryQty = getNewEquipmentVal('med-new-exp-qty') || '';
    const expiryBatch = getNewEquipmentVal('med-new-exp-batch') || '';
    const notes = document.getElementById('med-new-notes')?.value || '';
    const newId = `med-${Date.now()}`;
    const purchaseHistory = [];
    if (expiryDate) {
        purchaseHistory.push({
            id: `ph-${Date.now()}`,
            date: expiryDate,
            quantity: expiryQty || getNewEquipmentVal('med-new-qty') || '',
            notes: '',
            manufacturer: getNewEquipmentVal('med-new-sup') || '',
            batchLot: expiryBatch || '',
        });
    }
    const newMed = {
        id: newId,
        genericName: name,
        brandName: getNewEquipmentVal('med-new-brand'),
        form: getNewEquipmentVal('med-new-form'),
        strength: getNewEquipmentVal('med-new-strength'),
        formStrength: [getNewEquipmentVal('med-new-form'), getNewEquipmentVal('med-new-strength')].join(' ').trim(),
        currentQuantity: getNewEquipmentVal('med-new-qty') || '',
        minThreshold: getNewEquipmentVal('med-new-par') || '',
        unit: getNewEquipmentVal('med-new-unit') || '',
        storageLocation: getNewEquipmentVal('med-new-loc') || '',
        expiryDate: document.getElementById('med-new-exp')?.value || '',
        batchLot: '',
        controlled,
        manufacturer: getNewEquipmentVal('med-new-sup') || '',
        primaryIndication: getNewEquipmentVal('med-new-indication') || '',
        allergyWarnings: getNewEquipmentVal('med-new-allergy') || '',
        standardDosage: dosage,
        sortCategory,
        verified,
        notes,
        photos: [],
        purchaseHistory,
        source: 'manual_entry',
        photoImported: false,
        excludeFromResources: exclude,
    };

    const data = await fetchJson('/api/data/inventory');
    const items = Array.isArray(data) ? data : [];
    const g = (newMed.genericName || '').trim().toLowerCase();
    const b = (newMed.brandName || '').trim().toLowerCase();
    const targetKey = canonicalMedKey(g, b, newMed.strength, newMed.formStrength);
    const dup = items.find((m) => {
        const mg = (m.genericName || '').trim().toLowerCase();
        const mb = (m.brandName || '').trim().toLowerCase();
        return canonicalMedKey(mg, mb, m.strength, m.formStrength) === targetKey;
    });
    if (dup) {
        alert('A medication with the same Generic + Brand + Strength already exists. Please adjust to keep entries unique.');
        return;
    }
    items.push(newMed);
    await fetch('/api/data/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
        credentials: 'same-origin',
    });

    ['med-new-name','med-new-brand','med-new-form','med-new-strength','med-new-loc','med-new-exp','med-new-exp-qty','med-new-exp-batch','med-new-qty','med-new-par','med-new-unit','med-new-sup','med-new-indication','med-new-allergy','med-new-dose','med-new-notes']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    const sortSelect = document.getElementById('med-new-sort');
    const sortCustomInput = document.getElementById('med-new-sort-custom');
    if (sortSelect) sortSelect.value = '';
    if (sortCustomInput) { sortCustomInput.value = ''; sortCustomInput.style.display = 'none'; }
    const medVerified = document.getElementById('med-new-verified');
    if (medVerified) medVerified.checked = false;
    const medExclude = document.getElementById('med-new-exclude');
    if (medExclude) medExclude.checked = false;
    const ctrlSel = document.getElementById('med-new-ctrl');
    if (ctrlSel) ctrlSel.value = 'false';

    if (typeof loadPharmacy === 'function') {
        loadPharmacy();
    }
}

/**
 * Add new consumable item from form.
 * 
 * Validation:
 * - Name is required (focuses field if missing)
 * - Quantity and notes optional
 * 
 * Process:
 * 1. Collects form values  
 * 2. Creates new item with generated ID
 * 3. Adds to equipment list
 * 4. Saves to server
 * 5. Clears form for next entry
 * 6. Reloads with new item expanded
 * 
 * Item Type: 'consumable' (single-use supplies)
 * Category: 'Consumable'
 * 
 * Use Cases:
 * - Bandages, gauze pads, tape
 * - Gloves, masks, syringes
 * - Alcohol wipes, antiseptic
 * - Sutures, IV supplies
 */
async function addConsumableItem() {
    const name = getNewEquipmentVal('cons-new-name');
    if (!name) {
        alert('Please enter a Consumable name');
        const nameField = document.getElementById('cons-new-name');
        if (nameField) nameField.focus();
        return;
    }
    const quantity = getNewEquipmentVal('cons-new-qty');
    const notes = document.getElementById('cons-new-notes')?.value || '';
    const exclude = document.getElementById('cons-new-exclude')?.checked || false;
    const category = 'Consumable';
    const newId = `eq-${Date.now()}`;
    const newItem = ensureEquipmentDefaults({
        id: newId,
        name,
        category,
        type: 'consumable',
        totalQty: quantity,
        notes,
        status: 'In Stock',
        excludeFromResources: exclude,
    });

    const res = await fetch('/api/data/tools', { credentials: 'same-origin' });
    const data = await res.json();
    const items = Array.isArray(data) ? data.map(ensureEquipmentDefaults) : [];
    items.push(newItem);
    await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
        credentials: 'same-origin',
    });

    ['cons-new-name','cons-new-qty','cons-new-notes']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    const consumableExclude = document.getElementById('cons-new-exclude');
    if (consumableExclude) consumableExclude.checked = false;

    loadEquipment(newId);
}

/**
 * Delete equipment item with double confirmation.
 * 
 * Two-Step Safety:
 * 1. Confirm dialog
 * 2. Type "DELETE" prompt (exact match required)
 * 
 * Process:
 * 1. Loads full equipment list
 * 2. Filters out deleted item
 * 3. Writes remaining items to server
 * 4. Reloads equipment display
 * 
 * Permanent Action:
 * No undo available. Data is permanently removed from tools.json.
 * 
 * @param {string} id - Equipment item ID to delete
 */
async function deleteEquipment(id) {
    if (!confirm('Delete this equipment item?')) return;
    const confirmText = prompt('Type DELETE to confirm:');
    if (confirmText !== 'DELETE') {
        alert('Deletion cancelled.');
        return;
    }
    const res = await fetch('/api/data/tools', { credentials: 'same-origin' });
    const data = await res.json();
    const items = Array.isArray(data) ? data : [];
    const filtered = items.filter((i) => i.id !== id);
    await fetch('/api/data/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filtered),
        credentials: 'same-origin',
    });
    loadEquipment();
}

/**
 * Calculate days until a future date.
 * 
 * Used for:
 * - Expiry warnings (items expiring soon)
 * - Calibration due dates
 * - Maintenance schedules
 * 
 * Returns:
 * - Positive number: Days in future
 * - Negative number: Days in past (expired)
 * - 9999: Invalid date (parsing failed)
 * 
 * Thresholds:
 * - ≤ 60 days: Show "Expiring Soon" warning
 * - < 0 days: Show "Expired" warning
 * 
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {number} Days until date (or 9999 if invalid)
 */
function daysUntil(dateStr) {
    const now = new Date();
    const target = new Date(dateStr);
    if (isNaN(target.getTime())) return 9999;
    return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

// Expose handlers
window.loadEquipment = loadEquipment;
window.addEquipment = openEquipmentAddForm;
window.openEquipmentAddForm = openEquipmentAddForm;
window.addMedicalStore = addMedicalStore;
window.addMedicationItem = addMedicationItem;
window.addConsumableItem = addConsumableItem;
window.deleteEquipment = deleteEquipment;
window.scheduleSaveEquipment = scheduleSaveEquipment;
window.loadMedPhotoQueue = loadMedPhotoQueue;
window.importDesktopMedicinePhotos = importDesktopMedicinePhotos;
window.importPhoneMedicinePhotos = importPhoneMedicinePhotos;
window.openPhoneImportView = openPhoneImportView;
window.closePhoneImportView = closePhoneImportView;
window.setMedPhotoMode = setMedPhotoMode;
window.retryMedPhotoJob = retryMedPhotoJob;
window.deleteMedPhotoJob = deleteMedPhotoJob;
window.exportConsumables = exportConsumables;
window.openConsumablesFilePicker = openConsumablesFilePicker;
window.handleConsumablesFileImport = handleConsumablesFileImport;
window.exportEquipmentItems = exportEquipmentItems;
window.openEquipmentFilePicker = openEquipmentFilePicker;
window.handleEquipmentFileImport = handleEquipmentFileImport;
window.forceClearCache = function forceClearCache() {
    if (confirm('Force a hard reload and clear cached assets?')) {
        const url = new URL(window.location.href);
        url.searchParams.set('cache', Date.now().toString());
        window.location.replace(url.toString());
    }
};
// Ensure phone-only button appears on small screens and opens overlay
document.addEventListener('DOMContentLoaded', () => {
    const phoneBtns = Array.from(document.querySelectorAll('.phone-only'));
    const updatePhoneBtnVisibility = () => {
        const isPhoneLike = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 1100;
        phoneBtns.forEach((btn) => {
            btn.style.display = isPhoneLike ? 'inline-flex' : 'none';
        });
    };

    phoneBtns.forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            openPhoneImportView();
        });
    });

    updatePhoneBtnVisibility();
    window.addEventListener('resize', updatePhoneBtnVisibility);
    bindPhoneInput();
    renderPhonePreview();
    renderDesktopPreview();
    setMedPhotoMode(medPhotoMode);
});
