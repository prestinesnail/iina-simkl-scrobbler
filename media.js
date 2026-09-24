var ANIME_ID_KEYS = [
  "mal",
  "anidb",
  "anilist",
  "kitsu",
  "anisearch",
  "animeplanet",
  "livechart",
  "crunchyroll",
];

var REQUEST_ID_KEYS = [
  "simkl",
  "imdb",
  "tmdb",
  "tvdb",
  "mal",
  "anidb",
  "anilist",
  "kitsu",
  "anisearch",
  "animeplanet",
  "livechart",
];

var RESPONSE_ONLY_ID_KEYS = {
  slug: true,
  traktslug: true,
  tvdbslug: true,
  letterboxd: true,
  letterslug: true,
  boxd: true,
  mdlslug: true,
};

function trim(value) {
  return String(value == null ? "" : value).trim();
}

function decodeHtmlEntities(value) {
  var text = String(value == null ? "" : value);
  var named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, function (match, entity) {
    var key = String(entity || "").toLowerCase();
    if (named[key]) return named[key];
    if (key.charAt(0) !== "#") return match;
    var code = key.charAt(1) === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    if (!code || !isFinite(code) || code < 1 || code > 0x10ffff) return match;
    try {
      return String.fromCharCode(code);
    } catch (_error) {
      return match;
    }
  });
}

function cleanTitle(value) {
  return decodeHtmlEntities(trim(value));
}

function toNumber(value, fallback) {
  var number = Number(value);
  return isFinite(number) ? number : fallback;
}

function pad2(value) {
  var text = String(Math.max(0, Math.floor(toNumber(value, 0))));
  while (text.length < 2) text = "0" + text;
  return text;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function stripQueryAndHash(value) {
  return String(value || "").split("#")[0].split("?")[0];
}

function filenameHint(url) {
  var raw = trim(url);
  var hash = raw.indexOf("#");
  if (hash < 0) return "";
  var fragment = decodeURIComponentSafe(raw.slice(hash + 1).replace(/^\/+/, ""));
  fragment = fragment.split("?")[0];
  var parts = fragment.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function extractPath(url) {
  var raw = trim(url);
  if (!raw) return "";

  var hint = filenameHint(raw);
  if (/^file:/i.test(raw)) {
    raw = raw.replace(/^file:\/\//i, "");
    if (/^\/[A-Za-z]:\//.test(raw)) {
      raw = raw.slice(1);
    }
  }

  raw = stripQueryAndHash(raw);
  var path = decodeURIComponentSafe(raw.replace(/\\/g, "/"));
  if (hint) {
    var slash = path.lastIndexOf("/");
    path = (slash >= 0 ? path.slice(0, slash + 1) : "") + hint;
  }
  return path;
}

function extractFilename(url) {
  var hinted = filenameHint(url);
  if (hinted) return hinted;
  var path = extractPath(url);
  if (!path) return "";
  var parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function addSearchQuery(queries, seen, item) {
  var query = trim(item);
  if (!query) return;
  var key = query.toLowerCase();
  if (seen[key]) return;
  seen[key] = true;
  queries.push(query);
}

function cleanedSearchName(name) {
  var parsed = parseTitleFromFilename(name);
  if (!parsed.title) return "";
  var base = parsed.title;
  if (parsed.year) base += " (" + parsed.year + ")";
  var ext = String(name || "").match(/\.[a-z0-9]{2,4}$/i);
  return base + (ext ? ext[0] : ".mkv");
}

function sequelFileQueries(name) {
  var parsed = parseTitleFromFilename(name);
  var hint = parseEpisodeHint(name);
  if (!parsed.title || !hint || hint.season <= 1 || !hint.number) return [];
  var ext = String(name || "").match(/\.[a-z0-9]{2,4}$/i);
  ext = ext ? ext[0] : ".mkv";
  return [
    parsed.title + " S" + pad2(hint.season) + "E" + pad2(hint.number) + ext,
    parsed.title + " Season " + hint.season + ext,
  ];
}

function fileSearchQueries(url) {
  var path = extractPath(url);
  var filename = extractFilename(path);
  var parts = path.split("/").filter(Boolean);
  var parent = parts.length >= 2 ? parts[parts.length - 2] : "";
  var queries = [];
  var seen = {};
  var sequelQueries = sequelFileQueries(filename);
  var s;
  for (s = 0; s < sequelQueries.length; s += 1) addSearchQuery(queries, seen, sequelQueries[s]);
  addSearchQuery(queries, seen, cleanedSearchName(filename));
  addSearchQuery(queries, seen, filename);
  if (parent) {
    addSearchQuery(queries, seen, cleanedSearchName(parent));
    addSearchQuery(queries, seen, parent + "/" + (cleanedSearchName(filename) || filename));
    addSearchQuery(queries, seen, parent + "/" + filename);
  }
  return queries;
}

function lastRegexCapture(text, pattern) {
  var re = new RegExp(pattern, "gi");
  var last = null;
  var match;
  while ((match = re.exec(text))) last = match;
  return last;
}

function extractExternalIds(value) {
  var text = String(value || "");
  var ids = {};
  var imdb =
    lastRegexCapture(text, "\\{imdb[-:]?(tt\\d{7,})\\}") ||
    lastRegexCapture(text, "[{\\[](tt\\d{7,})[}\\]]") ||
    lastRegexCapture(text, "imdb[-:](tt\\d{7,})");
  if (imdb) ids.imdb = String(imdb[1]).toLowerCase();
  var tmdb = lastRegexCapture(text, "\\{tmdb[-:](\\d+)\\}");
  if (tmdb) ids.tmdb = tmdb[1];
  var tvdb = lastRegexCapture(text, "\\{tvdb[-:](\\d+)\\}");
  if (tvdb) ids.tvdb = tvdb[1];
  return ids;
}

function looksLikeStandaloneMovie(filename) {
  var name = String(filename || "");
  if (parseEpisodeHint(name)) return false;
  if (/\b(?:movie|film|gekijouban|the[- ]movie)\b/i.test(name)) return true;
  if (/\((?:19|20)\d{2}\)/.test(name)) return true;
  return false;
}

function isAnimeMovie(item) {
  var type = String((item && (item.animeType || item.type)) || "").toLowerCase();
  return !!(item && item.kind === "anime" && (type === "movie" || type === "film"));
}

function normalizeTitle(value) {
  return trim(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’:]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleWords(value) {
  return String(value || "")
    .split(" ")
    .filter(function (word) {
      return word.length > 2;
    });
}

function titleSimilarity(left, right) {
  var a = normalizeTitle(left);
  var b = normalizeTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  var aWords = titleWords(a);
  var bWords = titleWords(b);
  var longEnough = Math.min(a.length, b.length) >= 12 && aWords.length >= 3 && bWords.length >= 3;
  if (longEnough && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1)) return 0.9;
  if (!aWords.length || !bWords.length) return 0;
  var aHits = 0;
  var bHits = 0;
  var i;
  for (i = 0; i < aWords.length; i += 1) {
    if (b.indexOf(aWords[i]) !== -1) aHits += 1;
  }
  for (i = 0; i < bWords.length; i += 1) {
    if (a.indexOf(bWords[i]) !== -1) bHits += 1;
  }
  var recall = aHits / aWords.length;
  var precision = bHits / bWords.length;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function stripReleaseTags(name) {
  return trim(name)
    .replace(/\]-[A-Za-z0-9]+$/i, "]")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\([^)]*(?:1080|720|2160|480|WEB-?DL|WEBRip|BluRay|HDTV|AAC|x264|x265|HEVC)[^)]*\)/gi, " ");
}

function parseTitleFromFilename(name) {
  var source = stripReleaseTags(trim(name).replace(/\.[a-z0-9]{2,4}$/i, ""));
  if (!source) return { title: "", year: null, episodeTitle: "" };

  var year = null;
  var yearParen = source.match(/\(((?:19|20)\d{2})\)/);
  if (yearParen) {
    year = Number(yearParen[1]);
    source = source.replace(yearParen[0], " ");
  } else {
    var yearToken = source.match(/(?:^|[.\s_-])((?:19|20)\d{2})(?:[.\s_-]|$)/);
    if (yearToken) {
      year = Number(yearToken[1]);
      source = source.replace(yearToken[1], " ");
    }
  }

  var episodeTitle = "";
  var episodeCut = source.search(/S\d{1,2}E\d{1,3}/i);
  if (episodeCut < 0) episodeCut = source.search(/(?:^|[.\s_-])\d{1,2}x\d{1,3}(?:[.\s_-]|$)/i);
  if (episodeCut < 0) episodeCut = source.search(/(?:^|[.\s_-])(?:E|EP)[\s._-]?\d{1,3}(?:[.\s_-]|$)/i);
  if (episodeCut > 0) {
    var rest = source.slice(episodeCut).replace(/^S\d{1,2}E\d{1,3}/i, "").replace(/^\d{1,2}x\d{1,3}/i, "");
    rest = rest.replace(/^[\s._-]+/, "").replace(/\s*-\s*[A-Za-z0-9]+$/, "");
    episodeTitle = sanitizeEpisodeTitle(rest.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim());
    if (episodeTitle.length < 2 || /^(?:WEB|BluRay|HDTV|WEBDL)$/i.test(episodeTitle)) {
      episodeTitle = "";
    }
    source = source.slice(0, episodeCut);
  }

  var title = source
    .replace(/[._]+/g, " ")
    .replace(/\s+-\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    title: title,
    year: year,
    episodeTitle: episodeTitle,
  };
}

function sanitizeEpisodeTitle(value) {
  var text = trim(value);
  if (!text) return "";
  text = text.replace(/^(?:E(?:P(?:isode)?)?[\s._-]*)?\d{1,3}\s*[-–—.]\s+/i, "");
  return trim(text);
}

function isWeakTitle(value) {
  var title = trim(value);
  if (!title) return true;
  if (title.length < 2) return true;
  if (/^[\s.:_\-–—]+$/.test(title)) return true;
  return false;
}

function looksLikeEnglishPhrase(value) {
  var text = trim(value);
  if (!text || /[\u3040-\u30ff\u4e00-\u9faf]/.test(text)) return false;
  var tokens = normalizeTitle(text).split(" ").filter(Boolean);
  var englishCue = { the: 1, of: 1, and: 1, to: 1, from: 1, a: 1, in: 1, for: 1, with: 1, on: 1 };
  var romajiCue = { no: 1, ni: 1, wo: 1, ga: 1, wa: 1, sama: 1, chan: 1, kun: 1, san: 1, gakuin: 1, tensei: 1, musou: 1 };
  var englishHits = 0;
  var romajiHits = 0;
  for (var i = 0; i < tokens.length; i += 1) {
    if (englishCue[tokens[i]]) englishHits += 1;
    if (romajiCue[tokens[i]]) romajiHits += 1;
  }
  if (romajiHits >= 2) return false;
  if (englishHits >= 2) return true;
  return englishHits >= 1 && romajiHits === 0 && tokens.length >= 4;
}

function firstUsableTitle() {
  for (var i = 0; i < arguments.length; i += 1) {
    var title = cleanTitle(arguments[i]);
    if (!isWeakTitle(title)) return title;
  }
  return "";
}

function stripRedundantSeasonSuffix(title) {
  var text = cleanTitle(title);
  if (!text) return "";
  var stripped = text
    .replace(/\s+\d+(?:st|nd|rd|th)\s+season\s*$/i, "")
    .replace(/\s+season\s+\d+\s*$/i, "")
    .replace(/\s+s(?:eason)?\s*0*\d{1,2}\s*$/i, "")
    .replace(/\s+第\d+期\s*$/, "")
    .replace(/[.,;:\-–—]+$/, "")
    .trim();
  return stripped || text;
}

function formatYearLabel(yearStartEnd, year) {
  var range = trim(yearStartEnd);
  if (range) {
    var parts = range.split("-");
    var start = trim(parts[0] || "");
    var end = trim(parts.length > 1 ? parts[1] : "");
    if (start && end) return start + " - " + end;
    if (start) return start;
  }
  if (year) return String(Math.floor(toNumber(year, 0)));
  return "";
}

function collectEnglishTitle(source) {
  if (!source || typeof source !== "object") return "";
  var direct = firstUsableTitle(source.en_title, source.title_en, source.titleEn, source.enTitle);
  if (direct) return stripRedundantSeasonSuffix(direct);
  var alts = source.alt_titles;
  if (Array.isArray(alts)) {
    for (var i = 0; i < alts.length; i += 1) {
      var alt = alts[i];
      if (!alt || typeof alt !== "object") continue;
      var lang = String(alt.lang == null ? alt.language || "" : alt.lang).toLowerCase();
      if (lang === "en" || lang === "eng" || lang === "1" || lang === "2") {
        var named = firstUsableTitle(alt.name, alt.title);
        if (named) return stripRedundantSeasonSuffix(named);
      }
    }
  }
  return "";
}

function normalizeTitleLanguage(value) {
  var language = String(value || "english").toLowerCase();
  if (language === "original" || language === "romaji" || language === "native") return "original";
  return "english";
}

function preferredTitle(item, language) {
  if (!item || !item.matched) return "";
  var mode = normalizeTitleLanguage(language);
  if (mode === "original") {
    return stripRedundantSeasonSuffix(firstUsableTitle(item.title, item.titleRomaji, item.catalogTitle, item.titleEn));
  }
  var english = stripRedundantSeasonSuffix(firstUsableTitle(item.titleEn));
  if (english) return english;
  var fromFile = parseTitleFromFilename(item.filename || "").title;
  if (looksLikeEnglishPhrase(fromFile)) return fromFile;
  return firstUsableTitle(item.title, item.catalogTitle);
}

function applyTitleFallback(match, filename) {
  if (!match || !match.matched) return match;
  var parsed = parseTitleFromFilename(filename || match.filename || "");
  if (isWeakTitle(match.title) && parsed.title) {
    match.title = parsed.title;
  }
  if (!match.year && parsed.year) {
    match.year = parsed.year;
  }
  if (isWeakTitle(match.episodeTitle) && parsed.episodeTitle) {
    match.episodeTitle = parsed.episodeTitle;
  }
  return match;
}

function applyEpisodeFromFilename(match, filename) {
  if (!match || !match.matched) return match;
  var name = String(filename || match.filename || "");
  var hint = parseEpisodeHint(name);
  var values = Object.assign({}, match, {
    filename: name,
    episodeTitle: "",
    episodeIds: {},
  });
  if (match.kind !== "movie" && hint) {
    values.season = hint.season;
    values.number = hint.number;
    values.fileSeason = hint.season;
    values.fileNumber = hint.number;
    values.courChecked = false;
    values.courResolved = false;
  }
  return applyTitleFallback(createMedia(values), name);
}

function parseEpisodeHint(name) {
  var source = trim(name);
  if (!source) return null;

  var seasonEpisode = source.match(/(?:^|[.\s_\-\[(])S(\d{1,2})E(\d{1,3})(?:[.\s_\-\])]|$)/i);
  if (seasonEpisode) {
    return {
      season: Number(seasonEpisode[1]),
      number: Number(seasonEpisode[2]),
      explicitSeason: true,
    };
  }

  var xNotation = source.match(/(?:^|[.\s_\-\[(])(\d{1,2})x(\d{1,3})(?:[.\s_\-\])]|$)/i);
  if (xNotation) {
    return {
      season: Number(xNotation[1]),
      number: Number(xNotation[2]),
      explicitSeason: true,
    };
  }

  var episodeOnly = source.match(/(?:^|[.\s_\-\[(])(?:E|EP|Episode)[\s._-]?(\d{1,3})(?:[.\s_\-\])]|$)/i);
  if (episodeOnly) {
    return {
      season: 1,
      number: Number(episodeOnly[1]),
      explicitSeason: false,
    };
  }

  return null;
}

function progressPercent(position, duration) {
  var pos = toNumber(position, 0);
  var dur = toNumber(duration, 0);
  if (dur <= 0) return 0;
  var value = (pos / dur) * 100;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value * 100) / 100;
}

function trustedDuration(position, duration, previousTrusted) {
  var pos = Math.max(0, toNumber(position, 0));
  var dur = toNumber(duration, 0);
  var trusted = Math.max(0, toNumber(previousTrusted, 0));
  if (dur > trusted && dur > pos + 1) return dur;
  return trusted;
}

function playbackProgress(position, duration, previousTrusted) {
  var pos = Math.max(0, toNumber(position, 0));
  var dur = trustedDuration(position, duration, previousTrusted);
  if (dur <= 0) return 0;
  if (dur <= pos && toNumber(previousTrusted, 0) <= pos) return 0;
  return progressPercent(pos, dur);
}

function isNearEnd(position, duration, previousTrusted) {
  var pos = Math.max(0, toNumber(position, 0));
  var dur = trustedDuration(position, duration, previousTrusted);
  if (dur < 30) return false;
  return dur - pos <= Math.max(12, dur * 0.05);
}

function clampProgress(progress) {
  var value = toNumber(progress, 0);
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value * 100) / 100;
}

function readSimklId(ids) {
  if (!ids || typeof ids !== "object") return 0;
  return Math.floor(toNumber(ids.simkl != null ? ids.simkl : ids.simkl_id, 0));
}

function isAnimeIds(ids) {
  if (!ids || typeof ids !== "object") return false;
  for (var i = 0; i < ANIME_ID_KEYS.length; i += 1) {
    if (trim(ids[ANIME_ID_KEYS[i]])) return true;
  }
  return false;
}

function sanitizeIds(ids) {
  var source = ids && typeof ids === "object" ? ids : {};
  var out = {};
  var simkl = readSimklId(source);
  if (simkl > 0) out.simkl = simkl;

  if (source.tmdb) out.tmdb = String(source.tmdb);
  else if (source.moviedb) out.tmdb = String(source.moviedb);
  else if (source.tmdbtv) out.tmdb = String(source.tmdbtv);

  for (var i = 0; i < REQUEST_ID_KEYS.length; i += 1) {
    var key = REQUEST_ID_KEYS[i];
    if (key === "simkl" || key === "tmdb") continue;
    if (source[key] == null || source[key] === "") continue;
    out[key] = String(source[key]);
  }

  return out;
}

function copyTitleYear(block) {
  var item = {};
  if (block && trim(block.title)) item.title = trim(block.title);
  if (block && block.year) item.year = Math.floor(toNumber(block.year, 0)) || undefined;
  item.ids = sanitizeIds(block && block.ids);
  return item;
}

function episodesHaveTvdb(episodes) {
  if (!Array.isArray(episodes)) return false;
  for (var i = 0; i < episodes.length; i += 1) {
    var episode = episodes[i];
    if (!episode || String(episode.type || "") === "special") continue;
    var tvdb = episode.tvdb;
    if (tvdb && tvdb.season != null && tvdb.episode != null) return true;
  }
  return false;
}

function animeEpisodeForTvdb(episodes, season, number) {
  if (!Array.isArray(episodes)) return null;
  var seasonN = Math.floor(toNumber(season, NaN));
  var numberN = Math.floor(toNumber(number, NaN));
  if (!isFinite(seasonN) || seasonN < 0 || !isFinite(numberN) || numberN < 1) return null;
  for (var i = 0; i < episodes.length; i += 1) {
    var episode = episodes[i];
    if (!episode || String(episode.type || "episode") === "special") continue;
    var tvdb = episode.tvdb;
    if (!tvdb || tvdb.season == null || tvdb.episode == null) continue;
    if (Math.floor(toNumber(tvdb.season, -1)) !== seasonN) continue;
    if (Math.floor(toNumber(tvdb.episode, -1)) !== numberN) continue;
    if (Math.floor(toNumber(episode.episode, 0)) < 1) continue;
    return episode;
  }
  return null;
}

function applyAnimeTvdbEpisode(match, episode, hint) {
  if (!match || !episode) return match;
  var flat = Math.floor(toNumber(episode.episode, 0));
  if (flat < 1) return match;
  var parsed = hint || parseEpisodeHint(match.filename || "");
  var title = sanitizeEpisodeTitle(cleanTitle(episode.title));
  return createMedia(
    Object.assign({}, match, {
      season: parsed && parsed.season ? parsed.season : match.season,
      number: flat,
      fileSeason: parsed && parsed.season ? parsed.season : match.fileSeason,
      fileNumber: parsed && parsed.number ? parsed.number : match.fileNumber,
      episodeTitle: title || match.episodeTitle,
      episodeIds: episode.ids || match.episodeIds || {},
      courChecked: true,
      courResolved: true,
    })
  );
}

function westernTvIds(ids) {
  var source = sanitizeIds(ids);
  var out = {};
  if (source.tvdb) out.tvdb = String(source.tvdb);
  if (source.tmdb) out.tmdb = String(source.tmdb);
  if (source.imdb) out.imdb = String(source.imdb);
  return out;
}

function usesWesternAnimeCoordinates(media) {
  if (!media || media.kind !== "anime" || isAnimeMovie(media) || media.courResolved) return false;
  var hint = parseEpisodeHint(media.filename || "");
  if (!hint || !hint.explicitSeason || !hint.number) return false;
  var ids = westernTvIds(media.ids);
  return !!(ids.tvdb || ids.tmdb || ids.imdb);
}

function scrobbleIds(media) {
  var ids = sanitizeIds(media && media.ids);
  if (!media || media.kind !== "anime") return ids;
  if (!isAnimeIds(ids) && !readSimklId(ids)) return ids;
  var native = {};
  if (readSimklId(ids)) native.simkl = readSimklId(ids);
  for (var i = 0; i < ANIME_ID_KEYS.length; i += 1) {
    var key = ANIME_ID_KEYS[i];
    if (ids[key]) native[key] = ids[key];
  }
  return Object.keys(native).length ? native : ids;
}

function simklSection(kind) {
  if (kind === "movie") return "movies";
  if (kind === "anime") return "anime";
  return "tv";
}

function isSimklHttpsUrl(url) {
  return /^https:\/\/(www\.)?simkl\.com(\/|$)/i.test(String(url || "").trim());
}

function simklItemUrl(kind, ids) {
  var id = readSimklId(ids);
  if (!id) return "https://simkl.com";
  var slug = ids && trim(ids.slug);
  return "https://simkl.com/" + simklSection(kind) + "/" + id + "/" + (slug || "");
}

function posterUrl(path, size) {
  var allowed = { _s: 1, _cm: 1, _c: 1, _ca: 1, _m: 1, _w: 1 };
  var suffix = allowed[size] ? size : "_c";
  var fragment = trim(path);
  if (!fragment || !/^[A-Za-z0-9/_-]+$/.test(fragment)) {
    var ph = suffix === "_s" ? "_s" : "_c";
    return "https://wsrv.nl/?url=https://simkl.in/poster_no_pic" + ph + ".png";
  }
  return "https://wsrv.nl/?url=https://simkl.in/posters/" + fragment + suffix + ".webp&q=90";
}

function formatDuration(totalSeconds) {
  var value = Math.max(0, Math.floor(toNumber(totalSeconds, 0)));
  var hours = Math.floor(value / 3600);
  var minutes = Math.floor((value % 3600) / 60);
  var seconds = value % 60;
  if (hours > 0) {
    return pad2(hours) + ":" + pad2(minutes) + ":" + pad2(seconds);
  }
  return pad2(minutes) + ":" + pad2(seconds);
}

function mediaKindFromMatch(type, ids) {
  if (type === "movie") return "movie";
  if (isAnimeIds(ids)) return "anime";
  return "show";
}

function isEmptyMatch(body) {
  return body == null || (Array.isArray(body) && body.length === 0);
}

function createUnmatched(filename, reason) {
  return {
    matched: false,
    filename: filename || "",
    reason: reason || "no-match",
    kind: "",
    title: "",
    year: null,
    season: null,
    number: null,
    episodeTitle: "",
    ids: {},
    episodeIds: {},
    poster: "",
    url: "",
    source: "search-file",
  };
}

function createMedia(values) {
  var media = values || {};
  var kind = media.kind === "movie" || media.kind === "anime" ? media.kind : "show";
  var ids = sanitizeIds(media.ids);
  var season = media.season == null ? null : Math.floor(toNumber(media.season, 0));
  var number = media.number == null ? null : Math.floor(toNumber(media.number, 0));
  var hinted = parseEpisodeHint(media.filename || "");
  var fileSeason = media.fileSeason != null ? Math.floor(toNumber(media.fileSeason, 0)) : hinted && hinted.season;
  var fileNumber = media.fileNumber != null ? Math.floor(toNumber(media.fileNumber, 0)) : hinted && hinted.number;
  return {
    matched: true,
    filename: media.filename || "",
    reason: "",
    kind: kind,
    title: cleanTitle(media.title),
    titleEn: stripRedundantSeasonSuffix(cleanTitle(media.titleEn)),
    titleRomaji: cleanTitle(media.titleRomaji),
    year: media.year ? Math.floor(toNumber(media.year, 0)) : null,
    yearLabel: trim(media.yearLabel) || formatYearLabel(media.yearStartEnd, media.year),
    season: season && season > 0 ? season : (kind === "movie" ? null : season),
    number: number && number > 0 ? number : (kind === "movie" ? null : number),
    fileSeason: fileSeason && fileSeason > 0 ? fileSeason : null,
    fileNumber: fileNumber && fileNumber > 0 ? fileNumber : null,
    episodeTitle: sanitizeEpisodeTitle(cleanTitle(media.episodeTitle)),
    ids: ids,
    episodeIds: sanitizeIds(media.episodeIds),
    poster: trim(media.poster),
    url: media.url || simklItemUrl(kind, Object.assign({}, ids, { slug: media.slug })),
    slug: trim(media.slug),
    source: media.source || "search-file",
    catalogTitle: cleanTitle(media.catalogTitle),
    animeType: trim(media.animeType),
    trusted: media.trusted !== false && !isWeakTitle(media.catalogTitle || media.title),
    courChecked: media.courChecked === true,
    courResolved: media.courResolved === true,
  };
}

function matchFromSearchFile(body, filename) {
  var name = trim(filename);
  if (isEmptyMatch(body)) {
    return createUnmatched(name, Array.isArray(body) ? "no-match" : "empty-body");
  }

  var parsed = parseTitleFromFilename(name);
  var type = trim(body.type);
  if (type === "movie" && body.movie) {
    return applyTitleFallback(
      createMedia({
        filename: name,
        kind: "movie",
        title: body.movie.title,
        titleEn: collectEnglishTitle(body.movie),
        year: body.movie.year,
        ids: body.movie.ids,
        slug: body.movie.ids && body.movie.ids.slug,
        poster: body.movie.poster,
        source: "search-file",
        catalogTitle: body.movie.title,
        trusted: !isWeakTitle(body.movie.title),
      }),
      name
    );
  }

  var show = body.show || {};
  var episode = body.episode || {};
  var kind = mediaKindFromMatch(type, show.ids);
  var hint = parseEpisodeHint(name);
  var season = episode.season != null ? episode.season : hint && hint.season;
  var number = episode.episode != null ? episode.episode : episode.number != null ? episode.number : hint && hint.number;

  if (type === "show" && !number) {
    return applyTitleFallback(
      createMedia({
        filename: name,
        kind: kind,
        title: show.title,
        titleEn: collectEnglishTitle(show),
        year: show.year,
        ids: show.ids,
        slug: show.ids && show.ids.slug,
        poster: show.poster,
        source: "search-file",
        catalogTitle: show.title,
        trusted: !isWeakTitle(show.title),
      }),
      name
    );
  }

  return applyTitleFallback(
    createMedia({
      filename: name,
      kind: kind,
      title: show.title || parsed.title,
      titleEn: collectEnglishTitle(show),
      year: show.year || parsed.year,
      season: season,
      number: number,
      episodeTitle: episode.title || parsed.episodeTitle,
      ids: show.ids,
      episodeIds: episode.ids,
      slug: show.ids && show.ids.slug,
      poster: show.poster || episode.img,
      source: "search-file",
      catalogTitle: show.title,
      trusted: !isWeakTitle(show.title),
    }),
    name
  );
}

function mediaFromSearchResult(result, filename, hint, options) {
  var item = result || {};
  var settings = options || {};
  var endpoint = trim(item.endpoint_type || item.type);
  var kind = "show";
  if (endpoint === "movies" || endpoint === "movie") kind = "movie";
  else if (endpoint === "anime") kind = "anime";

  var ids = item.ids || {};
  if (ids.simkl_id && !ids.simkl) ids = Object.assign({}, ids, { simkl: ids.simkl_id });

  var parsedHint = hint || parseEpisodeHint(filename);
  return createMedia({
    filename: filename,
    kind: kind,
    title: item.title || item.title_romaji || item.title_en,
    titleEn: collectEnglishTitle(item) || trim(item.title_en),
    titleRomaji: trim(item.title_romaji),
    year: item.year,
    season: kind === "movie" ? null : parsedHint && parsedHint.season,
    number: kind === "movie" ? null : parsedHint && parsedHint.number,
    ids: ids,
    slug: ids.slug,
    poster: item.poster,
    source: settings.source || "search-text",
    catalogTitle: item.title || item.title_en || item.title_romaji,
    trusted: settings.trusted === true,
  });
}

function needsEpisode(media) {
  if (isAnimeMovie(media)) return false;
  return !!(media && (media.kind === "show" || media.kind === "anime") && !media.number);
}

function mediaKey(media) {
  if (!media || !media.matched) return "";
  var id = readSimklId(media.ids);
  var base = media.kind + ":" + (id || trim(media.title).toLowerCase()) + ":" + (media.year || "");
  if (media.kind === "movie") return base;
  return base + ":s" + (media.season || 1) + "e" + (media.number || 0);
}

function displaySeason(item) {
  if (!item) return 1;
  if (item.fileSeason && item.fileNumber && item.number && item.fileNumber === item.number && item.fileSeason !== item.season) {
    return item.fileSeason;
  }
  return item.season || item.fileSeason || 1;
}

function displayNumber(item) {
  if (!item) return 0;
  return item.number || item.fileNumber || 0;
}

function overlayEpisodePill(item) {
  if (!item || item.kind === "movie" || !item.number) return "";
  var number = displayNumber(item);
  if (!number) return "";
  if (item.kind === "anime") return "Ep. " + number;
  return "S" + pad2(displaySeason(item)) + "E" + pad2(number);
}

function overlayPayload(item, language) {
  if (!item || !item.matched) return null;
  var isEpisode = item.kind !== "movie" && !!item.number;
  var season = displaySeason(item);
  var number = displayNumber(item);
  var pill = overlayEpisodePill(item);
  return {
    title: preferredTitle(item, language) || stripRedundantSeasonSuffix(cleanTitle(item.title)) || "",
    kind: item.kind || "",
    year: item.yearLabel || item.year || null,
    season: isEpisode && item.kind !== "anime" ? season : null,
    number: isEpisode ? number : null,
    seasonChip: isEpisode && item.kind !== "anime" ? String(season) : "",
    episodeChip: isEpisode ? String(number) : "",
    episodeCode: pill,
    episodePill: pill,
    episodeTitle: sanitizeEpisodeTitle(cleanTitle(item.episodeTitle)),
    posterUrl: posterUrl(item.poster, "_m"),
    url: item.url || simklItemUrl(item.kind, item.ids),
  };
}

function mediaLabel(item, language) {
  if (!item || !item.matched) return "Unknown title";
  var title = preferredTitle(item, language) || item.title || "Unknown title";
  if (item.kind === "movie") {
    return title + (item.year ? " (" + item.year + ")" : "");
  }
  var code = "S" + pad2(displaySeason(item)) + "E" + pad2(displayNumber(item));
  if (!item.number) {
    return title + (item.year ? " (" + item.year + ")" : "");
  }
  if (item.episodeTitle) return title + " " + code + " — " + item.episodeTitle;
  return title + " " + code;
}

function scrobblePayload(media, progress) {
  if (!media || !media.matched) return null;

  var body = {
    progress: clampProgress(progress),
  };

  if (media.kind === "movie") {
    body.movie = copyTitleYear(media);
    return body;
  }

  if (usesWesternAnimeCoordinates(media)) {
    var hint = parseEpisodeHint(media.filename || "");
    var western = copyTitleYear(media);
    western.ids = westernTvIds(media.ids);
    if (!Object.keys(western.ids).length || !hint) return null;
    body.show = western;
    body.episode = {
      season: hint.season,
      number: hint.number,
    };
    return body;
  }

  var ids = scrobbleIds(media);
  if (!Object.keys(ids).length) return null;

  var block = copyTitleYear(media);
  block.ids = ids;

  if (media.kind === "anime" && (isAnimeIds(ids) || readSimklId(ids))) {
    body.anime = block;
    if (media.number) body.episode = { number: media.number };
    return body;
  }

  body.show = block;
  if (media.number) {
    body.episode = {
      season: media.fileSeason || media.season || 1,
      number: media.number,
    };
  }
  return body;
}

function cacheRecord(media) {
  if (!media) return null;
  if (!media.matched) {
    return {
      matched: false,
      filename: media.filename || "",
      reason: media.reason || "no-match",
      cachedAt: new Date().toISOString(),
    };
  }
  return {
    matched: true,
    filename: media.filename,
    kind: media.kind,
    title: media.title,
    titleEn: media.titleEn,
    titleRomaji: media.titleRomaji,
    year: media.year,
    yearLabel: media.yearLabel,
    season: media.season,
    number: media.number,
    fileSeason: media.fileSeason,
    fileNumber: media.fileNumber,
    episodeTitle: media.episodeTitle,
    ids: media.ids,
    episodeIds: media.episodeIds,
    poster: media.poster,
    slug: media.slug,
    source: media.source,
    catalogTitle: media.catalogTitle,
    animeType: media.animeType || "",
    trusted: media.trusted !== false,
    courChecked: media.courChecked === true,
    courResolved: media.courResolved === true,
    cachedAt: new Date().toISOString(),
  };
}

function mediaFromCache(record, filename) {
  if (!record) return null;
  if (!record.matched) {
    return createUnmatched(filename || record.filename, record.reason || "cached-negative");
  }
  return applyTitleFallback(
    createMedia(Object.assign({}, record, { filename: filename || record.filename })),
    filename || record.filename
  );
}

module.exports = {
  ANIME_ID_KEYS: ANIME_ID_KEYS,
  animeEpisodeForTvdb: animeEpisodeForTvdb,
  applyAnimeTvdbEpisode: applyAnimeTvdbEpisode,
  applyEpisodeFromFilename: applyEpisodeFromFilename,
  episodesHaveTvdb: episodesHaveTvdb,
  applyTitleFallback: applyTitleFallback,
  cacheRecord: cacheRecord,
  clampProgress: clampProgress,
  collectEnglishTitle: collectEnglishTitle,
  createMedia: createMedia,
  createUnmatched: createUnmatched,
  extractExternalIds: extractExternalIds,
  extractFilename: extractFilename,
  extractPath: extractPath,
  fileSearchQueries: fileSearchQueries,
  cleanedSearchName: cleanedSearchName,
  formatDuration: formatDuration,
  isAnimeMovie: isAnimeMovie,
  isAnimeIds: isAnimeIds,
  isEmptyMatch: isEmptyMatch,
  isWeakTitle: isWeakTitle,
  looksLikeEnglishPhrase: looksLikeEnglishPhrase,
  looksLikeStandaloneMovie: looksLikeStandaloneMovie,
  matchFromSearchFile: matchFromSearchFile,
  mediaFromCache: mediaFromCache,
  mediaFromSearchResult: mediaFromSearchResult,
  mediaKey: mediaKey,
  mediaLabel: mediaLabel,
  cleanTitle: cleanTitle,
  decodeHtmlEntities: decodeHtmlEntities,
  displayNumber: displayNumber,
  displaySeason: displaySeason,
  overlayEpisodePill: overlayEpisodePill,
  overlayPayload: overlayPayload,
  formatYearLabel: formatYearLabel,
  stripRedundantSeasonSuffix: stripRedundantSeasonSuffix,
  needsEpisode: needsEpisode,
  pad2: pad2,
  parseEpisodeHint: parseEpisodeHint,
  parseTitleFromFilename: parseTitleFromFilename,
  preferredTitle: preferredTitle,
  normalizeTitleLanguage: normalizeTitleLanguage,
  titleSimilarity: titleSimilarity,
  posterUrl: posterUrl,
  playbackProgress: playbackProgress,
  progressPercent: progressPercent,
  isNearEnd: isNearEnd,
  isSimklHttpsUrl: isSimklHttpsUrl,
  trustedDuration: trustedDuration,
  readSimklId: readSimklId,
  sanitizeIds: sanitizeIds,
  scrobblePayload: scrobblePayload,
  usesWesternAnimeCoordinates: usesWesternAnimeCoordinates,
  westernTvIds: westernTvIds,
  simklItemUrl: simklItemUrl,
};
