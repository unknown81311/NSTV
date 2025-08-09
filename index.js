// server.js
const express   = require('express');
const axios     = require('axios');
const cheerio   = require('cheerio');
const Parser    = require('rss-parser');
const WebSocket = require('ws');
const http      = require('http');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const parser = new Parser();

// ------------------------
// CONFIG
// ------------------------

// Priority order: index 0 = highest priority
const STREAMERS = [
  { name: 'nickjfuentes' },
  { name: 'joeldavis' },
  { name: 'chaotichermes' },
  { name: 'thelillypad' },
  { name: 'EpicDanger' },
  { name: 'therealtuber' },
  // { name: 'otherStreamer' },
];

// DEFAULT EMBED: includes normal entries and one virtual multi-part entry
const DEFAULT_EMBED = [
  { embedCode: 'v5fw85g', duration: 1662 },
  { embedCode: 'v6rdsa1', duration: 2564 },

  // Virtual video composed of 10 parts — treated as one long video
  {
    parts: [
      { embedCode: "v4qrqb0", duration: 3676 },
      { embedCode: "v4qskxc", duration: 3765 },
      { embedCode: "v4qsxvl", duration: 2393 },
      { embedCode: "v4qvssz", duration: 6398 },
      { embedCode: "v4qy1kq", duration: 3204 },
      { embedCode: "v4qycwe", duration: 3599 },
      { embedCode: "v4qytxc", duration: 4110 },
      { embedCode: "v4ryw8q", duration: 7513 },
      { embedCode: "v4ryx1w", duration: 6970 },
      { embedCode: "v4s31he", duration: 2142 }
    ],
    // sum durations (computed inline)
    duration: 3676 + 3765 + 2393 + 6398 + 3204 + 3599 + 4110 + 7513 + 6970 + 2142
  }
];

// ------------------------
// STATE
// ------------------------

let isLive         = false;   // are we currently in live mode?
let currentCode    = null;    // embed code currently playing (live or fallback part)
let startAtSec     = 0;       // seconds into the current item (for live we use 0)
let fallbackIdx    = null;    // which DEFAULT_EMBED index is the active fallback
let ticker         = null;    // interval ID for fallback time tracking
let currentLiveIdx = null;    // which streamer index is currently live (if isLive)

let savedFallbackState = null; // { fallbackIdx, startAtSec } — used to resume after live

// track last broadcasted embed/part so we only broadcast on changes
let lastEmbedCode = null;
let lastPartIndex = null;

// new: track when a live stream started (Date.now())
let liveStartTimestamp = null; // when a live stream started (ms since epoch)

// ------------------------
// HELPERS
// ------------------------

/**
 * Given a DEFAULT_EMBED entry and total seconds (elapsed into that entry),
 * returns the current part embed code, the part index (0-based) and the offset inside that part.
 *
 * If entry has no .parts (single video), returns embedCode, partIndex = 0 and startAtSec = elapsed.
 */
function getCurrentPartWithIndex(entry, totalSeconds) {
  if (!entry.parts) {
    // single video
    return { embedCode: entry.embedCode, partIndex: 0, startAtSec: Math.floor(totalSeconds) };
  }

  let elapsed = Math.floor(totalSeconds);
  for (let i = 0; i < entry.parts.length; i++) {
    const part = entry.parts[i];
    if (elapsed < part.duration) {
      return { embedCode: part.embedCode, partIndex: i, startAtSec: elapsed };
    }
    elapsed -= part.duration;
  }

  // If out-of-range (shouldn't happen), return first
  return { embedCode: entry.parts[0].embedCode, partIndex: 0, startAtSec: 0 };
}

/**
 * Send update message to all connected WebSocket clients.
 * This is purposely only called when we want clients to switch video/embed,
 * not every second.
 */
function broadcastStateWithStartAt(partStart) {
  const msg = JSON.stringify({
    type: 'update',
    isLive,
    embedCode: currentCode,
    startAtSec: partStart
  });
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ------------------------
// FALLBACK CONTROL
// ------------------------

/**
 * Start or resume fallback playback.
 * If resumeState is provided, resume at that fallbackIdx / startAtSec.
 * Otherwise pick a random fallback index (as before) and start at 0.
 *
 * This function sets up a ticker that increments startAtSec internally every second,
 * but will ONLY broadcast when the embed or part index changes (not every tick).
 */
function startFallback(resumeState = null) {
  // If a resume state was saved, restore it; otherwise pick random fallback index.
  if (resumeState && typeof resumeState.fallbackIdx === 'number') {
    fallbackIdx = resumeState.fallbackIdx;
    startAtSec = resumeState.startAtSec || 0;
  } else if (fallbackIdx === null) {
    fallbackIdx = Math.floor(Math.random() * DEFAULT_EMBED.length);
    startAtSec = 0;
  } else {
    // keep existing fallbackIdx/startAtSec if set
  }

  isLive = false;
  currentLiveIdx = null;

  // When starting fallback we want to force an initial broadcast for clients.
  // Reset last broadcast trackers so the first tick will definitely broadcast.
  lastEmbedCode = null;
  lastPartIndex = null;

  // Clear any existing ticker
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }

  // Immediately choose the correct embed for the current startAtSec and broadcast it.
  const currentFallback = DEFAULT_EMBED[fallbackIdx];
  const { embedCode, partIndex, startAtSec: partStart } = getCurrentPartWithIndex(currentFallback, startAtSec);
  currentCode = embedCode;

  // broadcast the initial fallback part (clients should load this)
  broadcastStateWithStartAt(partStart);
  lastEmbedCode = embedCode;
  lastPartIndex = partIndex;

  console.log(`[FALLBACK START] idx=${fallbackIdx}, embed=${embedCode}, part=${partIndex}, offset=${partStart}s`);

  // Ticker increments the internal 'startAtSec' every second so we know where we are.
  // IMPORTANT: we only broadcast when the underlying embed or part index changes,
  // NOT every second.
  ticker = setInterval(() => {
    startAtSec += 1; // advance the total seconds into the active fallback entry
    const entry = DEFAULT_EMBED[fallbackIdx];

    // If we've reached the end of this fallback entry, move to the next fallback entry
    if (startAtSec >= entry.duration) {
      fallbackIdx = (fallbackIdx + 1) % DEFAULT_EMBED.length;
      startAtSec = 0;

      // Reset last broadcast trackers so a new fallback entry results in an immediate broadcast
      lastEmbedCode = null;
      lastPartIndex = null;

      console.log(`[FALLBACK] cycled to idx=${fallbackIdx}`);
    }

    // Determine which actual part and offset are current
    const activeEntry = DEFAULT_EMBED[fallbackIdx];
    const { embedCode: nowEmbed, partIndex: nowPartIndex, startAtSec: nowPartStart } =
      getCurrentPartWithIndex(activeEntry, startAtSec);

    // Update the global currentCode (so new clients will see the right embed)
    currentCode = nowEmbed;

    // Broadcast ONLY if the embed changed or the part index changed (meaning part boundary crossed)
    if (nowEmbed !== lastEmbedCode || nowPartIndex !== lastPartIndex) {
      // send update to clients to switch to new embed/part
      broadcastStateWithStartAt(nowPartStart);
      lastEmbedCode = nowEmbed;
      lastPartIndex = nowPartIndex;

      console.log(`[FALLBACK] broadcast change -> embed=${nowEmbed}, part=${nowPartIndex}, offset=${nowPartStart}s`);
    }
    // otherwise: same part still playing, do NOT broadcast
  }, 1000);
}

// ------------------------
// LIVE CHECK
// ------------------------

/**
 * Extract embed code from the Rumble item page (based on your previous logic).
 * Returns the embed code string (e.g. 'xyz') or null.
 */
async function fetchLiveEmbed(streamer) {
  try {
    const feed = await parser.parseURL(`http://rssgen.xyz/rumble/${streamer}`);
    const firstItem = feed.items && feed.items[0];
    if (!firstItem) return null;

    // Simple heuristic — many RSS items put 'live' in title when streaming.
    const isLikelyLive = firstItem.title && firstItem.title.toLowerCase().includes('live');
    if (!isLikelyLive) return null;

    const htmlResp = await axios.get(firstItem.link, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' }
    });
    const $ = cheerio.load(htmlResp.data);
    const oembedUrl = $('link[type="application/json+oembed"]').attr('href');
    if (!oembedUrl) return null;

    const embeddedUrl = new URL(oembedUrl).searchParams.get('url');
    if (!embeddedUrl) return null;

    // the path typically looks like '/embed/video/EMBEDCODE' or '/video/EMBEDCODE' etc
    const parts = new URL(embeddedUrl).pathname.split('/').filter(Boolean);
    // choose last segment as embed code
    return parts.length ? parts[parts.length - 1] : null;
  } catch (err) {
    console.error('[LIVE CHECK ERROR]', err.message || err);
    return null;
  }
}

/**
 * Polls streamers in priority order. First live streamer discovered wins.
 * If we transition fallback->live we save the current fallback state so we can resume.
 */
async function pollLive() {
  try {
    for (let i = 0; i < STREAMERS.length; i++) {
      const s = STREAMERS[i];
      const code = await fetchLiveEmbed(s.name);

      if (code) {
        // Found a live streamer (the first found due to loop order is highest-priority live)
        // If we were in fallback, save where we were so we can resume later.
        if (!isLive) {
          savedFallbackState = {
            fallbackIdx: fallbackIdx,
            startAtSec: startAtSec
          };
          console.log(`[SAVE FALLBACK] saved idx=${savedFallbackState.fallbackIdx}, sec=${savedFallbackState.startAtSec}`);
        }

        // If already live on same code, do nothing.
        if (isLive && currentCode === code) {
          // still streaming same live; nothing to do
          currentLiveIdx = i;
          return;
        }

        // Switch into live mode (may be new live stream or promoted higher-priority)
        if (ticker) {
          clearInterval(ticker);
          ticker = null;
        }
        isLive = true;
        currentLiveIdx = i;
        currentCode = code;
        startAtSec = 0; // for live, we use 0 (clients treat live as starting now)
        liveStartTimestamp = Date.now(); // <-- set live start timestamp
        // Reset lastPartIndex because live is not part-indexed fallback content
        lastPartIndex = null;

        // Broadcast the live embed immediately (this is an embed change)
        broadcastStateWithStartAt(0);
        lastEmbedCode = currentCode;

        console.log(`[LIVE START] streamer=${s.name} (priority idx=${i}), embed=${currentCode}`);
        return; // do not check lower-priority streamers
      }
    }

    // If we get here: no streamer was live.
    if (isLive) {
      // We were live before, now all are gone -> resume fallback from saved position
      console.log('[LIVE END] no live streams found, resuming fallback');

      isLive = false;
      currentLiveIdx = null;
      liveStartTimestamp = null; // <-- clear live start timestamp

      // Resume saved fallback if present, otherwise startFallback() picks a random one
      const resume = savedFallbackState || null;
      startFallback(resume);

      // Clear savedFallbackState after resuming (optional)
      savedFallbackState = null;
    }
    // else: not live and already in fallback -> nothing to do
  } catch (err) {
    console.error('[POLL ERROR]', err.message || err);
  }
}

// ------------------------
// WebSocket connections
// ------------------------

// When a client connects we immediately send current state.
// Additionally we log each join (client IP, embed, current video time, and wall-clock timestamp).
wss.on('connection', ws => {
  try {
    // compute playback time for the client (seconds into the current part or live elapsed)
    let videoTimeSec = 0;
    let currentEmbedForLog = currentCode;

    if (isLive) {
      // for live, compute elapsed since live started (fallback code used startAtSec=0 previously)
      if (liveStartTimestamp) {
        videoTimeSec = Math.floor((Date.now() - liveStartTimestamp) / 1000);
      } else {
        videoTimeSec = 0;
      }

      ws.send(JSON.stringify({
        type: 'update',
        isLive: true,
        embedCode: currentCode,
        startAtSec: videoTimeSec // clients treat live as starting now (we provide elapsed)
      }));
    } else {
      // fallback: ensure we have a fallback index
      if (fallbackIdx === null) {
        // fallback hasn't been initialized yet — default to first entry
        fallbackIdx = 0;
        startAtSec = 0;
      }
      const entry = DEFAULT_EMBED[fallbackIdx];
      const { embedCode, startAtSec: partStart } = getCurrentPartWithIndex(entry, startAtSec);
      currentEmbedForLog = embedCode;
      videoTimeSec = partStart;

      ws.send(JSON.stringify({
        type: 'update',
        isLive: false,
        embedCode: embedCode,
        startAtSec: partStart
      }));
    }

    // log the join event: IP (if available), embed, video time, and timestamp
    const clientIp = (ws._socket && ws._socket.remoteAddress) ? ws._socket.remoteAddress : 'unknown';
    console.log(`[JOIN] client=${clientIp} embed=${currentEmbedForLog} videoTime=${videoTimeSec}s at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[WS CONNECT ERR]', err && err.message);
  }
});

// ------------------------
// HTTP & STARTUP
// ------------------------

app.get('/', (req, res) => res.sendFile(__dirname + '/client.html'));
app.use(express.static(__dirname + '/public'));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`[SERVER] listening on http://localhost:${PORT}`);

  // Start fallback initially (no resume state)
  startFallback();

  // Do an immediate poll then poll periodically
  pollLive();
  setInterval(pollLive, 60000); // check every minute
});
