const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.contains(value) : force;
    if (enabled) this.add(value);
    else this.remove(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.id = "";
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    const styleValues = {};
    this.style = {
      setProperty(name, value) {
        styleValues[name] = String(value);
        this[name] = String(value);
      },
      getPropertyValue(name) {
        return styleValues[name] || "";
      },
    };
    this.children = [];
    this.parentElement = null;
    this.classList = new FakeClassList();
    this.listeners = {};
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(
      (child) => child !== this,
    );
    this.parentElement = null;
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  getAttribute(name) {
    return this[name] ?? null;
  }

  getBoundingClientRect() {
    return { width: 100, height: 100, bottom: 100, left: 0 };
  }

  querySelector(selector) {
    if (selector === "video.html5-main-video") return this.video || null;
    if (selector === ".ytp-caption-window-container") {
      return this.captionContainer || null;
    }
    return this.findDescendant((child) => matchesSelector(child, selector));
  }

  querySelectorAll(selector) {
    if (selector === ".ytp-caption-segment") {
      return this.captionSegments || [];
    }
    return [];
  }

  findDescendant(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const nested = child.findDescendant?.(predicate);
      if (nested) return nested;
    }
    return null;
  }
}

function matchesSelector(element, selector) {
  if (selector.startsWith(".")) {
    return element.className.split(/\s+/).includes(selector.slice(1));
  }
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  return element.tagName === selector.toUpperCase();
}

function createContentHarness() {
  const head = new FakeElement("head");
  const body = new FakeElement("body");
  const player = new FakeElement("div");
  const captionContainer = new FakeElement("div");
  const captionSegment = new FakeElement("span");
  const video = new FakeElement("video");
  const elements = [];
  const intervals = new Map();
  let nextIntervalId = 1;
  let messageListener = null;

  player.id = "movie_player";
  player.className = "html5-video-player";
  player.captionContainer = captionContainer;
  player.video = video;
  captionContainer.captionSegments = [captionSegment];
  captionSegment.textContent = "hello";
  video.currentTime = 6;
  body.appendChild(player);

  const document = {
    readyState: "complete",
    head,
    body,
    addEventListener() {},
    querySelector(selector) {
      if (selector.includes("#movie_player")) return player;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById(id) {
      return elements.find((element) => element.id === id) || null;
    },
    createElement(tagName) {
      const element = new FakeElement(tagName);
      elements.push(element);
      return element;
    },
  };

  const context = {
    console,
    document,
    URLSearchParams,
    window: {
      location: { pathname: "/watch", search: "?v=video-a" },
      addEventListener() {},
      getComputedStyle() {
        return { position: "relative", display: "block", visibility: "visible" };
      },
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
        sendMessage: () => Promise.resolve({ success: true }),
      },
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval(callback) {
      const id = nextIntervalId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  };
  context.globalThis = context;
  vm.runInNewContext(read("content.js"), context);

  return {
    captionSegment,
    player,
    video,
    runIntervals() {
      Array.from(intervals.values()).forEach((callback) => callback());
    },
    sendMessage(message) {
      messageListener(message, {}, () => {});
    },
  };
}

function loadSidepanelHelpers() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({
        textContent: "",
        get innerHTML() {
          return "";
        },
      }),
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage: () => Promise.resolve({}) },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
        },
        session: {
          get: async () => ({}),
          set: async () => {},
        },
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: {
        onUpdated: listeners,
        onActivated: listeners,
        sendMessage: () => Promise.resolve({}),
      },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

test("player caption lookup follows semantic segment timestamps", () => {
  const { findTranscriptIndexAtTime } = loadSidepanelHelpers();
  const segments = [
    { id: "a", start: 0 },
    { id: "b", start: 5 },
    { id: "c", start: 12 },
  ];

  assert.equal(findTranscriptIndexAtTime(segments, -1), -1);
  assert.equal(findTranscriptIndexAtTime(segments, 0), 0);
  assert.equal(findTranscriptIndexAtTime(segments, 7.5), 1);
  assert.equal(findTranscriptIndexAtTime(segments, 30), 2);
});

test("semantic segments keep their real caption end time", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 10, duration: 3, text: "First complete sentence." },
      { start: 14, duration: 4, text: "Second complete sentence." },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );

  assert.equal(segments.length, 2);
  assert.equal(segments[0].end, 13);
  assert.equal(segments[1].end, 18);
});

test("player captions reuse semantic translations and prefetch five segments ahead", () => {
  const js = read("sidepanel.js");
  const updateRow = js.match(
    /function updateTranslatedRow\([\s\S]*?\n}\n\nlet activeTranslationQueue/,
  )?.[0];

  assert.match(js, /action: "setPlayerCaptions"/);
  assert.match(js, /action: "updatePlayerCaptionTranslations"/);
  assert.match(js, /action: "clearPlayerBilingualCaptions"/);
  assert.match(
    js,
    /const finalPlayerIndex = Math\.min\(\s*activePlayerIndex \+ 5,\s*playerSegments\.length - 1,\s*\)/,
  );
  assert.match(js, /function getPlayerCaptionSemanticSegments\(/);
  assert.match(js, /getActiveTranscriptSegments\(\)/);
  assert.match(js, /getPlayerCaptionAlignmentUnitsBySegment\(/);
  assert.match(js, /playerCaptionAlignedCache/);
  assert.match(js, /getOrCreateTranscriptTranslationQueue\(/);
  assert.match(js, /function buildPlayerCaptionSegmentsFromEntries\(/);
  assert.match(js, /player-segment-/);
  assert.doesNotMatch(js, /buildPlayerCaptionDisplayUnits/);
  assert.match(js, /750,\s*\);/);
  assert.doesNotMatch(js, /playerCaptionParagraphCache/);
  assert.doesNotMatch(js, /requestPlayerCaptionTranslationBatch/);
  assert.match(js, /void syncPlayerBilingualCaptions\(\{ clear: true \}\)/);
  assert.ok(updateRow);
  assert.ok(
    updateRow.indexOf("transcriptParagraphCache.set") <
      updateRow.indexOf("if (!row) return"),
    "translations must be cached even when no transcript row is mounted",
  );
  assert.match(js, /action: "enhanceTranscript"/);
  assert.match(js, /function restoreTranscriptPunctuation\(\)/);
  assert.match(js, /function applyCleanedTranscriptSources\(cleanedEntries\)/);
  assert.match(js, /PLAYER_CAPTION_ENABLED_KEY/);
  assert.match(js, /displayMode/);
});

test("content renders independent captions and enables subtitle selection", () => {
  const content = read("content.js");

  assert.match(content, /message\.action === "setPlayerCaptions"/);
  assert.match(content, /message\.action === "setPlayerBilingualCaptions"/);
  assert.match(content, /nativeYouTubeCaptionsAreVisible\(\)/);
  assert.match(content, /\.ytp-caption-window-container/);
  assert.match(content, /\.ytp-caption-segment/);
  assert.match(
    content,
    /player\.classList\.add\(BILINGUAL_CAPTION_HIDE_CLASS\)/,
  );
  assert.match(
    content,
    /player\?\.classList\.remove\(BILINGUAL_CAPTION_HIDE_CLASS\)/,
  );
  assert.doesNotMatch(
    content,
    /if \(!nativeYouTubeCaptionsAreEnabled\(\)\) \{[\s\S]*overlay\.hidden = true/,
  );
  assert.match(content, /width: min\(86%, 820px\)/);
  assert.doesNotMatch(content, /-webkit-line-clamp/);
  assert.match(content, /setPlayerBilingualCaptionScale/);
  assert.match(content, /--ytd-caption-font-scale/);
  assert.doesNotMatch(content, /BILINGUAL_CAPTION_DELAY_SECONDS/);
  assert.match(content, /findNativeBilingualCaption/);
  assert.match(content, /syncNativeCaptionObserver/);
  assert.match(content, /setInterval\(updatePlayerBilingualCaption, 100\)/);
  assert.match(content, /requestVideoFrameCallback/);
  assert.match(content, /pointer-events: auto/);
  assert.match(content, /user-select: text/);
  assert.match(content, /ytd-caption-selection-toolbar/);
  assert.match(content, /action: "explainSelection"/);
  assert.match(content, /action: "saveNote"/);
});

test("player captions use original cue boundaries with the 76/34 limits", () => {
  const { buildPlayerBilingualCaptionSegments, getPlayerCaptionMaxChars } =
    loadSidepanelHelpers();
  assert.equal(getPlayerCaptionMaxChars("English subtitle text"), 76);
  assert.equal(getPlayerCaptionMaxChars("这是中文字幕"), 34);
  const captions = buildPlayerBilingualCaptionSegments([
    {
      start: 5.25,
      duration: 1.75,
      text: "This first raw cue contains a complete sentence.",
    },
    {
      start: 7,
      duration: 2.5,
      text: "This second raw cue also stays reasonably short.",
    },
  ]);

  assert.equal(captions.length, 2);
  assert.equal(captions[0].start, 5.25);
  assert.equal(captions[0].end, 7);
  assert.equal(captions[0].timingEstimated, false);
  assert.equal(
    captions[0].text,
    "This first raw cue contains a complete sentence.",
  );
  assert.equal(captions[1].start, 7);
  assert.equal(captions.at(-1).end, 9.5);
  assert.equal(captions[1].timingEstimated, false);
  assert.equal(
    captions[1].text,
    "This second raw cue also stays reasonably short.",
  );
  assert.match(captions[0].id, /^player-segment-/);
});

test("player source text inherits restored sidebar punctuation", () => {
  const { slicePlayerCaptionSourceText } = loadSidepanelHelpers();
  const restored = slicePlayerCaptionSourceText(
    "Hello, this is a test. Next sentence.",
    "Hello, this, is, a, test",
  );

  assert.match(restored, /Hello, this is a test\./);
  assert.doesNotMatch(restored, /Hello, this, is/);
});

test("adjacent short cues merge without changing the first start time", () => {
  const { buildPlayerBilingualCaptionSegments } = loadSidepanelHelpers();
  const captions = buildPlayerBilingualCaptionSegments([
    {
      start: 10,
      duration: 2,
      text: "episode because I want",
    },
    {
      start: 12,
      duration: 2,
      text: "you to transform",
    },
  ]);

  assert.equal(captions.length, 1);
  assert.equal(captions[0].start, 10);
  assert.equal(captions[0].end, 14);
  assert.equal(
    captions[0].text,
    "episode because I want you to transform",
  );
});

test("content ignores synthetic page clicks and keyboard events", () => {
  const content = read("content.js");

  assert.match(
    content,
    /digestButton\.addEventListener\("click", async \(e\) => \{\s+if \(!e\.isTrusted\) return;/,
  );
  assert.match(
    content,
    /noteButton\.addEventListener\("click", async \(e\) => \{\s+if \(!e\.isTrusted\) return;/,
  );
  assert.match(
    content,
    /function handleNoteKeyboardShortcut\(e\) \{\s+if \(!e\.isTrusted\) return;/,
  );
});

test("content swaps native captions for timed bilingual captions", () => {
  const harness = createContentHarness();

  harness.sendMessage({
    action: "setPlayerCaptions",
    videoId: "video-a",
    displayMode: "bilingual",
    captions: [
      { id: "a", start: 0, end: 5, text: "first line", translation: "第一句" },
      { id: "b", start: 5, end: 12, text: "hello", translation: "你好" },
    ],
  });

  const overlay = harness.player.findDescendant(
    (element) => element.id === "ytd-bilingual-caption-overlay",
  );
  const source = overlay?.querySelector(".ytd-bilingual-caption-source");
  const translation = overlay?.querySelector(
    ".ytd-bilingual-caption-translation",
  );

  assert.ok(overlay);
  assert.equal(overlay.hidden, false);
  assert.equal(source.textContent, "hello");
  assert.equal(translation.textContent, "你好");
  assert.equal(
    harness.player.classList.contains("ytd-bilingual-caption-hide-native"),
    true,
  );

  harness.sendMessage({
    action: "updatePlayerCaptionTranslations",
    translations: [{ id: "b", source: "hello.", translation: "你好。" }],
  });
  assert.equal(source.textContent, "hello.");
  assert.equal(translation.textContent, "你好。");

  harness.captionSegment.textContent = "";
  harness.runIntervals();

  assert.equal(overlay.hidden, false);
  assert.equal(
    harness.player.classList.contains("ytd-bilingual-caption-hide-native"),
    true,
  );

  harness.sendMessage({
    action: "setPlayerCaptions",
    videoId: "video-a",
    displayMode: "zh",
    captions: [
      { id: "b", start: 5, end: 12, text: "hello.", translation: "你好。" },
    ],
  });
  assert.equal(source.hidden, true);
  assert.equal(translation.hidden, false);

  harness.sendMessage({
    action: "setPlayerCaptions",
    videoId: "video-a",
    displayMode: "original",
    captions: [
      { id: "b", start: 5, end: 12, text: "hello.", translation: "你好。" },
    ],
  });
  assert.equal(source.hidden, false);
  assert.equal(translation.hidden, true);

  harness.sendMessage({ action: "clearPlayerBilingualCaptions" });
  assert.equal(overlay.parentElement, null);
  assert.equal(
    harness.player.classList.contains("ytd-bilingual-caption-hide-native"),
    false,
  );
});

test("Supadata clock switches cues before late native DOM text", () => {
  const harness = createContentHarness();
  harness.sendMessage({
    action: "setPlayerBilingualCaptions",
    videoId: "video-a",
    captions: [
      { id: "a", start: 0, end: 5, text: "first line", translation: "第一句" },
      { id: "b", start: 5, end: 12, text: "hello", translation: "你好" },
    ],
  });
  const overlay = harness.player.findDescendant(
    (element) => element.id === "ytd-bilingual-caption-overlay",
  );
  const source = overlay.querySelector(".ytd-bilingual-caption-source");

  harness.captionSegment.textContent = "first line";
  harness.video.currentTime = 5.1;
  harness.runIntervals();
  assert.equal(source.textContent, "hello");
});

test("late native text cannot hold an estimated next caption back", () => {
  const harness = createContentHarness();
  harness.sendMessage({
    action: "setPlayerBilingualCaptions",
    videoId: "video-a",
    captions: [
      { id: "a", start: 0, end: 5, text: "first line", translation: "第一句" },
      {
        id: "b",
        start: 5,
        end: 12,
        timingEstimated: true,
        text: "second line",
        translation: "第二句",
      },
    ],
  });
  const overlay = harness.player.findDescendant(
    (element) => element.id === "ytd-bilingual-caption-overlay",
  );
  const source = overlay.querySelector(".ytd-bilingual-caption-source");

  harness.captionSegment.textContent = "first line";
  harness.runIntervals();
  harness.video.currentTime = 5.1;
  harness.runIntervals();

  assert.equal(source.textContent, "second line");
});

test("native cue matching keeps the complete sentence text", () => {
  const harness = createContentHarness();
  harness.sendMessage({
    action: "setPlayerBilingualCaptions",
    videoId: "video-a",
    captions: [
      {
        id: "a",
        start: 0,
        end: 12,
        text: "Hello, this is a complete sentence.",
        translation: "你好，这是一句完整的话。",
      },
    ],
  });
  const overlay = harness.player.findDescendant(
    (element) => element.id === "ytd-bilingual-caption-overlay",
  );
  const source = overlay.querySelector(".ytd-bilingual-caption-source");
  const translation = overlay.querySelector(
    ".ytd-bilingual-caption-translation",
  );

  harness.captionSegment.textContent = "hello this";
  harness.runIntervals();
  assert.equal(source.textContent, "Hello, this is a complete sentence.");
  assert.equal(translation.textContent, "你好，这是一句完整的话。");

  harness.captionSegment.textContent = "hello this is a";
  harness.runIntervals();
  assert.equal(source.textContent, "Hello, this is a complete sentence.");
});

test("native matching can find a sentence after a previous sentence ending", () => {
  const harness = createContentHarness();
  harness.sendMessage({
    action: "setPlayerBilingualCaptions",
    videoId: "video-a",
    captions: [
      {
        id: "a",
        start: 0,
        end: 2,
        text: "What I want.",
        translation: "我想要的东西。",
      },
      {
        id: "b",
        start: 10,
        end: 20,
        text: "This is the life I want to live.",
        translation: "这就是我想过的生活。",
      },
    ],
  });
  const overlay = harness.player.findDescendant(
    (element) => element.id === "ytd-bilingual-caption-overlay",
  );
  const source = overlay.querySelector(".ytd-bilingual-caption-source");

  harness.video.currentTime = 4;
  harness.captionSegment.textContent =
    "What I want. This is the life I want to live. And then";
  harness.runIntervals();

  assert.equal(source.textContent, "This is the life I want to live.");
});

test("clock captions advance before late native DOM text", () => {
  const harness = createContentHarness();
  harness.sendMessage({
    action: "setPlayerBilingualCaptions",
    videoId: "video-a",
    captions: [
      {
        id: "estimated",
        start: 0,
        end: 20,
        timingEstimated: true,
        text: "Estimated original sentence.",
        translation: "估算原文句。",
      },
      {
        id: "native",
        start: 30,
        end: 40,
        text: "Native matched sentence.",
        translation: "原生匹配句。",
      },
    ],
  });
  const overlay = harness.player.findDescendant(
    (element) => element.id === "ytd-bilingual-caption-overlay",
  );
  const source = overlay.querySelector(".ytd-bilingual-caption-source");
  const translation = overlay.querySelector(
    ".ytd-bilingual-caption-translation",
  );

  harness.video.currentTime = 2;
  harness.captionSegment.textContent = "Native matched sentence.";
  harness.runIntervals();

  assert.equal(source.textContent, "Estimated original sentence.");
  assert.equal(translation.textContent, "估算原文句。");
});

test("player caption font scale applies to the overlay", () => {
  const harness = createContentHarness();
  harness.sendMessage({
    action: "setPlayerBilingualCaptionScale",
    scale: 1.75,
  });
  harness.sendMessage({
    action: "setPlayerBilingualCaptions",
    videoId: "video-a",
    captions: [
      { id: "a", start: 0, end: 5, text: "first line", translation: "第一句" },
      { id: "b", start: 5, end: 12, text: "hello", translation: "你好" },
    ],
  });

  const overlay = harness.player.findDescendant(
    (element) => element.id === "ytd-bilingual-caption-overlay",
  );
  assert.equal(
    overlay.style.getPropertyValue("--ytd-caption-font-scale"),
    "1.75",
  );
});

test("player subtitles have a persistent switch independent of language mode", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");

  assert.match(
    html,
    /id="playerCaptionToggle"[\s\S]*aria-pressed="false"/,
  );
  assert.match(html, /id="captionScaleControl"/);
  assert.match(js, /ytd_player_captions_enabled/);
  assert.match(js, /handlePlayerCaptionsEnabledChange/);
  assert.match(js, /action: "setPlayerCaptions"/);
  assert.match(js, /displayMode/);
  assert.match(
    js,
    /!playerCaptionsEnabled[\s\S]*!currentTranscript\?\.length/,
  );
  assert.match(
    js,
    /setInterval\(\(\) => playbackTrackingTick\(\), 250\)/,
  );
});

test("Explain distinguishes literal meaning from contextual meaning", () => {
  const prompt = read("prompts/explain.md");

  assert.match(prompt, /Simplified Chinese and\s+English/);
  assert.match(prompt, /Each section is 1-2 sentences MAX/);
  assert.match(prompt, /original-meaning line must state the plain or literal meaning/);
  assert.match(prompt, /Chinese contextual explanation/);
  assert.match(prompt, /English contextual explanation/);
  assert.match(
    prompt,
    /If it's a word\/term: the original meaning is a brief definition/,
  );
  assert.match(
    prompt,
    /If it's a phrase\/claim: the original meaning is a straightforward paraphrase/,
  );
  assert.match(prompt, /No fluff/);
  assert.match(prompt, /这指的是/);
  assert.match(prompt, /Use simple language in both languages/);
  assert.match(prompt, /原意：<literal or plain meaning in Simplified Chinese>/);
  assert.match(prompt, /中文语境：<one concise Chinese explanation in context>/);
  assert.match(prompt, /English: <one concise English explanation in context>/);
});

test("translation prompt restores source punctuation without changing words", () => {
  const prompt = read("prompts/translation.md");

  assert.match(prompt, /commas between almost every word/);
  assert.match(prompt, /treat\s+those commas as ASR token separators, not punctuation/);
  assert.match(prompt, /must not translate, add, remove, replace, or reorder words/);
  assert.match(prompt, /"source":"source text with restored punctuation"/);
});
