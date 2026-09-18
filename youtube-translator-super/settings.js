/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  const DEFAULTS = Object.freeze({
    provider: "deepseek",
    aiApiKey: "",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    supadataApiKey: "",
  });

  function isLegacyCustom(input) {
    return !!input && input.provider === "custom";
  }

  function normalize(input = {}) {
    return {
      provider: DEFAULTS.provider,
      aiApiKey: isLegacyCustom(input)
        ? ""
        : typeof input.aiApiKey === "string"
          ? input.aiApiKey.trim()
          : "",
      aiBaseUrl: DEFAULTS.aiBaseUrl,
      aiModel: DEFAULTS.aiModel,
      supadataApiKey:
        typeof input.supadataApiKey === "string"
          ? input.supadataApiKey.trim()
          : "",
    };
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function chatCompletionsUrl() {
    return `${DEFAULTS.aiBaseUrl}/chat/completions`;
  }

  function canonicalYouTubeUrl(videoId) {
    const normalized = String(videoId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(normalized)) {
      throw new Error("Invalid YouTube video ID.");
    }
    return `https://www.youtube.com/watch?v=${normalized}`;
  }

  /**
   * Some auto-generated tracks return commas between almost every word.
   * Detect that only across a longer section so callers can request contextual
   * punctuation restoration without deleting normal punctuation.
   */
  function hasDenseAsrCommaArtifacts(input) {
    const text = String(input || "").replace(/\s+/g, " ").trim();
    const words = text.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g) || [];
    const commaCount = (text.match(/,/g) || []).length;
    if (words.length < 30 || commaCount < 10) return false;

    const parts = text.split(/\s*,\s*/).filter(Boolean);
    const singleWordParts = parts.filter((part) =>
      /^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(part),
    ).length;
    const commaDensity = commaCount / words.length;
    const singleWordPartRatio = parts.length
      ? singleWordParts / parts.length
      : 0;

    return commaDensity >= 0.32 && singleWordPartRatio >= 0.62;
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    isLegacyCustom,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    canonicalYouTubeUrl,
    hasDenseAsrCommaArtifacts,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
