const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

test("DeepSeek defaults use V4 Flash", () => {
  const normalized = settings.normalize({
    provider: "unexpected",
    aiApiKey: "  example-key  ",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: "  example-supadata  ",
  });

  assert.equal(normalized.provider, "deepseek");
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.aiModel, "deepseek-v4-flash");
  assert.equal(normalized.aiApiKey, "example-key");
  assert.equal(normalized.supadataApiKey, "example-supadata");
  assert.equal(
    settings.chatCompletionsUrl(),
    "https://api.deepseek.com/chat/completions",
  );
});

test("legacy custom migration clears only the AI key and is idempotent", () => {
  const legacy = {
    provider: "custom",
    aiApiKey: "custom-secret",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: " supadata-secret ",
  };
  const first = settings.migrateLegacyCustom(legacy);

  assert.equal(first.migrated, true);
  assert.equal(first.settings.provider, "deepseek");
  assert.equal(first.settings.aiBaseUrl, settings.DEFAULTS.aiBaseUrl);
  assert.equal(first.settings.aiModel, settings.DEFAULTS.aiModel);
  assert.equal(first.settings.aiApiKey, "");
  assert.equal(first.settings.supadataApiKey, "supadata-secret");

  const second = settings.migrateLegacyCustom(first.settings);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.settings, first.settings);

  const configuredDeepSeek = settings.normalize({
    ...first.settings,
    aiApiKey: "new-deepseek-key",
  });
  assert.equal(configuredDeepSeek.aiApiKey, "new-deepseek-key");
});

test("Supadata receives a canonical YouTube URL", () => {
  assert.equal(
    settings.canonicalYouTubeUrl("ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  assert.throws(
    () => settings.canonicalYouTubeUrl('"><script>'),
    /Invalid YouTube video ID/,
  );
});

test("dense auto-caption commas are detected without rewriting punctuation", () => {
  const denseCaption = [
    "so, what, do, you, do, here, in, Bali exactly, known, as, the, island, of, gods,",
    "for its, Rich, culture, and, many, temples, but also, known, as, the, island of, digital Nomads, in,",
    "areas, like, chenu, tens, of, thousands, of, xats, flock, to, experience the, best, gyms,",
  ].join(" ");
  const normalCaption =
    "So, what do you do here in Bali? It is known as the island of gods for its rich culture, many temples, and famous beaches.";
  const unpunctuatedCaption =
    "we just made it to the trail head is this where it all begins right here yeah we are ready for the nine day hike and everyone on the team is feeling excited about the long climb ahead";
  const shortList = "Red, green, blue, yellow, purple, orange.";
  const mixedCaption = [
    "This is a normally punctuated transcript section that should stay readable for the viewer and should not trigger cleanup by itself.",
    "It contains ordinary sentence punctuation, a few natural commas, and enough words to make the overall transcript look normal.",
    "young, age, to, be, able, to, run, my, business and, travel, the, world, where, I, soon, then found, this, island, of, Bali",
    "The following section returns to normal sentences with natural clauses, because only part of the track has caption artifacts.",
  ].join(" ");

  assert.equal(settings.hasDenseAsrCommaArtifacts(denseCaption), true);
  assert.equal(settings.hasDenseAsrCommaArtifacts(normalCaption), false);
  assert.equal(settings.hasDenseAsrCommaArtifacts(shortList), false);
  assert.equal(settings.hasDenseAsrCommaArtifacts(mixedCaption), true);
  assert.equal(settings.needsPunctuationRestore(unpunctuatedCaption), true);
  assert.equal(settings.needsPunctuationRestore(normalCaption), false);
  assert.match(denseCaption, /,\s*/);
});
