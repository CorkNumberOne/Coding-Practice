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

test("player captions use one Supadata segment per unit and prefetch five lines ahead", () => {
  const js = read("sidepanel.js");
  const updateRow = js.match(
    /function updateTranslatedRow\([\s\S]*?\n}\n\nlet activeTranslationQueue/,
  )?.[0];

  assert.match(js, /action: "setPlayerBilingualCaptions"/);
  assert.match(js, /action: "updatePlayerBilingualCaptionTranslations"/);
  assert.match(js, /action: "clearPlayerBilingualCaptions"/);
  assert.match(
    js,
    /const finalPlayerIndex = Math\.min\(\s*activePlayerIndex \+ 5,\s*playerSegments\.length - 1,\s*\)/,
  );
  assert.match(js, /function buildPlayerBilingualCaptionSegments\(/);
  assert.match(js, /transcriptPlayerSourceCache/);
  assert.match(js, /player-segment-/);
  assert.match(js, /750,\s*\);/);
  assert.match(js, /playerCaptionTranslationFailures/);
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
});

test("content hides only YouTube captions that are actively rendering", () => {
  const content = read("content.js");

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
  assert.match(content, /nativeYouTubeCaptionsAreEnabled\(\)/);
  assert.match(content, /player\.getOption\("captions", "track"\)/);
  assert.match(content, /width: min\(86%, 820px\)/);
  assert.doesNotMatch(content, /-webkit-line-clamp/);
  assert.match(content, /setPlayerBilingualCaptionScale/);
  assert.match(content, /--ytd-caption-font-scale/);
  assert.doesNotMatch(content, /BILINGUAL_CAPTION_DELAY_SECONDS/);
  assert.match(content, /findNativeBilingualCaption/);
  assert.match(content, /syncNativeCaptionObserver/);
  assert.match(content, /setInterval\(updatePlayerBilingualCaption, 100\)/);
  assert.match(content, /requestVideoFrameCallback/);
});

test("player captions map one Supadata segment to one display unit", () => {
  const { buildPlayerBilingualCaptionSegments } = loadSidepanelHelpers();
  const captions = buildPlayerBilingualCaptionSegments([
    {
      start: 5.25,
      duration: 2.5,
      text: "This sentence starts in one cue and finishes here.",
    },
    {
      start: 7.75,
      duration: 1.75,
      text: "The next sentence starts now.",
    },
  ]);

  assert.equal(captions.length, 2);
  assert.equal(captions[0].start, 5.25);
  assert.equal(captions[0].end, 7.75);
  assert.equal(
    captions[0].text,
    "This sentence starts in one cue and finishes here.",
  );
  assert.equal(captions[1].start, 7.75);
  assert.equal(captions[1].end, 9.5);
  assert.equal(captions[1].text, "The next sentence starts now.");
  assert.ok(captions.every((caption) => caption.timingEstimated === false));
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
    {
      start: 14,
      duration: 2,
      text: "your relationship with money.",
    },
  ]);

  assert.equal(captions.length, 1);
  assert.equal(captions[0].start, 10);
  assert.equal(captions[0].end, 16);
  assert.equal(
    captions[0].text,
    "episode because I want you to transform your relationship with money.",
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
    action: "updatePlayerBilingualCaptionTranslations",
    translations: [{ id: "b", source: "hello.", translation: "你好。" }],
  });
  assert.equal(source.textContent, "hello.");
  assert.equal(translation.textContent, "你好。");

  harness.captionSegment.textContent = "";
  harness.runIntervals();

  assert.equal(overlay.hidden, true);
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

test("estimated clock times prefer the matching native sentence", () => {
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

  assert.equal(source.textContent, "Native matched sentence.");
  assert.equal(translation.textContent, "原生匹配句。");
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

test("Explain applies every concise rule to both Chinese and English", () => {
  const prompt = read("prompts/explain.md");

  assert.match(prompt, /Simplified Chinese and\s+English/);
  assert.match(prompt, /Each explanation is 1-3 sentences MAX/);
  assert.match(
    prompt,
    /Chinese explanation must follow every rule below in the same way as the\s+English explanation/,
  );
  assert.match(prompt, /If it's a word\/term: give a brief definition/);
  assert.match(
    prompt,
    /If it's a phrase\/claim: explain what it means in context/,
  );
  assert.match(prompt, /No fluff/);
  assert.match(prompt, /这指的是/);
  assert.match(prompt, /Use simple language in both languages/);
  assert.match(prompt, /中文：<one concise Chinese explanation>/);
  assert.match(prompt, /English: <one concise English explanation>/);
});

test("translation prompt restores source punctuation without changing words", () => {
  const prompt = read("prompts/translation.md");

  assert.match(prompt, /commas between almost every word/);
  assert.match(prompt, /treat\s+those commas as ASR token separators, not punctuation/);
  assert.match(prompt, /must not translate, add, remove, replace, or reorder words/);
  assert.match(prompt, /"source":"source text with restored punctuation"/);
});
