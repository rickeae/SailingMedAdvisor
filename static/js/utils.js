/* =============================================================================
 * Author: Rick Escher
 * Project: SailingMedAdvisor
 * Context: Google HAI-DEF Framework
 * Models: Google MedGemmas
 * Program: Kaggle Impact Challenge
 * ========================================================================== */
/*
File: static/js/utils.js
Author notes: Shared utility functions for the SailingMedAdvisor frontend.

Key Responsibilities:
- HTML escaping for XSS prevention
- Debounce utility for input handlers
- Workspace header injection (multi-tenant placeholder)
- Centralized fetch wrapper with error handling
- Data category fetch helper

Architecture:
------------
Implemented as IIFE (Immediately Invoked Function Expression) that:
1. Creates or extends window.Utils namespace
2. Registers utility functions
3. Exposes both namespaced (Utils.escapeHtml) and global (escapeHtml) versions

Usage Pattern:
```javascript
// Preferred (namespaced):
const safe = Utils.escapeHtml(userInput);

// Legacy (global):
const safe = escapeHtml(userInput);
```

Integration:
All modules import these utilities with fallbacks:
```javascript
const escapeHtml = (window.Utils && window.Utils.escapeHtml) 
  ? window.Utils.escapeHtml 
  : (str) => str;
```

This allows modules to work even if utils.js fails to load.
*/

(function registerUtils() {
    const Utils = window.Utils || {};
    const CHAT_SECTION_LABELS = new Set(['avoid', 'monitor', 'evacuation', 'questions']);

    /**
     * normalizeChatSectionMarkdown: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function normalizeChatSectionMarkdown(raw) {
        return (raw || '')
            .toString()
            .replace(/\r\n?/g, '\n')
            .replace(
                /(^|\n)\s*(?:\*\*)?\s*(Avoid|Monitor|Evacuation|Questions)\s*(?:\*\*)?\s*[–-]\s+/gim,
                (_match, lead, label) => `${lead}**${label.charAt(0).toUpperCase()}${label.slice(1).toLowerCase()}:** `
            );
    }

    /**
     * normalizeChecklistMarkdown: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function normalizeChecklistMarkdown(raw) {
        const lines = (raw || '').toString().replace(/\r\n?/g, '\n').split('\n');
        const normalized = lines.map((line) => {
            const heading = line.match(/^\s*\[\s*[xX ]\s*\]\s*\*\*(.+?)\*\*\s*:?\s*$/);
            if (heading) {
                return `**${heading[1].trim()}:**`;
            }
            const item = line.match(/^\s*\[\s*[xX ]\s*\]\s+(.+)$/);
            if (item) {
                return `- ${item[1].trim()}`;
            }
            return line;
        });
        return normalized.join('\n');
    }

    /**
     * normalizeSectionLabelText: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function normalizeSectionLabelText(text) {
        return (text || '')
            .toString()
            .replace(/\*/g, '')
            .replace(/[:：]\s*$/, '')
            .trim()
            .toLowerCase();
    }

    /**
     * annotateChatSections: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function annotateChatSections(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return;

        root.querySelectorAll('strong').forEach((el) => {
            if (CHAT_SECTION_LABELS.has(normalizeSectionLabelText(el.textContent))) {
                el.classList.add('chat-section-label');
            }
        });

        root.querySelectorAll('p').forEach((p) => {
            const text = (p.textContent || '').trim();
            const dashMatch = text.match(/^(Avoid|Monitor|Evacuation|Questions)\s*[–-]\s+(.+)$/i);
            if (dashMatch) {
                p.classList.add('chat-section-heading');
                p.innerHTML = `<strong class="chat-section-label">${dashMatch[1]}:</strong> ${Utils.escapeHtml(dashMatch[2])}`;
                return;
            }
            const strong = p.querySelector('strong');
            if (strong && CHAT_SECTION_LABELS.has(normalizeSectionLabelText(strong.textContent))) {
                p.classList.add('chat-section-heading');
            }
        });
    }

    /**
     * extractJsonCandidateText: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function extractJsonCandidateText(raw) {
        const trimmed = (raw || '').toString().trim();
        if (!trimmed) return '';
        const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        return (fenceMatch ? fenceMatch[1] : trimmed).trim();
    }

    /**
     * tryParseJsonPayload: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function tryParseJsonPayload(raw) {
        let candidate = extractJsonCandidateText(raw);
        if (!candidate || (!candidate.startsWith('{') && !candidate.startsWith('['))) {
            return null;
        }
        for (let i = 0; i < 2; i += 1) {
            try {
                const parsed = JSON.parse(candidate);
                if (typeof parsed === 'string') {
                    candidate = parsed.trim();
                    if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
                        return null;
                    }
                    continue;
                }
                return parsed;
            } catch (_err) {
                return null;
            }
        }
        return null;
    }

    /**
     * formatJsonInline: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function formatJsonInline(value) {
        if (value === null) return 'null';
        if (typeof value === 'string') return value.trim();
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (Array.isArray(value)) {
            const primitive = value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
            if (primitive) {
                return value.map((item) => formatJsonInline(item)).join('; ');
            }
        }
        return JSON.stringify(value);
    }

    /**
     * formatJsonSection: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function formatJsonSection(title, value) {
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
            return `**${title}:** ${formatJsonInline(value)}`;
        }
        if (Array.isArray(value)) {
            if (!value.length) return `**${title}:** (none)`;
            const bullets = value.map((item) => `- ${formatJsonInline(item)}`).join('\n');
            return `**${title}:**\n${bullets}`;
        }
        if (value && typeof value === 'object') {
            const entries = Object.entries(value);
            if (!entries.length) return `**${title}:** (none)`;
            const bullets = entries
                .map(([k, v]) => `- ${k}: ${formatJsonInline(v)}`)
                .join('\n');
            return `**${title}:**\n${bullets}`;
        }
        return `**${title}:** ${formatJsonInline(value)}`;
    }

    /**
     * jsonToMarkdown: function-level behavior note for maintainers.
     * Keep this block synchronized with implementation changes.
     */
    function jsonToMarkdown(value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const keyMap = {};
            Object.keys(value).forEach((key) => {
                keyMap[key.toLowerCase()] = key;
            });
            const preferred = ['Avoid', 'Monitor', 'Evacuation', 'Questions'];
            const used = new Set();
            const blocks = [];

            preferred.forEach((label) => {
                const realKey = keyMap[label.toLowerCase()];
                if (!realKey) return;
                used.add(realKey);
                blocks.push(formatJsonSection(label, value[realKey]));
            });

            Object.keys(value).forEach((key) => {
                if (used.has(key)) return;
                blocks.push(formatJsonSection(key, value[key]));
            });

            if (blocks.length) {
                return blocks.join('\n\n').trim();
            }
        }
        return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
    }

    /**
     * Escape HTML special characters to prevent XSS attacks.
     * 
     * Character Mappings:
     * - & → &amp;
     * - < → &lt;
     * - > → &gt;
     * - " → &quot;
     * - ' → &#39;
     * 
     * Use Cases:
     * - Displaying user-entered text in HTML
     * - Rendering crew names, medication names
     * - Chat responses (before markdown parsing)
     * - Search results
     * - Any untrusted content inserted into DOM
     * 
     * Security:
     * Essential for preventing XSS when rendering user data. Always
     * escape before inserting into innerHTML or creating HTML strings.
     * 
     * Example:
     * ```javascript
     * const name = "<script>alert('xss')</script>";
     * el.innerHTML = Utils.escapeHtml(name);
     * // Result: &lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;
     * ```
     * 
     * @param {string} str - String to escape
     * @returns {string} Escaped string safe for HTML insertion
     */
    Utils.escapeHtml = function escapeHtml(str) {
        return (str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    /**
     * Debounce function calls to reduce execution frequency.
     * 
     * Debouncing delays function execution until after a specified time
     * has elapsed since the last call. Useful for expensive operations
     * triggered by rapid user input.
     * 
     * Use Cases:
     * - Search input: Wait for user to stop typing
     * - Auto-save: Batch saves instead of save-per-keystroke
     * - Window resize handlers: Prevent layout thrashing
     * - Scroll handlers: Reduce computation during scrolling
     * 
     * Behavior:
     * 1. First call: Starts timer
     * 2. Subsequent calls: Reset timer
     * 3. After delay expires: Execute function once with latest arguments
     * 
     * Example:
     * ```javascript
     * const saveSettings = Utils.debounce(() => {
     *   fetch('/api/settings', {method: 'POST', ...});
     * }, 800);
     * 
     * // User types rapidly:
     * saveSettings(); // Timer starts
     * saveSettings(); // Timer resets
     * saveSettings(); // Timer resets
     * // 800ms later: One save executed
     * ```
     * 
     * Common Delays:
     * - 250ms: Input validation, search
     * - 400ms: Crew credentials, simple saves
     * - 600ms: Equipment auto-save
     * - 800ms: Settings auto-save
     * 
     * @param {Function} fn - Function to debounce
     * @param {number} delay - Delay in milliseconds (default: 250)
     * @returns {Function} Debounced function
     */
    Utils.debounce = function debounce(fn, delay = 250) {
        let timer = null;
        return (...args) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    };

    /**
     * Get current workspace label for display.
     * 
     * Multi-Tenant Placeholder:
     * Currently returns empty string as multi-tenancy not yet implemented.
     * Future versions will return workspace name (vessel name, user account).
     * 
     * Planned Use Cases:
     * - Display current vessel name in header
     * - Show workspace in exported files
     * - Include in error reports
     * 
     * @returns {string} Workspace label (currently empty)
     * @deprecated Not yet implemented
     */
    Utils.getWorkspaceLabel = function getWorkspaceLabel() {
        return '';
    };

    /**
     * Generate HTTP headers with workspace context.
     * 
     * Multi-Tenant Placeholder:
     * Currently returns headers unchanged. Future versions will inject
     * workspace identifier headers for server-side routing.
     * 
     * Planned Headers:
     * - X-Workspace-Id: Unique workspace identifier
     * - X-Vessel-Name: Vessel name for logging
     * 
     * Current Usage:
     * ```javascript
     * fetch('/api/data/patients', {
     *   headers: workspaceHeaders({'Content-Type': 'application/json'})
     * })
     * ```
     * 
     * Used Throughout:
     * - equipment.js: Equipment saves
     * - crew.js: Crew data operations
     * - pharmacy.js: Medication operations
     * 
     * @param {Object} extra - Additional headers to include
     * @returns {Object} Headers object with workspace context (currently just extra)
     */
    Utils.workspaceHeaders = function workspaceHeaders(extra = {}) {
        return { ...extra };
    };

    /**
     * Fetch JSON with enhanced error handling and parsing.
     * 
     * Enhanced Fetch Features:
     * 1. Auto-includes credentials for cookie-based auth
     * 2. Handles empty responses gracefully (returns {})
     * 3. Attempts JSON parse even on error responses
     * 4. Throws detailed errors with response text
     * 5. Consistent error format across all API calls
     * 
     * Error Handling:
     * - HTTP error: Throws with status code
     * - JSON parse failure: Returns {} instead of throwing
     * - API error field: Extracts and throws error message
     * 
     * Example Success:
     * ```javascript
     * const crew = await fetchJson('/api/data/patients');
     * // Returns: [{id: 'crew-1', name: 'John'}, ...]
     * ```
     * 
     * Example Error:
     * ```javascript
     * try {
     *   await fetchJson('/api/data/invalid');
     * } catch (err) {
     *   // err.message: "Not found" or "Status 404"
     * }
     * ```
     * 
     * Advantages Over Raw Fetch:
     * - Consistent error messages
     * - No need to check res.ok manually
     * - Handles malformed JSON gracefully
     * - Credentials included by default
     * 
     * Used Throughout:
     * All modules use this for API calls instead of raw fetch.
     * 
     * @param {string} url - API endpoint URL
     * @param {Object} options - Fetch options (method, headers, body, etc.)
     * @returns {Promise<Object>} Parsed JSON response
     * @throws {Error} On HTTP error or API error response
     */
    Utils.fetchJson = async function fetchJson(url, options = {}) {
        const res = await fetch(url, { credentials: 'same-origin', ...options });
        const text = await res.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch (err) {
            data = {};
        }
        if (!res.ok || data?.error) {
            const detail = data?.error || text || `Status ${res.status}`;
            throw new Error(detail);
        }
        return data;
    };

    /**
     * Fetch data by category shorthand.
     * 
     * Convenience wrapper for common /api/data/* endpoints.
     * 
     * Categories:
     * - 'patients': /api/data/patients (crew list)
     * - 'history': /api/data/history (chat logs)
     * - 'settings': /api/data/settings (app config)
     * - 'inventory': /api/data/inventory (medications)
     * - 'tools': /api/data/tools (equipment/consumables)
     * - 'vessel': /api/data/vessel (vessel info)
     * 
     * Example:
     * ```javascript
     * const crew = await Utils.fetchDataCategory('patients');
     * // Equivalent to: Utils.fetchJson('/api/data/patients')
     * ```
     * 
     * Benefits:
     * - Shorter, more readable code
     * - Consistent URL construction
     * - Type-safe category names (if using TypeScript)
     * 
     * @param {string} category - Data category name
     * @param {Object} options - Fetch options
     * @returns {Promise<Object>} Parsed JSON response
     */
    Utils.fetchDataCategory = async function fetchDataCategory(category, options = {}) {
        return Utils.fetchJson(`/api/data/${category}`, options);
    };

    Utils.renderAssistantMarkdown = function renderAssistantMarkdown(raw) {
        const parsedJson = tryParseJsonPayload(raw);
        const source = parsedJson === null ? raw : jsonToMarkdown(parsedJson);
        const normalized = normalizeChatSectionMarkdown(normalizeChecklistMarkdown(source));
        if (!window.marked || typeof window.marked.parse !== 'function') {
            return Utils.escapeHtml(normalized).replace(/\n/g, '<br>');
        }
        const html = window.marked.parse(normalized, { gfm: true, breaks: true });
        const wrapper = document.createElement('div');
        wrapper.innerHTML = html;
        annotateChatSections(wrapper);
        return wrapper.innerHTML;
    };

    // Register Utils namespace globally
    window.Utils = Utils;
    
    /**
     * Legacy Global Exposure:
     * Expose escapeHtml directly to window for backward compatibility
     * with scripts that expect it in global scope.
     * 
     * Deprecated Pattern:
     * Old: window.escapeHtml(str)
     * New: Utils.escapeHtml(str)
     * 
     * Both work, but namespaced version preferred.
     */
    window.escapeHtml = Utils.escapeHtml;
    window.renderAssistantMarkdown = Utils.renderAssistantMarkdown;
})();
