var media = require("./media.js");

var API_ROOT = "https://api.simkl.com";
var APP_NAME = "iina-simkl-scrobbler";
var PLUGIN_VERSION = "1.1.34";
var USER_AGENT = "iina-simkl-scrobbler/" + PLUGIN_VERSION;
var TOKEN_PATH = "@data/simkl-token.json";
var CACHE_PATH = "@data/simkl-match-cache.json";
var NEGATIVE_CACHE_PATH = "@data/simkl-negative-cache.json";
var TOKEN_PREF = "simkl_oauth_token";
var KEYCHAIN_SERVICE = "io.github.prestinesnail.iina-simkl-scrobbler";
var KEYCHAIN_ACCOUNT = "simkl-oauth";
var PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
var AUTH_REQUIRED = "Simkl authorization required";
var OAUTH_SCOPE = "media:read media:write";
var OAUTH_ISSUER = "https://simkl.com";
var AUTHORIZE_ROOT = "https://simkl.com";
var CLIENT_ID = "594766b276bb4c56547b98e4f2bd73846852405ff3abb2f4cc0a95d5631c5acb";
var OAUTH_SCRIPT_PATH = "@tmp/simkl-oauth-listen.py";
var OAUTH_LISTEN_PATH = "@tmp/simkl-oauth-listen.json";
var OAUTH_CALLBACK_PATH = "@tmp/simkl-oauth-callback.json";
var POST_MIN_INTERVAL_MS = 1000;
var HTTP_TIMEOUT_MS = 8000;
var CACHE_MAX_ENTRIES = 500;
var NEGATIVE_TTL_MS = 30 * 60 * 1000;
var ACCESS_REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;
var REFRESH_TTL_SEC = 180 * 24 * 60 * 60;
var RATE_LIMIT_RETRY_MS = 1000;
var WRITE_LOCK_RETRY_MS = 1500;

var runtime = {
  file: null,
  http: null,
  preferences: null,
  utils: null,
  logger: function () {},
  notify: function () {},
  tokenCache: undefined,
  matchCache: null,
  negativeCache: null,
  authPromise: null,
  authCode: "",
  authUrl: "",
  authExpiresAt: 0,
  lastAuthFailure: "",
  viewerProfile: null,
  viewerProfileFetchedAt: 0,
  now: Date.now,
  sleep: null,
  lastPostAt: 0,
  requestTail: Promise.resolve(),
  refreshPromise: null,
  profilePromise: null,
  quotaBlockedUntil: 0,
  rateLimitRemaining: null,
  rateLimitLimit: null,
};

function configure(options) {
  var settings = options || {};
  if (settings.file) runtime.file = settings.file;
  if (settings.http) runtime.http = settings.http;
  if (settings.preferences) runtime.preferences = settings.preferences;
  if (settings.utils) runtime.utils = settings.utils;
  if (typeof settings.logger === "function") runtime.logger = settings.logger;
  if (typeof settings.notify === "function") runtime.notify = settings.notify;
  if (typeof settings.onAuthStatusChange === "function") runtime.onAuthStatusChange = settings.onAuthStatusChange;
  if (typeof settings.now === "function") runtime.now = settings.now;
  if (typeof settings.sleep === "function") runtime.sleep = settings.sleep;
  if (settings.httpTimeoutMs != null) runtime.httpTimeoutMs = Number(settings.httpTimeoutMs) || HTTP_TIMEOUT_MS;
  if (settings.resetRateLimit) {
    runtime.lastPostAt = 0;
    runtime.requestTail = Promise.resolve();
    runtime.quotaBlockedUntil = 0;
    runtime.rateLimitRemaining = null;
    runtime.rateLimitLimit = null;
  }
  if (settings.resetToken) {
    runtime.tokenCache = undefined;
    runtime.viewerProfile = null;
    runtime.viewerProfileFetchedAt = 0;
    runtime.authPromise = null;
    runtime.refreshPromise = null;
    runtime.profilePromise = null;
    runtime.authCode = "";
    runtime.authUrl = "";
    runtime.authExpiresAt = 0;
    runtime.lastAuthFailure = "";
    runtime.quotaBlockedUntil = 0;
    runtime.rateLimitRemaining = null;
    runtime.rateLimitLimit = null;
  }
}

function log(message) {
  runtime.logger(String(message || ""));
}

function notify(message) {
  runtime.notify(String(message || ""));
}

function emitAuthStatusChange() {
  if (typeof runtime.onAuthStatusChange !== "function") return;
  try {
    runtime.onAuthStatusChange();
  } catch (_error) {}
}

function pref(key, fallbackValue) {
  if (!runtime.preferences || typeof runtime.preferences.get !== "function") return fallbackValue;
  var value;
  try {
    value = runtime.preferences.get(key);
  } catch (_error) {
    return fallbackValue;
  }
  return value === undefined || value === null ? fallbackValue : value;
}

function getClientId() {
  return CLIENT_ID;
}

function sleep(ms) {
  if (typeof runtime.sleep === "function") return runtime.sleep(ms);
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function nowMs() {
  return Number(runtime.now()) || Date.now();
}

function httpTimeoutMs() {
  var value = Number(runtime.httpTimeoutMs);
  return value > 0 ? value : HTTP_TIMEOUT_MS;
}

function clearTimer(timer) {
  if (timer == null) return;
  if (typeof clearTimeout === "function") clearTimeout(timer);
}

function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error((label || "request") + " timed out after " + ms + "ms"));
    }, ms);
    Promise.resolve(promise).then(
      function (value) {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      },
      function (error) {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        reject(error);
      }
    );
  });
}

function enqueueRequest(task) {
  var run = runtime.requestTail.then(task, task);
  runtime.requestTail = run.then(
    function () {},
    function () {}
  );
  return run;
}

async function waitForPostSlot() {
  var wait = POST_MIN_INTERVAL_MS - (nowMs() - Number(runtime.lastPostAt || 0));
  if (runtime.lastPostAt && wait > 0) await sleep(wait);
  runtime.lastPostAt = nowMs();
}

function parseJson(text, fallbackValue) {
  if (!text) return fallbackValue;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallbackValue;
  }
}

function readJson(path, fallbackValue) {
  if (!runtime.file || !runtime.file.exists(path)) return fallbackValue;
  try {
    return parseJson(runtime.file.read(path) || "", fallbackValue);
  } catch (_error) {
    return fallbackValue;
  }
}

function writeJson(path, value) {
  if (!runtime.file) return;
  runtime.file.write(path, JSON.stringify(value, null, 2));
}

function encodeQuery(params) {
  return Object.keys(params || {})
    .filter(function (key) {
      return params[key] !== undefined && params[key] !== null && params[key] !== "";
    })
    .map(function (key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]));
    })
    .join("&");
}

function requiredQuery() {
  return {
    client_id: getClientId(),
    "app-name": APP_NAME,
    "app-version": PLUGIN_VERSION,
  };
}

function requiredHeaders(accessToken, method) {
  var headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (String(method || "GET").toUpperCase() === "POST") {
    headers["Content-Type"] = "application/json";
  }
  if (accessToken) headers.Authorization = "Bearer " + accessToken;
  return headers;
}

function isOAuthPath(path) {
  return String(path || "").indexOf("/oauth2/") === 0;
}

function isV2AccessToken(token) {
  return String(token || "").indexOf("simkl_at_") === 0;
}

function isV1AccessToken(token) {
  return /^[a-f0-9]{64}$/i.test(String(token || ""));
}

function normalizeHeaders(raw) {
  var headers = {};
  if (!raw || typeof raw !== "object") return headers;
  Object.keys(raw).forEach(function (key) {
    if (key == null) return;
    headers[String(key).toLowerCase()] = String(raw[key] == null ? "" : raw[key]).trim();
  });
  return headers;
}

function parseHeaderDump(text) {
  var blocks = String(text || "").split(/\r?\n\r?\n/);
  var last = "";
  for (var i = 0; i < blocks.length; i += 1) {
    if (String(blocks[i]).trim()) last = blocks[i];
  }
  var headers = {};
  String(last || "")
    .split(/\r?\n/)
    .forEach(function (line) {
      var idx = line.indexOf(":");
      if (idx < 1) return;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    });
  return headers;
}

function headerValue(headers, name) {
  if (!headers) return "";
  return String(headers[String(name || "").toLowerCase()] || "");
}

function errorCode(response) {
  var body = response && response.body;
  if (!body || typeof body !== "object") return "";
  return String(body.error || "");
}

function responseErrorMessage(response, fallback) {
  var body = response && response.body;
  if (!body || typeof body !== "object") return fallback;
  return body.error_description || body.message || body.error || fallback;
}

function retryAfterMs(response) {
  var raw = headerValue(response && response.headers, "retry-after");
  var sec = Number(raw);
  if (!isFinite(sec) || sec <= 0) return 0;
  return Math.min(sec * 1000, 24 * 60 * 60 * 1000);
}

function rememberRateLimit(response) {
  var remaining = headerValue(response && response.headers, "x-ratelimit-remaining");
  if (remaining === "") return;
  var value = Number(remaining);
  if (!isFinite(value)) return;
  runtime.rateLimitRemaining = value;
  var limit = Number(headerValue(response && response.headers, "x-ratelimit-limit"));
  if (isFinite(limit) && limit > 0) runtime.rateLimitLimit = limit;
}

function markQuotaExceeded(response) {
  var wait = retryAfterMs(response) || 60 * 60 * 1000;
  runtime.quotaBlockedUntil = nowMs() + wait;
}

function quotaBlocked() {
  return !!(runtime.quotaBlockedUntil && nowMs() < runtime.quotaBlockedUntil);
}

function escapeAppleScriptString(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

async function copyToClipboard(text) {
  if (!runtime.utils || typeof runtime.utils.exec !== "function") return false;
  try {
    await runtime.utils.exec("/usr/bin/osascript", [
      "-e",
      'set the clipboard to "' + escapeAppleScriptString(text) + '"',
    ]);
    return true;
  } catch (_error) {
    return false;
  }
}

async function copyPendingAuthCode() {
  var text = runtime.authCode || runtime.authUrl;
  if (!text) {
    return { ok: false, message: "No active sign-in." };
  }
  var copied = await copyToClipboard(text);
  return copied
    ? { ok: true, message: runtime.authCode ? "Code copied." : "Sign-in link copied." }
    : { ok: false, message: "Copy failed. Copy manually." };
}

function responseBody(res) {
  if (!res) return {};
  if (res.data != null && res.data !== "") return res.data;
  return parseJson(res.text, {});
}

async function requestWithHttp(method, path, options) {
  var settings = options || {};
  var query = Object.assign({}, requiredQuery(), settings.query || {});
  var url = API_ROOT + path + "?" + encodeQuery(query);
  var verb = String(method || "GET").toLowerCase();
  var fn = runtime.http && runtime.http[verb];
  if (typeof fn !== "function") {
    throw new Error("iina.http." + verb + " is unavailable");
  }
  var request = {
    headers: Object.assign({}, requiredHeaders(settings.accessToken, method), settings.headers || {}),
  };
  if (settings.body !== undefined) request.data = settings.body;
  var res = await fn.call(runtime.http, url, request);
  return {
    statusCode: Number(res && res.statusCode) || 0,
    body: responseBody(res),
    rawBody: res && res.text ? String(res.text) : "",
    headers: normalizeHeaders(res && (res.headers || res.header)),
    url: url,
  };
}

function resolvePluginPath(path) {
  if (!runtime.utils || typeof runtime.utils.resolvePath !== "function") return "";
  try {
    return runtime.utils.resolvePath(path) || "";
  } catch (_error) {
    return "";
  }
}

function chmodPrivate(path) {
  if (!path || !runtime.utils || typeof runtime.utils.exec !== "function") return Promise.resolve();
  return runtime.utils.exec("/bin/chmod", ["600", path]).catch(function () {});
}

function writeTempFile(path, contents) {
  if (!runtime.file || typeof runtime.file.write !== "function") {
    throw new Error("plugin temp file is unavailable");
  }
  runtime.file.write(path, contents);
  var resolved = resolvePluginPath(path);
  if (!resolved) throw new Error("could not resolve " + path);
  return resolved;
}

function deleteTempFile(path) {
  if (!runtime.file || !path) return;
  try {
    if (typeof runtime.file.delete === "function") runtime.file.delete(path);
    else runtime.file.write(path, "");
  } catch (_error) {}
}

function curlConfigLine(name, value) {
  return name + " = " + JSON.stringify(String(value));
}

async function requestWithCurl(method, path, options) {
  if (!runtime.utils || typeof runtime.utils.exec !== "function") {
    throw new Error("utils.exec is unavailable");
  }
  var settings = options || {};
  var query = Object.assign({}, requiredQuery(), settings.query || {});
  var url = API_ROOT + path + "?" + encodeQuery(query);
  var marker = "__IINA_SIMKL_STATUS__:";
  var headers = Object.assign({}, requiredHeaders(settings.accessToken, method), settings.headers || {});
  var headerPath = "@tmp/simkl-curl-headers.conf";
  var bodyPath = "@tmp/simkl-curl-body.json";
  var dumpPath = "@tmp/simkl-curl-response-headers.txt";
  var headerFile = "";
  var bodyFile = "";
  var dumpFile = "";
  var wroteHeader = false;
  var wroteBody = false;
  var wroteDump = false;
  try {
    dumpFile = writeTempFile(dumpPath, "");
    wroteDump = true;
    await chmodPrivate(dumpFile);
    var conf = ["silent", "show-error", "max-time = 8", curlConfigLine("request", String(method || "GET").toUpperCase())];
    if (settings.followRedirects !== false) conf.push("location");
    conf.push(curlConfigLine("dump-header", dumpFile));
    Object.keys(headers).forEach(function (name) {
      conf.push(curlConfigLine("header", name + ": " + headers[name]));
    });
    headerFile = writeTempFile(headerPath, conf.join("\n") + "\n");
    wroteHeader = true;
    await chmodPrivate(headerFile);
    var args = ["-K", headerFile, "-w", "\n" + marker + "%{http_code}"];
    if (settings.body !== undefined) {
      bodyFile = writeTempFile(bodyPath, JSON.stringify(settings.body));
      wroteBody = true;
      await chmodPrivate(bodyFile);
      args.push("--data-binary", "@" + bodyFile);
    }
    args.push(url);
    var response = await runtime.utils.exec("/usr/bin/curl", args);
    if (response.status !== 0) {
      throw new Error(response.stderr || "curl failed with status " + response.status);
    }
    var stdout = response.stdout || "";
    var markerIndex = stdout.lastIndexOf(marker);
    var rawBody = markerIndex >= 0 ? stdout.slice(0, markerIndex).trim() : stdout.trim();
    var statusCode =
      markerIndex >= 0 ? parseInt(stdout.slice(markerIndex + marker.length).trim(), 10) : 0;
    var dumpText = "";
    try {
      dumpText = runtime.file && typeof runtime.file.read === "function" ? runtime.file.read(dumpPath) || "" : "";
    } catch (_error) {
      dumpText = "";
    }
    return {
      statusCode: statusCode,
      body: parseJson(rawBody, rawBody === "" ? {} : rawBody),
      rawBody: rawBody,
      headers: parseHeaderDump(dumpText),
      url: url,
    };
  } finally {
    if (wroteHeader) deleteTempFile(headerPath);
    if (wroteBody) deleteTempFile(bodyPath);
    if (wroteDump) deleteTempFile(dumpPath);
  }
}

function httpFailureResponse(error, url) {
  var res = error;
  if (!res || typeof res !== "object") return null;
  if (res.statusCode == null && res.data && typeof res.data === "object" && res.data.statusCode != null) {
    res = res.data;
  }
  if (res.statusCode == null) return null;
  return {
    statusCode: Number(res.statusCode) || 0,
    body: responseBody(res),
    rawBody: res.text ? String(res.text) : "",
    headers: normalizeHeaders(res.headers || res.header),
    url: url || "",
  };
}

function requestUrl(path, options) {
  var settings = options || {};
  var query = Object.assign({}, requiredQuery(), settings.query || {});
  return API_ROOT + path + "?" + encodeQuery(query);
}

async function sendOnce(method, path, settings) {
  // IINA's Just client form-urlencodes `data`, so JSON bodies go straight to curl.
  // Do not follow redirects on /redirect — we need the Location header.
  if (settings.body === undefined && settings.followRedirects !== false && runtime.http) {
    try {
      return await withTimeout(requestWithHttp(method, path, settings), httpTimeoutMs(), "iina.http");
    } catch (error) {
      var asResponse = httpFailureResponse(error, requestUrl(path, settings));
      if (asResponse) return asResponse;
      log("iina.http failed, falling back to curl: " + (error && error.message ? error.message : error));
    }
  }
  return requestWithCurl(method, path, settings);
}

async function sendWithRetries(method, path, settings) {
  var verb = String(method || "GET").toUpperCase();
  var attempt = 0;
  while (true) {
    if (verb === "POST") await waitForPostSlot();
    var response = await sendOnce(method, path, settings);
    rememberRateLimit(response);
    var err = errorCode(response);

    if (response.statusCode === 429) {
      if (err === "user_limit_exceeded" || err === "app_limit_exceeded") {
        markQuotaExceeded(response);
        return response;
      }
      if (attempt < 3) {
        attempt += 1;
        await sleep(RATE_LIMIT_RETRY_MS + Math.floor(Math.random() * 250));
        continue;
      }
      return response;
    }

    if (response.statusCode === 400 && err === "RATE_LIMIT" && attempt < 2) {
      attempt += 1;
      await sleep(WRITE_LOCK_RETRY_MS);
      continue;
    }

    if (
      (response.statusCode === 500 || response.statusCode === 502 || response.statusCode === 503) &&
      attempt < 4 &&
      !isOAuthPath(path)
    ) {
      var delay = Math.min(1000 * Math.pow(2, attempt), 16000) + Math.floor(Math.random() * 1000);
      attempt += 1;
      await sleep(delay);
      continue;
    }

    return response;
  }
}

async function rawRequest(method, path, options) {
  var verb = String(method || "GET").toUpperCase();
  var settings = options || {};
  log("HTTP " + verb + " " + path);
  return enqueueRequest(async function () {
    return sendWithRetries(method, path, settings);
  });
}

function readTokenFromKeychain() {
  if (!runtime.utils || typeof runtime.utils.keyChainRead !== "function") return "";
  try {
    return runtime.utils.keyChainRead(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) || "";
  } catch (_error) {
    return "";
  }
}

function writeTokenToKeychain(rawValue) {
  if (!runtime.utils || typeof runtime.utils.keyChainWrite !== "function") return false;
  try {
    return runtime.utils.keyChainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, rawValue);
  } catch (_error) {
    return false;
  }
}

function readTokenFromPreferences() {
  if (!runtime.preferences || typeof runtime.preferences.get !== "function") return "";
  try {
    var value = runtime.preferences.get(TOKEN_PREF);
    if (!value) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  } catch (_error) {
    return "";
  }
}

function writeTokenToPreferences(rawValue) {
  if (!runtime.preferences || typeof runtime.preferences.set !== "function") return;
  try {
    runtime.preferences.set(TOKEN_PREF, rawValue || "");
    if (typeof runtime.preferences.sync === "function") runtime.preferences.sync();
  } catch (_error) {}
}

function deleteTokenFile() {
  if (!runtime.file) return;
  try {
    if (typeof runtime.file.delete === "function" && runtime.file.exists(TOKEN_PATH)) {
      runtime.file.delete(TOKEN_PATH);
    } else if (typeof runtime.file.write === "function") {
      runtime.file.write(TOKEN_PATH, "");
    }
  } catch (_error) {}
}

function clearPlaintextTokenCopies() {
  writeTokenToPreferences("");
  deleteTokenFile();
}

function persistTokenRaw(raw) {
  var text = raw || "";
  var keychainOk = writeTokenToKeychain(text);
  if (text && keychainOk) {
    clearPlaintextTokenCopies();
    return;
  }
  if (text && !keychainOk) {
    log("Warning: keychain write failed; keeping token in plugin preferences");
    writeTokenToPreferences(text);
    try {
      if (runtime.file) runtime.file.write(TOKEN_PATH, text);
    } catch (_error) {}
    return;
  }
  clearPlaintextTokenCopies();
}

function loadToken() {
  if (runtime.tokenCache !== undefined) return runtime.tokenCache;
  var fromKeychain = false;
  var raw = readTokenFromKeychain();
  if (raw) fromKeychain = true;
  if (!raw && runtime.file && runtime.file.exists(TOKEN_PATH)) {
    try {
      raw = runtime.file.read(TOKEN_PATH) || "";
    } catch (_error) {
      raw = "";
    }
  }
  if (!raw) raw = readTokenFromPreferences();
  runtime.tokenCache = parseJson(raw, null);
  if (runtime.tokenCache && runtime.tokenCache.access_token && raw) {
    if (fromKeychain) clearPlaintextTokenCopies();
    else persistTokenRaw(raw);
  }
  return runtime.tokenCache;
}

function saveToken(token) {
  runtime.tokenCache = token || null;
  persistTokenRaw(JSON.stringify(runtime.tokenCache || {}));
}

function clearToken() {
  runtime.tokenCache = null;
  runtime.lastAuthFailure = "";
  runtime.authCode = "";
  runtime.authUrl = "";
  runtime.authExpiresAt = 0;
  runtime.viewerProfile = null;
  runtime.viewerProfileFetchedAt = 0;
  persistTokenRaw("");
}

function storedAccessToken() {
  var token = loadToken();
  return token && token.access_token ? String(token.access_token) : "";
}

function getAccessToken() {
  var token = storedAccessToken();
  return isV2AccessToken(token) ? token : "";
}

function hasLegacyToken() {
  return isV1AccessToken(storedAccessToken());
}

function tokenHasWriteScope(token) {
  return String((token && token.scope) || "").indexOf("media:write") !== -1;
}

function accessTokenExpiresAtMs(token) {
  if (!token) return 0;
  if (token.expires_at) return Number(token.expires_at) * 1000;
  if (token.created_at && token.expires_in) {
    return (Number(token.created_at) + Number(token.expires_in)) * 1000;
  }
  return 0;
}

function persistOAuthToken(body, previous) {
  var now = Math.floor(nowMs() / 1000);
  var expiresIn = Number(body && body.expires_in) || 604800;
  var refreshToken = (body && body.refresh_token) || (previous && previous.refresh_token) || "";
  saveToken({
    access_token: body.access_token,
    refresh_token: refreshToken,
    token_type: body.token_type || "Bearer",
    expires_in: expiresIn,
    scope: body.scope || (previous && previous.scope) || "",
    created_at: now,
    expires_at: now + expiresIn,
    refresh_expires_at: now + REFRESH_TTL_SEC,
  });
}

function invalidClientMessage() {
  return "Simkl rejected this app's client ID. Try Connect again.";
}

function createAuthStatus(state, summary, detail, busy, extras) {
  var status = {
    state: state,
    summary: summary,
    detail: detail || "",
    busy: !!busy,
    connected: state === "connected",
    userCode: runtime.authCode || "",
    verificationUrl: runtime.authUrl || "",
  };
  Object.keys(extras || {}).forEach(function (key) {
    status[key] = extras[key];
  });
  return status;
}

function getAuthStatus() {
  if (runtime.authPromise) {
    return createAuthStatus(
      "authorizing",
      "Waiting for Simkl authorization",
      runtime.authCode
        ? "Approve " + runtime.authCode + " at simkl.com/pin, or use the page that just opened."
        : "Approve access in your browser, then return to IINA.",
      true
    );
  }
  if (hasLegacyToken()) {
    return createAuthStatus(
      "legacy",
      "Reconnect to Simkl",
      "Simkl upgraded sign-in. Connect once more. Your watch history stays on Simkl.",
      false
    );
  }
  if (getAccessToken()) {
    var token = loadToken();
    if (!tokenHasWriteScope(token)) {
      return createAuthStatus(
        "error",
        "Simkl granted read-only access",
        "Reconnect and allow Simkl to update your library so scrobbling can work.",
        false,
        { user: runtime.viewerProfile }
      );
    }
    return createAuthStatus("connected", "Connected to Simkl", "", false, {
      user: runtime.viewerProfile,
    });
  }
  if (runtime.lastAuthFailure) {
    return createAuthStatus("error", "Simkl authorization failed", runtime.lastAuthFailure, false);
  }
  return createAuthStatus(
    "disconnected",
    "Not connected to Simkl",
    "Connect opens Simkl in your browser. Approve access, then return to IINA.",
    false
  );
}

function isAuthRequiredError(error) {
  return !!(error && String(error.message || error) === AUTH_REQUIRED);
}

function canAllowRewatch() {
  try {
    if (!runtime.preferences || !runtime.preferences.get("track_rewatches")) return false;
  } catch (_error) {
    return false;
  }
  var type = runtime.viewerProfile && String(runtime.viewerProfile.accountType || "").toLowerCase();
  return type === "pro" || type === "vip";
}

function hashCacheKey(value) {
  var text = String(value || "");
  var hash = 2166136261;
  for (var i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function looksLikeRawPathKey(key) {
  var text = String(key || "");
  return text.length > 16 || text.indexOf("/") !== -1 || text.indexOf("\\") !== -1 || /\.[a-z0-9]{2,4}$/i.test(text);
}

function pruneCacheMap(cache, max) {
  var keys = Object.keys(cache || {});
  if (keys.length <= max) return false;
  keys.sort(function (a, b) {
    var left = Date.parse((cache[a] && cache[a].cachedAt) || 0) || 0;
    var right = Date.parse((cache[b] && cache[b].cachedAt) || 0) || 0;
    return left - right;
  });
  var drop = keys.length - max;
  for (var i = 0; i < drop; i += 1) delete cache[keys[i]];
  return true;
}

function migrateCacheKeys(cache) {
  var keys = Object.keys(cache || {});
  var needsRehash = keys.some(looksLikeRawPathKey);
  if (!needsRehash) return cache || {};
  var next = {};
  keys.forEach(function (key) {
    next[hashCacheKey(key)] = cache[key];
  });
  return next;
}

function backfillShowCache(cache) {
  var keys = Object.keys(cache || {});
  for (var i = 0; i < keys.length; i += 1) {
    var record = cache[keys[i]];
    if (!record || !record.matched || !record.ids) continue;
    var showKeys = showCacheKeysFromIds(record.ids);
    for (var s = 0; s < showKeys.length; s += 1) {
      if (!cache[showKeys[s]]) cache[showKeys[s]] = record;
    }
  }
}

function loadMatchCache() {
  if (runtime.matchCache) return runtime.matchCache;
  var cache = readJson(CACHE_PATH, null);
  runtime.matchCache = migrateCacheKeys(cache && typeof cache === "object" ? cache : {});
  backfillShowCache(runtime.matchCache);
  pruneCacheMap(runtime.matchCache, CACHE_MAX_ENTRIES);
  return runtime.matchCache;
}

function saveMatchCache() {
  if (!runtime.matchCache) return;
  pruneCacheMap(runtime.matchCache, CACHE_MAX_ENTRIES);
  writeJson(CACHE_PATH, runtime.matchCache);
}

function loadNegativeCache() {
  if (runtime.negativeCache) return runtime.negativeCache;
  var cache = readJson(NEGATIVE_CACHE_PATH, null);
  runtime.negativeCache = migrateCacheKeys(cache && typeof cache === "object" ? cache : {});
  pruneCacheMap(runtime.negativeCache, CACHE_MAX_ENTRIES);
  return runtime.negativeCache;
}

function saveNegativeCache() {
  if (!runtime.negativeCache) return;
  pruneCacheMap(runtime.negativeCache, CACHE_MAX_ENTRIES);
  writeJson(NEGATIVE_CACHE_PATH, runtime.negativeCache);
}

function cacheKeyFor(filename, path) {
  return hashCacheKey(
    "v3:" +
      String(path || filename || "")
        .trim()
        .toLowerCase()
  );
}

function negativeEntryFresh(entry) {
  if (!entry || !entry.cachedAt) return false;
  var age = Date.now() - Date.parse(entry.cachedAt);
  return isFinite(age) && age >= 0 && age < NEGATIVE_TTL_MS;
}

function showCacheKeysFromIds(ids) {
  var keys = [];
  if (!ids) return keys;
  if (ids.imdb) keys.push(hashCacheKey("v3:show:imdb:" + String(ids.imdb).toLowerCase()));
  if (ids.tvdb) keys.push(hashCacheKey("v3:show:tvdb:" + String(ids.tvdb)));
  if (ids.tmdb) keys.push(hashCacheKey("v3:show:tmdb:" + String(ids.tmdb)));
  var simklId = media.readSimklId(ids);
  if (simklId) keys.push(hashCacheKey("v3:show:simkl:" + simklId));
  return keys;
}

function rememberShow(match) {
  if (!match || !match.matched) return;
  var keys = showCacheKeysFromIds(match.ids);
  if (!keys.length) return;
  var cache = loadMatchCache();
  var record = media.cacheRecord(match);
  record.episodeTitle = "";
  record.episodeIds = {};
  keys.forEach(function (key) {
    cache[key] = record;
  });
  saveMatchCache();
}

function cachedShowMatch(path, filename) {
  var leaf = media.extractFilename(path) || filename;
  var ids = Object.assign({}, media.extractExternalIds(path), media.extractExternalIds(leaf));
  var keys = showCacheKeysFromIds(ids);
  if (!keys.length) return null;
  var cache = loadMatchCache();
  var movieLike = media.looksLikeStandaloneMovie(leaf);
  for (var i = 0; i < keys.length; i += 1) {
    var record = cache[keys[i]];
    if (!record || !record.matched) continue;
    if (movieLike && record.kind !== "movie" && record.animeType !== "movie") continue;
    return media.applyEpisodeFromFilename(media.mediaFromCache(record, filename), filename);
  }
  return null;
}

function rememberMatch(filename, path, match) {
  var key = cacheKeyFor(filename, path);
  if (!key) return;
  var cache = loadMatchCache();
  cache[key] = media.cacheRecord(match);
  saveMatchCache();
  rememberShow(match);
  var negative = loadNegativeCache();
  if (negative[key]) {
    delete negative[key];
    saveNegativeCache();
  }
}

function rememberNegative(filename, path, reason) {
  var key = cacheKeyFor(filename, path);
  if (!key) return;
  var cache = loadNegativeCache();
  cache[key] = {
    reason: reason || "no-match",
    cachedAt: new Date().toISOString(),
  };
  saveNegativeCache();
}

function cachedMatch(filename, path) {
  var key = cacheKeyFor(filename, path);
  if (!key) return null;
  var cache = loadMatchCache();
  if (cache[key]) return media.mediaFromCache(cache[key], filename);
  var negative = loadNegativeCache();
  if (negative[key]) {
    if (negativeEntryFresh(negative[key])) {
      return media.createUnmatched(filename, negative[key].reason || "cached-negative");
    }
    delete negative[key];
    saveNegativeCache();
  }
  return null;
}

function forgetMatch(path, filename) {
  var key = cacheKeyFor(filename, path);
  if (!key) return;
  var cache = loadMatchCache();
  if (cache[key]) {
    delete cache[key];
    saveMatchCache();
  }
  var negative = loadNegativeCache();
  if (negative[key]) {
    delete negative[key];
    saveNegativeCache();
  }
}

function isTrustedMatch(match) {
  return !!(
    match &&
    match.matched &&
    match.trusted !== false &&
    !media.isWeakTitle(match.catalogTitle || "") &&
    media.readSimklId(match.ids)
  );
}

function hasCatalogFields(match) {
  return !!(
    isTrustedMatch(match) &&
    (match.titleEn || match.catalogTitle) &&
    (match.poster || match.yearLabel || match.year)
  );
}

async function searchByFileName(query, filename) {
  var response = await authedRequest("POST", "/search/file", {
    body: { file: query },
  });
  if (response.statusCode >= 400) {
    throw new Error(
      responseErrorMessage(response, "Simkl file search failed with status " + response.statusCode)
    );
  }
  var match = media.matchFromSearchFile(response.body, filename);
  match.filename = filename;
  return match;
}

function textSearchScore(parsed, item) {
  var score = Math.max(
    media.titleSimilarity(parsed.title, item.title),
    media.titleSimilarity(parsed.title, item.title_en),
    media.titleSimilarity(parsed.title, item.title_romaji)
  );
  var yearHit = !!(parsed.year && Number(item.year) === Number(parsed.year));
  if (yearHit) score = Math.min(1, score + 0.08);
  return { score: score, yearHit: yearHit };
}

function isStrongTextMatch(parsed, item) {
  var result = textSearchScore(parsed, item);
  if (result.score >= 0.99) return true;
  if (result.yearHit && result.score >= 0.8) return true;
  return false;
}

function pickBestSearchResult(items, parsed) {
  var list = Array.isArray(items) ? items : [];
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < list.length; i += 1) {
    var item = list[i] || {};
    var scored = textSearchScore(parsed, item);
    if (scored.score > bestScore) {
      bestScore = scored.score;
      best = item;
    }
  }
  if (!best || !isStrongTextMatch(parsed, best)) return null;
  return best;
}

async function identifyByText(filename, filePath) {
  var names = [filename];
  var parts = media.extractPath(filePath || "").split("/").filter(Boolean);
  if (parts.length >= 2) names.push(parts[parts.length - 2]);
  var episodeHint = media.parseEpisodeHint(filename);
  var types = episodeHint ? ["anime", "tv", "movie"] : ["movie", "tv", "anime"];

  for (var n = 0; n < names.length; n += 1) {
    var parsed = media.parseTitleFromFilename(names[n]);
    if (!parsed.title || media.isWeakTitle(parsed.title)) continue;
    var queries = [parsed.title];
    if (episodeHint && episodeHint.season > 1) {
      queries.unshift(parsed.title + " Season " + episodeHint.season);
    }
    for (var q = 0; q < queries.length; q += 1) {
      var scored = Object.assign({}, parsed);
      if (episodeHint && episodeHint.season > 1) scored.year = null;
      var items = await searchCatalog(queries[q], types, 5);
      var best = pickBestSearchResult(items, scored);
      if (!best) continue;
      var match = media.applyTitleFallback(
        media.mediaFromSearchResult(best, filename, episodeHint),
        filename
      );
      match.trusted = isStrongTextMatch(scored, best);
      if (match.trusted) return match;
    }
  }
  return null;
}

function parseRedirectLocation(location) {
  var href = String(location || "");
  var match = href.match(/simkl\.com\/(movies|tv|anime)\/(\d+)(?:\/([^/?#]+))?/i);
  if (!match) return null;
  var section = String(match[1] || "").toLowerCase();
  var kind = section === "movies" ? "movie" : section === "anime" ? "anime" : "show";
  return {
    kind: kind,
    id: Number(match[2]),
    slug: decodeURIComponent(String(match[3] || "")),
  };
}

async function resolveRedirect(query) {
  var response = await authedRequest("GET", "/redirect", {
    query: query,
    followRedirects: false,
  });
  if (response.statusCode === 412) {
    throw new Error(responseErrorMessage(response, "Simkl client_id failed"));
  }
  if (response.statusCode !== 301 && response.statusCode !== 302) return null;
  return parseRedirectLocation(headerValue(response.headers, "location"));
}

async function identifyByExternalId(filePath, filename) {
  var leaf = media.extractFilename(filePath) || filename;
  var leafIds = media.extractExternalIds(leaf);
  var pathIds = media.extractExternalIds(filePath);
  var ids = Object.assign({}, pathIds, leafIds);
  if (!leafIds.imdb && !leafIds.tmdb && !leafIds.tvdb && media.looksLikeStandaloneMovie(leaf)) {
    ids = leafIds;
  }
  if (!ids.imdb && !ids.tmdb && !ids.tvdb) return null;
  var query = { to: "simkl" };
  if (ids.imdb) query.imdb = ids.imdb;
  else if (ids.tvdb) query.tvdb = ids.tvdb;
  else {
    query.tmdb = ids.tmdb;
    query.type = media.parseEpisodeHint(filename) ? "tv" : "movie";
  }
  var resolved = await resolveRedirect(query);
  if (!resolved || !resolved.id) return null;
  var type = resolved.kind === "movie" ? "movie" : resolved.kind === "anime" ? "anime" : "tv";
  var match = media.applyTitleFallback(
    media.mediaFromSearchResult(
      {
        title: resolved.slug || "",
        type: type,
        endpoint_type: type,
        ids: { simkl: resolved.id, slug: resolved.slug },
      },
      filename,
      media.parseEpisodeHint(filename),
      { trusted: true, source: "redirect" }
    ),
    filename
  );
  match.ids = media.sanitizeIds(Object.assign({}, match.ids, ids, { simkl: resolved.id, slug: resolved.slug }));
  match.kind = resolved.kind;
  match.slug = resolved.slug || match.slug;
  match.url = media.simklItemUrl(match.kind, match.ids);
  match.trusted = true;
  return match;
}

async function identifyFile(filePath, options) {
  var settings = options || {};
  var path = String(filePath || "").trim();
  var filename = media.extractFilename(path) || path;
  if (!filename) {
    return media.createUnmatched("", "missing-filename");
  }

  if (!getAccessToken()) {
    return media.createUnmatched(filename, "auth-required");
  }
  if (quotaBlocked()) {
    return media.createUnmatched(filename, "quota-exceeded");
  }

  if (!settings.force) {
    var cached = cachedMatch(filename, path);
    if (
      cached &&
      cached.matched &&
      isTrustedMatch(cached) &&
      media.looksLikeStandaloneMovie(filename) &&
      cached.kind !== "movie" &&
      !media.isAnimeMovie(cached)
    ) {
      log("Ignoring episodic cache for movie-like file " + filename);
      cached = null;
    }
    if (cached && cached.matched && isTrustedMatch(cached)) {
      if (!hasCatalogFields(cached)) cached = await enrichMatch(cached);
      if (!hasCatalogFields(cached) || needsCourAlignment(cached)) {
        cached = await publishMatch(filename, path, cached);
      }
      log("Match cache hit for " + filename + " -> " + media.mediaLabel(cached, "english"));
      return cached;
    }
    if (cached && !cached.matched) {
      log("Negative cache hit for " + filename);
      return cached;
    }
    var showCached = cachedShowMatch(path, filename);
    if (showCached && isTrustedMatch(showCached)) {
      if (!hasCatalogFields(showCached)) showCached = await enrichMatch(showCached);
      showCached = await publishMatch(filename, path, showCached);
      log("Show cache hit for " + filename + " -> " + media.mediaLabel(showCached, "english"));
      return showCached;
    }
  }

  var match = null;
  var searchError = false;
  try {
    match = await identifyByExternalId(path, filename);
    if (match && media.readSimklId(match.ids)) {
      match = await enrichMatch(match);
      if (isTrustedMatch(match)) {
        match = await publishMatch(filename, path, match);
        log("Identified " + filename + " by external ID as " + media.mediaLabel(match));
        return match;
      }
    }
  } catch (error) {
    if (isAuthRequiredError(error)) return media.createUnmatched(filename, "auth-required");
    searchError = true;
    log("External ID search failed: " + (error && error.message ? error.message : error));
  }

  var queries = media.fileSearchQueries(path || filename);
  for (var i = 0; i < queries.length; i += 1) {
    log("File search with " + queries[i]);
    try {
      match = await searchByFileName(queries[i], filename);
    } catch (error) {
      if (isAuthRequiredError(error)) return media.createUnmatched(filename, "auth-required");
      searchError = true;
      log("File search failed for " + queries[i] + ": " + (error && error.message ? error.message : error));
      continue;
    }
    if (isTrustedMatch(match)) {
      match = await enrichMatch(match);
      if (isTrustedMatch(match)) {
        match = await publishMatch(filename, path, match);
        log("Identified " + filename + " as " + media.mediaLabel(match));
        return match;
      }
    }
    log("Ignoring untrusted file match for " + queries[i] + ": " + (match && match.catalogTitle ? match.catalogTitle : "none"));
  }

  try {
    match = await identifyByText(filename, path);
    if (match && match.matched && isTrustedMatch(match)) {
      match = await enrichMatch(match);
      if (isTrustedMatch(match)) {
        match = await publishMatch(filename, path, match);
        log("Identified " + filename + " by title search as " + media.mediaLabel(match));
        return match;
      }
    }
  } catch (error) {
    if (isAuthRequiredError(error)) return media.createUnmatched(filename, "auth-required");
    searchError = true;
    log("Title search failed: " + (error && error.message ? error.message : error));
  }

  if (!searchError) rememberNegative(filename, path, "no-match");
  log("Simkl did not recognize " + filename);
  return media.createUnmatched(filename, searchError ? "search-error" : "no-match");
}

async function enrichMatch(match) {
  if (!match || !match.matched) return match;
  if (hasCatalogFields(match) && match.source !== "redirect") return match;
  var id = media.readSimklId(match.ids);
  if (!id) return media.applyTitleFallback(match, match.filename);

  var paths = [];
  if (match.kind === "movie") paths.push("/movies/" + id);
  else if (match.kind === "anime") paths.push("/anime/" + id, "/tv/" + id);
  else paths.push("/tv/" + id, "/anime/" + id);

  for (var i = 0; i < paths.length; i += 1) {
    try {
      var response = await authedRequest("GET", paths[i]);
      if (response.statusCode >= 400 || !response.body) continue;
      var body = response.body;
      if (body.title && !media.isWeakTitle(body.title)) {
        match.title = media.cleanTitle(body.title);
        match.catalogTitle = media.cleanTitle(body.title);
        match.trusted = true;
      }
      var english = media.collectEnglishTitle(body);
      if (english) match.titleEn = english;
      if (body.title_romaji) match.titleRomaji = media.cleanTitle(body.title_romaji);
      if (body.year) match.year = Number(body.year);
      match.yearLabel = media.formatYearLabel(body.year_start_end, match.year);
      if (body.poster) match.poster = body.poster;
      if (body.ids && body.ids.slug) match.slug = body.ids.slug;
      if (paths[i].indexOf("/anime/") === 0) match.kind = "anime";
      if (paths[i].indexOf("/movies/") === 0) match.kind = "movie";
      var animeType = String(body.anime_type || body.type || "").toLowerCase();
      if (match.kind === "anime" && (animeType === "movie" || animeType === "film")) {
        match.animeType = "movie";
      }
      match.url = media.simklItemUrl(match.kind, Object.assign({}, match.ids, { slug: match.slug }));
      match.ids = media.sanitizeIds(Object.assign({}, match.ids, body.ids || {}));
      break;
    } catch (error) {
      log("Metadata enrich failed for " + paths[i] + ": " + (error && error.message ? error.message : error));
    }
  }

  match = media.applyTitleFallback(match, match.filename);
  return match;
}

function mappedTvdbSeasons(body) {
  var raw = body && body.mapped_tvdb_seasons;
  if (!Array.isArray(raw)) return [];
  var out = [];
  for (var i = 0; i < raw.length; i += 1) {
    var n = Math.floor(Number(raw[i]));
    if (n > 0) out.push(n);
  }
  return out;
}

function listAnimeRelations(body) {
  var rel = body && body.relations;
  if (Array.isArray(rel)) return rel;
  if (!rel || typeof rel !== "object") return [];
  var out = [];
  Object.keys(rel).forEach(function (key) {
    var items = rel[key];
    if (!Array.isArray(items)) items = items ? [items] : [];
    items.forEach(function (item) {
      if (!item || typeof item !== "object") return;
      out.push(Object.assign({}, item, { relation_type: item.relation_type || key }));
    });
  });
  return out;
}

function isTvAnimeRelation(rel) {
  var at = String((rel && (rel.anime_type || rel.type)) || "tv").toLowerCase();
  return !at || at === "tv" || at === "ona" || at === "anime";
}

function relationType(rel) {
  return String((rel && (rel.relation_type || rel.relation)) || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .trim();
}

function isSequelRelation(rel) {
  return relationType(rel) === "sequel";
}

function isPreviousCourRelation(rel) {
  var type = relationType(rel);
  if (type === "prequel") return true;
  return /^season\s+\d+$/.test(type);
}

function pickDirectSequel(body) {
  var rels = listAnimeRelations(body);
  var direct = null;
  var fallback = null;
  for (var i = 0; i < rels.length; i += 1) {
    var rel = rels[i];
    if (!isSequelRelation(rel) || !isTvAnimeRelation(rel)) continue;
    if (!media.readSimklId(rel.ids)) continue;
    if (rel.is_direct === true || rel.is_direct === "true") {
      direct = rel;
      break;
    }
    if (!fallback) fallback = rel;
  }
  return direct || fallback;
}

function pickDirectPrevious(body) {
  var rels = listAnimeRelations(body);
  var seasonLink = null;
  for (var i = 0; i < rels.length; i += 1) {
    var rel = rels[i];
    if (!isPreviousCourRelation(rel) || !isTvAnimeRelation(rel)) continue;
    if (!media.readSimklId(rel.ids)) continue;
    if (rel.is_direct !== true && rel.is_direct !== "true") continue;
    if (relationType(rel) === "prequel") return rel;
    if (!seasonLink) seasonLink = rel;
  }
  return seasonLink;
}

async function fetchAnimeDetail(id) {
  if (!runtime.animeDetailCache) runtime.animeDetailCache = {};
  if (runtime.animeDetailCache[id]) return runtime.animeDetailCache[id];
  var response = await authedRequest("GET", "/anime/" + id);
  if (response.statusCode >= 400 || !response.body || media.isEmptyMatch(response.body)) return null;
  runtime.animeDetailCache[id] = response.body;
  return response.body;
}

async function fetchAnimeEpisodes(id) {
  if (!runtime.animeEpisodeCache) runtime.animeEpisodeCache = {};
  if (runtime.animeEpisodeCache[id]) return runtime.animeEpisodeCache[id];
  var response = await authedRequest("GET", "/anime/episodes/" + id);
  if (response.statusCode >= 400 || !Array.isArray(response.body)) return null;
  runtime.animeEpisodeCache[id] = response.body;
  return response.body;
}

function applyAnimeDetail(match, body, filename) {
  var next = media.mediaFromSearchResult(
    {
      title: body.title,
      title_en: body.en_title,
      title_romaji: body.title_romaji,
      year: body.year,
      poster: body.poster,
      ids: body.ids,
      endpoint_type: "anime",
    },
    filename || match.filename,
    media.parseEpisodeHint(filename || match.filename),
    { trusted: true, source: match.source || "anime-sequel" }
  );
  next.titleEn = media.collectEnglishTitle(body) || next.titleEn;
  next.catalogTitle = media.cleanTitle(body.title);
  next.yearLabel = media.formatYearLabel(body.year_start_end, next.year);
  next.kind = "anime";
  next.trusted = true;
  return media.applyTitleFallback(next, filename || match.filename);
}

async function followAnimeSequel(match) {
  if (!match || !match.matched || match.kind !== "anime") return match;
  if (media.isAnimeMovie(match)) return match;
  var hint = media.parseEpisodeHint(match.filename || "");
  if (!hint || !hint.season || hint.season <= 1) return match;
  var target = hint.season;
  var seen = {};
  var current = match;
  var hops = 0;
  while (current && hops < 12) {
    var id = media.readSimklId(current.ids);
    if (!id || seen[id]) break;
    seen[id] = true;
    var body;
    try {
      body = await fetchAnimeDetail(id);
    } catch (_error) {
      break;
    }
    if (!body) break;
    var mapped = mappedTvdbSeasons(body);
    if (mapped.indexOf(target) !== -1) {
      if (hops === 0) return match;
      current = applyAnimeDetail(current, body, match.filename);
      log("Followed anime sequel to " + media.mediaLabel(current));
      return current;
    }
    var maxMapped = mapped.length ? Math.max.apply(null, mapped) : 0;
    if (maxMapped >= target) {
      return hops === 0 ? match : applyAnimeDetail(current, body, match.filename);
    }
    var sequel = pickDirectSequel(body);
    if (!sequel) break;
    current = media.mediaFromSearchResult(sequel, match.filename, hint, {
      trusted: true,
      source: "anime-sequel",
    });
    hops += 1;
  }
  if (hops > 0 && current && current.matched) {
    try {
      var sequelBody = await fetchAnimeDetail(media.readSimklId(current.ids));
      if (sequelBody) return applyAnimeDetail(current, sequelBody, match.filename);
    } catch (_error) {}
    return current;
  }
  return match;
}

function courHint(match) {
  return media.parseEpisodeHint((match && match.filename) || "");
}

function needsCourAlignment(match) {
  if (!match || !match.matched || match.kind !== "anime" || media.isAnimeMovie(match)) return false;
  if (match.courChecked) return false;
  var hint = courHint(match);
  return !!(hint && hint.explicitSeason && hint.number);
}

function markCourChecked(match) {
  return media.createMedia(Object.assign({}, match, { courChecked: true, courResolved: false }));
}

async function searchCourChain(start, hint, seen) {
  var current = start;
  var hops = 0;
  while (current && hops < 8) {
    var id = media.readSimklId(current.ids);
    if (!id || seen[id]) return { found: null };
    var episodes;
    try {
      episodes = await fetchAnimeEpisodes(id);
    } catch (error) {
      return { found: null, unavailable: true, error: error };
    }
    if (!episodes) return { found: null, unavailable: true };
    if (hops === 0 && !media.episodesHaveTvdb(episodes)) {
      seen[id] = { show: current, noTvdb: true };
      return { noTvdb: true, found: null };
    }
    var hit = media.animeEpisodeForTvdb(episodes, hint.season, hint.number);
    if (hit) {
      seen[id] = { show: current };
      return { found: { show: current, episode: hit, id: id } };
    }
    var body;
    try {
      body = await fetchAnimeDetail(id);
    } catch (error) {
      return { found: null, unavailable: true, error: error };
    }
    seen[id] = { show: current, body: body };
    if (!body) return { found: null, unavailable: true };
    var sequel = pickDirectSequel(body);
    if (!sequel) return { found: null };
    current = media.mediaFromSearchResult(sequel, start.filename, hint, {
      trusted: true,
      source: "anime-sequel",
    });
    hops += 1;
  }
  return { found: null };
}

async function finishCourHit(found, hint, filename) {
  var show = found.show;
  var body = found.body;
  if (!body) {
    try {
      body = await fetchAnimeDetail(found.id);
    } catch (_error) {
      body = null;
    }
  }
  if (body) show = applyAnimeDetail(show, body, filename);
  var next = media.applyAnimeTvdbEpisode(show, found.episode, hint);
  var moved =
    media.readSimklId(next.ids) !== media.readSimklId(found.show.ids) ||
    Number(next.number) !== Number(hint.number);
  if (moved) {
    log(
      "Mapped S" +
        media.pad2(hint.season) +
        "E" +
        media.pad2(hint.number) +
        " to " +
        media.mediaLabel(next)
    );
  }
  return next;
}

async function alignAnimeCour(match) {
  if (!needsCourAlignment(match)) return match;
  var hint = courHint(match);
  var seen = {};
  var chain = await searchCourChain(match, hint, seen);
  if (chain.unavailable) return match;
  if (chain.noTvdb) return markCourChecked(await followAnimeSequel(match));
  if (chain.found) return finishCourHit(chain.found, hint, match.filename);

  var startId = media.readSimklId(match.ids);
  var startSeen = startId && seen[startId];
  var startBody = startSeen && startSeen.body;
  if (!startBody && startId) {
    try {
      startBody = await fetchAnimeDetail(startId);
    } catch (_error) {
      return match;
    }
  }
  var previous = startBody && pickDirectPrevious(startBody);
  if (previous && !seen[media.readSimklId(previous.ids)]) {
    var prevMatch = media.mediaFromSearchResult(previous, match.filename, hint, {
      trusted: true,
      source: "anime-sequel",
    });
    var backward = await searchCourChain(prevMatch, hint, seen);
    if (backward.unavailable) return match;
    if (backward.found) return finishCourHit(backward.found, hint, match.filename);
  }
  return markCourChecked(match);
}

async function publishMatch(filename, path, match) {
  var next = match;
  if (needsCourAlignment(match)) {
    try {
      next = await alignAnimeCour(match);
    } catch (error) {
      log("Anime cour lookup failed: " + (error && error.message ? error.message : error));
      next = match;
    }
  }
  if (next && isTrustedMatch(next)) rememberMatch(filename, path, next);
  return next || match;
}

async function searchCatalog(query, types, limit) {
  var trimmed = String(query || "").trim();
  if (!trimmed) return [];
  var wanted = Array.isArray(types) && types.length ? types : ["movie", "tv", "anime"];
  var results = [];
  for (var i = 0; i < wanted.length; i += 1) {
    var type = wanted[i];
    var response = await authedRequest("GET", "/search/" + type, {
      query: {
        q: trimmed,
        limit: String(limit || 8),
        extended: "full",
      },
    });
    if (response.statusCode >= 400) {
      throw new Error(
        responseErrorMessage(response, "Simkl search failed with status " + response.statusCode)
      );
    }
    var items = Array.isArray(response.body) ? response.body : [];
    items.forEach(function (item) {
      results.push(item);
    });
  }
  return results;
}

function correctionCandidate(item, filename, language) {
  var match = media.mediaFromSearchResult(item, filename, media.parseEpisodeHint(filename));
  if (!match.matched) return null;
  var rating =
    item.ratings && item.ratings.simkl && item.ratings.simkl.rating
      ? Number(item.ratings.simkl.rating)
      : null;
  return {
    key: media.mediaKey(match),
    kind: match.kind,
    title: media.preferredTitle(match, language) || match.title,
    year: match.year,
    subtitle:
      (match.kind === "movie" ? "Movie" : match.kind === "anime" ? "Anime" : "TV") +
      (match.year ? " · " + match.year : ""),
    detail: rating ? "Simkl " + rating.toFixed(1) : "",
    posterUrl: media.posterUrl(match.poster, "_c"),
    url: match.url,
    media: match,
  };
}

async function searchCorrectionCandidates(current, query, limit, language) {
  var filename = current && current.filename ? current.filename : "";
  var items = await searchCatalog(query, ["movie", "tv", "anime"], limit || 6);
  return items
    .map(function (item) {
      return correctionCandidate(item, filename, language);
    })
    .filter(Boolean)
    .slice(0, 12);
}

async function applyMatchOverride(filename, path, chosen) {
  if (!chosen || !chosen.matched) {
    throw new Error("A valid Simkl match is required.");
  }
  var next = media.createMedia(
    Object.assign({}, chosen, {
      filename: filename || chosen.filename,
      source: "manual",
      trusted: true,
      courChecked: false,
      courResolved: false,
    })
  );
  try {
    next = await alignAnimeCour(next);
  } catch (error) {
    log("Anime cour lookup failed: " + (error && error.message ? error.message : error));
  }
  rememberMatch(next.filename, path, next);
  return next;
}

async function refreshAccessToken() {
  if (runtime.refreshPromise) return runtime.refreshPromise;
  runtime.refreshPromise = (async function () {
    var token = loadToken();
    if (!token || !token.refresh_token || !isV2AccessToken(token.access_token)) return false;
    var response = await rawRequest("POST", "/oauth2/token", {
      body: {
        grant_type: "refresh_token",
        client_id: getClientId(),
        refresh_token: token.refresh_token,
      },
    });
    if (response.statusCode >= 400 || !response.body || !response.body.access_token) {
      log("Token refresh failed: " + responseErrorMessage(response, "status " + response.statusCode));
      return false;
    }
    persistOAuthToken(response.body, token);
    return true;
  })();
  try {
    return await runtime.refreshPromise;
  } finally {
    runtime.refreshPromise = null;
  }
}

async function ensureFreshAccessToken() {
  var token = loadToken();
  if (!token || !isV2AccessToken(token.access_token)) return false;
  var expiresAt = accessTokenExpiresAtMs(token);
  if (!expiresAt && token.created_at) {
    expiresAt = (Number(token.created_at) + 604800) * 1000;
  }
  if (!expiresAt) return true;
  if (expiresAt - nowMs() > ACCESS_REFRESH_SKEW_MS) return true;
  return refreshAccessToken();
}

async function authedRequest(method, path, options) {
  await ensureFreshAccessToken();
  var token = getAccessToken();
  if (!token) {
    throw new Error(AUTH_REQUIRED);
  }
  var settings = Object.assign({}, options || {}, { accessToken: token });
  var response = await rawRequest(method, path, settings);
  if (response.statusCode === 401) {
    if (errorCode(response) === "user_token_required") {
      throw new Error(AUTH_REQUIRED);
    }
    var refreshed = await refreshAccessToken();
    if (!refreshed) {
      clearToken();
      throw new Error(AUTH_REQUIRED);
    }
    settings.accessToken = getAccessToken();
    if (!settings.accessToken) {
      clearToken();
      throw new Error(AUTH_REQUIRED);
    }
    response = await rawRequest(method, path, settings);
    if (response.statusCode === 401) {
      clearToken();
      throw new Error(AUTH_REQUIRED);
    }
  }
  return response;
}

async function getViewerProfile(options) {
  if (!getAccessToken()) return null;
  var settings = options || {};
  if (runtime.viewerProfile && !settings.force) {
    return runtime.viewerProfile;
  }
  if (runtime.profilePromise) return runtime.profilePromise;
  runtime.profilePromise = (async function () {
    var response = await authedRequest("GET", "/users/settings");
    if (response.statusCode >= 400) {
      throw new Error(responseErrorMessage(response, "Failed to load Simkl account"));
    }
    var user = (response.body && response.body.user) || {};
    var account = (response.body && response.body.account) || {};
    runtime.viewerProfile = {
      name: user.name || "",
      avatar: user.avatar || "",
      joinedAt: user.joined_at || user.joined || "",
      accountType: String(account.type || user.account_type || "").toLowerCase(),
    };
    runtime.viewerProfileFetchedAt = Date.now();
    return runtime.viewerProfile;
  })();
  try {
    return await runtime.profilePromise;
  } finally {
    runtime.profilePromise = null;
  }
}

function oauthListenerSource() {
  return [
    "import json, os, sys, time",
    "from http.server import BaseHTTPRequestHandler, HTTPServer",
    "from urllib.parse import parse_qs, urlparse",
    "listen_path, callback_path = sys.argv[1], sys.argv[2]",
    "done = {'v': False}",
    "class H(BaseHTTPRequestHandler):",
    "    def log_message(self, fmt, *args):",
    "        return",
    "    def do_GET(self):",
    "        u = urlparse(self.path)",
    "        if u.path != '/callback':",
    "            self.send_response(404)",
    "            self.end_headers()",
    "            return",
    "        q = parse_qs(u.query)",
    "        one = lambda k: (q.get(k) or [''])[0]",
    "        payload = {'code': one('code'), 'state': one('state'), 'iss': one('iss'), 'error': one('error'), 'error_description': one('error_description')}",
    "        tmp = callback_path + '.tmp'",
    "        with open(tmp, 'w') as f:",
    "            json.dump(payload, f)",
    "        os.replace(tmp, callback_path)",
    "        ok = payload.get('code') and not payload.get('error')",
    "        body = b'<html><body style=\"font-family:-apple-system,sans-serif;background:#111;color:#eee;padding:48px\"><h1>' + (b'Connected to Simkl' if ok else b'Authorization cancelled') + b'</h1><p>You can close this tab and return to IINA.</p></body></html>'",
    "        self.send_response(200)",
    "        self.send_header('Content-Type', 'text/html; charset=utf-8')",
    "        self.send_header('Content-Length', str(len(body)))",
    "        self.end_headers()",
    "        self.wfile.write(body)",
    "        done['v'] = True",
    "httpd = HTTPServer(('127.0.0.1', 0), H)",
    "port = httpd.server_address[1]",
    "listen = {'pid': os.getpid(), 'port': port, 'redirect_uri': 'http://127.0.0.1:%d/callback' % port}",
    "tmp = listen_path + '.tmp'",
    "with open(tmp, 'w') as f:",
    "    json.dump(listen, f)",
    "os.replace(tmp, listen_path)",
    "try:",
    "    os.chmod(listen_path, 0o600)",
    "except Exception:",
    "    pass",
    "httpd.timeout = 1",
    "deadline = time.time() + 900",
    "while time.time() < deadline and not done['v']:",
    "    httpd.handle_request()",
    "httpd.server_close()",
    "if not os.path.exists(callback_path):",
    "    tmp = callback_path + '.tmp'",
    "    with open(tmp, 'w') as f:",
    "        json.dump({'error': 'expired_token'}, f)",
    "    os.replace(tmp, callback_path)",
    "",
  ].join("\n");
}

async function generatePkce() {
  if (!runtime.utils || typeof runtime.utils.exec !== "function") {
    throw new Error("utils.exec is unavailable");
  }
  var response = await runtime.utils.exec("/usr/bin/python3", [
    "-c",
    "import base64,hashlib,os,json\nb=lambda x: base64.urlsafe_b64encode(x).rstrip(b'=').decode()\nv=b(os.urandom(32)); c=b(hashlib.sha256(v.encode()).digest()); s=b(os.urandom(16))\nprint(json.dumps({'verifier':v,'challenge':c,'state':s}))",
  ]);
  if (response.status !== 0) {
    throw new Error(response.stderr || "Could not generate a sign-in challenge");
  }
  var data = parseJson(response.stdout, null);
  if (!data || !data.verifier || !data.challenge || !data.state) {
    throw new Error("Could not generate a sign-in challenge");
  }
  return data;
}

function killOauthListener(pid) {
  if (!pid || !runtime.utils || typeof runtime.utils.exec !== "function") return;
  runtime.utils.exec("/bin/kill", [String(pid)]).catch(function () {});
}

async function startLoopbackListener() {
  deleteTempFile(OAUTH_LISTEN_PATH);
  deleteTempFile(OAUTH_CALLBACK_PATH);
  var scriptFile = writeTempFile(OAUTH_SCRIPT_PATH, oauthListenerSource());
  await chmodPrivate(scriptFile);
  writeTempFile(OAUTH_LISTEN_PATH, "{}");
  await chmodPrivate(resolvePluginPath(OAUTH_LISTEN_PATH));
  var listenFile = resolvePluginPath(OAUTH_LISTEN_PATH);
  var callbackFile = resolvePluginPath(OAUTH_CALLBACK_PATH);
  if (!listenFile || !callbackFile) throw new Error("Could not prepare local sign-in callback");
  runtime.utils.exec("/usr/bin/python3", [scriptFile, listenFile, callbackFile]).catch(function (error) {
    log("OAuth listener exited: " + (error && error.message ? error.message : error));
  });
  var listen = null;
  for (var i = 0; i < 50; i += 1) {
    await sleep(100);
    listen = readJson(OAUTH_LISTEN_PATH, null);
    if (listen && listen.port) return listen;
  }
  throw new Error("Could not start local sign-in callback on 127.0.0.1");
}

function buildAuthorizeUrl(challenge, state, redirectUri) {
  return (
    AUTHORIZE_ROOT +
    "/oauth2/authorize?" +
    encodeQuery({
      client_id: getClientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: OAUTH_SCOPE,
      state: state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
  );
}

async function runBrowserAuth(restart) {
  if (runtime.authPromise && !restart) return runtime.authPromise;
  runtime.authPromise = (async function () {
    var pkce = await generatePkce();
    var listen = await startLoopbackListener();
    var redirectUri = String(listen.redirect_uri || "");
    var authorizeUrl = buildAuthorizeUrl(pkce.challenge, pkce.state, redirectUri);
    runtime.authCode = "";
    runtime.authUrl = authorizeUrl;
    runtime.authExpiresAt = Date.now() + 900 * 1000;
    emitAuthStatusChange();

    log("Simkl browser auth started");
    notify("Approve Simkl in your browser");
    if (runtime.utils && typeof runtime.utils.open === "function") {
      try {
        runtime.utils.open(authorizeUrl);
      } catch (_error) {}
    }

    var callback = null;
    while (Date.now() < runtime.authExpiresAt) {
      await sleep(400);
      callback = readJson(OAUTH_CALLBACK_PATH, null);
      if (callback) break;
    }
    killOauthListener(listen.pid);
    deleteTempFile(OAUTH_LISTEN_PATH);
    deleteTempFile(OAUTH_CALLBACK_PATH);
    deleteTempFile(OAUTH_SCRIPT_PATH);

    if (!callback) {
      throw new Error("Timed out waiting for Simkl authorization");
    }
    if (callback.error) {
      if (callback.error === "access_denied") throw new Error("Simkl authorization was cancelled.");
      if (callback.error === "expired_token") throw new Error("Timed out waiting for Simkl authorization");
      throw new Error("Simkl authorization failed");
    }
    if (String(callback.iss || "") !== OAUTH_ISSUER) {
      throw new Error("Authorization response did not come from Simkl");
    }
    if (String(callback.state || "") !== pkce.state) {
      throw new Error("Simkl authorization state mismatch. Start Connect again.");
    }
    if (!callback.code) {
      throw new Error("Simkl did not return an authorization code");
    }

    var tokenResponse = await rawRequest("POST", "/oauth2/token", {
      body: {
        grant_type: "authorization_code",
        client_id: getClientId(),
        code: String(callback.code),
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      },
    });
    if (errorCode(tokenResponse) === "invalid_client" || tokenResponse.statusCode === 401) {
      throw new Error(invalidClientMessage());
    }
    if (tokenResponse.statusCode >= 400 || !tokenResponse.body || !tokenResponse.body.access_token) {
      throw new Error(responseErrorMessage(tokenResponse, "Failed to exchange Simkl authorization code"));
    }
    if (!tokenHasWriteScope(tokenResponse.body)) {
      throw new Error("Simkl granted read-only access. Reconnect and allow library updates.");
    }
    persistOAuthToken(tokenResponse.body);
    runtime.authCode = "";
    runtime.authUrl = "";
    runtime.lastAuthFailure = "";
    try {
      await getViewerProfile({ force: true });
    } catch (error) {
      log("Profile fetch after auth failed: " + (error && error.message ? error.message : error));
    }
    notify("Connected to Simkl");
    log("Simkl browser auth completed");
    return tokenResponse.body.access_token;
  })();

  try {
    return await runtime.authPromise;
  } catch (error) {
    runtime.lastAuthFailure = error && error.message ? error.message : String(error);
    runtime.authCode = "";
    runtime.authUrl = "";
    notify(runtime.lastAuthFailure);
    throw error;
  } finally {
    runtime.authPromise = null;
    runtime.authCode = "";
    runtime.authUrl = "";
    runtime.authExpiresAt = 0;
    if (runtime.utils && typeof runtime.utils.exec === "function") {
      runtime.utils.exec("/usr/bin/pkill", ["-f", "simkl-oauth-listen.py"]).catch(function () {});
    }
    emitAuthStatusChange();
  }
}

async function beginInteractiveAuth(options) {
  var settings = options || {};
  if (settings.force || hasLegacyToken() || getAccessToken()) {
    await revokeStoredToken();
    clearToken();
  }
  await runBrowserAuth(!!settings.restart || !!settings.force);
  return getAuthStatus();
}

async function revokeStoredToken() {
  var token = loadToken();
  var value = token && (token.refresh_token || token.access_token);
  if (!value || !isV2AccessToken(token.access_token)) return;
  try {
    await rawRequest("POST", "/oauth2/revoke", {
      body: {
        client_id: getClientId(),
        token: value,
      },
    });
  } catch (error) {
    log("Token revoke failed: " + (error && error.message ? error.message : error));
  }
}

async function signOut() {
  var pending = revokeStoredToken();
  clearToken();
  await pending;
  return getAuthStatus();
}

async function scrobble(action, current, progress) {
  if (!getAccessToken()) {
    return { ok: false, skip: true, reason: hasLegacyToken() ? "legacy-auth" : "auth-required" };
  }
  if (quotaBlocked()) {
    return { ok: false, skip: true, reason: "quota-exceeded" };
  }
  if (!current || !current.matched) {
    return { ok: false, skip: true, reason: "missing-simkl-match" };
  }
  if (media.needsEpisode(current)) {
    return { ok: false, skip: true, reason: "missing-episode" };
  }

  var payload = media.scrobblePayload(current, progress);
  if (!payload) {
    return { ok: false, skip: true, reason: "missing-simkl-match" };
  }

  var options = { body: payload };
  if (action === "stop" && Number(payload.progress) >= 80 && canAllowRewatch()) {
    options.query = { allow_rewatch: "yes" };
  }
  log(
    "Scrobble " +
      action +
      " " +
      (payload.anime ? "anime" : payload.show ? "show" : "movie") +
      " ids=" +
      JSON.stringify((payload.anime || payload.show || payload.movie || {}).ids || {}) +
      " episode=" +
      JSON.stringify(payload.episode || null)
  );

  var response;
  try {
    response = await authedRequest("POST", "/scrobble/" + action, options);
  } catch (error) {
    if (isAuthRequiredError(error)) {
      return { ok: false, skip: true, reason: "auth-required" };
    }
    throw error;
  }

  if (response.statusCode === 404) {
    return { ok: false, notFound: true, body: response.body };
  }
  if (response.statusCode === 409) {
    return { ok: false, duplicate: true, body: response.body };
  }
  if (response.statusCode === 403 && errorCode(response) === "insufficient_scope") {
    return { ok: false, skip: true, reason: "insufficient-scope" };
  }
  if (response.statusCode === 429) {
    if (errorCode(response) === "user_limit_exceeded" || errorCode(response) === "app_limit_exceeded") {
      markQuotaExceeded(response);
      return { ok: false, skip: true, reason: "quota-exceeded", body: response.body };
    }
    return { ok: false, throttled: true, body: response.body };
  }
  if (response.statusCode >= 400) {
    var error = new Error(
      responseErrorMessage(response, "Simkl scrobble failed with status " + response.statusCode)
    );
    error.statusCode = response.statusCode;
    error.responseBody = response.body;
    throw error;
  }

  return {
    ok: true,
    action: response.body && response.body.action ? String(response.body.action) : action,
    progress:
      response.body && isFinite(Number(response.body.progress))
        ? Number(response.body.progress)
        : Number(progress || 0),
    rewatchStatus: response.body && response.body.rewatch_status ? String(response.body.rewatch_status) : "",
    body: response.body,
  };
}

module.exports = {
  APP_NAME: APP_NAME,
  PLUGIN_VERSION: PLUGIN_VERSION,
  applyMatchOverride: applyMatchOverride,
  beginInteractiveAuth: beginInteractiveAuth,
  configure: configure,
  copyPendingAuthCode: copyPendingAuthCode,
  forgetMatch: forgetMatch,
  getAuthStatus: getAuthStatus,
  getClientId: getClientId,
  getViewerProfile: getViewerProfile,
  identifyFile: identifyFile,
  isAuthRequiredError: isAuthRequiredError,
  scrobble: scrobble,
  searchCorrectionCandidates: searchCorrectionCandidates,
  signOut: signOut,
};
