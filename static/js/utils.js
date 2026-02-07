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
})();
