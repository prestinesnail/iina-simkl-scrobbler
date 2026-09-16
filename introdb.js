var API_ROOT = "https://api.introdb.app";
var USER_AGENT = "iina-simkl-scrobbler/1.1.27";
var SKIP_PROMPT_MS = 5000;
var SKIP_LEAD_IN_SEC = 1.5;
var MIN_REMAINING_SEC = 2;

var runtime = {
  http: null,
  utils: null,
  logger: function () {},
  cache: {},
};

function configure(options) {
  var settings = options || {};
  if (settings.http) runtime.http = settings.http;
  if (settings.utils) runtime.utils = settings.utils;
  if (typeof settings.logger === "function") runtime.logger = settings.logger;
}

function log(message) {
  runtime.logger(String(message || ""));
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

function parseJson(text, fallbackValue) {
  if (!text) return fallbackValue;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallbackValue;
  }
}

function normalizeImdbId(value) {
  var raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  var match = raw.match(/^(?:imdb[-:]?)?(?:tt)?(\d{7,})$/i);
  if (!match) return "";
  return "tt" + match[1];
}

function clockToSeconds(value) {
  var parts = String(value || "").split(":");
  if (parts.length < 2 || parts.length > 3) return NaN;
  var numbers = [];
  for (var i = 0; i < parts.length; i += 1) {
    if (!/^\d+(\.\d+)?$/.test(parts[i])) return NaN;
    numbers.push(Number(parts[i]));
  }
  if (numbers.length === 3) return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  return numbers[0] * 60 + numbers[1];
}

function toSeconds(value, msValue) {
  if (value != null && value !== "") {
    if (typeof value === "number" && isFinite(value)) return value;
    var text = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
    var clock = clockToSeconds(text);
    if (isFinite(clock)) return clock;
  }
  if (msValue != null && msValue !== "") {
    var ms = Number(msValue);
    if (isFinite(ms)) return ms / 1000;
  }
  return NaN;
}

var SEGMENT_TYPES = ["recap", "intro", "outro"];
var SEGMENT_LABELS = {
  recap: "Recap",
  intro: "Intro",
  outro: "Outro",
};

function skipTypeLabel(type) {
  return SEGMENT_LABELS[type] || "Intro";
}

function skipButtonLabel(segment) {
  return "Skip " + skipTypeLabel(segment && segment.type);
}

function parseSegment(source, type) {
  if (!source || typeof source !== "object" || source.error) return null;
  var start = toSeconds(
    source.start_sec != null ? source.start_sec : source.start,
    source.start_ms != null ? source.start_ms : source.startMs
  );
  var end = toSeconds(
    source.end_sec != null ? source.end_sec : source.end,
    source.end_ms != null ? source.end_ms : source.endMs
  );
  if (!isFinite(start) || !isFinite(end) || end <= start) return null;
  if (start < 0) start = 0;
  var kind = SEGMENT_LABELS[type] ? type : "intro";
  return {
    id: kind + ":" + start + "-" + end,
    type: kind,
    label: skipTypeLabel(kind),
    startSec: start,
    endSec: end,
    confidence: isFinite(Number(source.confidence)) ? Number(source.confidence) : null,
    submissionCount: isFinite(Number(source.submission_count))
      ? Number(source.submission_count)
      : null,
  };
}

function parseIntroResponse(body) {
  if (!body || typeof body !== "object" || body.error) return null;
  if (body.intro && typeof body.intro === "object") return parseSegment(body.intro, "intro");
  if (body.start_sec != null || body.start_ms != null || body.start != null) {
    return parseSegment(body, "intro");
  }
  return null;
}

function parseSegmentsResponse(body) {
  if (!body || typeof body !== "object" || body.error) return [];
  var segments = [];
  for (var i = 0; i < SEGMENT_TYPES.length; i += 1) {
    var type = SEGMENT_TYPES[i];
    var parsed = parseSegment(body[type], type);
    if (parsed) segments.push(parsed);
  }
  if (!segments.length) {
    var intro = parseIntroResponse(body);
    if (intro) segments.push(intro);
  }
  segments.sort(function (left, right) {
    return left.startSec - right.startSec;
  });
  return segments;
}

function introCacheKey(imdbId, season, episode) {
  return String(imdbId || "").toLowerCase() + ":s" + Number(season || 0) + "e" + Number(episode || 0);
}

function inIntroWindow(position, segment) {
  var pos = Number(position);
  if (!segment || !isFinite(pos)) return false;
  var start = Number(segment.startSec);
  var end = Number(segment.endSec);
  if (!isFinite(start) || !isFinite(end) || end <= start) return false;
  return pos >= start && pos < end;
}

function skipWorthShowing(position, segment, options) {
  var settings = options || {};
  var pos = Number(position);
  if (!segment || !isFinite(pos)) return false;
  var start = Number(segment.startSec);
  var end = Number(segment.endSec);
  if (!isFinite(start) || !isFinite(end) || end <= start) return false;
  var leadIn = isFinite(Number(settings.leadIn)) ? Math.max(0, Number(settings.leadIn)) : 0;
  if (pos < start - leadIn || pos >= end) return false;
  return end - pos >= MIN_REMAINING_SEC;
}

function activeSegment(position, segments, options) {
  var settings = options || {};
  var list = Array.isArray(segments) ? segments : [];
  var dismissed = settings.dismissed || {};
  for (var i = 0; i < list.length; i += 1) {
    var segment = list[i];
    if (!segment) continue;
    if (dismissed[segment.id]) continue;
    if (skipWorthShowing(position, segment, settings)) return segment;
  }
  return null;
}

function responseBody(res) {
  if (!res) return {};
  if (res.data != null && res.data !== "") return res.data;
  return parseJson(res.text, {});
}

function httpFailure(error) {
  var err = error || {};
  var response = err.response || err.res || null;
  var status = Number(err.statusCode || err.status || (response && (response.statusCode || response.status)) || 0);
  var message = err && err.message ? String(err.message) : String(error || "");
  if (!status) {
    var code = message.match(/\b(404|4\d\d)\b/);
    if (code) status = Number(code[1]);
  }
  var body = response ? responseBody(response) : {};
  if ((!body || !body.error) && /not found/i.test(message)) body = { error: "Not found." };
  return { statusCode: status || 0, body: body, message: message };
}

function isNotFoundResult(statusCode, body, message) {
  if (Number(statusCode) === 404) return true;
  var errText = body && body.error ? String(body.error) : "";
  var text = String(message || "");
  return /not found/i.test(errText) || /not found/i.test(text);
}

async function requestWithHttp(url) {
  if (!runtime.http || typeof runtime.http.get !== "function") {
    throw new Error("iina.http.get is unavailable");
  }
  var res = await runtime.http.get(url, {
    params: {},
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  return {
    statusCode: Number(res && res.statusCode) || 0,
    body: responseBody(res),
  };
}

async function requestWithCurl(url) {
  if (!runtime.utils || typeof runtime.utils.exec !== "function") {
    throw new Error("utils.exec is unavailable");
  }
  var marker = "__IINA_SIMKL_STATUS__:";
  var response = await runtime.utils.exec("/usr/bin/curl", [
    "-sS",
    "-L",
    "-H",
    "Accept: application/json",
    "-H",
    "User-Agent: " + USER_AGENT,
    "--max-time",
    "8",
    "-w",
    "\n" + marker + "%{http_code}",
    url,
  ]);
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
  };
}

async function rawGet(url) {
  log("HTTP GET " + url);
  try {
    if (runtime.http) return await requestWithHttp(url);
  } catch (error) {
    var failed = httpFailure(error);
    if (isNotFoundResult(failed.statusCode, failed.body, failed.message)) {
      return { statusCode: 404, body: failed.body && failed.body.error ? failed.body : { error: "Not found." } };
    }
    log("iina.http failed, falling back to curl: " + failed.message);
  }
  return requestWithCurl(url);
}

function segmentsRequestUrl(imdbId, season, episode) {
  return (
    API_ROOT +
    "/segments?" +
    encodeQuery({
      imdb_id: imdbId,
      season: season,
      episode: episode,
    })
  );
}

function introRequestUrl(imdbId, season, episode) {
  return segmentsRequestUrl(imdbId, season, episode);
}

async function fetchSegments(params) {
  var settings = params || {};
  var imdbId = normalizeImdbId(settings.imdbId);
  var season = Math.floor(Number(settings.season || 0));
  var episode = Math.floor(Number(settings.episode || 0));
  if (!imdbId || season < 1 || episode < 1) return [];

  var key = introCacheKey(imdbId, season, episode);
  if (Object.prototype.hasOwnProperty.call(runtime.cache, key)) {
    return runtime.cache[key] || [];
  }

  var url = segmentsRequestUrl(imdbId, season, episode);
  var response = await rawGet(url);
  if (response.statusCode === 404) {
    runtime.cache[key] = [];
    return [];
  }
  if (response.statusCode >= 400) {
    var message =
      (response.body && (response.body.error || response.body.message)) ||
      "IntroDB failed with status " + response.statusCode;
    throw new Error(message);
  }

  var segments = parseSegmentsResponse(response.body);
  runtime.cache[key] = segments;
  return segments;
}

async function fetchIntro(params) {
  var segments = await fetchSegments(params);
  for (var i = 0; i < segments.length; i += 1) {
    if (segments[i].type === "intro") return segments[i];
  }
  return null;
}

function forgetIntro(imdbId, season, episode) {
  var key = introCacheKey(normalizeImdbId(imdbId), season, episode);
  delete runtime.cache[key];
}

function clearCache() {
  runtime.cache = {};
}

module.exports = {
  API_ROOT: API_ROOT,
  MIN_REMAINING_SEC: MIN_REMAINING_SEC,
  SEGMENT_LABELS: SEGMENT_LABELS,
  SEGMENT_TYPES: SEGMENT_TYPES,
  SKIP_LEAD_IN_SEC: SKIP_LEAD_IN_SEC,
  SKIP_PROMPT_MS: SKIP_PROMPT_MS,
  activeSegment: activeSegment,
  clearCache: clearCache,
  configure: configure,
  fetchIntro: fetchIntro,
  fetchSegments: fetchSegments,
  httpFailure: httpFailure,
  isNotFoundResult: isNotFoundResult,
  forgetIntro: forgetIntro,
  inIntroWindow: inIntroWindow,
  introCacheKey: introCacheKey,
  introRequestUrl: introRequestUrl,
  normalizeImdbId: normalizeImdbId,
  parseIntroResponse: parseIntroResponse,
  parseSegment: parseSegment,
  parseSegmentsResponse: parseSegmentsResponse,
  segmentsRequestUrl: segmentsRequestUrl,
  skipButtonLabel: skipButtonLabel,
  skipTypeLabel: skipTypeLabel,
  skipWorthShowing: skipWorthShowing,
};
