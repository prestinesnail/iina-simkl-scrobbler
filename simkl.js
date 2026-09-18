var media = require("./media.js");

var API_ROOT = "https://api.simkl.com";
var APP_NAME = "iina-simkl-scrobbler";
var PLUGIN_VERSION = "1.1.29";
var USER_AGENT = "iina-simkl-scrobbler/" + PLUGIN_VERSION;
var TOKEN_PATH = "@data/simkl-token.json";
var CACHE_PATH = "@data/simkl-match-cache.json";
var NEGATIVE_CACHE_PATH = "@data/simkl-negative-cache.json";
var TOKEN_PREF = "simkl_oauth_token";
var KEYCHAIN_SERVICE = "io.github.prestinesnail.iina-simkl-scrobbler";
var KEYCHAIN_ACCOUNT = "simkl-oauth";
var PROFILE_TTL_MS = 5 * 60 * 1000;
var AUTH_REQUIRED = "Simkl authorization required";
var POST_MIN_INTERVAL_MS = 1000;
var HTTP_TIMEOUT_MS = 8000;
var CACHE_MAX_ENTRIES = 500;
var NEGATIVE_TTL_MS = 30 * 60 * 1000;

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
  }
  if (settings.resetToken) {
    runtime.tokenCache = undefined;
    runtime.viewerProfile = null;
    runtime.viewerProfileFetchedAt = 0;
    runtime.authPromise = null;
    runtime.authCode = "";
    runtime.authUrl = "";
    runtime.authExpiresAt = 0;
    runtime.lastAuthFailure = "";
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
  return String(pref("simkl_client_id", "") || "").trim();
}

function hasCredentials() {
  return !!getClientId();
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

function requiredHeaders(accessToken) {
  var headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (accessToken) headers.Authorization = "Bearer " + accessToken;
  return headers;
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
  if (!runtime.authCode) {
    return { ok: false, message: "No active code." };
  }
  var copied = await copyToClipboard(runtime.authCode);
  return copied
    ? { ok: true, message: "Code copied." }
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
    headers: Object.assign({}, requiredHeaders(settings.accessToken), settings.headers || {}),
  };
  if (settings.body !== undefined) request.data = settings.body;
  var res = await fn.call(runtime.http, url, request);
  return {
    statusCode: Number(res && res.statusCode) || 0,
    body: responseBody(res),
    rawBody: res && res.text ? String(res.text) : "",
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
  var headers = Object.assign({}, requiredHeaders(settings.accessToken), settings.headers || {});
  var headerPath = "@tmp/simkl-curl-headers.conf";
  var bodyPath = "@tmp/simkl-curl-body.json";
  var headerFile = "";
  var bodyFile = "";
  var wroteHeader = false;
  var wroteBody = false;
  try {
    var conf = ["silent", "show-error", "location", "max-time = 8", curlConfigLine("request", String(method || "GET").toUpperCase())];
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
    return {
      statusCode: statusCode,
      body: parseJson(rawBody, rawBody === "" ? {} : rawBody),
      rawBody: rawBody,
      url: url,
    };
  } finally {
    if (wroteHeader) deleteTempFile(headerPath);
    if (wroteBody) deleteTempFile(bodyPath);
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
    url: url || "",
  };
}

function requestUrl(path, options) {
  var settings = options || {};
  var query = Object.assign({}, requiredQuery(), settings.query || {});
  return API_ROOT + path + "?" + encodeQuery(query);
}

async function rawRequest(method, path, options) {
  if (!getClientId()) {
    throw new Error("Missing Simkl client_id. Add it in the plugin preferences.");
  }
  var verb = String(method || "GET").toUpperCase();
  var settings = options || {};
  log("HTTP " + verb + " " + path);
  return enqueueRequest(async function () {
    if (verb === "POST") await waitForPostSlot();
    // IINA's Just client form-urlencodes `data`, so JSON bodies go straight to curl.
    if (settings.body === undefined && runtime.http) {
      try {
        return await withTimeout(requestWithHttp(method, path, settings), httpTimeoutMs(), "iina.http");
      } catch (error) {
        var asResponse = httpFailureResponse(error, requestUrl(path, settings));
        if (asResponse) return asResponse;
        log("iina.http failed, falling back to curl: " + (error && error.message ? error.message : error));
      }
    }
    return requestWithCurl(method, path, settings);
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
  runtime.viewerProfile = null;
  runtime.viewerProfileFetchedAt = 0;
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

function getAccessToken() {
  var token = loadToken();
  return token && token.access_token ? String(token.access_token) : "";
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
        ? "Open simkl.com/pin and enter " + runtime.authCode + "."
        : "Requesting a PIN code.",
      true
    );
  }
  if (!hasCredentials()) {
    return createAuthStatus(
      "missing_credentials",
      "Simkl client ID required",
      "Create an app at simkl.com/settings/developer and paste the client_id into this plugin's preferences.",
      false
    );
  }
  if (getAccessToken()) {
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
    "Connect with a PIN code from simkl.com/pin.",
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

function loadMatchCache() {
  if (runtime.matchCache) return runtime.matchCache;
  var cache = readJson(CACHE_PATH, null);
  runtime.matchCache = migrateCacheKeys(cache && typeof cache === "object" ? cache : {});
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

function rememberMatch(filename, path, match) {
  var key = cacheKeyFor(filename, path);
  if (!key) return;
  var cache = loadMatchCache();
  cache[key] = media.cacheRecord(match);
  saveMatchCache();
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

async function searchByFileName(query, filename) {
  var response = await rawRequest("POST", "/search/file", {
    body: { file: query },
  });
  if (response.statusCode >= 400) {
    throw new Error(
      (response.body && (response.body.message || response.body.error)) ||
        "Simkl file search failed with status " + response.statusCode
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

async function identifyByExternalId(filePath, filename) {
  var ids = media.extractExternalIds(String(filePath || "") + " " + String(filename || ""));
  if (!ids.imdb && !ids.tmdb && !ids.tvdb) return null;
  var query = {};
  if (ids.imdb) query.imdb = ids.imdb;
  else if (ids.tvdb) query.tvdb = ids.tvdb;
  else {
    query.tmdb = ids.tmdb;
    query.type = media.parseEpisodeHint(filename) ? "tv" : "movie";
  }
  var response = await rawRequest("GET", "/search/id", { query: query });
  if (response.statusCode >= 400) {
    throw new Error(
      (response.body && (response.body.message || response.body.error)) ||
        "Simkl ID search failed with status " + response.statusCode
    );
  }
  var items = Array.isArray(response.body) ? response.body : [];
  var item = items[0];
  if (!item || !item.title) return null;
  var match = media.applyTitleFallback(
    media.mediaFromSearchResult(item, filename, media.parseEpisodeHint(filename), {
      trusted: true,
      source: "search-id",
    }),
    filename
  );
  match.ids = media.sanitizeIds(Object.assign({}, match.ids, ids));
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

  if (!settings.force) {
    var cached = cachedMatch(filename, path);
    if (cached && cached.matched && isTrustedMatch(cached)) {
      if (!cached.titleEn || !cached.yearLabel) {
        cached = await enrichMatch(cached);
        rememberMatch(filename, path, cached);
      }
      log("Match cache hit for " + filename + " -> " + media.mediaLabel(cached, "english"));
      return cached;
    }
    if (cached && !cached.matched) {
      log("Negative cache hit for " + filename);
      return cached;
    }
  }

  var match = null;
  var searchError = false;
  try {
    match = await identifyByExternalId(path, filename);
    if (match && isTrustedMatch(match)) {
      match = await enrichMatch(match);
      if (isTrustedMatch(match)) {
        rememberMatch(filename, path, match);
        log("Identified " + filename + " by external ID as " + media.mediaLabel(match));
        return match;
      }
    }
  } catch (error) {
    searchError = true;
    log("External ID search failed: " + (error && error.message ? error.message : error));
  }

  var queries = media.fileSearchQueries(path || filename);
  for (var i = 0; i < queries.length; i += 1) {
    log("File search with " + queries[i]);
    try {
      match = await searchByFileName(queries[i], filename);
    } catch (error) {
      searchError = true;
      log("File search failed for " + queries[i] + ": " + (error && error.message ? error.message : error));
      continue;
    }
    if (isTrustedMatch(match)) {
      match = await enrichMatch(match);
      if (isTrustedMatch(match)) {
        rememberMatch(filename, path, match);
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
        rememberMatch(filename, path, match);
        log("Identified " + filename + " by title search as " + media.mediaLabel(match));
        return match;
      }
    }
  } catch (error) {
    searchError = true;
    log("Title search failed: " + (error && error.message ? error.message : error));
  }

  if (!searchError) rememberNegative(filename, path, "no-match");
  log("Simkl did not recognize " + filename);
  return media.createUnmatched(filename, searchError ? "search-error" : "no-match");
}

async function enrichMatch(match) {
  if (!match || !match.matched) return match;
  var id = media.readSimklId(match.ids);
  if (!id) return media.applyTitleFallback(match, match.filename);

  var paths = [];
  if (match.kind === "movie") paths.push("/movies/" + id);
  else if (match.kind === "anime") paths.push("/anime/" + id, "/tv/" + id);
  else paths.push("/tv/" + id, "/anime/" + id);

  for (var i = 0; i < paths.length; i += 1) {
    try {
      var response = await rawRequest("GET", paths[i]);
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
      match.url = media.simklItemUrl(match.kind, Object.assign({}, match.ids, { slug: match.slug }));
      match.ids = media.sanitizeIds(Object.assign({}, match.ids, body.ids || {}));
      break;
    } catch (error) {
      log("Metadata enrich failed for " + paths[i] + ": " + (error && error.message ? error.message : error));
    }
  }

  match = media.applyTitleFallback(match, match.filename);
  return followAnimeSequel(match);
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

function isSequelRelation(rel) {
  var t = String((rel && (rel.relation_type || rel.relation)) || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  return t === "sequel";
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

async function fetchAnimeDetail(id) {
  var response = await rawRequest("GET", "/anime/" + id);
  if (response.statusCode >= 400 || !response.body || media.isEmptyMatch(response.body)) return null;
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

async function searchCatalog(query, types, limit) {
  var trimmed = String(query || "").trim();
  if (!trimmed) return [];
  var wanted = Array.isArray(types) && types.length ? types : ["movie", "tv", "anime"];
  var results = [];
  for (var i = 0; i < wanted.length; i += 1) {
    var type = wanted[i];
    var response = await rawRequest("GET", "/search/" + type, {
      query: {
        q: trimmed,
        limit: String(limit || 8),
        extended: "full",
      },
    });
    if (response.statusCode >= 400) {
      throw new Error(
        (response.body && (response.body.message || response.body.error)) ||
          "Simkl search failed with status " + response.statusCode
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

function applyMatchOverride(filename, path, chosen) {
  if (!chosen || !chosen.matched) {
    throw new Error("A valid Simkl match is required.");
  }
  var next = media.createMedia(
    Object.assign({}, chosen, {
      filename: filename || chosen.filename,
      source: "manual",
      trusted: true,
    })
  );
  rememberMatch(next.filename, path, next);
  return next;
}

async function authedRequest(method, path, options) {
  var token = getAccessToken();
  if (!token) {
    throw new Error(AUTH_REQUIRED);
  }
  var settings = Object.assign({}, options || {}, { accessToken: token });
  var response = await rawRequest(method, path, settings);
  if (response.statusCode === 401) {
    clearToken();
    throw new Error(AUTH_REQUIRED);
  }
  return response;
}

async function getViewerProfile(options) {
  if (!getAccessToken()) return null;
  var settings = options || {};
  if (
    !settings.force &&
    runtime.viewerProfile &&
    Date.now() - runtime.viewerProfileFetchedAt < PROFILE_TTL_MS
  ) {
    return runtime.viewerProfile;
  }
  var response = await authedRequest("POST", "/users/settings", { body: {} });
  if (response.statusCode >= 400) {
    throw new Error(
      (response.body && (response.body.message || response.body.error)) ||
        "Failed to load Simkl account"
    );
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
}

async function runPinAuth(restart) {
  if (runtime.authPromise && !restart) return runtime.authPromise;
  runtime.authPromise = (async function () {
    if (!hasCredentials()) {
      throw new Error("Missing Simkl client_id");
    }

    var pinResponse = await rawRequest("GET", "/oauth/pin");
    if (pinResponse.statusCode >= 400 || !pinResponse.body || pinResponse.body.result !== "OK") {
      throw new Error(
        (pinResponse.body && (pinResponse.body.message || pinResponse.body.error)) ||
          "Failed to request a Simkl PIN"
      );
    }

    var userCode = String(pinResponse.body.user_code || "");
    var verificationUrl = String(
      pinResponse.body.verification_uri || pinResponse.body.verification_url || "https://simkl.com/pin"
    );
    if (!media.isSimklHttpsUrl(verificationUrl)) verificationUrl = "https://simkl.com/pin";
    var intervalMs = Math.max(5000, Number(pinResponse.body.interval || 5) * 1000);
    var expiresAt = Date.now() + Math.max(60, Number(pinResponse.body.expires_in || 900)) * 1000;
    runtime.authCode = userCode;
    runtime.authUrl = verificationUrl;
    runtime.authExpiresAt = expiresAt;
    emitAuthStatusChange();

    log("Simkl PIN auth started: enter " + userCode + " at " + verificationUrl);
    await copyToClipboard(userCode);
    notify("Simkl PIN " + userCode + " copied. Enter it at simkl.com/pin");
    if (runtime.utils && typeof runtime.utils.open === "function") {
      try {
        runtime.utils.open(verificationUrl);
      } catch (_error) {}
    }

    while (Date.now() < expiresAt) {
      await sleep(intervalMs);
      var poll = await rawRequest("GET", "/oauth/pin/" + encodeURIComponent(userCode));
      var body = poll.body || {};
      if (body.access_token) {
        saveToken({
          access_token: body.access_token,
          token_type: body.token_type || "bearer",
          created_at: Math.floor(Date.now() / 1000),
        });
        runtime.authCode = "";
        runtime.authUrl = "";
        runtime.lastAuthFailure = "";
        notify("Connected to Simkl");
        log("Simkl PIN auth completed");
        return body.access_token;
      }
      if (body.device_code && body.user_code && body.user_code !== userCode) {
        throw new Error("The Simkl PIN expired. Start Connect again.");
      }
    }

    throw new Error("Timed out waiting for Simkl authorization");
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
    emitAuthStatusChange();
  }
}

async function beginInteractiveAuth(options) {
  var settings = options || {};
  if (settings.force) clearToken();
  await runPinAuth(!!settings.restart || !!settings.force);
  try {
    await getViewerProfile({ force: true });
  } catch (error) {
    log("Profile fetch after auth failed: " + (error && error.message ? error.message : error));
  }
  return getAuthStatus();
}

function signOut() {
  clearToken();
  return getAuthStatus();
}

async function scrobble(action, current, progress) {
  if (!hasCredentials()) {
    return { ok: false, skip: true, reason: "missing-client-credentials" };
  }
  if (!getAccessToken()) {
    return { ok: false, skip: true, reason: "auth-required" };
  }
  if (!current || !current.matched) {
    return { ok: false, skip: true, reason: "missing-simkl-match" };
  }
  if ((current.kind === "show" || current.kind === "anime") && !current.number) {
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
  if (response.statusCode === 429) {
    return { ok: false, throttled: true, body: response.body };
  }
  if (response.statusCode >= 400) {
    var error = new Error(
      (response.body && (response.body.message || response.body.error)) ||
        "Simkl scrobble failed with status " + response.statusCode
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
  hasCredentials: hasCredentials,
  identifyFile: identifyFile,
  isAuthRequiredError: isAuthRequiredError,
  scrobble: scrobble,
  searchCorrectionCandidates: searchCorrectionCandidates,
  signOut: signOut,
};
