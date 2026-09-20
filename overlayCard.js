function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function kindLabel(kind) {
  if (kind === "anime") return "Anime";
  if (kind === "movie") return "Movie";
  return "TV";
}

var FADE_MS = 550;
var OVERLAY_POSITIONS = [
  "top-left",
  "bottom-left",
  "top-right",
  "bottom-right",
  "top-center",
  "top-full",
  "bottom-full",
];
var DEFAULT_OVERLAY_POSITION = "bottom-left";
var DEFAULT_OVERLAY_OFFSET_PX = 24;
var MAX_OVERLAY_OFFSET_PX = 240;

function normalizeOverlayPosition(value) {
  var raw = String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  var i;
  for (i = 0; i < OVERLAY_POSITIONS.length; i += 1) {
    if (OVERLAY_POSITIONS[i] === raw) return raw;
  }
  return DEFAULT_OVERLAY_POSITION;
}

function clampOverlayOffsetPx(value) {
  var n = Math.round(Number(value));
  if (!isFinite(n)) n = DEFAULT_OVERLAY_OFFSET_PX;
  return Math.max(0, Math.min(MAX_OVERLAY_OFFSET_PX, n));
}

function skipCornerForOverlay(position) {
  var pos = normalizeOverlayPosition(position);
  if (pos === "bottom-right") return "bottom-left";
  if (pos === "bottom-full") return "top-right";
  return "bottom-right";
}

function overlayInset(offsetPx, oscClearancePx, edge) {
  var offset = clampOverlayOffsetPx(offsetPx);
  var osc = Math.max(0, Number(oscClearancePx) || 0);
  if (edge === "bottom") return offset + osc + "px";
  return offset + "px";
}

function overlayCSS(options) {
  var fading = !!(options && options.fading);
  var skipFading = !!(options && options.skipFading);
  var fadeSec = FADE_MS / 1000 + "s ease";
  var position = normalizeOverlayPosition(options && options.position);
  var offsetPx = clampOverlayOffsetPx(options && options.offsetPx);
  var osc = Math.max(0, Number(options && options.oscClearance) || 0);
  var skipCorner = skipCornerForOverlay(position);
  var npPos = [];
  var skipPos = [];
  if (position === "top-left") {
    npPos.push("top: " + overlayInset(offsetPx, osc, "top") + ";", "left: " + overlayInset(offsetPx, osc, "left") + ";");
  } else if (position === "top-right") {
    npPos.push("top: " + overlayInset(offsetPx, osc, "top") + ";", "right: " + overlayInset(offsetPx, osc, "right") + ";");
  } else if (position === "top-center") {
    npPos.push(
      "top: " + overlayInset(offsetPx, osc, "top") + ";",
      "left: 50%;",
      "transform: translate(-50%, " + (fading ? "0" : "-8px") + ");"
    );
  } else if (position === "bottom-right") {
    npPos.push(
      "bottom: " + overlayInset(offsetPx, osc, "bottom") + ";",
      "right: " + overlayInset(offsetPx, osc, "right") + ";"
    );
  } else if (position === "top-full") {
    npPos.push(
      "top: " + overlayInset(offsetPx, osc, "top") + ";",
      "left: " + overlayInset(offsetPx, osc, "left") + ";",
      "right: " + overlayInset(offsetPx, osc, "right") + ";"
    );
  } else if (position === "bottom-full") {
    npPos.push(
      "bottom: " + overlayInset(offsetPx, osc, "bottom") + ";",
      "left: " + overlayInset(offsetPx, osc, "left") + ";",
      "right: " + overlayInset(offsetPx, osc, "right") + ";"
    );
  } else {
    npPos.push(
      "bottom: " + overlayInset(offsetPx, osc, "bottom") + ";",
      "left: " + overlayInset(offsetPx, osc, "left") + ";"
    );
  }
  if (skipCorner === "top-left") {
    skipPos.push("top: " + overlayInset(offsetPx, osc, "top") + ";", "left: " + overlayInset(offsetPx, osc, "left") + ";");
  } else if (skipCorner === "top-right") {
    skipPos.push("top: " + overlayInset(offsetPx, osc, "top") + ";", "right: " + overlayInset(offsetPx, osc, "right") + ";");
  } else if (skipCorner === "bottom-left") {
    skipPos.push(
      "bottom: " + overlayInset(offsetPx, osc, "bottom") + ";",
      "left: " + overlayInset(offsetPx, osc, "left") + ";"
    );
  } else {
    skipPos.push(
      "bottom: " + overlayInset(offsetPx, osc, "bottom") + ";",
      "right: " + overlayInset(offsetPx, osc, "right") + ";"
    );
  }
  return [
    "html, body { margin: 0; width: 100%; height: 100%; background: transparent !important; overflow: hidden; }",
    ".content { position: absolute; inset: 0; pointer-events: none; background: transparent; }",
    ".np { position: absolute; " + npPos.join(" ") + " display: flex; align-items: stretch; gap: 16px;",
    (position === "top-full" || position === "bottom-full"
      ? "min-width: 0; max-width: none; width: auto; "
      : "min-width: 520px; max-width: 74vw; ") +
      "padding: 14px 18px 14px 14px; border-radius: 18px; color: #f6f7fb; overflow: hidden;",
    "background: rgba(8, 8, 12, 0.84); border: 1px solid rgba(255,255,255,0.12);",
    "box-shadow: 0 22px 60px rgba(0,0,0,0.55); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
    "opacity: " + (fading ? "0" : "1") + "; transition: opacity " + fadeSec + "; }",
    ".np.visible.fading { opacity: 0; }",
    ".np.visible.fading.peek { opacity: 1; }",
    ".np-poster { width: 86px; height: 128px; object-fit: cover; border-radius: 10px; background: #1a2230; flex: 0 0 auto; display: block; }",
    ".np-copy { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; gap: 8px; }",
    ".np-live { display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px 4px 8px; border: 1.5px solid #3ddc6c;",
    "border-radius: 8px; color: #6ef095; font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }",
    '.np-live[data-state="skipped"] { border-color: #5ad0ff; color: #9ae4ff; }',
    ".np-title { margin: 0; font-size: 26px; font-weight: 700; line-height: 1.15; letter-spacing: -0.03em; }",
    ".np-year { color: rgba(255,255,255,0.48); font-size: 15px; }",
    ".np-ep-pill { display: inline-flex; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(232, 197, 71, 0.85); color: #f0d36a; font-size: 12px; font-weight: 800; letter-spacing: 0.06em; }",
    ".np-ep { margin: 0; color: rgba(255,255,255,0.78); font-size: 15px; }",
    ".np-percent { font-size: 44px; font-weight: 800; color: rgba(255,255,255,0.82); }",
    ".np-percent-label { font-size: 12px; font-weight: 800; letter-spacing: 0.18em; color: rgba(255,255,255,0.42); }",
    ".np-left { font-size: 13px; font-weight: 800; letter-spacing: 0.12em; }",
    ".skip { position: absolute; " + skipPos.join(" ") + " z-index: 3; pointer-events: auto; appearance: none; cursor: pointer;",
    "display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px 8px 12px; border-radius: 8px;",
    "border: 1.5px solid #e8c547; color: #f0d36a; background: rgba(18, 14, 6, 0.82);",
    "box-shadow: 0 0 18px rgba(232, 197, 71, 0.42);",
    "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
    "font-size: 13px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; user-select: none;",
    "opacity: " + (skipFading ? "0.16" : "1") + "; transition: opacity " + fadeSec + ", background 0.15s ease, box-shadow 0.15s ease; }",
    ".skip:hover { background: rgba(36, 28, 10, 0.9); box-shadow: 0 0 22px rgba(232, 197, 71, 0.55); }",
    ".skip-dot { width: 7px; height: 7px; border-radius: 50%; background: #e8c547; box-shadow: 0 0 8px rgba(232, 197, 71, 0.9); }",
  ].join(" ");
}

function chipNumber(value) {
  var n = Math.floor(Number(String(value).replace(/^0+/, "") || 0));
  if (!isFinite(n) || n < 0) n = 0;
  return n;
}

function pad2(value) {
  var n = Math.max(0, Math.floor(Number(value) || 0));
  return n < 10 ? "0" + n : String(n);
}

function episodePillLabel(data) {
  if (!data || data.kind === "movie") return "";
  if (data.episodePill) return String(data.episodePill);
  var ep = chipNumber(data.number != null ? data.number : data.episodeChip);
  if (!ep && data.episodeCode) {
    var match = String(data.episodeCode).match(/E(\d+)/i);
    if (match) ep = chipNumber(match[1]);
  }
  if (!ep) return "";
  if (data.kind === "anime") return "Ep. " + ep;
  var season = chipNumber(data.season != null ? data.season : data.seasonChip);
  if (season > 0) return "S" + pad2(season) + "E" + pad2(ep);
  var code = String(data.episodeCode || "").trim();
  if (code) return code;
  return "Ep. " + ep;
}

function scrobbleChip(scrobble) {
  var status = scrobble || {};
  if (status.status === "waiting" || status.status === "sending") {
    return { label: "Updating", state: status.status === "sending" ? "sending" : "waiting" };
  }
  if (status.status === "succeeded" && status.action === "scrobble") {
    return { label: "Watched", state: "watched" };
  }
  if (status.status === "succeeded" && status.verb === "start") {
    return { label: "Now Watching", state: "watching" };
  }
  if (status.status === "succeeded" && status.verb === "pause") {
    return { label: "Paused", state: "paused" };
  }
  if (status.status === "succeeded" && status.verb === "stop") {
    return { label: "Stopped", state: "stopped" };
  }
  if (status.status === "succeeded") return { label: "Now Watching", state: "watching" };
  if (status.status === "unmatched") return { label: "Unmatched", state: "error" };
  if (status.status === "failed") return { label: "Error", state: "error" };
  if (status.status === "disabled") return { label: "Off", state: "off" };
  if (status.status === "ready") return { label: "Ready", state: "ready" };
  return { label: "", state: "" };
}

function formatElapsed(totalSeconds) {
  var sec = Math.max(0, Math.floor(Number(totalSeconds || 0)));
  if (sec < 60) return "Elapsed " + sec + "s";
  var min = Math.floor(sec / 60);
  var rem = sec % 60;
  if (min < 60) {
    if (!rem) return "Elapsed " + min + "m";
    return "Elapsed " + min + "m " + rem + "s";
  }
  var hours = Math.floor(min / 60);
  min = min % 60;
  if (!min && !rem) return "Elapsed " + hours + "h";
  if (!rem) return "Elapsed " + hours + "h " + min + "m";
  return "Elapsed " + hours + "h " + min + "m " + rem + "s";
}

function formatRemaining(totalSeconds) {
  var value = Math.max(0, Number(totalSeconds || 0));
  if (!isFinite(value)) return "";
  var minutes = Math.max(0, Math.ceil(value / 60));
  var hours = Math.floor(minutes / 60);
  minutes = minutes % 60;
  if (hours > 0) {
    if (minutes) return hours + "H " + minutes + "M LEFT";
    return hours + "H LEFT";
  }
  return minutes + "M LEFT";
}

function nowPlayingHTML(payload) {
  var data = payload || {};
  var poster = escapeHtml(data.posterUrl || "https://wsrv.nl/?url=https://simkl.in/poster_no_pic_c.png");
  var title = escapeHtml(data.title || "Unknown title");
  var chip = scrobbleChip(data.scrobble || data.status);
  var progress = Math.max(0, Math.min(100, Math.round(Number(data.progress || 0))));
  var parts = ['<div class="np" data-clickable>'];
  parts.push('<div class="np-bg"></div><div class="np-wash"></div>');
  parts.push('<img class="np-poster" src="' + poster + '" alt="">');
  parts.push('<div class="np-copy">');
  parts.push('<div class="np-live-row">');
  if (chip.label) {
    parts.push('<span class="np-live" data-state="' + escapeHtml(chip.state) + '">');
    parts.push('<span class="np-live-dot"></span>' + escapeHtml(chip.label) + "</span>");
  }
  if (data.startedLabel) {
    parts.push('<p class="np-started">' + escapeHtml(data.startedLabel) + "</p>");
  }
  parts.push("</div>");
  parts.push('<div class="np-title-row"><p class="np-title">' + title + "</p>");
  if (data.year) parts.push('<p class="np-year">(' + escapeHtml(String(data.year)) + ")</p>");
  parts.push("</div>");
  var ep = episodePillLabel(data);
  if (ep) {
    parts.push('<div class="np-meta">');
    parts.push('<span class="np-ep-pill">' + escapeHtml(ep) + "</span>");
    if (data.episodeTitle) {
      parts.push('<p class="np-ep">' + escapeHtml(data.episodeTitle) + "</p>");
    }
    parts.push("</div>");
  }
  parts.push("</div>");
  parts.push('<div class="np-stats"><div class="np-percent">' + progress + "%</div>");
  parts.push('<div class="np-percent-label">WATCHED</div>');
  if (data.remainingLabel) parts.push('<div class="np-left">' + escapeHtml(data.remainingLabel) + "</div>");
  parts.push("</div></div>");
  return parts.join("");
}

function skipIntroHTML() {
  return (
    '<button class="skip" type="button" data-clickable onclick="iina.postMessage(\'skip-intro\')"><span class="skip-dot"></span><span>Skip Intro</span></button>'
  );
}

function overlayHTML(payload, options) {
  var skip = !!(options && options.skip);
  var parts = [];
  if (payload) parts.push(nowPlayingHTML(payload));
  if (skip) parts.push(skipIntroHTML());
  return parts.join("");
}

module.exports = {
  DEFAULT_OVERLAY_OFFSET_PX: DEFAULT_OVERLAY_OFFSET_PX,
  DEFAULT_OVERLAY_POSITION: DEFAULT_OVERLAY_POSITION,
  FADE_MS: FADE_MS,
  MAX_OVERLAY_OFFSET_PX: MAX_OVERLAY_OFFSET_PX,
  OVERLAY_POSITIONS: OVERLAY_POSITIONS,
  clampOverlayOffsetPx: clampOverlayOffsetPx,
  escapeHtml: escapeHtml,
  normalizeOverlayPosition: normalizeOverlayPosition,
  skipCornerForOverlay: skipCornerForOverlay,
  formatElapsed: formatElapsed,
  formatRemaining: formatRemaining,
  kindLabel: kindLabel,
  episodePillLabel: episodePillLabel,
  overlayCSS: overlayCSS,
  overlayHTML: overlayHTML,
  scrobbleChip: scrobbleChip,
  skipIntroHTML: skipIntroHTML,
};
