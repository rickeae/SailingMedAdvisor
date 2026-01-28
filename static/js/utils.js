// Shared utilities for SailingMedAdvisor frontend (global, non-module)

(function registerUtils() {
    const Utils = window.Utils || {};

    Utils.escapeHtml = function escapeHtml(str) {
        return (str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    Utils.debounce = function debounce(fn, delay = 250) {
        let timer = null;
        return (...args) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    };

    Utils.getWorkspaceLabel = function getWorkspaceLabel() {
        return '';
    };

    Utils.workspaceHeaders = function workspaceHeaders(extra = {}) {
        return { ...extra };
    };

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

    Utils.fetchDataCategory = async function fetchDataCategory(category, options = {}) {
        return Utils.fetchJson(`/api/data/${category}`, options);
    };

    window.Utils = Utils;
    // Expose a global helper for legacy scripts that expect escapeHtml in the global scope
    window.escapeHtml = Utils.escapeHtml;
})();
