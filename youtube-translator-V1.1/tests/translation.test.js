const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const settingsModule = require(path.join(root, "settings.js"));

function loadSidepanelHelpers({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sessionStorage = {};
  const localStorage = {};
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      storage: {
        local: {
          get: async (key) => ({ [key]: localStorage[key] }),
          set: async (values) => Object.assign(localStorage, values),
        },
        session: {
          get: async (key) => ({ [key]: sessionStorage[key] }),
          set: async (values) => Object.assign(sessionStorage, values),
        },
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: settingsModule,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  sidePanel = {
    setPanelBehavior() {},
    setOptions: () => Promise.resolve(),
  },
  tabsQuery = async () => [],
  tabsReload = async () => {},
  executeScript = async () => [],
  storageSeed = {},
} = {}) {
  const listeners = { addListener() {} };
  const localStorage = { ytd_settings: settings, ...storageSeed };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (key === null) return { ...localStorage };
            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((item) => [item, localStorage[item]]));
            }
            return { [key]: localStorage[key] };
          },
          set: async (values) => Object.assign(localStorage, values),
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStorage[key];
            }
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel,
      runtime: {
        id: "test",
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      scripting: { executeScript },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        query: tabsQuery,
        reload: tabsReload,
      },
    },
    YTD_SETTINGS: settingsModule,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

test("non-YouTube tabs explicitly close before their panel is disabled", async () => {
  const calls = [];
  const background = loadBackgroundHelpers({
    sidePanel: {
      setPanelBehavior() {},
      close: async (options) => calls.push(["close", options]),
      setOptions: async (options) => calls.push(["setOptions", options]),
    },
  });

  await background.updatePanelForTab(17, "https://example.com/page", 4);

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["close", { tabId: 17 }],
    ["setOptions", { tabId: 17, enabled: false }],
  ]);
});

test("extension reload refreshes open YouTube tabs", async () => {
  const reloaded = [];
  const { recoverYouTubeContentScripts } = loadBackgroundHelpers({
    tabsQuery: async () => [
      { id: 11, url: "https://www.youtube.com/watch?v=one" },
      { id: 12, url: "https://www.youtube.com/watch?v=two" },
      { id: undefined, url: "https://www.youtube.com/" },
    ],
    tabsReload: async (tabId) => {
      reloaded.push(tabId);
    },
  });

  await recoverYouTubeContentScripts();

  assert.deepEqual(reloaded, [11, 12]);
});

test("background authorizes actions by extension and YouTube sender context", () => {
  const { isAuthorizedMessage } = loadBackgroundHelpers();
  const extensionSender = {
    id: "test",
    url: "chrome-extension://test/sidepanel.html",
  };
  const youtubeSender = {
    id: "test",
    url: "https://www.youtube.com/watch?v=video123",
  };
  const untrustedSender = {
    id: "other-extension",
    url: "https://www.youtube.com/watch?v=video123",
  };

  assert.equal(isAuthorizedMessage("fetchTranscript", extensionSender), true);
  assert.equal(
    isAuthorizedMessage("fetchTranscript", youtubeSender),
    false,
  );
  assert.equal(isAuthorizedMessage("saveNote", youtubeSender), true);
  assert.equal(
    isAuthorizedMessage("explainSelection", youtubeSender),
    true,
  );
  assert.equal(
    isAuthorizedMessage("deleteNote", youtubeSender),
    false,
  );
  assert.equal(isAuthorizedMessage("saveNote", untrustedSender), false);
  assert.equal(
    isAuthorizedMessage("fetchTranscript", {
      id: "test",
      url: "https://example.com/",
    }),
    false,
  );
});

test("Supadata cue timing keeps sub-second precision", () => {
  const source = read("background.js");
  assert.match(source, /SUPADATA_TRANSCRIPT_CHUNK_SIZE = 96/);
  assert.match(source, /searchParams\.set\(\s*"chunkSize"/);
  assert.match(source, /Number\(chunk\.offset \|\| 0\) \/ 1000/);
  assert.match(source, /Number\(chunk\.duration \|\| 0\) \/ 1000/);
  assert.doesNotMatch(
    source,
    /Math\.floor\(\(chunk\.offset \|\| 0\) \/ 1000\)/,
  );
});

test("video metadata is bounded before prompts and UI rendering", () => {
  const { normalizeVideoMetadata } = loadBackgroundHelpers();
  const normalized = normalizeVideoMetadata({
    title: "t".repeat(1000),
    channelName: "c".repeat(1000),
    description: "d".repeat(10000),
    duration: 999999999,
  });

  assert.equal(normalized.title.length, 500);
  assert.equal(normalized.channelName.length, 300);
  assert.equal(normalized.description.length, 5000);
  assert.equal(normalized.duration, 12 * 60 * 60);
});

test("a global panel closes by window when the tab close is rejected", async () => {
  const calls = [];
  const background = loadBackgroundHelpers({
    sidePanel: {
      setPanelBehavior() {},
      close: async (options) => {
        calls.push(["close", options]);
        if (options.tabId) throw new Error("Global panel");
      },
      setOptions: async (options) => calls.push(["setOptions", options]),
    },
  });

  await background.updatePanelForTab(17, "https://example.com/page", 4);

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["close", { tabId: 17 }],
    ["close", { windowId: 4 }],
    ["setOptions", { tabId: 17, enabled: false }],
  ]);
});

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    fireActive(delay) {
      const match = [...timers.entries()].find(
        ([, timer]) => timer.active && timer.delay === delay,
      );
      assert.ok(match, `Expected an active ${delay}ms timer`);
      match[1].active = false;
      match[1].callback();
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && timer.delay === delay,
      ).length;
    },
    createdCount(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay).length;
    },
  };
}

function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  let index = 0;
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
  };
}

const encode = (value) => new TextEncoder().encode(value);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("the header exposes one universal language control for all result tabs", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /id="transcriptModeControl"[\s\S]*aria-label="Content language"/);
  assert.match(html, /id="transcriptModeControl"[\s\S]*id="tabsNav"/);
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>Original</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  assert.match(js, /handleDisplayLanguageModeChange\(button\.dataset\.transcriptMode\)/);
  assert.match(js, /contentType: "transcriptBatch"/);
  assert.match(js, /contentType: "interfaceBatch"/);
  assert.match(js, /translateOverviewContent/);
  assert.match(js, /translateNotesContent/);
  assert.doesNotMatch(js, /English \+ Chinese/);
  assert.doesNotMatch(`${html}\n${js}`, /From video subtitles/);
});

test("the side panel exposes persisted 10%-200% player caption sizes", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  const { normalizePlayerCaptionFontScale } = loadSidepanelHelpers();

  assert.match(html, /id="captionScaleControl"/);
  assert.match(html, /id="captionScaleSelect"/);
  assert.match(html, /value="0\.1">10%/);
  assert.match(html, /value="1" selected>100%/);
  assert.match(html, /value="2">200%/);
  assert.match(js, /ytd_player_caption_font_scale/);
  assert.match(js, /setPlayerBilingualCaptionScale/);
  assert.equal(normalizePlayerCaptionFontScale("1.25"), 1.25);
  assert.equal(normalizePlayerCaptionFontScale("0.3"), 1);
  assert.equal(normalizePlayerCaptionFontScale("3"), 1);
});

test("new videos default to Original while returning videos restore their choice", async () => {
  const { loadDisplayLanguageMode, saveDisplayLanguageMode } =
    loadSidepanelHelpers();

  await saveDisplayLanguageMode("video-a", "bilingual");
  assert.equal(await loadDisplayLanguageMode("video-a"), "bilingual");
  assert.equal(await loadDisplayLanguageMode("unseen-video"), "original");
});

test("Overview shares the Transcript batch generation and retries when opened", () => {
  const js = read("sidepanel.js");
  const transcriptFunction = js.match(
    /async function translateTranscript\(\)[\s\S]*?\n}\n\nfunction setTranslatingSpinner/,
  )?.[0];

  assert.ok(transcriptFunction);
  assert.doesNotMatch(transcriptFunction, /translationGeneration \+= 1/);
  assert.match(js, /const TRANSLATION_BATCH_SIZE = 3/);
  assert.match(
    js,
    /const batch = missing\.slice\(start, start \+ TRANSLATION_BATCH_SIZE\)[\s\S]*?rerender\(\);[\s\S]*?await updateCache\(\)/,
  );
  assert.match(
    js,
    /tabName === "overview"[\s\S]*?currentAnalysis[\s\S]*?currentTranscriptMode !== "original"[\s\S]*?translateOverviewContent\(\)/,
  );
  assert.match(
    js,
    /Translate only the visible tab[\s\S]*?tabName === "notes"[\s\S]*?translateNotesContent\(\)/,
  );
  assert.match(
    js,
    /activeTabName === "overview"[\s\S]*?translateOverviewContent\(\)[\s\S]*?activeTabName === "notes"[\s\S]*?translateNotesContent\(\)[\s\S]*?activeTabName === "transcript"[\s\S]*?translateTranscript\(\)/,
  );
});

test("transcript reading position survives a side panel close", async () => {
  const { saveTranscriptViewState, loadTranscriptViewState } =
    loadSidepanelHelpers();

  await saveTranscriptViewState("video-a", 427.5);
  const restored = await loadTranscriptViewState("video-a");

  assert.deepEqual(JSON.parse(JSON.stringify(restored)), {
    videoId: "video-a",
    scrollTop: 427.5,
  });
});

test("selected transcript notes keep exact text and row timestamp", async () => {
  const providerMustNotRun = async () => {
    throw new Error("Selected note must not call a provider");
  };
  const { handleSaveNote } = loadBackgroundHelpers({
    fetchImpl: providerMustNotRun,
  });

  const result = await handleSaveNote(
    "video123",
    92.9,
    "Test video",
    "Test channel",
    "  The selected words stay exact.  ",
  );

  assert.equal(result.success, true);
  assert.equal(result.note.text, "The selected words stay exact.");
  assert.equal(result.note.rawText, "The selected words stay exact.");
  assert.equal(result.note.timestamp, "1:32");
  assert.equal(result.note.timestampSeconds, 92);
  assert.equal(
    result.note.timestampedUrl,
    "https://www.youtube.com/watch?v=video123&t=92s",
  );
});

test("transcript labels preserve millisecond precision", () => {
  const { formatTranscriptTimestamp } = loadSidepanelHelpers();
  assert.equal(formatTranscriptTimestamp(79.456), "1:19.456");
  assert.equal(formatTranscriptTimestamp(0.05), "0:00.050");
});

test("overview quote notes reuse the quote text without an AI cleanup call", () => {
  const sidepanel = read("sidepanel.js");
  assert.match(
    sidepanel,
    /function saveQuoteAsNote\([\s\S]*action: "saveNote"[\s\S]*selectedText: quote\.quote/,
  );
});

test("well-punctuated timestamp notes skip AI cleanup", async () => {
  const providerMustNotRun = async () => {
    throw new Error("Clean note should not call a provider");
  };
  const { handleSaveNote } = loadBackgroundHelpers({
    fetchImpl: providerMustNotRun,
    storageSeed: {
      digest_video123: {
        transcript: [
          { start: 0, duration: 3, text: "This is already a clean sentence." },
        ],
        timestamp: Date.now(),
      },
    },
  });

  const result = await handleSaveNote(
    "video123",
    0,
    "Test video",
    "Test channel",
  );

  assert.equal(result.success, true);
  assert.equal(result.note.text, "This is already a clean sentence.");
});

test("saved-note links are rebuilt from validated video IDs", () => {
  const { getSafeTimestampedNoteUrl } = loadSidepanelHelpers();

  assert.equal(
    getSafeTimestampedNoteUrl({
      videoId: "ydTeb_I0b94",
      timestampSeconds: 92.9,
      timestampedUrl: "javascript:alert(1)",
    }),
    "https://www.youtube.com/watch?v=ydTeb_I0b94&t=92s",
  );
  assert.equal(
    getSafeTimestampedNoteUrl({
      videoId: "bad/id",
      timestampSeconds: 10,
      timestampedUrl: "https://example.com/",
    }),
    "",
  );
});

test("semantic segmentation rebuilds sentences across caption boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "Caption boundaries should" },
      { start: 2, text: "not break a complete sentence." },
      { start: 5, text: "The next thought also" },
      { start: 7, text: "stays together!" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(
    segments[0].text,
    "Caption boundaries should not break a complete sentence.",
  );
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].text, "The next thought also stays together!");
  assert.equal(segments[1].start, 5);
});

test("dense auto-caption punctuation is preserved until contextual restore", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      {
        start: 0,
        text: "so, what, do, you, do, here, in, Bali exactly, known, as, the, island, of, gods,",
      },
      {
        start: 8,
        text: "for its, Rich, culture, and, many, temples, but also, known, as, the, island of, digital Nomads, in,",
      },
      {
        start: 16,
        text: "areas, like, chenu, tens, of, thousands, of, xats, flock, to, experience the, best, gyms,",
      },
    ],
    { minChars: 1, idealChars: 500, maxChars: 2000, maxSeconds: 60 },
  );

  assert.equal(segments.length, 1);
  assert.match(segments[0].text, /so, what, do, you/);
  assert.match(segments[0].text, /what, do, you, do, here, in, Bali/);
});

test("background flags dense auto-caption punctuation without deleting it", () => {
  const { analyzeParsedTranscript } = loadBackgroundHelpers();
  const transcript = [
    {
      start: 0,
      duration: 8,
      text: "so, what, do, you, do, here, in, Bali exactly, known, as, the, island, of, gods,",
    },
    {
      start: 8,
      duration: 8,
      text: "for its, Rich, culture, and, many, temples, but also, known, as, the, island of, digital Nomads, in,",
    },
    {
      start: 16,
      duration: 8,
      text: "areas, like, chenu, tens, of, thousands, of, xats, flock, to, experience the, best, gyms,",
    },
  ];
  const plain = transcript.map((entry) => entry.text).join(" ");
  const timestamped = transcript
    .map((entry, index) => `[0:${String(index * 8).padStart(2, "0")}] ${entry.text}`)
    .join("\n");
  const result = analyzeParsedTranscript(transcript, plain, timestamped);

  assert.equal(result.needsPunctuationRestore, true);
  assert.match(result.transcriptText, /,\s*/);
  assert.equal(result.transcriptTextTimestamped.split("\n").length, 3);
  assert.match(result.transcriptTextTimestamped, /,\s*/);
});

test("transcript cleanup restores punctuation while preserving timestamps", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url) => {
      if (url.startsWith("chrome-extension://")) {
        return {
          ok: true,
          text: async () => read("prompts/transcript-cleanup.md"),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  "[0:00] So, what do you do here in Bali?\n" +
                  "[0:08] It is known as the island of gods.",
              },
            },
          ],
        }),
      };
    },
  });
  const entries = [
    {
      start: 0,
      text: "so, what, do, you, do, here, in, Bali",
    },
    {
      start: 8,
      text: "it is, known, as, the, island, of, gods,",
    },
  ];
  const result = await helpers.handleEnhanceTranscript(
    entries.map((entry) => `[0:${String(entry.start).padStart(2, "0")}] ${entry.text}`).join("\n"),
    entries,
    "Bali video",
    "A video about Bali.",
  );

  assert.equal(result.success, true);
  assert.equal(result.enhancedTranscript.length, 2);
  assert.equal(
    result.enhancedTranscript[0].text,
    "So, what do you do here in Bali?",
  );
  assert.match(result.enhancedTranscript[1].text, /island of gods\.$/);
});

test("cleaned transcript output aligns by timestamp and preserves fallbacks", () => {
  const helpers = loadBackgroundHelpers();
  const parsed = helpers.parseTimestampedTranscript(
    "[0:00] So, what do you do here in Bali?\n[1:02] Natural punctuation.",
  );
  const aligned = helpers.alignCleanedTranscript(
    [
      { start: 0, text: "so, what, do, you, do, here, in, Bali" },
      { start: 30, text: "missing cleaned line" },
      { start: 62, text: "natural, punctuation," },
    ],
    parsed,
  );

  assert.equal(parsed.length, 2);
  assert.equal(aligned[0].text, "So, what do you do here in Bali?");
  assert.equal(aligned[1].text, "missing cleaned line");
  assert.equal(aligned[2].text, "Natural punctuation.");
});

test("a huge raw Supadata entry is split into seekable bounded segments", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const segments = groupTranscriptEntries([
    { start: 12, duration: 90, text },
  ]);
  assert.ok(segments.length > 8);
  assert.ok(segments.every((segment) => segment.text.length <= 384));
  assert.equal(segments[0].start, 12);
  assert.ok(segments.at(-1).start > segments[0].start);
  assert.ok(segments.every((segment) => /^segment-\d+-\d+$/.test(segment.id)));
});

test("Chinese sentence and clause punctuation creates semantic guardrails", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "这是一个被字幕切开的" },
      { start: 2, text: "完整句子。这是第二个想法，" },
      { start: 5, text: "也应该保持语义完整！" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "这是一个被字幕切开的完整句子。");
  assert.equal(segments[1].text, "这是第二个想法，也应该保持语义完整！");
});

test("structured translation batches align by stable ID and expose missing fallback", () => {
  const sidepanel = loadSidepanelHelpers();
  const background = loadBackgroundHelpers();
  const source = [
    { id: "segment-0-0", text: "A complete first sentence." },
    { id: "segment-1-5000", text: "A complete second sentence." },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.validateTranscriptBatchRequest({ segments: source }))),
    source,
  );

  const normalized = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        { id: "unknown", text: "\u5ffd\u7565" },
        { id: "segment-1-5000", text: "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002" },
      ],
    },
    source,
  );
  const aligned = sidepanel.alignTranslatedSegmentBatch(
    source,
    normalized.segments,
  );
  assert.equal(aligned[0].id, source[0].id);
  assert.equal(aligned[0].text, "");
  assert.match(aligned[0].error, /unavailable/i);
  assert.equal(aligned[1].text, "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002");
});

test("translation batches preserve player display-unit alignment", () => {
  const sidepanel = loadSidepanelHelpers();
  const background = loadBackgroundHelpers();
  const source = [
    {
      id: "segment-0-0",
      text: "First display sentence. Second display sentence.",
      displayUnits: [
        { id: "player-1::segment-0-0", text: "First display sentence." },
        { id: "player-2::segment-0-0", text: "Second display sentence." },
      ],
    },
  ];

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        background.validateTranscriptBatchRequest({ segments: source }),
      ),
    ),
    source,
  );

  const normalized = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        {
          id: "segment-0-0",
          text: "\u7b2c\u4e00\u53e5\u3002\u7b2c\u4e8c\u53e5\u3002",
          source: "First display sentence. Second display sentence.",
          displayUnits: [
            {
              id: "player-1::segment-0-0",
              text: "\u7b2c\u4e00\u53e5\u3002",
            },
            {
              id: "player-2::segment-0-0",
              text: "\u7b2c\u4e8c\u53e5\u3002",
            },
          ],
        },
      ],
    },
    source,
  );
  const aligned = sidepanel.alignTranslatedSegmentBatch(
    source,
    normalized.segments,
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(aligned[0].displayUnits)),
    [
      {
        id: "player-1::segment-0-0",
        text: "\u7b2c\u4e00\u53e5\u3002",
      },
      {
        id: "player-2::segment-0-0",
        text: "\u7b2c\u4e8c\u53e5\u3002",
      },
    ],
  );
});

test("translation restores punctuation only when source words stay unchanged", () => {
  const background = loadBackgroundHelpers();
  const source = [
    {
      id: "segment-0-0",
      text: "so, what, do, you, do, here, in, Bali",
    },
  ];
  const restored = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        {
          id: "segment-0-0",
          text: "\u90a3\u4e48\uff0c\u4f60\u5728\u5df4\u5398\u5c9b\u505a\u4ec0\u4e48\uff1f",
          source: "So, what do you do here in Bali?",
        },
      ],
    },
    source,
  );
  const unsafe = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        {
          id: "segment-0-0",
          text: "\u90a3\u4e48\uff0c\u4f60\u5728\u5df4\u5398\u5c9b\u505a\u4ec0\u4e48\uff1f",
          source: "So, what do you do here in Bali? This adds words.",
        },
      ],
    },
    source,
  );

  assert.equal(restored.segments[0].source, "So, what do you do here in Bali?");
  assert.equal(unsafe.segments[0].source, source[0].text);
});

test("translated-only omits English while bilingual renders aligned English and Chinese", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const segment = { id: "segment-0-0", text: "Original English sentence." };
  const translatedOnly = renderTranscriptSegmentContent(
    segment,
    "zh",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  const bilingual = renderTranscriptSegmentContent(
    segment,
    "bilingual",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  assert.doesNotMatch(translatedOnly, /Original English sentence/);
  assert.match(translatedOnly, /\u4e2d\u6587\u8bd1\u6587/);
  assert.match(bilingual, /transcript-original/);
  assert.match(bilingual, /Original English sentence/);
  assert.match(bilingual, /\u4e2d\u6587\u8bd1\u6587/);
});

test("subtitle formatting tags render in original and translated segment text", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const html = renderTranscriptSegmentContent(
    {
      id: "segment-0-0",
      text: "Think <i>deeply</i>, <b>carefully</b>, and <u>clearly</u>.<br>Next line.",
    },
    "bilingual",
    "\u5b57\u5730<i>\u601d\u8003</i>\u7684\u3002<strong>\u91cd\u70b9</strong>",
    "",
  );

  assert.match(html, /Think <i>deeply<\/i>/);
  assert.match(html, /<b>carefully<\/b>/);
  assert.match(html, /<u>clearly<\/u>\.<br>Next line/);
  assert.match(html, /\u5b57\u5730<i>\u601d\u8003<\/i>\u7684\u3002<strong>\u91cd\u70b9<\/strong>/);
});

test("subtitle markup renderer keeps attributed and arbitrary HTML escaped", () => {
  const { renderSubtitleInlineMarkup } = loadSidepanelHelpers();
  const html = renderSubtitleInlineMarkup(
    '<img src=x onerror="alert(1)"><i onclick="alert(2)">unsafe</i><script>alert(3)</script>',
  );

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;i onclick=&quot;alert\(2\)&quot;&gt;unsafe<\/i>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b|<i\s+onclick|<script\b/);
});

test("background rejects unsupported language fallthrough and malformed batches", () => {
  const source = read("background.js");
  const { validateTranscriptBatchRequest } = loadBackgroundHelpers();
  assert.match(source, /targetLanguage !== "zh"/);
  assert.match(source, /\["transcriptBatch", "interfaceBatch"\]/);
  assert.throws(
    () => validateTranscriptBatchRequest({ segments: [] }),
    /1 to 4 segments/,
  );
  assert.throws(
    () =>
      validateTranscriptBatchRequest({
        segments: [
          { id: "duplicate", text: "first" },
          { id: "duplicate", text: "second" },
        ],
      }),
    /unique and stable/,
  );
});

test("all AI product requests use DeepSeek non-thinking and JSON behavior", async () => {
  const deepSeekRequests = [];
  const successfulFetch = (requests) => async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated" } }],
      }),
    };
  };

  const deepSeek = loadBackgroundHelpers({
    fetchImpl: successfulFetch(deepSeekRequests),
  });
  const deepSeekResult = await deepSeek.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(deepSeekResult.text, "translated");
  assert.deepEqual(deepSeekRequests[0].thinking, { type: "disabled" });
  assert.deepEqual(deepSeekRequests[0].response_format, {
    type: "json_object",
  });

  const backgroundSource = read("background.js");
  assert.equal(
    (backgroundSource.match(/await requestAiCompletion\(\{/g) || []).length,
    5,
  );
  assert.doesNotMatch(backgroundSource, /disableThinking/);
  for (const callPath of [
    "handleAnalyzeTranscript",
    "enhanceSingleChunk",
    "cleanupNoteText",
    "handleExplainSelection",
    "callAiTranslation",
  ]) {
    assert.match(
      backgroundSource,
      new RegExp(`async function ${callPath}\\([\\s\\S]*?requestAiCompletion\\(\\{`),
    );
  }
});

test("identical AI requests reuse the in-memory response cache", async () => {
  let requestCount = 0;
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "cached result" } }],
        }),
      };
    },
  });
  const request = {
    maxTokens: 128,
    messages: [{ role: "user", content: "Same request." }],
  };

  const first = await helpers.requestAiCompletion(request);
  const second = await helpers.requestAiCompletion(request);

  assert.equal(first.text, "cached result");
  assert.equal(second.text, "cached result");
  assert.equal(requestCount, 1);
});

test("blank-line chunks reset provider idle timeout and valid JSON succeeds", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async () =>
      streamingResponse([
        encode("\n"),
        encode("\n"),
        encode('{"choices":[{"message":{"content":"translated"}}]}'),
      ]),
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "translated");
  assert.equal(timers.createdCount(50_000), 5);
  assert.equal(timers.activeCount(50_000), 0);
  assert.equal(timers.activeCount(120_000), 0);
});

test("provider idle silence aborts with a distinct Retry-able error", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }),
      },
    }),
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  timers.fireActive(50_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_IDLE_TIMEOUT");
  assert.match(result.error, /inactive for 50 seconds.*Retry/i);
  assert.equal(timers.activeCount(120_000), 0);
});

test("blank-line keepalives cannot evade the provider hard cap", async () => {
  const timers = createFakeTimers();
  let releaseRead;
  let signal;
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve, reject) => {
                releaseRead = () => resolve({ done: false, value: encode("\n") });
                signal.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                }, { once: true });
              }),
          }),
        },
      };
    },
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  releaseRead();
  await nextTurn();
  releaseRead();
  await nextTurn();
  assert.equal(timers.activeCount(50_000), 1);
  timers.fireActive(120_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_HARD_TIMEOUT");
  assert.match(result.error, /120-second limit.*Retry/i);
  assert.equal(timers.activeCount(50_000), 0);
});

test("provider response reader accepts leading whitespace before JSON", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([
        encode('  \n\t{"choices":[{"message":{"content":"ok"}}]}'),
      ]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "ok");
});

test("provider response reader rejects bodies over 2 MiB", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([new Uint8Array(2 * 1024 * 1024 + 1)]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RESPONSE_TOO_LARGE");
  assert.match(result.error, /2 MiB limit/);
});

test("DeepSeek retries one empty transcript JSON response without response_format", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: requests.length === 1
                ? ""
                : '{"segments":[{"id":"segment-0-0","text":"\u4e2d\u6587\u8bd1\u6587\u3002"}]}',
            },
          }],
        }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "English source sentence." }] },
    "transcriptBatch",
    "zh",
    "Video",
  );
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
  assert.equal(requests[0].max_tokens, 4096);
});

test("interface batches use the dedicated Overview and Notes translation prompt", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: '{"segments":[{"id":"note-1","text":"\u4e2d\u6587\u7b14\u8bb0\u3002"}]}',
            },
          }],
        }),
      };
    },
  });

  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "note-1", text: "Saved note." }] },
    "interfaceBatch",
    "zh",
    "Video",
  );

  assert.equal(result.success, true);
  assert.equal(result.translatedContent.segments[0].text, "\u4e2d\u6587\u7b14\u8bb0\u3002");
  assert.match(
    requests[0].messages[0].content,
    /chapter titles, summaries, quotes, and saved notes/,
  );
});

test("translation message watchdog rejects, clears its timer, and ignores late replies", async () => {
  let timeoutCallback;
  let timeoutDelay;
  let resolveMessage;
  let clearCount = 0;
  const helpers = loadSidepanelHelpers({
    sendMessage: () =>
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    setTimeoutImpl(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 73;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 73);
      clearCount += 1;
    },
  });

  const request = helpers.sendTranslationMessage({
    action: "translateContent",
  });
  assert.equal(timeoutDelay, 130_000);
  timeoutCallback();
  await assert.rejects(request, /timed out after 130 seconds.*Retry/i);
  assert.equal(clearCount, 1);

  resolveMessage({ success: true });
  await Promise.resolve();
  assert.equal(clearCount, 1);

  let successTimeoutCallback;
  let successClearCount = 0;
  const successfulHelpers = loadSidepanelHelpers({
    sendMessage: () => Promise.resolve({ success: true }),
    setTimeoutImpl(callback) {
      successTimeoutCallback = callback;
      return 91;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 91);
      successClearCount += 1;
    },
  });
  assert.deepEqual(
    await successfulHelpers.sendTranslationMessage({
      action: "translateContent",
    }),
    { success: true },
  );
  assert.equal(successClearCount, 1);
  successTimeoutCallback();
  assert.equal(successClearCount, 1);
});

test("Chinese prompt preserves natural bilingual-learning style rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Translate the complete thought/);
  assert.match(prompt, /Use 你, never 您/);
  assert.match(prompt, /spaces between Chinese and adjacent English words or digits/);
  assert.match(prompt, /source-language `text`/);
  assert.match(prompt, /translated display unit for every/);
  assert.match(prompt, /without omitting, duplicating, or reordering meaning/);
});
