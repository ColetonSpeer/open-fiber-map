/*
 * Open Fiber Map — API access layer.
 *
 * Lets the SAME frontend run two ways:
 *   1. As a normal web app served same-origin (API_BASE = '') — uses the
 *      session cookie, behaves exactly as before.
 *   2. As a native (Capacitor) app loaded from its own origin, pointed at a
 *      remote server (API_BASE = 'http://10.10.11.4') — uses a bearer token,
 *      no cookies, CORS-friendly.
 *
 * Everything is exposed on window so the inline page scripts can use it.
 * Load this BEFORE any page script.
 */
(function () {
  var BASE_KEY = 'ofm_api_base';
  var TOKEN_KEY = 'ofm_token';

  function read(key) { try { return localStorage.getItem(key) || ''; } catch (_) { return ''; } }
  function write(key, val) { try { val ? localStorage.setItem(key, val) : localStorage.removeItem(key); } catch (_) {} }

  // Normalize a base: strip a trailing slash so apiUrl('/api/x') doesn't double up.
  function normBase(b) { return (b || '').replace(/\/+$/, ''); }

  var API = {
    // Server base URL. Empty string => same-origin (web). Set => remote (native).
    getBase: function () { return normBase(read(BASE_KEY)); },
    setBase: function (b) { write(BASE_KEY, normBase(b)); },

    // Bearer token returned by /api/login (used when pointed at a remote server).
    getToken: function () { return read(TOKEN_KEY); },
    setToken: function (t) { write(TOKEN_KEY, t || ''); },
    clearToken: function () { write(TOKEN_KEY, ''); },

    // Build an absolute URL for an API/asset path.
    apiUrl: function (path) {
      var base = API.getBase();
      if (!path) return base || '';
      if (/^https?:\/\//i.test(path)) return path; // already absolute (external)
      return base + path;
    },

    // fetch() wrapper: prepends the base, attaches the bearer token, and picks
    // the right credentials mode (cookie same-origin, bearer cross-origin).
    // Returns a raw Response (named apiRequest to avoid clashing with site.html's
    // own higher-level apiFetch(method, path, body) JSON helper).
    apiRequest: function (path, opts) {
      opts = opts || {};
      var base = API.getBase();
      var headers = Object.assign({}, opts.headers || {});
      var token = API.getToken();
      if (token && !headers.Authorization) headers.Authorization = 'Bearer ' + token;
      // Same-origin → send the cookie. Cross-origin (remote server) → omit
      // cookies (CORS isn't configured for credentials) and rely on the token.
      var credentials = opts.credentials || (base ? 'omit' : 'include');
      return fetch(API.apiUrl(path), Object.assign({}, opts, { headers: headers, credentials: credentials }));
    },

    // EventSource wrapper for SSE. EventSource can't send an Authorization
    // header, so the token rides as ?token= (server accepts it). Same-origin
    // still works via the cookie.
    apiEventSource: function (path) {
      var token = API.getToken();
      var url = API.apiUrl(path);
      if (token) url += (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
      return new EventSource(url, { withCredentials: !API.getBase() });
    },
  };

  // Expose helpers globally.
  window.OFM_API = API;
  window.apiUrl = API.apiUrl;
  window.apiRequest = API.apiRequest;
  window.apiEventSource = API.apiEventSource;

  // Resolves once config is loaded. Synchronous today (localStorage); kept as a
  // promise so a future Capacitor Preferences (async) load can slot in.
  window.apiReady = Promise.resolve();
})();
