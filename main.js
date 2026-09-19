var __iinaSimklGlobal = typeof globalThis !== "undefined" ? globalThis : typeof global !== "undefined" ? global : null;
function __runPreviousSimklTeardown(owner) {
  if (!owner || typeof owner.__iinaSimklTeardown !== "function") return;
  try {
    owner.__iinaSimklTeardown();
  } catch (_error) {}
  owner.__iinaSimklTeardown = null;
}
__runPreviousSimklTeardown(typeof iina !== "undefined" ? iina : null);
__runPreviousSimklTeardown(__iinaSimklGlobal);

var media = require("./media.js");
var sessionLib = require("./session.js");
var simkl = require("./simkl.js");
var overlayCard = require("./overlayCard.js");
var introdb = require("./introdb.js");

var { core, event, file, http, menu, mpv, overlay, preferences, sidebar, utils } = iina;

var UI_POLL_MS = 750;
var current = {
  url: "",
  path: "",
  filename: "",
  media: null,
  identifiedAt: "",
  identifying: false,
};
var playbackSession = sessionLib.createSession();
var lastScrobble = createScrobbleStatus();
var correction = createCorrectionState();
var scrobbleChain = Promise.resolve();
var authChain = Promise.resolve();
var sidebarHandlersBound = false;
var sidebarLoaded = false;
var sidebarWebviewReady = false;
var pluginSidebarOpen = false;
var sidebarFlushInFlight = false;
var sidebarHydrateTimer = null;
var overlayReady = false;
var overlayWarmed = false;
var overlayLoaded = false;
var overlayHideTimer = null;
var overlayFadeTimer = null;
var overlayShouldHide = false;
var overlayFading = false;
var overlayNowPlaying = null;
var overlayHideMode = "";
var overlayWindowHovered = false;
var pendingOverlayMode = "";
var lastOverlayKey = "";
var fileWorkChain = Promise.resolve();
var overlayWarned = false;
var pendingOverlayMatch = null;
var overlayHandlersBound = false;
var overlaySkipVisible = false;
var overlaySkipFading = false;
var skipHideTimer = null;
var skipFadeTimer = null;
var skipPollTimer = null;
var chapterSkipRetryTimers = [];
var skipIntro = createSkipIntroState();
var sidebarDirty = false;
var sidebarForceProfile = false;
var sidebarFlushTimer = null;
var pendingCopyAuthResult = null;
var profileRefreshInFlight = false;
var windowClosing = false;
var pluginAlive = true;
var osdHoldTimer = null;
var osdHoldUntil = 0;
var osdHoldMessage = "";
var overlayNotice = null;
var overlayNoticeTimer = null;
var lastAuthActionNonce = "";
var authActionTimer = null;
var lastSourceSignature = "";
var seeking = false;
var seekSettleTimer = null;
var pollTimer = null;
var pendingTickTimer = null;
var scrobbleWaitTimer = null;
var prefCache = {};
var prefCacheReady = false;
var lastHandledPause = null;
var trustedDuration = 0;
var authResyncAt = 0;
var activeSimklSession = false;
var flushStopInFlight = null;
var lastStoppedKey = "";
var mpvUnavailable = false;
var lastPlaybackTimes = {
  position: 0,
  duration: 0,
  percent: 0,
  paused: false,
};
var unloadHookBound = false;
var lastSimklSentAt = 0;
var watchStartedAt = 0;
var oscClearancePx = 0;
var oscLayoutCheckedAt = 0;
var oscLayoutTimer = null;
var overlayPlaybackPaintAt = 0;
var lastOverlayLayoutSignature = "";
var OSC_POSITION_BOTTOM = 2;
var OSC_BOTTOM_CLEARANCE_PX = 48;
var volumeDuck = createVolumeDuckState();

function createScrobbleStatus() {
  return {
    status: "idle",
    verb: "",
    action: "",
    mediaLabel: "",
    detail: "No scrobble has been attempted in this window yet.",
    reason: "",
    progress: null,
    updatedAt: "",
  };
}

function createCorrectionState() {
  return {
    active: false,
    busy: false,
    query: "",
    error: "",
    mediaLabel: "",
    results: [],
  };
}

function createSkipIntroState() {
  return {
    mediaKey: "",
    status: "idle",
    prompt: "hidden",
    source: "",
    segments: [],
    active: null,
    dismissed: {},
    preview: false,
    label: "Skip Intro",
  };
}

function createVolumeDuckState() {
  return {
    active: false,
    original: null,
    duckedTo: null,
    segmentId: "",
  };
}

function log(message) {
  iina.console.log("[SIMKL] " + message);
}

function errStr(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  return error.message || String(error);
}

function jsonSafe(value) {
  try {
    var text = JSON.stringify(value);
    if (!text) return null;
    // IINA injects plugin→webview payloads via String.raw`...`. Backticks or
    // `${` inside JSON break that script and the webview never sees state.
    if (text.indexOf("`") !== -1) text = text.replace(/`/g, "'");
    if (text.indexOf("${") !== -1) text = text.replace(/\$\{/g, "$ {");
    return JSON.parse(text);
  } catch (error) {
    log("JSON snapshot failed: " + errStr(error));
    return null;
  }
}

function finiteNumber(value, fallback) {
  var n = Number(value);
  return typeof n === "number" && isFinite(n) ? n : fallback;
}

function cachedPref(key) {
  return prefCacheReady ? prefCache[key] : undefined;
}

function refreshPrefCache() {
  if (!pluginAlive) return;
  var keys = [
    "scrobble_enabled",
    "status_osd",
    "debug_osd",
    "osd_seconds",
    "pause_debounce_ms",
    "title_language",
    "overlay_enabled",
    "overlay_seconds",
    "overlay_resume_seconds",
    "overlay_position",
    "overlay_offset_px",
    "skip_intro_enabled",
    "volume_duck_enabled",
    "volume_duck_percent",
    "track_rewatches",
    "auth_action_kind",
    "auth_action_nonce",
    "simkl_oauth_token",
  ];
  var next = {};
  var i;
  for (i = 0; i < keys.length; i += 1) {
    try {
      next[keys[i]] = preferences.get(keys[i]);
    } catch (_error) {
      next[keys[i]] = prefCache[keys[i]];
    }
  }
  prefCache = next;
  prefCacheReady = true;
}

function cachedPreferencesApi() {
  return {
    get: function (key) {
      return cachedPref(key);
    },
    set: function (key, value) {
      var values = {};
      values[key] = value;
      persistPreferences(values);
    },
    sync: function () {
      if (!pluginAlive) return;
      try {
        if (typeof preferences.sync === "function") preferences.sync();
      } catch (_error) {}
    },
  };
}

function prefBool(key, fallbackValue) {
  if (!pluginAlive) return fallbackValue;
  var value = cachedPref(key);
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallbackValue;
}

function prefNumber(key, fallbackValue) {
  if (!pluginAlive) return fallbackValue;
  var value = Number(cachedPref(key));
  return isFinite(value) ? value : fallbackValue;
}

function persistPreferences(values) {
  if (!pluginAlive) return;
  Object.keys(values || {}).forEach(function (key) {
    try {
      preferences.set(key, values[key]);
      prefCache[key] = values[key];
    } catch (_error) {}
  });
  prefCacheReady = true;
  if (typeof preferences.sync === "function") {
    try {
      preferences.sync();
    } catch (_error) {}
  }
}

function osdDurationMs() {
  var seconds = prefNumber("osd_seconds", 4);
  if (!isFinite(seconds) || seconds <= 0) return 1000;
  return Math.round(Math.min(15, Math.max(1, seconds)) * 1000);
}

function clearOsdHold() {
  if (osdHoldTimer) {
    clearTimeout(osdHoldTimer);
    osdHoldTimer = null;
  }
  osdHoldUntil = 0;
  osdHoldMessage = "";
}

function postOsd(message) {
  try {
    core.osd(message);
  } catch (_error) {}
}

function showHeldOsd(message) {
  postOsd(message);
  var duration = osdDurationMs();
  osdHoldMessage = message;
  osdHoldUntil = Date.now() + duration;
  if (osdHoldTimer) return;
  function holdTick() {
    osdHoldTimer = null;
    if (!pluginAlive || windowClosing || !osdHoldMessage || Date.now() >= osdHoldUntil) {
      clearOsdHold();
      return;
    }
    postOsd(osdHoldMessage);
    osdHoldTimer = setTimeout(holdTick, 800);
  }
  osdHoldTimer = setTimeout(holdTick, 800);
}

function importantOsd(message) {
  postOsd("SIMKL: " + message);
}

function statusOsd(message) {
  if (!prefBool("status_osd", true)) return;
  showHeldOsd(message);
}

function debugOsd(message) {
  if (!prefBool("debug_osd", false)) return;
  try {
    core.osd("SIMKL: " + message);
  } catch (_error) {}
}

function isScrobblingEnabled() {
  return prefBool("scrobble_enabled", true);
}

function titleLanguage() {
  if (!pluginAlive) return "english";
  return media.normalizeTitleLanguage(cachedPref("title_language") || "english");
}

function labelFor(match) {
  if (!match) return "";
  if (!match.matched) return match.filename || "";
  return media.mediaLabel(match, titleLanguage());
}

function overlayDurationMs() {
  if (!prefBool("overlay_enabled", true)) return 0;
  var seconds = prefNumber("overlay_seconds", 8);
  if (!isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(Math.min(30, Math.max(1, seconds)) * 1000);
}

function overlayResumeDurationMs() {
  if (!prefBool("overlay_enabled", true)) return 0;
  var seconds = prefNumber("overlay_resume_seconds", 2);
  if (!isFinite(seconds) || seconds <= 0) seconds = 2;
  return Math.round(Math.min(30, Math.max(1, seconds)) * 1000);
}

function overlayPosition() {
  return overlayCard.normalizeOverlayPosition(cachedPref("overlay_position"));
}

function overlayOffsetPx() {
  return overlayCard.clampOverlayOffsetPx(
    prefNumber("overlay_offset_px", overlayCard.DEFAULT_OVERLAY_OFFSET_PX)
  );
}

function overlayLayoutSignature() {
  return overlayPosition() + "|" + overlayOffsetPx() + "|" + Number(oscClearancePx || 0);
}

function maybeRepaintOverlayLayout() {
  var next = overlayLayoutSignature();
  if (next === lastOverlayLayoutSignature) return;
  if (overlayLoaded) paintOverlay();
}

function overlayShouldTrackHover() {
  return false;
}

function overlayHideDelayMs(mode) {
  if (mode === "notice") return osdDurationMs();
  if (mode === "resume") return overlayResumeDurationMs();
  return overlayDurationMs();
}

function resolveOverlayHideMode(mode) {
  if (mode === "hold") return "hold";
  if (mode === "notice") return playbackIsPaused() ? "hold" : "notice";
  if (mode === "resume") return "resume";
  if (playbackIsPaused()) return "hold";
  return mode || "start";
}

function armOverlayHideTimer(mode) {
  clearOverlayHideTimer();
  overlayHideMode = resolveOverlayHideMode(mode || overlayHideMode || "start");
  if (overlayHideMode === "hold") return;
  var duration = overlayHideDelayMs(overlayHideMode);
  if (!duration) return;
  overlayHideTimer = setTimeout(function () {
    overlayHideTimer = null;
    if (!pluginAlive || windowClosing) return;
    if (overlayHideMode === "hold" || playbackIsPaused()) return;
    startOverlayFade();
  }, duration);
}

function noteOverlayHover(hovered) {
  overlayWindowHovered = !!hovered;
}

function openSimklPage(url) {
  var href = String(url || "").trim();
  if (!media.isSimklHttpsUrl(href)) return;
  if (!utils || typeof utils.open !== "function") return;
  try {
    utils.open(href);
  } catch (_error) {}
}

function isSkipIntroEnabled() {
  return prefBool("skip_intro_enabled", true);
}

function isVolumeDuckEnabled() {
  return prefBool("volume_duck_enabled", true);
}

function wantsSkipSegments() {
  return isSkipIntroEnabled() || isVolumeDuckEnabled();
}

function volumeDuckPercent() {
  var n = prefNumber("volume_duck_percent", 75);
  if (!isFinite(n)) n = 75;
  if (n < 1) n = 1;
  if (n > 100) n = 100;
  return Math.round(n);
}

function mpvGetVolume() {
  if (!pluginAlive || mpvUnavailable || !mpv || typeof mpv.getNumber !== "function") return null;
  try {
    var vol = mpv.getNumber("volume");
    if (typeof vol === "number" && isFinite(vol) && vol >= 0) return vol;
  } catch (_error) {}
  return null;
}

function mpvSetVolume(value) {
  if (!pluginAlive || mpvUnavailable || !mpv || typeof mpv.set !== "function") return false;
  var vol = Number(value);
  if (!isFinite(vol) || vol < 0) return false;
  try {
    mpv.set("volume", vol);
    return true;
  } catch (error) {
    log("mpv.set volume failed: " + errStr(error));
    return false;
  }
}

function duckableSegmentAt(position) {
  var list = skipIntro.segments || [];
  var pos = Number(position);
  if (!isFinite(pos) || !list.length) return null;
  for (var i = 0; i < list.length; i += 1) {
    var segment = list[i];
    if (!segment) continue;
    if (segment.type !== "intro" && segment.type !== "outro") continue;
    if (introdb.inIntroWindow(pos, segment)) return segment;
  }
  return null;
}

function clearVolumeDuckState() {
  volumeDuck = createVolumeDuckState();
}

function restoreVolumeDuck(reason) {
  if (!volumeDuck.active) {
    clearVolumeDuckState();
    return;
  }
  var original = volumeDuck.original;
  var duckedTo = volumeDuck.duckedTo;
  clearVolumeDuckState();
  if (original == null) return;
  if (reason !== "window-will-close" && reason !== "shutdown" && reason !== "teardown") {
    var current = mpvGetVolume();
    if (current != null && duckedTo != null && Math.abs(current - duckedTo) > 1.5) {
      log("Volume duck skipped restore; volume changed during duck");
      return;
    }
  }
  if (mpvSetVolume(original)) {
    log("Restored volume to " + original + " after " + (reason || "intro/outro"));
  }
}

function applyVolumeDuck() {
  if (!isVolumeDuckEnabled() || windowClosing || mpvUnavailable) {
    restoreVolumeDuck(isVolumeDuckEnabled() ? "idle" : "disabled");
    return;
  }
  if (skipIntro.status !== "ready" || !(skipIntro.segments && skipIntro.segments.length)) {
    restoreVolumeDuck("no-segments");
    return;
  }
  var segment = duckableSegmentAt(playbackPosition());
  if (!segment) {
    restoreVolumeDuck("segment-ended");
    return;
  }
  var pct = volumeDuckPercent() / 100;
  if (volumeDuck.active && volumeDuck.segmentId === segment.id) {
    if (volumeDuck.original == null) return;
    var retarget = Math.max(0, Math.round(volumeDuck.original * pct * 100) / 100);
    if (retarget >= volumeDuck.original) return;
    if (volumeDuck.duckedTo != null && Math.abs(retarget - volumeDuck.duckedTo) <= 0.5) return;
    var live = mpvGetVolume();
    if (live != null && volumeDuck.duckedTo != null && Math.abs(live - volumeDuck.duckedTo) > 1.5) return;
    volumeDuck.duckedTo = retarget;
    mpvSetVolume(retarget);
    return;
  }
  if (volumeDuck.active) {
    volumeDuck.segmentId = segment.id;
    return;
  }
  var current = mpvGetVolume();
  if (current == null) return;
  var target = Math.max(0, Math.round(current * pct * 100) / 100);
  if (target >= current) return;
  volumeDuck.active = true;
  volumeDuck.original = current;
  volumeDuck.duckedTo = target;
  volumeDuck.segmentId = segment.id;
  if (mpvSetVolume(target)) {
    log(
      "Ducked volume from " +
        current +
        " to " +
        target +
        " (" +
        volumeDuckPercent() +
        "%) for " +
        (segment.type || "intro")
    );
  } else {
    clearVolumeDuckState();
  }
}

function overlayAvailable() {
  return !!(
    overlay &&
    typeof overlay.show === "function" &&
    typeof overlay.loadFile === "function" &&
    typeof overlay.postMessage === "function"
  );
}

function mpvCanQuery() {
  return !!(pluginAlive && !windowClosing && !mpvUnavailable && mpv);
}

function markMpvUnavailable() {
  mpvUnavailable = true;
}

function playbackPosition() {
  var cached = Number(lastPlaybackTimes.position || 0);
  if (cached > 0) return cached;
  try {
    var pos = Number(core.status.position || 0);
    if (isFinite(pos) && pos >= 0) return pos;
  } catch (_error) {}
  return 0;
}

function warnOverlayUnavailable(error) {
  if (overlayWarned) return;
  overlayWarned = true;
  var message =
    "Video overlay is unavailable. In Settings → Plugins → SIMKL Scrobbler → Permissions, allow Video Overlay, then restart IINA.";
  log(message + (error ? " (" + errStr(error) + ")" : ""));
  importantOsd(message);
}

function playerUiReady() {
  return !windowClosing && windowIsLoaded();
}

function playbackIsPaused() {
  try {
    if (typeof core.status.paused === "boolean") return !!core.status.paused;
  } catch (_error) {}
  return !!lastPlaybackTimes.paused;
}

function clearOverlayHideTimer() {
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
}

function clearOverlayFadeTimer() {
  if (overlayFadeTimer) {
    clearTimeout(overlayFadeTimer);
    overlayFadeTimer = null;
  }
}

function setOverlayOpacity(value) {
  try {
    if (overlay && typeof overlay.setOpacity === "function") overlay.setOpacity(value);
  } catch (_error) {}
}

function overlayHasVisibleContent() {
  return !!(
    overlayNowPlaying ||
    overlayFading ||
    overlaySkipVisible ||
    overlaySkipFading ||
    overlayNotice
  );
}

function clearOverlayNotice() {
  if (overlayNoticeTimer) {
    clearTimeout(overlayNoticeTimer);
    overlayNoticeTimer = null;
  }
  overlayNotice = null;
}

function showOverlayNotice(label) {
  var text = String(label || "").trim();
  if (!text || !pluginAlive || windowClosing) return;
  if (!prefBool("overlay_enabled", true)) {
    statusOsd(text);
    return;
  }
  overlayNotice = {
    label: text,
    state: "skipped",
    until: Date.now() + osdDurationMs(),
  };
  if (overlayNoticeTimer) clearTimeout(overlayNoticeTimer);
  overlayNoticeTimer = setTimeout(function () {
    overlayNoticeTimer = null;
    overlayNotice = null;
    if (pluginAlive && !windowClosing) paintOverlay();
  }, osdDurationMs());
  if (overlayNowPlaying && !overlayFading) {
    paintOverlay();
    return;
  }
  if (current.media && current.media.matched) {
    showNowPlayingOverlay(current.media, true, "notice");
    return;
  }
  paintOverlay();
}

function bindOverlayMessages() {
  if (overlayHandlersBound || !overlay || typeof overlay.onMessage !== "function") return;
  overlayHandlersBound = true;
  function overlayMessage(name, fn) {
    overlay.onMessage(name, function (payload) {
      if (!pluginAlive) return;
      try {
        fn(payload);
      } catch (error) {
        log("overlay " + name + " failed: " + errStr(error));
      }
    });
  }
  overlayMessage("overlay-ready", function () {
    markOverlayLoaded();
  });
  overlayMessage("skip-intro", function () {
    skipCurrentIntro();
  });
  overlayMessage("overlay-pause", function () {
    if (playbackIsPaused()) core.resume();
    else core.pause();
  });
  overlayMessage("overlay-dblclick", function () {
    core.window.fullscreen = !core.window.fullscreen;
  });
  overlayMessage("overlay-hover", function () {
    noteOverlayHover(true);
  });
  overlayMessage("overlay-leave", function () {
    noteOverlayHover(false);
  });
  overlayMessage("overlay-open", function (payload) {
    openSimklPage((payload && payload.url) || (overlayNowPlaying && overlayNowPlaying.url));
  });
}

function markOverlayLoaded() {
  bindOverlayMessages();
  if (overlayLoaded) {
    paintOverlay();
    return;
  }
  overlayLoaded = true;
  overlayReady = true;
  overlayWarmed = true;
  try {
    overlay.show();
    if (typeof overlay.setClickable === "function") overlay.setClickable(false);
    setOverlayOpacity(1);
  } catch (_error) {}
  log("Video overlay ready");
  flushOverlayUI();
  tickSkipIntro();
}

function overlayStartedLabel() {
  var times = readPlaybackTimes();
  var sec = Number(times.position || 0);
  if (!isFinite(sec) || sec < 0) sec = 0;
  return overlayCard.formatElapsed(sec);
}

function paintOverlayPlayback() {
  if (!overlayNowPlaying || !pluginAlive || windowClosing) return;
  var now = Date.now();
  if (overlayPlaybackPaintAt && now - overlayPlaybackPaintAt < 250) return;
  overlayPlaybackPaintAt = now;
  paintOverlay();
}

function overlayNowPlayingState() {
  if (!overlayNowPlaying) return null;
  var times = readPlaybackTimes();
  var pos = Number(times.position || 0);
  var dur = Number(times.duration || trustedDuration || 0);
  if (!isFinite(pos) || pos < 0) pos = 0;
  if (!isFinite(dur) || dur < 0) dur = 0;
  var progress = currentProgress();
  if (!isFinite(progress) || progress < 0) progress = 0;
  if (progress > 100) progress = 100;
  return Object.assign({}, overlayNowPlaying, {
    progress: progress,
    remainingLabel: overlayCard.formatRemaining(Math.max(0, dur - pos)) || "",
    startedLabel: overlayCard.formatElapsed(pos) || "",
  });
}

function parseDefaultsValue(result) {
  var text = "";
  if (result && typeof result === "object") text = String(result.stdout != null ? result.stdout : result.output || "");
  else text = String(result || "");
  return text.trim().toLowerCase();
}

function parseDefaultsInt(result, fallback) {
  var n = parseInt(parseDefaultsValue(result), 10);
  return isFinite(n) ? n : fallback;
}

function parseDefaultsBool(result, fallback) {
  var text = parseDefaultsValue(result);
  if (text === "1" || text === "true" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "no") return false;
  return fallback;
}

function refreshOscClearance() {
  if (!pluginAlive || !utils || typeof utils.exec !== "function") return;
  var now = Date.now();
  if (oscLayoutCheckedAt && now - oscLayoutCheckedAt < 2500) return;
  oscLayoutCheckedAt = now;
  Promise.resolve()
    .then(function () {
      return utils.exec("/usr/bin/defaults", ["read", "com.colliderli.iina", "oscPosition"]);
    })
    .then(function (posResult) {
      var oscPosition = parseDefaultsInt(posResult, 0);
      return Promise.all([
        oscPosition,
        utils.exec("/usr/bin/defaults", ["read", "com.colliderli.iina", "edgeToEdgeVideo"]).catch(function () {
          return { stdout: "1" };
        }),
        utils.exec("/usr/bin/defaults", ["read", "com.colliderli.iina", "dockedControlBarAndTitlebar"]).catch(function () {
          return { stdout: "0" };
        }),
      ]);
    })
    .then(function (parts) {
      if (!pluginAlive) return;
      var oscPosition = parts[0];
      var edgeToEdge = parseDefaultsBool(parts[1], true);
      var dockedBar = parseDefaultsBool(parts[2], false);
      var docked = !edgeToEdge && dockedBar;
      var next = oscPosition === OSC_POSITION_BOTTOM && !docked ? OSC_BOTTOM_CLEARANCE_PX : 0;
      if (next === oscClearancePx) return;
      oscClearancePx = next;
      log("OSC clearance " + oscClearancePx + "px (oscPosition=" + oscPosition + ")");
      paintOverlay();
    })
    .catch(function () {});
}

function postOverlayState() {
  if (!overlayLoaded || !overlay || typeof overlay.postMessage !== "function") return false;
  try {
    var payload = jsonSafe({
      nowPlaying: overlayNowPlayingState(),
      nowPlayingFading: !!overlayFading,
      scrobble: overlayScrobbleChip(),
      skip: !!(overlaySkipVisible || overlaySkipFading),
      skipFading: !!overlaySkipFading,
      skipLabel: skipIntro.label || "Skip Intro",
      position: overlayPosition(),
      offsetPx: overlayOffsetPx(),
      oscClearance: Number(oscClearancePx || 0),
      trackHover: overlayShouldTrackHover(),
    });
    if (!payload) return false;
    lastOverlayLayoutSignature = overlayLayoutSignature();
    overlay.postMessage("overlay-state", payload);
    if (typeof overlay.setClickable === "function") {
      overlay.setClickable(!!overlaySkipVisible || !!overlayNowPlaying);
    }
    overlay.show();
    setOverlayOpacity(1);
    return true;
  } catch (error) {
    warnOverlayUnavailable(error);
    return false;
  }
}

function startOscLayoutPoll() {
  if (oscLayoutTimer) return;
  function tick() {
    oscLayoutTimer = null;
    if (!pluginAlive || windowClosing) return;
    oscLayoutCheckedAt = 0;
    refreshOscClearance();
    oscLayoutTimer = setTimeout(tick, 30000);
  }
  oscLayoutTimer = setTimeout(tick, 30000);
}

function paintOverlay() {
  if (!playerUiReady()) return false;
  if (!warmOverlay()) return false;
  if (!overlayLoaded) return false;
  if (!overlayHasVisibleContent()) {
    finishHideOverlay();
    return true;
  }
  return postOverlayState();
}

function hideNowPlayingOverlay() {
  overlayShouldHide = true;
  pendingOverlayMatch = null;
  clearOverlayHideTimer();
}

function finishHideOverlay() {
  overlayFading = false;
  overlayShouldHide = false;
  overlayNowPlaying = null;
  clearOverlayNotice();
  overlayHideMode = "";
  overlayWindowHovered = false;
  overlaySkipVisible = false;
  overlaySkipFading = false;
  clearOverlayHideTimer();
  clearOverlayFadeTimer();
  clearSkipHideTimer();
  clearSkipFadeTimer();
  if (!overlayLoaded) return;
  try {
    if (typeof overlay.setClickable === "function") overlay.setClickable(false);
    overlay.postMessage("overlay-state", {
      nowPlaying: null,
      nowPlayingFading: false,
      scrobble: null,
      skip: false,
      skipFading: false,
      position: overlayPosition(),
      offsetPx: overlayOffsetPx(),
      oscClearance: Number(oscClearancePx || 0),
    });
    lastOverlayLayoutSignature = overlayLayoutSignature();
  } catch (_error) {}
  setOverlayOpacity(1);
}

function startOverlayFade() {
  if (!overlayWarmed || overlayFading || !overlayNowPlaying) return;
  if (playbackIsPaused()) return;
  overlayFading = true;
  overlayShouldHide = false;
  clearOverlayHideTimer();
  clearOverlayFadeTimer();
  paintOverlay();
}

function dismissNowPlayingOverlay() {
  overlayFading = false;
  overlayNowPlaying = null;
  if (!overlayHasVisibleContent()) finishHideOverlay();
  else paintOverlay();
}

function hideNowPlayingOverlayNow(options) {
  var instant = !!(options && options.instant);
  overlayShouldHide = false;
  pendingOverlayMatch = null;
  clearOverlayHideTimer();
  clearOverlayFadeTimer();
  if (instant || overlayFading || !overlayWarmed || !overlayNowPlaying) {
    dismissNowPlayingOverlay();
    return;
  }
  overlayFading = true;
  paintOverlay();
  overlayFadeTimer = setTimeout(function () {
    overlayFadeTimer = null;
    dismissNowPlayingOverlay();
  }, overlayCard.FADE_MS || 550);
}

function warmOverlay() {
  if (overlayLoaded) return true;
  if (overlayWarmed) return false;
  if (!playerUiReady()) return false;
  if (!overlayAvailable()) {
    warnOverlayUnavailable();
    return false;
  }
  try {
    overlay.loadFile("overlay.html");
    overlayWarmed = true;
    overlayHandlersBound = false;
    log("Loading video overlay");
    return false;
  } catch (error) {
    warnOverlayUnavailable(error);
    return false;
  }
}

function presentNowPlayingOverlay(payload, mode) {
  var duration = overlayDurationMs();
  if (!duration || !payload) return false;
  if (!playerUiReady()) {
    log("Waiting for the player window before showing the overlay");
    return false;
  }
  overlayFading = false;
  overlayNowPlaying = payload;
  overlayShouldHide = false;
  overlayWindowHovered = false;
  clearOverlayHideTimer();
  clearOverlayFadeTimer();
  overlayHideMode = resolveOverlayHideMode(mode);
  if (!paintOverlay()) return false;
  var hideMs = overlayHideDelayMs(overlayHideMode);
  log(
    "Showing now-playing overlay for " +
      payload.title +
      " " +
      (payload.episodeCode || "") +
      " mode=" +
      overlayHideMode +
      " (" +
      hideMs +
      "ms)"
  );
  armOverlayHideTimer(overlayHideMode);
  return true;
}

function showNowPlayingOverlay(match, force, mode) {
  var duration = overlayDurationMs();
  if (!duration || !match || !match.matched) return;
  var key = media.mediaKey(match);
  if (!force && key && key === lastOverlayKey) return;
  var payload = media.overlayPayload(match, titleLanguage());
  if (!payload) return;
  lastOverlayKey = key || "";
  overlayShouldHide = false;
  pendingOverlayMatch = match;
  pendingOverlayMode = mode || "";
  flushOverlayUI();
}

function flushOverlayUI() {
  if (!playerUiReady()) return;
  if (overlayShouldHide && !pendingOverlayMatch) {
    hideNowPlayingOverlayNow();
    overlayShouldHide = false;
    return;
  }
  if (!pendingOverlayMatch) return;
  var payload = media.overlayPayload(pendingOverlayMatch, titleLanguage());
  var mode = pendingOverlayMode;
  if (presentNowPlayingOverlay(payload, mode)) {
    pendingOverlayMatch = null;
    pendingOverlayMode = "";
  }
}

function clearSkipHideTimer() {
  if (skipHideTimer) {
    clearTimeout(skipHideTimer);
    skipHideTimer = null;
  }
}

function clearSkipFadeTimer() {
  if (skipFadeTimer) {
    clearTimeout(skipFadeTimer);
    skipFadeTimer = null;
  }
}

function stopSkipPoll() {
  if (skipPollTimer) {
    clearTimeout(skipPollTimer);
    skipPollTimer = null;
  }
}

function ensureSkipPoll() {
  if (skipPollTimer) return;
  function skipTick() {
    skipPollTimer = null;
    if (!pluginAlive) return;
    tickSkipIntro();
    if (!pluginAlive) return;
    skipPollTimer = setTimeout(skipTick, 250);
  }
  skipPollTimer = setTimeout(skipTick, 250);
}

function clearChapterSkipRetries() {
  if (!chapterSkipRetryTimers.length) return;
  chapterSkipRetryTimers.forEach(function (timer) {
    clearTimeout(timer);
  });
  chapterSkipRetryTimers = [];
}

function resetSkipIntro() {
  restoreVolumeDuck("reset");
  stopSkipPoll();
  clearSkipHideTimer();
  clearSkipFadeTimer();
  clearChapterSkipRetries();
  skipIntro = createSkipIntroState();
  overlaySkipVisible = false;
  overlaySkipFading = false;
  if (overlayNowPlaying || overlayFading) paintOverlay();
  else if (overlayWarmed) finishHideOverlay();
}

function stopRuntimeTimers() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (pendingTickTimer) {
    clearTimeout(pendingTickTimer);
    pendingTickTimer = null;
  }
  if (sidebarFlushTimer) {
    clearTimeout(sidebarFlushTimer);
    sidebarFlushTimer = null;
  }
  stopSidebarHydrate();
  if (seekSettleTimer) {
    clearTimeout(seekSettleTimer);
    seekSettleTimer = null;
  }
  if (scrobbleWaitTimer) {
    clearTimeout(scrobbleWaitTimer);
    scrobbleWaitTimer = null;
  }
  if (authActionTimer) {
    clearTimeout(authActionTimer);
    authActionTimer = null;
  }
  if (oscLayoutTimer) {
    clearTimeout(oscLayoutTimer);
    oscLayoutTimer = null;
  }
  clearOsdHold();
  clearOverlayNotice();
  clearOverlayHideTimer();
  clearOverlayFadeTimer();
  stopSkipPoll();
  clearSkipHideTimer();
  clearSkipFadeTimer();
  clearChapterSkipRetries();
}

function teardownPlugin() {
  restoreVolumeDuck("teardown");
  pluginAlive = false;
  windowClosing = true;
  markMpvUnavailable();
  stopRuntimeTimers();
}

function hideSkipPrompt(options) {
  var instant = !!(options && options.instant);
  clearSkipHideTimer();
  clearSkipFadeTimer();
  if (!overlaySkipVisible && !overlaySkipFading) return;
  if (instant || !overlayWarmed) {
    overlaySkipVisible = false;
    overlaySkipFading = false;
    paintOverlay();
    return;
  }
  overlaySkipVisible = true;
  overlaySkipFading = true;
  paintOverlay();
  skipFadeTimer = setTimeout(function () {
    skipFadeTimer = null;
    overlaySkipVisible = false;
    overlaySkipFading = false;
    paintOverlay();
  }, overlayCard.FADE_MS || 550);
}

function showSkipPrompt(segment) {
  var active = segment || skipIntro.active;
  if (!active && !skipIntro.preview) return;
  skipIntro.active = active || skipIntro.active;
  skipIntro.label = active ? introdb.skipButtonLabel(active) : skipIntro.label || "Skip Intro";
  skipIntro.prompt = "visible";
  overlaySkipVisible = true;
  overlaySkipFading = false;
  clearSkipHideTimer();
  clearSkipFadeTimer();
  if (!paintOverlay()) {
    skipIntro.prompt = "hidden";
    overlaySkipVisible = false;
    return;
  }
  log("Showing " + skipIntro.label + " button");
  skipHideTimer = setTimeout(function () {
    skipHideTimer = null;
    if (skipIntro.prompt !== "visible") return;
    if (skipIntro.preview) {
      skipIntro.prompt = "dismissed";
      hideSkipPrompt();
      return;
    }
    skipIntro.prompt = "faded";
    overlaySkipVisible = true;
    overlaySkipFading = true;
    paintOverlay();
  }, introdb.SKIP_PROMPT_MS);
}

function seekToSeconds(seconds) {
  var target = Number(seconds);
  if (!isFinite(target) || target < 0) return false;
  var ok = false;
  try {
    if (mpvCanQuery() && typeof mpv.set === "function") {
      mpv.set("time-pos", target);
      ok = true;
    }
  } catch (error) {
    log("mpv.set time-pos failed: " + errStr(error));
  }
  try {
    core.seekTo(target);
    ok = true;
  } catch (error) {
    log("core.seekTo failed: " + errStr(error));
  }
  return ok;
}

function skipCurrentIntro() {
  if (skipIntro.preview) {
    skipIntro.preview = false;
    skipIntro.prompt = "dismissed";
    skipIntro.active = null;
    overlaySkipVisible = false;
    overlaySkipFading = false;
    clearSkipHideTimer();
    clearSkipFadeTimer();
    paintOverlay();
    showOverlayNotice("Skipped Intro");
    log("Skip Intro preview clicked");
    return;
  }
  var segment = skipIntro.active;
  log((skipIntro.label || "Skip") + " clicked");
  if (!segment) {
    log("Skip click ignored: no active segment");
    return;
  }
  skipIntro.prompt = "skipped";
  skipIntro.preview = false;
  skipIntro.dismissed[segment.id] = "skipped";
  overlaySkipVisible = false;
  overlaySkipFading = false;
  clearSkipHideTimer();
  clearSkipFadeTimer();
  paintOverlay();
  if (!seekToSeconds(segment.endSec)) {
    importantOsd("Could not skip " + String(segment.label || "intro").toLowerCase());
    return;
  }
  showOverlayNotice("Skipped " + String(segment.label || "intro"));
  log("Skipped " + (segment.type || "intro") + " to " + Number(segment.endSec).toFixed(1) + "s");
  if (segment.type === "intro" || segment.type === "outro") restoreVolumeDuck("skipped");
}

function pruneSkipDismissed(position) {
  var dismissed = skipIntro.dismissed || {};
  var next = {};
  (skipIntro.segments || []).forEach(function (segment) {
    if (!dismissed[segment.id]) return;
    if (introdb.skipWorthShowing(position, segment, { leadIn: introdb.SKIP_LEAD_IN_SEC })) {
      next[segment.id] = dismissed[segment.id];
    }
  });
  skipIntro.dismissed = next;
}

function tickSkipIntro() {
  if (skipIntro.preview) return;
  if (windowClosing || mpvUnavailable || core.status.idle) {
    skipIntro.active = null;
    skipIntro.prompt = "hidden";
    if (overlaySkipVisible || overlaySkipFading) hideSkipPrompt({ instant: true });
    restoreVolumeDuck("idle");
    return;
  }
  applyVolumeDuck();
  if (!isSkipIntroEnabled()) {
    skipIntro.active = null;
    skipIntro.prompt = "hidden";
    if (overlaySkipVisible || overlaySkipFading) hideSkipPrompt({ instant: true });
    return;
  }
  if (skipIntro.status !== "ready" || !(skipIntro.segments && skipIntro.segments.length)) return;
  var pos = playbackPosition();
  pruneSkipDismissed(pos);
  var active = introdb.activeSegment(pos, skipIntro.segments, {
    leadIn: introdb.SKIP_LEAD_IN_SEC,
    dismissed: skipIntro.dismissed,
  });
  if (!active) {
    skipIntro.active = null;
    skipIntro.prompt = "hidden";
    if (overlaySkipVisible || overlaySkipFading) hideSkipPrompt({ instant: true });
    return;
  }
  if (skipIntro.active && skipIntro.active.id === active.id) {
    if (skipIntro.prompt === "visible" || skipIntro.prompt === "faded") return;
  }
  showSkipPrompt(active);
}

function playbackDurationSec() {
  var dur = finiteNumber(core.status.duration || 0, 0);
  if (dur > 0) return dur;
  if (lastPlaybackTimes.duration > 0) return lastPlaybackTimes.duration;
  return finiteNumber(trustedDuration, 0);
}

function playbackChapters() {
  var list = [];
  try {
    if (core && typeof core.getChapters === "function") {
      list = core.getChapters() || [];
    }
  } catch (error) {
    log("core.getChapters failed: " + errStr(error));
  }
  if ((!list || !list.length) && mpvCanQuery() && typeof mpv.getNative === "function") {
    try {
      var native = mpv.getNative("chapter-list");
      if (Array.isArray(native)) list = native;
    } catch (error) {
      log("mpv chapter-list failed: " + errStr(error));
    }
  }
  return Array.isArray(list) ? list : [];
}

function skipSegmentSignature(segments) {
  return (segments || [])
    .map(function (segment) {
      return segment && segment.id ? String(segment.id) : "";
    })
    .join("|");
}

function activateSkipSegments(segments, source, summary) {
  skipIntro.segments = segments || [];
  skipIntro.source = source || "";
  skipIntro.status = skipIntro.segments.length ? "ready" : "missing";
  queueSidebarRefresh(false);
  if (!skipIntro.segments.length) return false;
  log(summary);
  debugOsd(
    skipIntro.segments
      .map(function (segment) {
        var name = segment.chapterTitle || segment.label;
        return (
          "Skip " +
          name +
          " " +
          media.formatDuration(segment.startSec) +
          "–" +
          media.formatDuration(segment.endSec)
        );
      })
      .join(" · ")
  );
  ensureSkipPoll();
  tickSkipIntro();
  return true;
}

function applyChapterSkipFallback() {
  if (!wantsSkipSegments()) return false;
  if (skipIntro.source === "introdb" && skipIntro.segments && skipIntro.segments.length) return false;
  var segments = introdb.segmentsFromChapters(playbackChapters(), playbackDurationSec());
  if (!segments.length) return false;
  if (
    skipIntro.source === "chapters" &&
    skipSegmentSignature(skipIntro.segments) === skipSegmentSignature(segments)
  ) {
    return true;
  }
  return activateSkipSegments(
    segments,
    "chapters",
    "Chapter skip segments: " +
      segments
        .map(function (segment) {
          var name = segment.chapterTitle || segment.type;
          return name + " " + segment.startSec + "s–" + segment.endSec + "s";
        })
        .join(", ")
  );
}

function scheduleChapterSkipRetry(mediaKey) {
  clearChapterSkipRetries();
  [400, 1200, 3000].forEach(function (delayMs) {
    var timer = setTimeout(function () {
      if (!pluginAlive || windowClosing || mpvUnavailable) return;
      if (!current.media || media.mediaKey(current.media) !== mediaKey) return;
      if (skipIntro.source === "introdb" && skipIntro.segments && skipIntro.segments.length) return;
      applyChapterSkipFallback();
    }, delayMs);
    chapterSkipRetryTimers.push(timer);
  });
}

function handleChapterListChanged() {
  if (!pluginAlive || windowClosing || mpvUnavailable) return;
  if (!wantsSkipSegments()) return;
  if (!current.media || !current.media.matched) return;
  if (skipIntro.status === "loading") return;
  if (skipIntro.source === "introdb" && skipIntro.segments && skipIntro.segments.length) return;
  applyChapterSkipFallback();
}

async function loadSkipIntro(match) {
  resetSkipIntro();
  if (!wantsSkipSegments()) return;
  if (!match || !match.matched) return;
  var mediaKey = media.mediaKey(match);
  skipIntro.mediaKey = mediaKey;
  skipIntro.status = "loading";
  queueSidebarRefresh(false);

  var wantIntrodb = match.kind !== "movie" && !!match.number;
  var imdbId = introdb.normalizeImdbId(match.ids && match.ids.imdb);
  var fallbackStatus = "missing";

  if (wantIntrodb && !imdbId) {
    fallbackStatus = "no-imdb";
    log("No IMDb ID on Simkl match; trying file chapters for Skip Intro");
  } else if (wantIntrodb) {
    var season = media.displaySeason(match);
    var episode = media.displayNumber(match);
    try {
      var segments = await introdb.fetchSegments({
        imdbId: imdbId,
        season: season,
        episode: episode,
      });
      if (!current.media || media.mediaKey(current.media) !== mediaKey) return;
      if (segments && segments.length) {
        activateSkipSegments(
          segments,
          "introdb",
          "IntroDB segments for " +
            imdbId +
            " S" +
            season +
            "E" +
            episode +
            ": " +
            segments
              .map(function (segment) {
                return segment.type + " " + segment.startSec + "s–" + segment.endSec + "s";
              })
              .join(", ")
        );
        return;
      }
      fallbackStatus = "missing";
      log("IntroDB has no skip segments for " + imdbId + " S" + season + "E" + episode);
    } catch (error) {
      if (!current.media || media.mediaKey(current.media) !== mediaKey) return;
      fallbackStatus = "error";
      log("IntroDB fetch failed: " + errStr(error));
    }
  }

  if (!current.media || media.mediaKey(current.media) !== mediaKey) return;
  if (applyChapterSkipFallback()) return;
  skipIntro.status = fallbackStatus;
  queueSidebarRefresh(false);
  scheduleChapterSkipRetry(mediaKey);
}

function queueFileWork(label, fn) {
  fileWorkChain = fileWorkChain
    .then(function () {
      return wrap(label, fn)();
    })
    .catch(function (error) {
      log(label + " queue failed: " + errStr(error));
    });
  return fileWorkChain;
}

function sessionOptions() {
  return {
    pauseDebounceMs: Math.max(0, prefNumber("pause_debounce_ms", 400)),
    seekDebounceMs: sessionLib.DEFAULT_SEEK_DEBOUNCE_MS,
    lockMs: 20000,
    minProgress: 0.5,
    minSeekDelta: sessionLib.DEFAULT_MIN_SEEK_DELTA,
  };
}

refreshPrefCache();
simkl.configure({
  file: file,
  http: http,
  preferences: cachedPreferencesApi(),
  utils: utils,
  logger: log,
  notify: importantOsd,
  onAuthStatusChange: function () {
    queueSidebarRefresh(true);
  },
});

introdb.configure({
  http: http,
  utils: utils,
  logger: log,
});

function rememberPlaybackTimes(times) {
  if (!times) return;
  lastPlaybackTimes = {
    position: Number(times.position || 0),
    duration: Number(times.duration || 0),
    percent: Number(times.percent || 0),
    paused: !!times.paused,
  };
}

function readCorePlaybackTimes() {
  var position = 0;
  var duration = 0;
  var paused = !!lastPlaybackTimes.paused;
  try {
    position = Number(core.status.position || 0);
  } catch (_error) {}
  try {
    duration = Number(core.status.duration || 0);
  } catch (_error) {}
  try {
    if (typeof core.status.paused === "boolean") paused = !!core.status.paused;
  } catch (_error) {}
  if (!isFinite(position) || position < 0) position = 0;
  if (!isFinite(duration) || duration < 0) duration = 0;
  return { position: position, duration: duration, paused: paused };
}

function stopProgressSnapshot() {
  if (lastPlaybackTimes.percent > 0) return lastPlaybackTimes;
  var coreTimes = readCorePlaybackTimes();
  var duration = coreTimes.duration || trustedDuration || 0;
  trustedDuration = media.trustedDuration(coreTimes.position, duration, trustedDuration);
  return {
    position: coreTimes.position,
    duration: duration,
    percent: media.playbackProgress(coreTimes.position, duration, trustedDuration),
    paused: coreTimes.paused,
  };
}

function cachedPlaybackTimes() {
  if ((windowClosing || mpvUnavailable) && lastPlaybackTimes.percent > 0) {
    return lastPlaybackTimes;
  }
  var coreTimes = readCorePlaybackTimes();
  var position = coreTimes.position;
  var duration = coreTimes.duration || lastPlaybackTimes.duration || trustedDuration || 0;
  var paused = coreTimes.paused;
  trustedDuration = media.trustedDuration(position, duration, trustedDuration);
  return {
    position: position,
    duration: duration,
    percent: media.playbackProgress(position, duration, trustedDuration),
    paused: paused,
  };
}

function refreshMpvPlaybackTimes() {
  if (!mpvCanQuery() || typeof mpv.getNumber !== "function") return cachedPlaybackTimes();
  var position = 0;
  var duration = 0;
  var percent = null;
  var paused = playbackIsPaused();
  try {
    var mpvPos = mpv.getNumber("time-pos");
    var mpvDur = mpv.getNumber("duration");
    var mpvPct = mpv.getNumber("percent-pos");
    if (isFinite(mpvPos) && mpvPos >= 0) position = mpvPos;
    if (isFinite(mpvDur) && mpvDur > 0) duration = mpvDur;
    if (typeof mpv.getFlag === "function") {
      var flag = mpv.getFlag("pause");
      if (typeof flag === "boolean") paused = flag;
    }
    trustedDuration = media.trustedDuration(position, duration, trustedDuration);
    if (isFinite(mpvPct) && mpvPct >= 0 && mpvPct <= 100) {
      if (mpvPct <= 1 && duration > 0 && position / duration > 0.02) mpvPct *= 100;
      if (duration > position + 1 || mpvPct < 95) percent = Math.round(mpvPct * 100) / 100;
    }
  } catch (_error) {
    return cachedPlaybackTimes();
  }
  if (percent == null) {
    percent = media.playbackProgress(position, duration, trustedDuration);
  }
  var times = { position: position, duration: duration, percent: percent, paused: paused };
  rememberPlaybackTimes(times);
  return times;
}

function readPlaybackTimes() {
  return cachedPlaybackTimes();
}

function currentProgress() {
  var times = readPlaybackTimes();
  if (times.percent < 0.5 && times.position > 8) {
    if (trustedDuration > times.position + 2) {
      return media.progressPercent(times.position, trustedDuration);
    }
    if (times.duration > times.position + 2) {
      return media.progressPercent(times.position, times.duration);
    }
    return times.percent;
  }
  return times.percent;
}

function isPlaybackNearEnd() {
  var times = readPlaybackTimes();
  return media.isNearEnd(times.position, times.duration, trustedDuration);
}

function sleepMs(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function waitForReliableProgress() {
  var started = Date.now();
  var times = readPlaybackTimes();
  var lastPercent = null;
  var stableAt = 0;
  while (Date.now() - started < 4000) {
    if (!pluginAlive || windowClosing || mpvUnavailable) return null;
    if (mpvCanQuery()) refreshMpvPlaybackTimes();
    times = readPlaybackTimes();
    if (times.duration > times.position + 2 && times.duration > 30) {
      var percent = currentProgress();
      if (!(percent < 0.5 && times.position > 8)) {
        if (lastPercent != null && Math.abs(percent - lastPercent) < 1.5) {
          if (Date.now() - stableAt >= 700) return percent;
        } else {
          lastPercent = percent;
          stableAt = Date.now();
        }
      }
    }
    await sleepMs(100);
  }
  times = readPlaybackTimes();
  var percent = currentProgress();
  if (percent < 0.5 && times.position > 8) {
    log(
      "Duration still untrusted at " +
        times.position.toFixed(1) +
        "s / " +
        times.duration.toFixed(1) +
        "s, not sending 0%"
    );
    return null;
  }
  return percent;
}

async function syncPlaybackToSimkl(reason) {
  if (!pluginAlive || windowClosing || mpvUnavailable) return;
  if (flushStopInFlight) {
    try {
      await flushStopInFlight;
    } catch (_error) {}
  }
  var match = current.media;
  if (!match || !match.matched) return;
  if (current.path !== currentPath()) return;
  if (lastStoppedKey && media.mediaKey(match) === lastStoppedKey) return;
  if (core.status.idle) return;
  var percent = await waitForReliableProgress();
  if (percent == null) return;
  log("Syncing Simkl from " + reason + " at " + Number(percent).toFixed(1) + "%");
  var alreadyStarted =
    playbackSession.lastSentAction === "start" || playbackSession.lastSentAction === "pause";
  var fields = playbackDispatchFields();
  fields.progress = percent;
  await dispatch(
    Object.assign(
      {
        type: alreadyStarted || fields.paused ? "seek" : "play",
        itemKey: media.mediaKey(match),
      },
      fields
    )
  );
}

function currentPath() {
  return media.extractPath(core.status.url || "") || String(core.status.url || "");
}

function sourceSignature() {
  return String(core.status.url || "") + "|" + String(core.status.title || "");
}

function overlayScrobbleChip() {
  if (overlayNotice && overlayNotice.label && Date.now() < Number(overlayNotice.until || 0)) {
    return { label: overlayNotice.label, state: overlayNotice.state || "skipped" };
  }
  if (!prefBool("status_osd", true)) return null;
  var chip = overlayCard.scrobbleChip(buildScrobbleSnapshot());
  if (!chip || !chip.label) return chip;
  var paused = playbackIsPaused();
  if (chip.state === "paused" && !paused) return { label: "Now Watching", state: "watching" };
  if (chip.state === "watching" && paused) return { label: "Paused", state: "paused" };
  return chip;
}

function setScrobbleStatus(values) {
  lastScrobble = Object.assign({}, lastScrobble, values || {}, {
    updatedAt: new Date().toISOString(),
  });
  queueSidebarRefresh(false);
  paintOverlay();
}

function maybeRefreshProfile(force) {
  if (!simkl.getAuthStatus().connected) return;
  if (profileRefreshInFlight) return;
  if (simkl.getAuthStatus().user) return;
  profileRefreshInFlight = true;
  Promise.resolve()
    .then(function () {
      return simkl.getViewerProfile({ force: false });
    })
    .then(function () {
      profileRefreshInFlight = false;
      queueSidebarRefresh(false);
    })
    .catch(function (error) {
      profileRefreshInFlight = false;
      log("Profile refresh failed: " + errStr(error));
    });
}

function windowIsLoaded() {
  try {
    return !!(core.window && core.window.loaded);
  } catch (_error) {
    return false;
  }
}

function showSidebarTab() {
  if (!playerUiReady()) {
    log("Waiting for the player window before showing the sidebar");
    return;
  }
  if (pluginSidebarOpen) {
    try {
      if (sidebar && typeof sidebar.hide === "function") sidebar.hide();
    } catch (error) {
      log("sidebar.hide failed: " + errStr(error));
    }
    pluginSidebarOpen = false;
    return;
  }
  try {
    if (sidebar && typeof sidebar.show === "function") sidebar.show();
    pluginSidebarOpen = true;
  } catch (error) {
    log("sidebar.show failed: " + errStr(error));
  }
  readAuthActionFromPreferences();
  initializeSidebar();
  queueSidebarRefresh(true);
}

function playbackStateName() {
  if (core.status.idle) return "idle";
  if (playbackIsPaused()) return "paused";
  return "playing";
}

function buildSidebarPlayback() {
  var match = current.media;
  var overlayInfo = match && match.matched ? media.overlayPayload(match, titleLanguage()) : null;
  var pos = finiteNumber(playbackPosition(), 0);
  var dur = finiteNumber(core.status.duration || 0, 0);
  return {
    available: !!(match && match.matched),
    unmatched: !!(match && !match.matched),
    mediaLabel: match && match.matched ? labelFor(match) : match ? current.filename : "",
    filename: current.filename || "",
    kind: overlayInfo ? overlayInfo.kind : match && match.kind ? match.kind : "",
    kindLabel: overlayInfo ? overlayCard.kindLabel(overlayInfo.kind) : "",
    title: overlayInfo ? overlayInfo.title : "",
    year: overlayInfo && overlayInfo.year ? overlayInfo.year : null,
    season: overlayInfo && overlayInfo.season ? overlayInfo.season : null,
    number: overlayInfo && overlayInfo.number ? overlayInfo.number : null,
    seasonChip: overlayInfo ? overlayInfo.seasonChip : "",
    episodeChip: overlayInfo ? overlayInfo.episodeChip : "",
    episodeCode: overlayInfo ? overlayInfo.episodeCode : "",
    episodePill: overlayInfo ? overlayInfo.episodePill : "",
    episodeTitle: overlayInfo ? overlayInfo.episodeTitle : "",
    url: match && match.url ? match.url : "",
    posterUrl: overlayInfo ? overlayInfo.posterUrl : "",
    state: playbackStateName(),
    progress: finiteNumber(currentProgress(), 0),
    position: pos,
    duration: dur,
    remainingLabel: overlayCard.formatRemaining(Math.max(0, dur - pos)) || "",
    startedLabel: overlayCard.formatElapsed(pos) || "",
    identifiedAt: current.identifiedAt,
    skipIntro: buildSkipIntroSidebar(),
  };
}

function buildSkipIntroSidebar() {
  var segments = skipIntro.segments || [];
  var detail = "";
  var items = [];
  if (!isSkipIntroEnabled() && !isVolumeDuckEnabled()) detail = "Skip Intro is turned off.";
  else if (!isSkipIntroEnabled() && isVolumeDuckEnabled()) {
    if (skipIntro.status === "ready" && segments.length) {
      items = segments.map(function (segment) {
        return {
          type: segment.type,
          label: segment.chapterTitle || segment.label,
          range: media.formatDuration(segment.startSec) + " – " + media.formatDuration(segment.endSec),
        };
      });
      detail = "Skip buttons off. Volume ducks during intro and outro.";
    } else {
      detail = "Skip buttons off. Volume ducking is on.";
    }
  }
  else if (skipIntro.status === "loading") detail = "Looking up IntroDB timestamps…";
  else if (skipIntro.status === "ready" && segments.length) {
    items = segments.map(function (segment) {
      return {
        type: segment.type,
        label: segment.chapterTitle || segment.label,
        range: media.formatDuration(segment.startSec) + " – " + media.formatDuration(segment.endSec),
      };
    });
    if (skipIntro.source === "chapters") detail = "From file chapters.";
  } else if (skipIntro.status === "no-imdb") detail = "No IMDb ID on this Simkl match.";
  else if (skipIntro.status === "missing") detail = "No IntroDB skip times for this episode.";
  else if (skipIntro.status === "error") detail = "Intro lookup failed.";
  return {
    status: skipIntro.status,
    enabled: isSkipIntroEnabled(),
    source: skipIntro.source || "",
    detail: detail,
    items: items,
    prompt: skipIntro.prompt,
  };
}

function pendingWaitSeconds(now) {
  var until = Number(playbackSession && playbackSession.pendingAt || 0);
  if (!playbackSession || !playbackSession.pendingAction || until <= now) return 0;
  return Math.max(1, Math.ceil((until - now) / 1000));
}

function stopScrobbleWaitTicker() {
  if (scrobbleWaitTimer) {
    clearTimeout(scrobbleWaitTimer);
    scrobbleWaitTimer = null;
  }
}

function ensureScrobbleWaitTicker() {
  if (!pluginAlive || !playbackSession || !playbackSession.pendingAction) {
    stopScrobbleWaitTicker();
    return;
  }
  if (Date.now() >= Number(playbackSession.pendingAt || 0)) {
    stopScrobbleWaitTicker();
    return;
  }
  if (scrobbleWaitTimer) return;
  scrobbleWaitTimer = setTimeout(function () {
    scrobbleWaitTimer = null;
    if (!pluginAlive) return;
    queueSidebarRefresh(false);
    paintOverlay();
    ensureScrobbleWaitTicker();
  }, 250);
}

function buildScrobbleSnapshot() {
  var now = Date.now();
  var wait = pendingWaitSeconds(now);
  var pending = playbackSession && playbackSession.pendingAction ? playbackSession.pendingAction : "";
  if (pending && wait > 0 && lastScrobble.status !== "sending") {
    var pendingProgress = Number(playbackSession.pendingProgress || 0);
    var reported = Number(playbackSession.lastReportedProgress || 0);
    var position = 0;
    try {
      position = Number(core.status.position || 0);
    } catch (_error) {}
    var clock = media.formatDuration(position);
    var verb = pending === "pause" ? "Waiting to save pause" : "Waiting to update Simkl";
    var detail =
      "Player is at " +
      clock +
      " (" +
      pendingProgress.toFixed(0) +
      "%). Simkl still has " +
      reported.toFixed(0) +
      "%. Sending the new position in " +
      wait +
      "s.";
    return {
      status: "waiting",
      verb: pending,
      action: "",
      mediaLabel: lastScrobble.mediaLabel || "",
      detail: detail,
      reason: "cooldown",
      progress: pendingProgress,
      waitSeconds: wait,
      pendingAction: pending,
      reportedProgress: reported,
      updatedAt: lastScrobble.updatedAt || "",
    };
  }
  return Object.assign({}, lastScrobble, {
    waitSeconds: 0,
    pendingAction: pending,
    reportedProgress: playbackSession ? Number(playbackSession.lastReportedProgress || 0) : null,
  });
}

function buildSidebarSnapshot() {
  var auth = simkl.getAuthStatus();
  return {
    app: { version: simkl.PLUGIN_VERSION },
    scrobblingEnabled: isScrobblingEnabled(),
    statusOsdEnabled: prefBool("status_osd", true),
    auth: auth,
    playback: buildSidebarPlayback(),
    scrobble: buildScrobbleSnapshot(),
    correction: Object.assign({}, correction, {
      results: (correction.results || []).map(function (item) {
        return {
          key: item.key,
          kind: item.kind,
          title: item.title,
          year: item.year,
          subtitle: item.subtitle,
          detail: item.detail,
          posterUrl: item.posterUrl,
          url: item.url,
        };
      }),
    }),
    generatedAt: new Date().toISOString(),
  };
}

function queueSidebarRefresh(forceProfile) {
  if (forceProfile) sidebarForceProfile = true;
  sidebarDirty = true;
  if (sidebarFlushTimer || !pluginAlive) return;
  sidebarFlushTimer = setTimeout(function () {
    sidebarFlushTimer = null;
    if (!pluginAlive) return;
    flushSidebarUI();
  }, 50);
}

function stopSidebarHydrate() {
  if (sidebarHydrateTimer) {
    clearTimeout(sidebarHydrateTimer);
    sidebarHydrateTimer = null;
  }
}

function scheduleSidebarHydrate() {
  if (!pluginAlive || windowClosing || sidebarWebviewReady) {
    stopSidebarHydrate();
    return;
  }
  if (sidebarHydrateTimer) return;
  var attempt = 0;
  function tick() {
    sidebarHydrateTimer = null;
    if (!pluginAlive || windowClosing || sidebarWebviewReady) return;
    queueSidebarRefresh(false);
    attempt += 1;
    if (attempt < 20) {
      sidebarHydrateTimer = setTimeout(tick, attempt < 8 ? 400 : 800);
    }
  }
  sidebarHydrateTimer = setTimeout(tick, 150);
}

function fallbackSidebarSnapshot(auth) {
  return {
    app: { version: simkl.PLUGIN_VERSION },
    scrobblingEnabled: isScrobblingEnabled(),
    statusOsdEnabled: prefBool("status_osd", true),
    auth: {
      state: auth && auth.state ? auth.state : "disconnected",
      summary: (auth && auth.summary) || "",
      detail: (auth && auth.detail) || "",
      busy: !!(auth && auth.busy),
      connected: !!(auth && auth.connected),
      userCode: (auth && auth.userCode) || "",
      verificationUrl: (auth && auth.verificationUrl) || "",
      user: auth && auth.user ? jsonSafe(auth.user) : null,
    },
    playback: {
      available: false,
      unmatched: false,
      mediaLabel: "",
      filename: current.filename || "",
      title: "",
      kind: "",
      kindLabel: "",
      year: null,
      season: null,
      number: null,
      seasonChip: "",
      episodeChip: "",
      episodeCode: "",
      episodePill: "",
      episodeTitle: "",
      url: "",
      posterUrl: "",
      state: playbackStateName(),
      progress: 0,
      position: 0,
      duration: 0,
      remainingLabel: "",
      startedLabel: "",
    },
    scrobble: {
      status: "idle",
      verb: "",
      action: "",
      mediaLabel: "",
      detail: "Sidebar snapshot failed to serialize.",
      reason: "",
    },
    correction: { active: false, busy: false, query: "", error: "", results: [] },
    generatedAt: new Date().toISOString(),
  };
}

function postSidebarMessage(name, payload) {
  if (!sidebar || typeof sidebar.postMessage !== "function") return false;
  if (!playerUiReady() || !sidebarLoaded) return false;
  var data = payload;
  if (payload && typeof payload === "object") {
    data = jsonSafe(payload);
    if (!data) return false;
  }
  try {
    sidebar.postMessage(name, data);
    return true;
  } catch (error) {
    log("sidebar.postMessage(" + name + ") failed: " + errStr(error));
    return false;
  }
}

function flushSidebarUI() {
  if (!playerUiReady() || sidebarFlushInFlight) return;
  sidebarFlushInFlight = true;
  try {
    if (!sidebarLoaded) initializeSidebar();
    if (sidebarLoaded) {
      if (!sidebarHandlersBound) bindSidebar();
      if (pendingCopyAuthResult) {
        postSidebarMessage("copy_auth_result", pendingCopyAuthResult);
        pendingCopyAuthResult = null;
      }
      var force = sidebarForceProfile;
      if (force) sidebarForceProfile = false;
      var snapshot = jsonSafe(buildSidebarSnapshot()) || fallbackSidebarSnapshot(simkl.getAuthStatus());
      var ok = postSidebarMessage("state", snapshot);
      log(
        "Sidebar flush connected=" +
          !!(snapshot.auth && snapshot.auth.connected) +
          " media=" +
          ((snapshot.playback && (snapshot.playback.mediaLabel || snapshot.playback.filename)) || "none") +
          " ready=" +
          sidebarWebviewReady +
          " ok=" +
          ok
      );
      if (ok) sidebarDirty = false;
      maybeRefreshProfile(force);
    }
  } catch (error) {
    log("Sidebar flush failed: " + errStr(error));
  }
  sidebarFlushInFlight = false;
}

function maybeShowScrobbleOsd() {
  paintOverlay();
}

function armPendingTick() {
  if (pendingTickTimer) {
    clearTimeout(pendingTickTimer);
    pendingTickTimer = null;
  }
  if (!pluginAlive || !playbackSession || !playbackSession.pendingAction) {
    stopScrobbleWaitTicker();
    return;
  }
  ensureScrobbleWaitTicker();
  queueSidebarRefresh(false);
  var wait = Math.max(50, Number(playbackSession.pendingAt || 0) - Date.now());
  pendingTickTimer = setTimeout(function () {
    pendingTickTimer = null;
    if (!pluginAlive) return;
    tickPauseDebounce();
    armPendingTick();
  }, wait);
}

function dispatch(eventSpec) {
  var decision = sessionLib.decide(playbackSession, eventSpec, Date.now(), sessionOptions());
  playbackSession = decision.session;
  armPendingTick();
  queueSidebarRefresh(false);
  if (!decision.send) return Promise.resolve();
  return enqueueScrobble(decision.send.action, decision.send.progress, !!decision.send.deferred);
}

function playbackDispatchFields() {
  var progress = currentProgress();
  var duration = 0;
  try {
    duration = Number(core.status.duration || trustedDuration || 0);
  } catch (_error) {}
  var speed = 1;
  try {
    speed = Number(core.status.speed || 1);
  } catch (_error) {}
  if (!isFinite(speed) || speed <= 0) speed = 1;
  return {
    progress: progress,
    paused: playbackIsPaused(),
    seeking: !!seeking,
    duration: duration,
    speed: speed,
    ignoreSeek: progress >= 95 && !isPlaybackNearEnd(),
  };
}

function syncCurrentPlayback(reason) {
  if (!pluginAlive || windowClosing) return Promise.resolve();
  if (!current.media || !current.media.matched) {
    queueSidebarRefresh(false);
    return Promise.resolve();
  }
  if (core.status.idle) return Promise.resolve();
  var fields = playbackDispatchFields();
  if (lastHandledPause !== null && lastHandledPause !== fields.paused) {
    return handlePauseChanged();
  }
  var sent = dispatch(
    Object.assign(
      {
        type: reason === "seek" ? "seek" : "progress",
        itemKey: media.mediaKey(current.media),
      },
      fields
    )
  );
  paintOverlayPlayback();
  return sent;
}

function startPlaybackPoll() {
  if (pollTimer) return;
  function tick() {
    pollTimer = null;
    if (!pluginAlive || windowClosing || mpvUnavailable) return;
    refreshMpvPlaybackTimes();
    applyVolumeDuck();
    syncCurrentPlayback("poll").catch(function (error) {
      log("playback poll failed: " + errStr(error));
    });
    pollTimer = setTimeout(tick, 500);
  }
  pollTimer = setTimeout(tick, 400);
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
        clearTimeout(timer);
        resolve(value);
      },
      function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function watchingSessionOpen() {
  if (activeSimklSession) return true;
  var phase = playbackSession && playbackSession.phase;
  if (phase === "watching" || phase === "paused") return true;
  var last = playbackSession && playbackSession.lastSentAction;
  return last === "start" || last === "pause";
}

function closeWatchingSessionLocally() {
  activeSimklSession = false;
  if (!playbackSession) playbackSession = sessionLib.createSession();
  playbackSession.phase = "idle";
  playbackSession.lastSentAction = "stop";
  playbackSession.pendingAction = "";
  playbackSession.pendingAt = 0;
  playbackSession.pendingProgress = 0;
}

async function flushStop(reason, options) {
  if (flushStopInFlight) return flushStopInFlight;
  var settings = options || {};
  var match = current.media;
  var progress = settings.completed ? 100 : settings.progress != null ? Number(settings.progress) : currentProgress();
  if (!isFinite(progress)) progress = 0;
  if (!match || !match.matched || !watchingSessionOpen()) {
    closeWatchingSessionLocally();
    log("No active Simkl watching session to stop (" + reason + ")");
    return;
  }
  var captured = match;
  lastStoppedKey = media.mediaKey(captured);
  closeWatchingSessionLocally();
  log("Stopping Simkl watching session (" + reason + ") at " + progress + "%");
  flushStopInFlight = (async function () {
    try {
      await enqueueScrobble("stop", progress, false, captured);
    } catch (error) {
      log("Failed to stop Simkl session on " + reason + ": " + errStr(error));
    } finally {
      flushStopInFlight = null;
    }
  })();
  return flushStopInFlight;
}

function bindUnloadHook() {
  if (unloadHookBound) return;
  if (!mpv || typeof mpv.addHook !== "function") return;
  try {
    mpv.addHook("on_unload", 50, async function (next) {
      try {
        restoreVolumeDuck("on_unload");
        var times = stopProgressSnapshot();
        await flushStop("on_unload", { progress: times.percent });
      } catch (error) {
        log("on_unload stop failed: " + errStr(error));
      }
      if (typeof next === "function") next();
    });
    unloadHookBound = true;
    log("Registered mpv on_unload hook for Simkl stop");
  } catch (error) {
    log("Could not register on_unload hook: " + errStr(error));
  }
}

function enqueueScrobble(action, progress, deferred, match) {
  var captured = match || current.media;
  var sentAt = Number(playbackSession && playbackSession.lastSentAt || lastSimklSentAt || 0);
  scrobbleChain = scrobbleChain
    .then(async function () {
      if (deferred) {
        var wait = Math.max(0, 20000 - (Date.now() - sentAt));
        if (wait) await new Promise(function (resolve) { setTimeout(resolve, wait); });
      }
      await sendScrobble(action, progress, false, captured);
    })
    .catch(function (error) {
      log("Scrobble queue failed: " + errStr(error));
    });
  return scrobbleChain;
}

async function sendScrobble(action, progress, isRetry, matchOverride) {
  if (!pluginAlive && action !== "stop") return;
  var match = matchOverride || current.media;
  if (!isScrobblingEnabled() && action !== "stop") {
    setScrobbleStatus({
      status: "disabled",
      verb: action,
      mediaLabel: match && match.matched ? labelFor(match) : "",
      detail: "Scrobbling is turned off.",
      reason: "disabled",
      progress: progress,
    });
    return;
  }

  setScrobbleStatus({
    status: "sending",
    verb: action,
    mediaLabel: match && match.matched ? labelFor(match) : "",
    detail: "Sending " + action + " to Simkl.",
    reason: "",
    progress: progress,
  });

  var result;
  try {
    result = await simkl.scrobble(action, match, progress);
  } catch (error) {
    setScrobbleStatus({
      status: "failed",
      verb: action,
      mediaLabel: match && match.matched ? labelFor(match) : "",
      detail: errStr(error),
      reason: "error",
      progress: progress,
    });
    playbackSession = sessionLib.rollback(playbackSession, action);
    importantOsd("Scrobble failed");
    log("Scrobble " + action + " failed: " + errStr(error));
    return;
  }

  if (result.skip) {
    playbackSession = sessionLib.rollback(playbackSession, action);
    var skipDetail = "Skipped.";
    if (result.reason === "auth-required") skipDetail = "Connect Simkl to scrobble.";
    if (result.reason === "legacy-auth") skipDetail = "Reconnect Simkl to continue scrobbling.";
    if (result.reason === "quota-exceeded") skipDetail = "Simkl daily request limit reached. Try again after midnight US Eastern.";
    if (result.reason === "insufficient-scope") skipDetail = "Reconnect Simkl and allow library updates.";

    if (result.reason === "missing-simkl-match") skipDetail = "This file was not identified.";
    if (result.reason === "missing-episode") skipDetail = "Pick the correct episode before scrobbling.";
    setScrobbleStatus({
      status: result.reason === "missing-simkl-match" || result.reason === "missing-episode" ? "unmatched" : "skipped",
      verb: action,
      mediaLabel: match && match.matched ? labelFor(match) : current.filename,
      detail: skipDetail,
      reason: result.reason,
      progress: progress,
    });
    return;
  }

  if (result.duplicate) {
    if (action === "stop") activeSimklSession = false;
    setScrobbleStatus({
      status: "duplicate",
      verb: action,
      action: "scrobble",
      mediaLabel: labelFor(match),
      detail: "Simkl already marked this as watched.",
      reason: "",
      progress: progress,
    });
    return;
  }

  if (result.throttled) {
    playbackSession = sessionLib.rollback(playbackSession, action);
    playbackSession.pendingAction = action;
    playbackSession.pendingProgress = Number(progress || 0);
    playbackSession.pendingAt = Math.max(Date.now() + 1000, lastSimklSentAt + 20000);
    playbackSession.lastSentAt = lastSimklSentAt;
    if (action === "start") playbackSession.phase = "watching";
    armPendingTick();
    setScrobbleStatus({
      status: "waiting",
      verb: action,
      mediaLabel: labelFor(match),
      detail: "Simkl cooldown. Retrying this " + action + " shortly.",
      reason: "throttled",
      progress: progress,
    });
    queueSidebarRefresh(false);
    return;
  }

  if (result.notFound) {
    playbackSession = sessionLib.rollback(playbackSession, action);
    var sameItem = !matchOverride || (current.media && media.mediaKey(matchOverride) === media.mediaKey(current.media));
    if (!isRetry && current.path && sameItem) {
      log("Simkl returned 404 for " + labelFor(match) + "; re-identifying from filename");
      simkl.forgetMatch(current.path, current.filename);
      var retried = await simkl.identifyFile(current.path, { force: true });
      current.media = retried;
      queueSidebarRefresh(false);
      if (retried && retried.matched) {
        return sendScrobble(action, progress, true, retried);
      }
    }
    setScrobbleStatus({
      status: "unmatched",
      verb: action,
      mediaLabel: match && match.matched ? labelFor(match) : current.filename,
      detail: "Simkl could not match this title. Try Correct Match.",
      reason: "id_err",
      progress: progress,
    });
    return;
  }

  if (!result.ok) {
    setScrobbleStatus({
      status: "failed",
      verb: action,
      mediaLabel: match && match.matched ? labelFor(match) : "",
      detail: "Simkl rejected this scrobble.",
      reason: "error",
      progress: progress,
    });
    return;
  }

  lastSimklSentAt = Date.now();
  playbackSession.lastSentAt = lastSimklSentAt;
  playbackSession.lastSentAction = action;
  if (action === "start") {
    activeSimklSession = true;
    if (!watchStartedAt) watchStartedAt = lastSimklSentAt;
  }
  if (action === "stop") {
    activeSimklSession = false;
    watchStartedAt = 0;
  }
  var previousStatus = lastScrobble;
  setScrobbleStatus({
    status: "succeeded",
    verb: action,
    action: result.action,
    mediaLabel: labelFor(match),
    detail:
      result.action === "scrobble"
        ? "Marked watched at " + Number(result.progress || progress).toFixed(0) + "%."
        : "Simkl accepted " + action + " at " + Number(result.progress || progress).toFixed(0) + "%.",
    reason: "",
    progress: result.progress,
  });
  maybeShowScrobbleOsd(
    action,
    result.action,
    result.progress != null ? result.progress : progress,
    previousStatus
  );
  log("Scrobble " + action + " -> " + result.action + " at " + result.progress + "% for " + labelFor(match));
  queueSidebarRefresh(true);
}

async function identifyCurrentFile() {
  var path = currentPath();
  var filename = media.extractFilename(path);
  current.url = String(core.status.url || "");
  current.path = path;
  current.filename = filename;
  current.identifying = true;
  queueSidebarRefresh(false);

  if (!filename) {
    current.media = media.createUnmatched("", "missing-filename");
    current.identifiedAt = new Date().toISOString();
    current.identifying = false;
    setScrobbleStatus({
      status: "unmatched",
      detail: "No file name is available to identify.",
      reason: "missing-filename",
    });
    return null;
  }

  try {
    var match = await simkl.identifyFile(path);
    if (current.path !== path) return null;
    current.media = match;
    current.identifiedAt = new Date().toISOString();
    current.identifying = false;
    if (!match.matched) {
      if (core.status.title) match.title = String(core.status.title);
      var unmatchedDetail = "Simkl could not identify this file. Use Correct Match.";
      if (match.reason === "auth-required") unmatchedDetail = "Connect Simkl to identify titles.";
      if (match.reason === "quota-exceeded") unmatchedDetail = "Simkl daily request limit reached. Try again after midnight US Eastern.";
      setScrobbleStatus({
        status: "unmatched",
        mediaLabel: filename,
        detail: unmatchedDetail,
        reason: match.reason === "auth-required" || match.reason === "quota-exceeded" ? match.reason : "missing-simkl-match",
      });
      debugOsd("Unmatched: " + filename);
      resetSkipIntro();
      hideNowPlayingOverlay();
      return match;
    }
    setScrobbleStatus({
      status: "ready",
      mediaLabel: labelFor(match),
      detail: "Watching for playback changes.",
      reason: "",
    });
    debugOsd("Matched " + labelFor(match));
    showNowPlayingOverlay(match);
    loadSkipIntro(match).catch(function (error) {
      log("Skip intro load failed: " + errStr(error));
    });
    return match;
  } catch (error) {
    current.identifying = false;
    log("Identify failed: " + errStr(error));
    setScrobbleStatus({
      status: "failed",
      mediaLabel: filename,
      detail: errStr(error),
      reason: "identify-failed",
    });
    return null;
  } finally {
    current.identifying = false;
    queueSidebarRefresh(false);
  }
}

async function handleNewFile() {
  var signature = sourceSignature();
  var previousProgress = currentProgress();
  var fileChanged = !!(lastSourceSignature && lastSourceSignature !== signature);
  if (fileChanged) {
    await flushStop("file-change", { progress: previousProgress });
  }
  lastSourceSignature = signature;
  if (fileChanged || !playbackSession || !playbackSession.itemKey) {
    trustedDuration = 0;
    lastPlaybackTimes = { position: 0, duration: 0, percent: 0, paused: false };
    watchStartedAt = 0;
    playbackSession = sessionLib.createSession();
    correction = createCorrectionState();
    lastOverlayKey = "";
    resetSkipIntro();
  }
  if (current.identifying && current.path === currentPath()) return;
  await identifyCurrentFile();
  lastStoppedKey = "";
}

async function handlePlaybackStarted() {
  if (!current.media || current.path !== currentPath() || current.identifying) {
    await handleNewFile();
  }
  if (playbackIsPaused() || current.identifying) return;
  if (current.path !== currentPath()) return;
  var match = current.media;
  if (!match || !match.matched) return;
  if (lastStoppedKey && media.mediaKey(match) === lastStoppedKey) return;
  await syncPlaybackToSimkl("playback-started");
}

function noteSeeking() {
  seeking = true;
  if (seekSettleTimer) clearTimeout(seekSettleTimer);
  seekSettleTimer = setTimeout(function () {
    seekSettleTimer = null;
    seeking = false;
    handleSeekSettled().catch(function (error) {
      log("seek sync failed: " + errStr(error));
    });
  }, 400);
}

async function handleSeekSettled() {
  log("Seek settled at " + Number(currentProgress() || 0).toFixed(1) + "%");
  await syncCurrentPlayback("seek");
}

async function handlePauseChanged() {
  var paused = playbackIsPaused();
  if (lastHandledPause === paused) return;
  lastHandledPause = paused;
  var match = current.media;
  if (!match || !match.matched) return;
  showNowPlayingOverlay(match, true, paused ? "hold" : "resume");
  var fields = playbackDispatchFields();
  await dispatch(
    Object.assign(
      {
        type: paused ? "pause" : "play",
        itemKey: media.mediaKey(match),
      },
      fields
    )
  );
}

function tickPauseDebounce() {
  var decision = sessionLib.decide(
    playbackSession,
    { type: "tick-pause-debounce" },
    Date.now(),
    sessionOptions()
  );
  playbackSession = decision.session;
  if (decision.send) {
    enqueueScrobble(decision.send.action, decision.send.progress, !!decision.send.deferred);
  }
}

function checkAuthActionRequest() {
  if (!pluginAlive) return;
  var nonce = String(cachedPref("auth_action_nonce") || "");
  var action = String(cachedPref("auth_action_kind") || "");
  if (!nonce || nonce === lastAuthActionNonce) return;
  lastAuthActionNonce = nonce;
  persistPreferences({ auth_action_kind: "", auth_action_nonce: "" });
  if (action === "show_sidebar") {
    showSidebarTab();
    queueSidebarRefresh(true);
  } else if (action === "connect") {
    runManualAuth(false);
  } else if (action === "signout") {
    handleSignOut();
  }
}

function readAuthActionFromPreferences() {
  if (!pluginAlive) return;
  refreshPrefCache();
  checkAuthActionRequest();
  maybeRepaintOverlayLayout();
  applyVolumeDuck();
}

function startAuthActionPoll() {
  if (authActionTimer) return;
  function tick() {
    authActionTimer = null;
    if (!pluginAlive || windowClosing) return;
    readAuthActionFromPreferences();
    authActionTimer = setTimeout(tick, 500);
  }
  readAuthActionFromPreferences();
  authActionTimer = setTimeout(tick, 500);
}

function resyncCurrentPlayback(reason) {
  if (!current.media || !current.media.matched) return Promise.resolve();
  if (core.status.idle) return Promise.resolve();
  log(reason || "Re-syncing current playback with Simkl");
  playbackSession = sessionLib.createSession();
  lastHandledPause = null;
  if (playbackIsPaused()) {
    return dispatch({
      type: "play",
      itemKey: media.mediaKey(current.media),
      progress: currentProgress(),
    }).then(function () {
      return dispatch({
        type: "pause",
        itemKey: media.mediaKey(current.media),
        progress: currentProgress(),
      });
    });
  }
  return dispatch({
    type: "play",
    itemKey: media.mediaKey(current.media),
    progress: currentProgress(),
  });
}

async function runManualAuth(force) {
  showSidebarTab();
  queueSidebarRefresh(false);
  var pending = simkl.beginInteractiveAuth({ force: !!force, restart: true });
  queueSidebarRefresh(false);
  try {
    await pending;
    authResyncAt = Date.now();
    queueSidebarRefresh(false);
    if (current.path) await identifyCurrentFile();
    if (current.media && current.media.matched && !playbackIsPaused() && !core.status.idle) {
      await syncPlaybackToSimkl("connect");
    }
  } catch (error) {
    log("Auth failed: " + errStr(error));
    importantOsd(errStr(error));
    queueSidebarRefresh(false);
  }
}

function handleSignOut() {
  authChain = authChain
    .then(function () {
      return simkl.signOut();
    })
    .then(function () {
      watchStartedAt = 0;
      playbackSession = sessionLib.createSession();
      lastScrobble = createScrobbleStatus();
      correction = createCorrectionState();
      importantOsd("Signed out of Simkl");
      queueSidebarRefresh(true);
    })
    .catch(function (error) {
      log("Sign out failed: " + errStr(error));
      queueSidebarRefresh(true);
    });
}

function setScrobblingEnabled(enabled) {
  persistPreferences({ scrobble_enabled: !!enabled });
  queueSidebarRefresh(false);
}

function setStatusOsdEnabled(enabled) {
  persistPreferences({ status_osd: !!enabled });
  queueSidebarRefresh(false);
}

async function openCorrection(query) {
  if (!current.media) return;
  correction = {
    active: true,
    busy: false,
    query: String(query || media.preferredTitle(current.media, titleLanguage()) || current.media.title || current.filename || "").trim(),
    error: "",
    mediaLabel: current.media.matched ? labelFor(current.media) : current.filename,
    results: [],
  };
  queueSidebarRefresh(false);
  await searchCorrection(correction.query);
}

async function searchCorrection(query) {
  if (!current.media) return;
  var trimmed = String(query || "").trim();
  correction = Object.assign({}, correction, {
    active: true,
    busy: true,
    query: trimmed,
    error: trimmed ? "" : "Enter a title to search.",
    results: [],
  });
  queueSidebarRefresh(false);
  if (!trimmed) return;
  try {
    var results = await simkl.searchCorrectionCandidates(current.media, trimmed, 6, titleLanguage());
    correction = Object.assign({}, correction, {
      busy: false,
      error: results.length ? "" : "No Simkl matches found.",
      results: results,
    });
  } catch (error) {
    correction = Object.assign({}, correction, {
      busy: false,
      error: errStr(error),
      results: [],
    });
  }
  queueSidebarRefresh(false);
}

async function applyCorrection(key) {
  var chosen = (correction.results || []).find(function (item) {
    return item.key === key;
  });
  if (!chosen || !chosen.media) return;
  correction = Object.assign({}, correction, { busy: true, error: "" });
  queueSidebarRefresh(false);
  try {
    var next = simkl.applyMatchOverride(current.filename, current.path, chosen.media);
    current.media = next;
    current.identifiedAt = new Date().toISOString();
    correction = createCorrectionState();
    playbackSession.lastSentAction = "";
    setScrobbleStatus({
      status: "ready",
      mediaLabel: labelFor(next),
      detail: "Match updated. Watching for playback changes.",
      reason: "",
    });
    importantOsd("Simkl match updated");
    loadSkipIntro(next).catch(function (error) {
      log("Skip intro load failed: " + errStr(error));
    });
    if (!playbackIsPaused() && !core.status.idle) {
      await dispatch({
        type: "play",
        itemKey: media.mediaKey(next),
        progress: currentProgress(),
      });
    }
  } catch (error) {
    correction = Object.assign({}, correction, { busy: false, error: errStr(error) });
  }
  queueSidebarRefresh(true);
}

function bindSidebar() {
  if (sidebarHandlersBound || !sidebar || typeof sidebar.onMessage !== "function") return;
  sidebarHandlersBound = true;
  function sidebarMessage(name, fn) {
    sidebar.onMessage(name, function (payload) {
      if (!pluginAlive) return;
      try {
        fn(payload);
      } catch (error) {
        log("sidebar " + name + " failed: " + errStr(error));
      }
    });
  }
  sidebarMessage("sidebar_visibility", function (payload) {
    pluginSidebarOpen = !!(payload && payload.visible);
  });
  sidebarMessage("ready", function (payload) {
    var hydrated = !!(
      payload &&
      (payload.hydrated === true || payload.hydrated === 1 || payload.hydrated === "true")
    );
    if (hydrated) {
      if (!sidebarWebviewReady) log("Sidebar webview hydrated");
      sidebarWebviewReady = true;
      stopSidebarHydrate();
      return;
    }
    if (sidebarWebviewReady || sidebarFlushInFlight) return;
    queueSidebarRefresh(false);
  });
  sidebarMessage("connect", function () {
    authChain = authChain
      .then(function () {
        return runManualAuth(false);
      })
      .catch(function (error) {
        log("Connect failed: " + errStr(error));
        importantOsd(errStr(error));
        queueSidebarRefresh(true);
      });
  });
  sidebarMessage("signout", function () {
    handleSignOut();
  });
  sidebarMessage("toggle_scrobbling", function (payload) {
    setScrobblingEnabled(!(payload && payload.enabled === false));
  });
  sidebarMessage("toggle_status_osd", function (payload) {
    setStatusOsdEnabled(!(payload && payload.enabled === false));
  });
  sidebarMessage("copy_auth_code", function () {
    Promise.resolve()
      .then(function () {
        return simkl.copyPendingAuthCode();
      })
      .then(function (result) {
        pendingCopyAuthResult = result;
      })
      .catch(function () {
        pendingCopyAuthResult = { ok: false, message: "Copy failed." };
      });
  });
  sidebarMessage("open_correction", function (payload) {
    authChain = authChain.then(function () {
      return openCorrection(payload && payload.query);
    });
  });
  sidebarMessage("search_correction", function (payload) {
    authChain = authChain.then(function () {
      return searchCorrection(payload && payload.query);
    });
  });
  sidebarMessage("close_correction", function () {
    correction = createCorrectionState();
    queueSidebarRefresh(false);
  });
  sidebarMessage("choose_correction", function (payload) {
    authChain = authChain.then(function () {
      return applyCorrection(payload && payload.key);
    });
  });
  sidebarMessage("open_url", function (payload) {
    openSimklPage(payload && payload.url);
  });
  sidebarMessage("refresh", function () {
    queueSidebarRefresh(true);
  });
}

function initializeSidebar() {
  if (!sidebar || typeof sidebar.loadFile !== "function") return;
  if (!playerUiReady()) {
    log("Deferring sidebar load until the player window is ready");
    return;
  }
  if (!sidebarLoaded) {
    try {
      // IINA's sidebar.loadFile() clears onMessage listeners. Bind after it returns.
      sidebar.loadFile("sidebar.html");
      sidebarLoaded = true;
      sidebarWebviewReady = false;
      sidebarHandlersBound = false;
      log(
        "Loaded SIMKL sidebar, auth=" +
          (simkl.getAuthStatus().connected ? "connected" : simkl.getAuthStatus().state)
      );
    } catch (error) {
      sidebarLoaded = false;
      log("sidebar.loadFile failed: " + errStr(error));
      return;
    }
  }
  bindSidebar();
  checkAuthActionRequest();
  scheduleSidebarHydrate();
  queueSidebarRefresh(true);
}

function registerMenu() {
  if (!menu || typeof menu.addItem !== "function") return;
  menu.addItem(
    menu.item(
      "Show SIMKL Sidebar",
      function () {
        showSidebarTab();
        queueSidebarRefresh(true);
      },
      { keyBinding: "Meta+k" }
    )
  );
  menu.addItem(
    menu.item("Connect to Simkl", function () {
      runManualAuth(false).catch(function (error) {
        log("Connect failed: " + errStr(error));
      });
    })
  );
  menu.addItem(
    menu.item("Toggle Scrobbling", function () {
      setScrobblingEnabled(!isScrobblingEnabled());
      importantOsd(isScrobblingEnabled() ? "Scrobbling on" : "Scrobbling off");
    })
  );
  menu.addItem(
    menu.item("Mark as Watched", function () {
      if (!current.media || !current.media.matched) {
        importantOsd("Nothing to mark as watched");
        return;
      }
      flushStop("mark-watched", { completed: true, progress: 100 });
    })
  );
  menu.addItem(
    menu.item("Preview Now Playing Overlay", function () {
      if (!current.media || !current.media.matched) {
        importantOsd("Load a matched episode to preview the overlay");
        return;
      }
      lastOverlayKey = "";
      showNowPlayingOverlay(current.media, true);
      flushOverlayUI();
    })
  );
  menu.addItem(
    menu.item("Preview Skip Intro", function () {
      warmOverlay();
      skipIntro.preview = true;
      skipIntro.prompt = "visible";
      skipIntro.label = "Skip Intro";
      skipIntro.active = { id: "preview", type: "intro", label: "Intro", startSec: 0, endSec: 0 };
      overlaySkipVisible = true;
      overlaySkipFading = false;
      if (!paintOverlay()) {
        skipIntro.preview = false;
        importantOsd("Video overlay is not ready yet. Try again in a moment.");
        return;
      }
      clearSkipHideTimer();
      skipHideTimer = setTimeout(function () {
        skipHideTimer = null;
        skipIntro.preview = false;
        skipIntro.prompt = "dismissed";
        hideSkipPrompt();
      }, introdb.SKIP_PROMPT_MS);
    })
  );
}

function wrap(label, fn) {
  return async function () {
    if (!pluginAlive) return;
    if (windowClosing || mpvUnavailable) {
      if (
        label !== "end-file" &&
        label !== "shutdown" &&
        label !== "window-will-close" &&
        label !== "window-did-close"
      ) {
        return;
      }
    }
    try {
      return await fn.apply(null, arguments);
    } catch (error) {
      log(label + " failed: " + errStr(error));
    }
  };
}

event.on(
  "iina.window-loaded",
  wrap("window-loaded", function () {
    if (!pluginAlive) return;
    windowClosing = false;
    mpvUnavailable = false;
    startAuthActionPoll();
    initializeSidebar();
    startPlaybackPoll();
    oscLayoutCheckedAt = 0;
    refreshOscClearance();
    startOscLayoutPoll();
    setTimeout(function () {
      if (!pluginAlive || windowClosing) return;
      warmOverlay();
      flushSidebarUI();
      flushOverlayUI();
    }, 250);
  })
);
event.on(
  "iina.plugin-overlay-loaded",
  wrap("plugin-overlay-loaded", function () {
    markOverlayLoaded();
  })
);
event.on(
  "iina.file-loaded",
  function () {
    lastHandledPause = null;
    queueFileWork("file-loaded", handleNewFile);
  }
);
event.on(
  "iina.file-started",
  function () {
    queueFileWork("file-started", handlePlaybackStarted);
  }
);
event.on(
  "mpv.pause.changed",
  wrap("pause.changed", function () {
    return handlePauseChanged();
  })
);
event.on(
  "mpv.seeking.changed",
  wrap("seeking.changed", function () {
    noteSeeking();
  })
);
try {
  event.on(
    "mpv.seek",
    wrap("seek", function () {
      noteSeeking();
    })
  );
} catch (error) {
  log("mpv.seek listener not available: " + errStr(error));
}
try {
  event.on(
    "mpv.playback-restart",
    wrap("playback-restart", function () {
      seeking = false;
      if (seekSettleTimer) {
        clearTimeout(seekSettleTimer);
        seekSettleTimer = null;
      }
      return handleSeekSettled();
    })
  );
} catch (error) {
  log("mpv.playback-restart listener not available: " + errStr(error));
}
try {
  event.on(
    "mpv.chapter-list.changed",
    wrap("chapter-list.changed", function () {
      handleChapterListChanged();
    })
  );
} catch (error) {
  log("mpv.chapter-list.changed listener not available: " + errStr(error));
}
try {
  event.on(
    "mpv.chapters.changed",
    wrap("chapters.changed", function () {
      handleChapterListChanged();
    })
  );
} catch (error) {
  log("mpv.chapters.changed listener not available: " + errStr(error));
}
event.on(
  "mpv.end-file",
  wrap("end-file", function () {
    var times = stopProgressSnapshot();
    var completed = media.isNearEnd(times.position, times.duration, trustedDuration);
    return flushStop("end-file", {
      completed: completed,
      progress: completed ? 100 : times.percent,
    });
  })
);
event.on(
  "iina.window-will-close",
  wrap("window-will-close", function () {
    restoreVolumeDuck("window-will-close");
    windowClosing = true;
    markMpvUnavailable();
    stopRuntimeTimers();
    resetSkipIntro();
    hideNowPlayingOverlayNow({ instant: true });
    overlayWarmed = false;
    overlayLoaded = false;
    overlayReady = false;
    sidebarLoaded = false;
    sidebarWebviewReady = false;
    sidebarHandlersBound = false;
    pluginSidebarOpen = false;
    clearOsdHold();
    try {
      if (overlay && typeof overlay.hide === "function") overlay.hide();
    } catch (_error) {}
    return flushStop("window-will-close", { progress: stopProgressSnapshot().percent });
  })
);
event.on(
  "iina.window-did-close",
  wrap("window-did-close", function () {
    windowClosing = true;
    markMpvUnavailable();
    return flushStop("window-did-close", { progress: stopProgressSnapshot().percent });
  })
);
try {
  event.on(
    "mpv.shutdown",
    wrap("shutdown", function () {
      restoreVolumeDuck("shutdown");
      windowClosing = true;
      markMpvUnavailable();
      stopRuntimeTimers();
      return flushStop("mpv.shutdown", { progress: stopProgressSnapshot().percent });
    })
  );
} catch (error) {
  log("mpv.shutdown listener not available: " + errStr(error));
}

registerMenu();
bindUnloadHook();
if (typeof iina !== "undefined") iina.__iinaSimklTeardown = teardownPlugin;
if (__iinaSimklGlobal) __iinaSimklGlobal.__iinaSimklTeardown = teardownPlugin;
log("SIMKL scrobbler ready, auth=" + (simkl.getAuthStatus().connected ? "connected" : simkl.getAuthStatus().state));
queueSidebarRefresh(true);
