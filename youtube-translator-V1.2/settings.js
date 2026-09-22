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
   * Detect both a globally fragmented transcript and a locally fragmented
   * section, since some tracks switch between normal and comma-per-word text.
   */
  function hasDenseAsrCommaArtifacts(input) {
    const text = String(input || "").replace(/\s+/g, " ").trim();
    if (!text) return false;

    const measure = (value) => {
      const words = value.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g) || [];
      const commaCount = (value.match(/,/g) || []).length;
      const parts = value.split(/\s*,\s*/).filter(Boolean);
      const singleWordParts = parts.filter((part) =>
        /^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(part),
      ).length;
      return {
        words: words.length,
        commaCount,
        commaDensity: words.length ? commaCount / words.length : 0,
        singleWordPartRatio: parts.length
          ? singleWordParts / parts.length
          : 0,
      };
    };

    const isDense = (metrics, minimumWords) =>
      metrics.words >= minimumWords &&
      metrics.commaCount >= Math.max(7, Math.round(minimumWords * 0.5)) &&
      metrics.commaDensity >= 0.28 &&
      metrics.singleWordPartRatio >= 0.55;

    if (isDense(measure(text), 30)) return true;

    const tokens = text.split(/\s+/).filter(Boolean);
    const windowSize = 18;
    const step = 6;
    for (let start = 0; start < tokens.length; start += step) {
      const windowText = tokens
        .slice(start, start + windowSize)
        .join(" ");
      if (isDense(measure(windowText), 12)) return true;
      if (start + windowSize >= tokens.length) break;
    }

    return false;
  }

  function needsPunctuationRestore(input) {
    const text = String(input || "").replace(/\s+/g, " ").trim();
    if (!text) return false;
    if (hasDenseAsrCommaArtifacts(text)) return true;

    const words = text.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g) || [];
    if (words.length < 30) return false;
    return !/[.!?。！？]/.test(text);
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
    needsPunctuationRestore,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}
