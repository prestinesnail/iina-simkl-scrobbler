var DEFAULT_LOCK_MS = 20000;
var DEFAULT_PAUSE_DEBOUNCE_MS = 400;
var DEFAULT_SEEK_DEBOUNCE_MS = 5000;
var DEFAULT_MIN_PROGRESS = 0.5;
var DEFAULT_MIN_SEEK_DELTA = 2;

function cloneSession(session) {
  var source = session || createSession();
  return {
    itemKey: source.itemKey || null,
    phase: source.phase || "idle",
    lastProgress: Number(source.lastProgress || 0),
    lastReportedProgress: Number(
      source.lastReportedProgress != null ? source.lastReportedProgress : source.lastProgress || 0
    ),
    lastSentAt: Number(source.lastSentAt || 0),
    lastSentAction: source.lastSentAction || "",
    pendingAction: source.pendingAction || "",
    pendingAt: Number(source.pendingAt || source.pendingPauseAt || 0),
    pendingProgress: Number(source.pendingProgress || source.pendingPauseProgress || 0),
  };
}

function createSession() {
  return {
    itemKey: null,
    phase: "idle",
    lastProgress: 0,
    lastReportedProgress: 0,
    lastSentAt: 0,
    lastSentAction: "",
    pendingAction: "",
    pendingAt: 0,
    pendingProgress: 0,
  };
}

function optionsFrom(options) {
  var settings = options || {};
  return {
    lockMs: settings.lockMs == null ? DEFAULT_LOCK_MS : Number(settings.lockMs),
    pauseDebounceMs:
      settings.pauseDebounceMs == null
        ? DEFAULT_PAUSE_DEBOUNCE_MS
        : Number(settings.pauseDebounceMs),
    minProgress:
      settings.minProgress == null ? DEFAULT_MIN_PROGRESS : Number(settings.minProgress),
    minSeekDelta:
      settings.minSeekDelta == null ? DEFAULT_MIN_SEEK_DELTA : Number(settings.minSeekDelta),
    seekDebounceMs:
      settings.seekDebounceMs == null ? DEFAULT_SEEK_DEBOUNCE_MS : Number(settings.seekDebounceMs),
  };
}

function clearPending(session) {
  session.pendingAction = "";
  session.pendingAt = 0;
  session.pendingProgress = 0;
}

function locked(session, now, lockMs, action) {
  if (action === "stop") return false;
  if (!session.lastSentAt) return false;
  return now - session.lastSentAt < lockMs;
}

function expectedProgress(session, now, duration, paused, speed) {
  var reported = Number(session.lastReportedProgress || 0);
  if (paused || session.phase === "paused") return reported;
  var sentAt = Number(session.lastSentAt || 0);
  var dur = Number(duration || 0);
  if (!sentAt || dur <= 30) return reported;
  var elapsed = Math.max(0, (now - sentAt) / 1000);
  var rate = Number(speed || 1);
  if (!isFinite(rate) || rate <= 0) rate = 1;
  var expected = reported + (elapsed / dur) * 100 * rate;
  if (expected < 0) return 0;
  if (expected > 100) return 100;
  return expected;
}

function result(session, send) {
  return {
    session: session,
    send: send || null,
  };
}

function sendAction(session, action, progress, now) {
  session.lastSentAt = now;
  session.lastSentAction = action;
  session.lastProgress = progress;
  session.lastReportedProgress = progress;
  if (action === "start") session.phase = "watching";
  else if (action === "pause") session.phase = "paused";
  else session.phase = "idle";
  clearPending(session);
  return result(session, { action: action, progress: progress });
}

function schedule(session, action, progress, now, settings, extraDelay) {
  var unlockAt = session.lastSentAt ? session.lastSentAt + settings.lockMs : now;
  var delayUntil = now + (extraDelay || 0);
  session.pendingAction = action;
  session.pendingProgress = progress;
  session.pendingAt = Math.max(unlockAt, delayUntil);
  if (session.pendingAt <= now && !locked(session, now, settings.lockMs, action)) {
    return sendAction(session, action, progress, now);
  }
  return result(session, null);
}

function decide(session, event, now, options) {
  var next = cloneSession(session);
  var settings = optionsFrom(options);
  var type = event && event.type;
  var itemKey = event && event.itemKey ? String(event.itemKey) : next.itemKey;
  var progress = Number(event && event.progress != null ? event.progress : next.lastProgress);
  if (!isFinite(progress)) progress = 0;
  if (progress < 0) progress = 0;
  if (progress > 100) progress = 100;

  if (type === "progress" || type === "seek") {
    next.lastProgress = progress;
    if (next.pendingAction === "start" || next.pendingAction === "pause") {
      next.pendingProgress = progress;
    }
    return result(next, null);
  }

  if (type === "file-change") {
    var previousKey = event.previousItemKey || next.itemKey;
    var previousProgress =
      event.previousProgress != null ? Number(event.previousProgress) : next.lastProgress;
    if (previousKey && next.phase !== "idle") {
      next.itemKey = previousKey;
      if (locked(next, now, settings.lockMs, "stop")) {
        next.lastProgress = previousProgress;
        return result(next, { action: "stop", progress: previousProgress, deferred: true });
      }
      var stopped = sendAction(next, "stop", previousProgress, now);
      stopped.session.itemKey = itemKey || null;
      stopped.session.phase = "idle";
      stopped.session.lastProgress = 0;
      return stopped;
    }
    next.itemKey = itemKey || null;
    next.phase = "idle";
    next.lastProgress = 0;
    clearPending(next);
    return result(next, null);
  }

  if (type === "tick" || type === "tick-pause-debounce") {
    if (!next.pendingAction || now < next.pendingAt) {
      return result(next, null);
    }
    if (locked(next, now, settings.lockMs, next.pendingAction)) {
      return result(next, null);
    }
    var sendProgress =
      next.lastProgress != null && isFinite(Number(next.lastProgress))
        ? Number(next.lastProgress)
        : next.pendingProgress;
    return sendAction(next, next.pendingAction, sendProgress, now);
  }

  if (!itemKey) {
    return result(next, null);
  }

  if (type === "play") {
    next.itemKey = itemKey;
    next.lastProgress = progress;
    if (next.pendingAction === "pause" && next.phase === "watching") {
      clearPending(next);
      return result(next, null);
    }
    if (next.phase === "watching" && next.lastSentAction === "start") {
      if (next.pendingAction === "start") next.pendingProgress = progress;
      else clearPending(next);
      return result(next, null);
    }
    clearPending(next);
    if (next.phase === "idle") {
      return sendAction(next, "start", progress, now);
    }
    return schedule(next, "start", progress, now, settings, 0);
  }

  if (type === "pause") {
    next.itemKey = itemKey;
    next.lastProgress = progress;
    if (next.phase === "paused" && next.lastSentAction === "pause") {
      clearPending(next);
      return result(next, null);
    }
    if (next.phase !== "watching" && next.phase !== "paused") {
      if (progress < settings.minProgress) {
        return result(next, null);
      }
      next.phase = "watching";
    }
    if (progress < settings.minProgress) {
      return result(next, null);
    }
    return schedule(next, "pause", progress, now, settings, settings.pauseDebounceMs);
  }

  if (type === "stop") {
    next.itemKey = itemKey;
    next.lastProgress = progress;
    clearPending(next);
    if (next.phase === "idle" && next.lastSentAction !== "start" && next.lastSentAction !== "pause") {
      return result(next, null);
    }
    if (event && event.completed) {
      progress = 100;
      next.lastProgress = 100;
    }
    if (locked(next, now, settings.lockMs, "stop")) {
      return result(next, { action: "stop", progress: progress, deferred: true });
    }
    return sendAction(next, "stop", progress, now);
  }

  return result(next, null);
}

function rollback(session, action) {
  var next = cloneSession(session);
  if (action === "start") {
    next.phase = "idle";
    next.lastSentAction = "";
  } else if (action === "pause") {
    next.phase = "watching";
    next.lastSentAction = "start";
  } else if (action === "stop") {
    next.phase = next.lastSentAction === "pause" ? "paused" : "watching";
  }
  next.lastSentAt = 0;
  clearPending(next);
  return next;
}

module.exports = {
  DEFAULT_LOCK_MS: DEFAULT_LOCK_MS,
  DEFAULT_MIN_PROGRESS: DEFAULT_MIN_PROGRESS,
  DEFAULT_MIN_SEEK_DELTA: DEFAULT_MIN_SEEK_DELTA,
  DEFAULT_PAUSE_DEBOUNCE_MS: DEFAULT_PAUSE_DEBOUNCE_MS,
  DEFAULT_SEEK_DEBOUNCE_MS: DEFAULT_SEEK_DEBOUNCE_MS,
  cloneSession: cloneSession,
  createSession: createSession,
  decide: decide,
  expectedProgress: expectedProgress,
  rollback: rollback,
};
