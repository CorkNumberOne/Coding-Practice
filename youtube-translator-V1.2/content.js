/**
 * CONTENT SCRIPT
 *
 * This script runs ON the YouTube page itself. It can see and modify
 * the YouTube page DOM (the HTML elements).
 *
 * It handles:
 * 1. Extracting video info (title, channel name) from the page
 * 2. Injecting "key moment" markers onto YouTube's progress bar
 * 3. Adding a "Digest" button to YouTube's action bar (next to Share/Save)
 *
 * Think of it like a robot sitting inside the YouTube tab,
 * reading the page and making small visual changes.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// GLOBAL STATE
// ============================================================

let ytdNoteButton = null;
let ytdNoteButtonTimer = null;
let ytdNoteKeyboardListenerAdded = false;
let ytdNoteButtonRetryTimer = null;
let ytdDigestButton = null;
let digestButtonObserver = null;
let digestButtonReconcileTimer = null;
let digestButtonResizeListenerAdded = false;
let ytdBilingualCaptionOverlay = null;
let ytdBilingualCaptionSources = [];
let ytdBilingualCaptionTranslations = new Map();
let ytdBilingualCaptionMatchKeys = new Map();
let ytdBilingualActiveCaptionId = "";
let ytdBilingualCaptionTimer = null;
let ytdBilingualCaptionObserver = null;
let ytdBilingualCaptionObservedContainer = null;
let ytdBilingualFrameCallbackId = null;
let ytdBilingualCaptionScale = 1;
let ytdBilingualCaptionDisplayMode = "bilingual";
let ytdBilingualCaptionSelectionActive = false;
let ytdBilingualCaptionSelectionToolbar = null;
let ytdBilingualCaptionSelection = null;
let ytdBilingualCaptionSelectionListenersBound = false;

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 */
function init() {
  // Register the global "n" keyboard shortcut once
  if (!ytdNoteKeyboardListenerAdded) {
    document.addEventListener("keydown", handleNoteKeyboardShortcut);
    ytdNoteKeyboardListenerAdded = true;
  }

  // Try to inject the buttons immediately
  injectDigestButton();
  tryInjectNoteButton();

  // Also set up an observer to handle YouTube's dynamic content loading
  // (YouTube is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupDigestButtonResizeListener();
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. YouTube renders the player asynchronously
 * after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  if (!window.location.pathname.includes("/watch")) return;

  // Clear any existing retry so we don't stack timers
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying

  function attempt() {
    attempts++;
    const playerContainer = document.querySelector(
      "#movie_player.html5-video-player, #movie_player, .html5-video-player",
    );

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[YouTube Digest Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 * When they send key moments, we highlight them on the progress bar.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.id && sender.id !== chrome.runtime.id) {
    sendResponse({ success: false, error: "UNAUTHORIZED_MESSAGE" });
    return false;
  }
  debugLog("[YouTube Digest Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[YouTube Digest Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "highlightMoments") {
    // Key moment markers disabled — chapters are shown in the side panel only.
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const video = document.querySelector("video.html5-main-video");
    sendResponse({
      currentTime: video ? video.currentTime : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[YouTube Digest Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  if (
    message.action === "setPlayerCaptions" ||
    message.action === "setPlayerBilingualCaptions"
  ) {
    setPlayerBilingualCaptions(
      message.captions,
      message.videoId,
      message.displayMode,
    );
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "setPlayerBilingualCaptionScale") {
    setPlayerBilingualCaptionScale(message.scale);
    sendResponse({ success: true });
    return false;
  }

  if (
    message.action === "updatePlayerCaptions" ||
    message.action === "updatePlayerCaptionTranslations" ||
    message.action === "updatePlayerBilingualCaptionTranslations"
  ) {
    updatePlayerBilingualCaptionTranslations(message.translations);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "clearPlayerBilingualCaptions") {
    clearPlayerBilingualCaptions();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "showNoteSavedFeedback") {
    // Show brief feedback that note was saved
    showNoteSavedToast(message.note);
    sendResponse({ success: true });
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[YouTube Digest Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into YouTube's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the YouTube Digest side panel.
 */
function isVisibleDigestHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * YouTube keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 */
function findDigestButtonHost() {
  const primaryActionRows = Array.from(
    document.querySelectorAll("ytd-watch-metadata #actions-inner"),
  );

  for (const actionRow of primaryActionRows) {
    if (!isVisibleDigestHost(actionRow)) continue;

    const visibleButtonGroup = Array.from(
      actionRow.querySelectorAll("#top-level-buttons-computed"),
    ).find(isVisibleDigestHost);
    if (visibleButtonGroup) return visibleButtonGroup;
  }

  const fallbackCandidates = Array.from(
    document.querySelectorAll(
      "ytd-watch-metadata #actions #top-level-buttons-computed, " +
        "ytd-watch-metadata #top-level-buttons-computed, " +
        "#primary #actions #top-level-buttons-computed",
    ),
  );

  return (
    fallbackCandidates.find(
      (candidate) =>
        isVisibleDigestHost(candidate) &&
        (candidate.closest("ytd-watch-metadata") ||
          candidate.closest("#primary")),
    ) || null
  );
}

function createDigestButton() {
  const digestButton = document.createElement("button");
  digestButton.id = "ytd-digest-button";
  digestButton.type = "button";
  digestButton.setAttribute("aria-label", "Open YouTube Digest");
  digestButton.innerHTML = `<span class="ytd-digest-label">Digest</span>`;

  // Style the button — rounded pill in our terracotta accent, sized to sit
  // comfortably among YouTube's native action buttons.
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #c8674f;
    color: white;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    margin-right: 8px;
    transition: background 0.2s, transform 0.1s;
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  // Hover effects
  digestButton.addEventListener("mouseenter", () => {
    digestButton.style.background = "#b25742";
    digestButton.style.transform = "scale(1.02)";
  });

  digestButton.addEventListener("mouseleave", () => {
    digestButton.style.background = "#c8674f";
    digestButton.style.transform = "scale(1)";
  });

  // Click handler — open the side panel
  digestButton.addEventListener("click", async (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();

    debugLog("[YouTube Digest] Digest button clicked");

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[YouTube Digest] openSidePanel response:", result);
      if (!result?.success) {
        throw new Error(result?.error || "Could not open the side panel.");
      }
    } catch (err) {
      console.error("[YouTube Digest] Failed to open side panel:", err);
      const label = digestButton.querySelector(".ytd-digest-label");
      if (label) label.textContent = "Refresh YouTube";
      digestButton.title =
        "YouTube Digest was reloaded. Refresh this page and try again.";
    }
  });

  ytdDigestButton = digestButton;
  return digestButton;
}

/**
 * Reconciles the Digest button with YouTube's currently visible action row.
 * This is intentionally idempotent because YouTube rebuilds its watch page
 * during navigation and at responsive breakpoints.
 */
function injectDigestButton() {
  const existingButtons = Array.from(
    document.querySelectorAll("#ytd-digest-button"),
  );

  if (!window.location.pathname.includes("/watch")) {
    existingButtons.forEach((button) => button.remove());
    ytdDigestButton = null;
    return false;
  }

  const actionsContainer = findDigestButtonHost();
  if (!actionsContainer) {
    debugLog("[YouTube Digest Content] Visible actions container not found yet");
    return false;
  }

  let digestButton = existingButtons.find(
    (button) => button === ytdDigestButton,
  );

  if (!digestButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    digestButton = createDigestButton();
  }

  existingButtons.forEach((button) => {
    if (button !== digestButton) button.remove();
  });

  if (digestButton.parentElement !== actionsContainer) {
    // YouTube turns #actions-inner into a vertical flex column at narrow
    // breakpoints. A direct child there stretches into a full-width second
    // row, so keep Digest inside the native horizontal button group and
    // prepend it to preserve visibility when space is limited.
    actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
  }

  debugLog("[YouTube Digest Content] Digest button reconciled");
  return true;
}

function scheduleDigestButtonReconciliation(delay = 80) {
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
  }

  digestButtonReconcileTimer = setTimeout(() => {
    digestButtonReconcileTimer = null;
    injectDigestButton();
  }, delay);
}

function setupDigestButtonResizeListener() {
  if (digestButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleDigestButtonReconciliation(120);
  });
  digestButtonResizeListenerAdded = true;
}

/**
 * Sets up a MutationObserver to watch for YouTube's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  if (digestButtonObserver) return;

  digestButtonObserver = new MutationObserver(() => {
    // Check if we need to inject the buttons
    if (window.location.pathname.includes("/watch")) {
      scheduleDigestButtonReconciliation();
      if (!ytdNoteButton || !ytdNoteButton.isConnected) {
        tryInjectNoteButton();
      }
    }
  });

  // Watch the entire body for changes (YouTube rebuilds large chunks of the DOM)
  digestButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the YouTube video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!window.location.pathname.includes("/watch")) return;

  // Don't inject if button already exists and is properly tracked.
  // If a stale button exists (e.g., from a previous content-script instance),
  // remove it and re-inject so event listeners are attached to the live one.
  const existingButton = document.getElementById("ytd-note-button");
  if (existingButton) {
    if (ytdNoteButton === existingButton && existingButton.isConnected) {
      return; // already injected and connected
    }
    existingButton.remove();
  }

  // Find the video player container. YouTube rebuilds this dynamically, so
  // we try the most common selectors.
  const playerContainer = document.querySelector(
    "#movie_player.html5-video-player, " +
      "#movie_player, " +
      ".html5-video-player",
  );

  if (!playerContainer) {
    debugLog(
      "[YouTube Digest Content] Player container not found yet, will retry",
    );
    return;
  }

  // Ensure the player container has relative positioning for absolute children
  if (
    window.getComputedStyle(playerContainer).position === "static" ||
    !playerContainer.style.position
  ) {
    playerContainer.style.position = "relative";
  }

  debugLog("[YouTube Digest Content] Injecting note button");

  // Create the note button — a soft rounded pill that floats over the player
  const noteButton = document.createElement("button");
  noteButton.id = "ytd-note-button";
  noteButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 7px;">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
    <span>Note</span>
  `;

  // Soft rounded pill in the terracotta accent, with a gentle shadow.
  // Start hidden; visibility is controlled by mouse activity.
  noteButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    align-items: center;
    padding: 9px 16px;
    background: #c8674f;
    color: white;
    border: none;
    border-radius: 999px;
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  `;

  ytdNoteButton = noteButton;

  // Show button when mouse enters or moves over the player.
  // Hide after 2 seconds of idle or when the mouse leaves.
  playerContainer.addEventListener("mouseenter", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mousemove", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mouseleave", () => {
    clearTimeout(ytdNoteButtonTimer);
    ytdNoteButtonTimer = null;
    hideNoteButton();
  });

  // Hover effect — lift slightly
  noteButton.addEventListener("mouseenter", () => {
    noteButton.style.background = "#b25742";
    noteButton.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    noteButton.style.transform = "translateY(-1px)";
  });

  noteButton.addEventListener("mouseleave", () => {
    noteButton.style.background = "#c8674f";
    noteButton.style.boxShadow = "0 4px 14px rgba(0,0,0,0.3)";
    noteButton.style.transform = "translateY(0)";
  });

  // Click handler — save the current moment as a note
  noteButton.addEventListener("click", async (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    await saveCurrentNote();
  });

  playerContainer.appendChild(noteButton);

  debugLog("[YouTube Digest Content] Note button injected");
}

function showNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "1";
  ytdNoteButton.style.pointerEvents = "auto";
}

function hideNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "0";
  ytdNoteButton.style.pointerEvents = "none";
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

/**
 * Handles the "n" keyboard shortcut for saving a note.
 * Only triggers on YouTube watch pages and when the user is not typing
 * in an input field.
 */
function handleNoteKeyboardShortcut(e) {
  if (!e.isTrusted) return;
  if (!window.location.pathname.includes("/watch")) return;
  if (e.key !== "n" && e.key !== "N") return;

  // Ignore if the user is typing in an input/textarea/contenteditable
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable)
  ) {
    return;
  }

  // Prevent YouTube's own "n" shortcut (e.g. next video in playlist)
  e.preventDefault();
  e.stopPropagation();

  // Show brief visual feedback on the button, then save
  showNoteButton();
  resetNoteButtonTimer();
  saveCurrentNote();
}

/**
 * Captures the current timestamp and saves it as a note.
 */
async function saveCurrentNote() {
  debugLog("[YouTube Digest] Saving note");

  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest] No video element found");
    return;
  }

  // Go back 3 seconds to capture what was just said (user reacts after hearing it)
  const currentTime = Math.max(0, Math.floor(video.currentTime) - 3);
  const videoInfo = extractVideoInfo();
  const videoId = new URLSearchParams(window.location.search).get("v");

  const noteButton = ytdNoteButton;
  const originalContent = noteButton ? noteButton.innerHTML : "";

  if (noteButton) {
    noteButton.innerHTML =
      '<span style="letter-spacing: 0.2px;">SAVING...</span>';
    noteButton.style.pointerEvents = "none";
  }

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: videoId,
      timestamp: currentTime,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
    });

    if (result.success) {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">SAVED</span>';
        noteButton.style.background = "#7c8b6f";
      }
      showNoteSavedToast(result.note);
    } else {
      if (noteButton) {
        noteButton.innerHTML =
          '<span style="letter-spacing: 0.2px;">ERROR</span>';
      }
      console.error("[YouTube Digest] Save note error:", result.error);
    }
  } catch (err) {
    if (noteButton) {
      noteButton.innerHTML =
        '<span style="letter-spacing: 0.2px;">ERROR</span>';
    }
    console.error("[YouTube Digest] Save note exception:", err);
  }

  setTimeout(() => {
    if (noteButton) {
      noteButton.innerHTML = originalContent;
      noteButton.style.background = "#c8674f";
      noteButton.style.pointerEvents = "auto";
    }
  }, 2000);
}

/**
 * Shows a toast notification when a note is saved.
 */
function showNoteSavedToast(note) {
  // Remove existing toast
  const existing = document.getElementById("ytd-note-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ytd-note-toast";
  const safeTimestampedUrl = getSafeTimestampedNoteUrl(note);
  toast.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 6px; color: #c8674f;">Note saved</div>
    <div style="font-size: 12px; color: #6b6258; margin-bottom: 8px;">${escapeHtmlForContent(note.timestamp)} — ${escapeHtmlForContent(note.videoTitle)}</div>
    <div style="font-size: 13px; line-height: 1.55; color: #2e2a24;">"${escapeHtmlForContent(note.text)}"</div>
    <div style="margin-top: 10px; font-size: 11px;">
      <a href="${escapeHtmlForContent(safeTimestampedUrl)}" style="color: #c8674f; font-weight: 600; text-decoration: none;">Copy link</a>
    </div>
  `;

  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background: #ffffff;
    border: 1px solid #ece5d9;
    border-radius: 14px;
    padding: 16px 20px;
    max-width: 350px;
    box-shadow: 0 12px 32px rgba(50, 42, 32, 0.2);
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    animation: ytdSlideIn 0.3s ease;
  `;

  // Add animation keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ytdSlideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  // Copy link handler
  toast.querySelector("a").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      if (!safeTimestampedUrl) return;
      await navigator.clipboard.writeText(safeTimestampedUrl);
      e.target.textContent = "Copied";
    } catch (err) {
      console.error("Copy failed:", err);
    }
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.animation = "ytdSlideIn 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from YouTube's page.
 * These are just sitting in the HTML — we grab them from the DOM elements.
 */
function extractVideoInfo() {
  // The video title is in an h1 element inside the #title container
  const titleElement = document.querySelector(
    "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
  );

  // The channel name is in the channel info section
  const channelElement = document.querySelector(
    "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
  );

  // Video duration from the video element
  const videoElement = document.querySelector("video.html5-main-video");

  // Video description — YouTube has this in a few possible places
  const descriptionElement = document.querySelector(
    "#description-inner, " +
      "ytd-watch-metadata #description yt-attributed-string, " +
      "#description yt-formatted-string, " +
      "ytd-expander#description yt-attributed-string",
  );

  return {
    title: titleElement?.textContent?.trim().slice(0, 500) || "",
    channelName: channelElement?.textContent?.trim().slice(0, 300) || "",
    duration:
      Number.isFinite(videoElement?.duration) && videoElement.duration > 0
        ? Math.min(videoElement.duration, 12 * 60 * 60)
        : 0,
    description:
      descriptionElement?.textContent?.trim().slice(0, 5000) || "",
  };
}

// ============================================================
// PROGRESS BAR KEY MOMENTS
// ============================================================

/**
 * Adds colored marker dots to YouTube's video progress bar
 * at the positions of key moments identified by the AI provider.
 *
 * How it works:
 * - YouTube's progress bar is a <div> element with a known class
 * - We calculate each moment's position as a percentage of total duration
 * - We inject small colored <div> elements at those positions
 * - The markers are absolutely positioned on top of the progress bar
 *
 * This is a "bonus feature" — it gives you a visual preview
 * of where the good stuff is in the video.
 */
function highlightKeyMoments(moments, videoDuration) {
  // Disabled: no timeline markers. Chapters live only in the side panel.
  return;
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const video = document.querySelector("video.html5-main-video");
  if (!video) {
    console.error("[YouTube Digest Content] No video element found for seek");
    return;
  }

  debugLog("[YouTube Digest Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

// ============================================================
// PLAYER CAPTIONS
// ============================================================

const BILINGUAL_CAPTION_HIDE_CLASS = "ytd-bilingual-caption-hide-native";

function getYouTubePlayer() {
  return document.querySelector(
    "#movie_player.html5-video-player, #movie_player, .html5-video-player",
  );
}

function normalizeBilingualCaptionScale(value) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale >= 0.1 && scale <= 2 ? scale : 1;
}

function applyBilingualCaptionScale() {
  if (!ytdBilingualCaptionOverlay?.style) return;
  ytdBilingualCaptionOverlay.style.setProperty(
    "--ytd-caption-font-scale",
    String(ytdBilingualCaptionScale),
  );
}

function setPlayerBilingualCaptionScale(scale) {
  ytdBilingualCaptionScale = normalizeBilingualCaptionScale(scale);
  applyBilingualCaptionScale();
}

function ensureBilingualCaptionStyles() {
  if (document.getElementById("ytd-bilingual-caption-styles")) return;

  const style = document.createElement("style");
  style.id = "ytd-bilingual-caption-styles";
  style.textContent = `
    #movie_player.${BILINGUAL_CAPTION_HIDE_CLASS} .ytp-caption-window-container {
      visibility: hidden !important;
    }

    .ytd-bilingual-caption-overlay {
      position: absolute;
      left: 50%;
      bottom: 8%;
      z-index: 60;
      width: min(86%, 820px);
      box-sizing: border-box;
      transform: translateX(-50%);
      padding: 6px 12px 8px;
      border-radius: 6px;
      background: rgba(8, 8, 8, 0.72);
      color: #fff;
      text-align: center;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
      pointer-events: none;
      font-family: "YouTube Noto", Roboto, Arial, sans-serif;
      line-height: 1.35;
    }

    .ytd-bilingual-caption-source {
      overflow-wrap: anywhere;
      font-size: calc(18px * var(--ytd-caption-font-scale, 1));
      font-weight: 400;
      cursor: text;
      pointer-events: auto;
      user-select: text;
    }

    .ytd-bilingual-caption-translation {
      overflow-wrap: anywhere;
      margin-top: 3px;
      font-size: calc(19px * var(--ytd-caption-font-scale, 1));
      font-weight: 500;
      cursor: text;
      pointer-events: auto;
      user-select: text;
    }

    .ytd-bilingual-caption-translation.pending {
      color: rgba(255, 255, 255, 0.72);
      font-weight: 400;
    }

    #movie_player.ytp-fullscreen .ytd-bilingual-caption-source {
      font-size: calc(22px * var(--ytd-caption-font-scale, 1));
    }

    #movie_player.ytp-fullscreen .ytd-bilingual-caption-translation {
      font-size: calc(23px * var(--ytd-caption-font-scale, 1));
    }

    .ytd-caption-selection-toolbar {
      position: absolute;
      z-index: 82;
      display: none;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 6px;
      background: rgba(14, 14, 14, 0.94);
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.36);
      transform: translateX(-50%);
      font-family: "YouTube Noto", Roboto, Arial, sans-serif;
    }

    .ytd-caption-selection-toolbar button {
      padding: 5px 9px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: #fff;
      cursor: pointer;
      font: 600 12px/1.2 "YouTube Noto", Roboto, Arial, sans-serif;
    }

    .ytd-caption-selection-toolbar button:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.14);
    }

    .ytd-caption-selection-toolbar button:disabled {
      cursor: default;
      opacity: 0.62;
    }

    .ytd-caption-explain-overlay {
      position: absolute;
      inset: 0;
      z-index: 90;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.62);
      font-family: "YouTube Noto", Roboto, Arial, sans-serif;
    }

    .ytd-caption-explain-modal {
      display: flex;
      flex-direction: column;
      width: min(92%, 640px);
      max-height: min(78vh, 560px);
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 6px;
      background: #171717;
      color: #f4f4f4;
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
    }

    .ytd-caption-explain-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 13px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }

    .ytd-caption-explain-title {
      font-size: 15px;
      font-weight: 700;
    }

    .ytd-caption-explain-close {
      padding: 5px 9px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      background: transparent;
      color: #f4f4f4;
      cursor: pointer;
      font: 600 12px/1.2 "YouTube Noto", Roboto, Arial, sans-serif;
    }

    .ytd-caption-explain-selection {
      margin: 14px 16px 0;
      padding: 9px 11px;
      border-left: 3px solid #c8674f;
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.78);
      font-size: 12px;
      line-height: 1.5;
    }

    .ytd-caption-explain-content {
      overflow: auto;
      padding: 14px 16px 18px;
      white-space: pre-wrap;
      color: rgba(255, 255, 255, 0.9);
      font-size: 13px;
      line-height: 1.64;
    }

    .ytd-caption-explain-content.error {
      color: #ffb09f;
    }
  `;
  document.head.appendChild(style);
}

function createBilingualCaptionOverlay() {
  const existing = document.getElementById("ytd-bilingual-caption-overlay");
  if (existing) return existing;

  const overlay = document.createElement("div");
  overlay.id = "ytd-bilingual-caption-overlay";
  overlay.className = "ytd-bilingual-caption-overlay";
  overlay.hidden = true;

  const source = document.createElement("div");
  source.className = "ytd-bilingual-caption-source";
  const translation = document.createElement("div");
  translation.className = "ytd-bilingual-caption-translation";

  overlay.append(source, translation);
  ytdBilingualCaptionOverlay = overlay;
  applyBilingualCaptionScale();
  return overlay;
}

function normalizeBilingualCaptionSources(captions) {
  if (!Array.isArray(captions)) return [];

  return captions
    .map((caption) => {
      const id = typeof caption?.id === "string" ? caption.id.trim() : "";
      const text =
        typeof caption?.text === "string" ? caption.text.trim() : "";
      const start = Number(caption?.start);
      const end =
        caption?.end === null || caption?.end === undefined
          ? null
          : Number(caption.end);
      const translation =
        typeof caption?.translation === "string"
          ? caption.translation.trim()
          : "";
      return {
        id,
        text,
        start: Number.isFinite(start) ? Math.max(0, start) : 0,
        end: Number.isFinite(end) ? Math.max(0, end) : null,
        timingEstimated: caption?.timingEstimated === true,
        translation,
      };
    })
    .filter((caption) => caption.id && caption.text)
    .sort((a, b) => a.start - b.start);
}

function normalizePlayerCaptionDisplayMode(value) {
  return ["original", "zh", "bilingual"].includes(value)
    ? value
    : "bilingual";
}

function setPlayerBilingualCaptions(captions, videoId, displayMode) {
  const currentVideoId = new URLSearchParams(window.location.search).get("v");
  if (videoId && currentVideoId && videoId !== currentVideoId) return;

  ytdBilingualCaptionDisplayMode =
    normalizePlayerCaptionDisplayMode(displayMode);
  ytdBilingualCaptionSources = normalizeBilingualCaptionSources(captions);
  ytdBilingualCaptionMatchKeys = new Map(
    ytdBilingualCaptionSources.map((caption) => [
      caption.id,
      normalizeBilingualCaptionMatchText(caption.text),
    ]),
  );
  ytdBilingualActiveCaptionId = "";
  ytdBilingualCaptionTranslations = new Map(
    ytdBilingualCaptionSources
      .filter((caption) => caption.translation)
      .map((caption) => [caption.id, caption.translation]),
  );

  if (!ytdBilingualCaptionSources.length) {
    clearPlayerBilingualCaptions();
    return;
  }

  ensureBilingualCaptionStyles();
  const player = getYouTubePlayer();
  if (!player) return;

  bindPlayerCaptionSelectionActions();
  const overlay = createBilingualCaptionOverlay();
  if (overlay.parentElement !== player) player.appendChild(overlay);
  applyBilingualCaptionScale();
  startBilingualCaptionSync();
}

function updatePlayerBilingualCaptionTranslations(translations) {
  if (!Array.isArray(translations)) return;

  translations.forEach((item) => {
    if (typeof item?.id !== "string") return;

    if (typeof item.translation === "string" && item.translation.trim()) {
      ytdBilingualCaptionTranslations.set(item.id, item.translation.trim());
    }
    if (typeof item.source === "string" && item.source.trim()) {
      let caption = ytdBilingualCaptionSources.find(
        (candidate) => candidate.id === item.id,
      );
      if (!caption && Number.isFinite(Number(item.start))) {
        caption = {
          id: item.id,
          start: Math.max(0, Number(item.start)),
          end: Number.isFinite(Number(item.end))
            ? Math.max(0, Number(item.end))
            : null,
          timingEstimated: item.timingEstimated === true,
          text: "",
          translation: "",
        };
        ytdBilingualCaptionSources.push(caption);
      }
      if (!caption) return;
      caption.text = item.source.trim();
      caption.start = Number.isFinite(Number(item.start))
        ? Math.max(0, Number(item.start))
        : caption.start;
      caption.end = Number.isFinite(Number(item.end))
        ? Math.max(0, Number(item.end))
        : caption.end;
      caption.timingEstimated = item.timingEstimated === true;
      ytdBilingualCaptionMatchKeys.set(
        caption.id,
        normalizeBilingualCaptionMatchText(caption.text),
      );
    }
  });
  ytdBilingualCaptionSources.sort((a, b) => a.start - b.start);
  updatePlayerBilingualCaption();
}

function clearPlayerBilingualCaptions() {
  stopBilingualCaptionSync();
  dismissPlayerCaptionSelectionActions();
  ytdBilingualCaptionSources = [];
  ytdBilingualCaptionTranslations = new Map();
  ytdBilingualCaptionMatchKeys = new Map();
  ytdBilingualActiveCaptionId = "";
  ytdBilingualCaptionDisplayMode = "bilingual";

  const player = getYouTubePlayer();
  player?.classList.remove(BILINGUAL_CAPTION_HIDE_CLASS);
  ytdBilingualCaptionOverlay?.remove();
  ytdBilingualCaptionOverlay = null;
}

function startBilingualCaptionSync() {
  if (ytdBilingualCaptionTimer) {
    updatePlayerBilingualCaption();
    return;
  }
  updatePlayerBilingualCaption();
  syncNativeCaptionObserver();
  scheduleBilingualFrameUpdate();
  ytdBilingualCaptionTimer = setInterval(updatePlayerBilingualCaption, 100);
}

function stopBilingualCaptionSync() {
  clearInterval(ytdBilingualCaptionTimer);
  ytdBilingualCaptionTimer = null;
  ytdBilingualCaptionObserver?.disconnect();
  ytdBilingualCaptionObserver = null;
  ytdBilingualCaptionObservedContainer = null;
  const video = getYouTubePlayer()?.querySelector(
    "video.html5-main-video",
  );
  if (
    ytdBilingualFrameCallbackId !== null &&
    typeof video?.cancelVideoFrameCallback === "function"
  ) {
    video.cancelVideoFrameCallback(ytdBilingualFrameCallbackId);
  }
  ytdBilingualFrameCallbackId = null;
}

function scheduleBilingualFrameUpdate() {
  const video = getYouTubePlayer()?.querySelector("video.html5-main-video");
  if (typeof video?.requestVideoFrameCallback !== "function") return;

  ytdBilingualFrameCallbackId = video.requestVideoFrameCallback(() => {
    ytdBilingualFrameCallbackId = null;
    updatePlayerBilingualCaption();
    scheduleBilingualFrameUpdate();
  });
}

function syncNativeCaptionObserver() {
  const container = getYouTubePlayer()?.querySelector(
    ".ytp-caption-window-container",
  );
  if (!container) return;
  if (ytdBilingualCaptionObservedContainer === container) return;

  ytdBilingualCaptionObserver?.disconnect();
  ytdBilingualCaptionObservedContainer = container;
  ytdBilingualCaptionObserver = new MutationObserver(() => {
    updatePlayerBilingualCaption();
  });
  ytdBilingualCaptionObserver.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function getNativeYouTubeCaptionText() {
  const player = getYouTubePlayer();
  if (!player) return "";

  const container = player.querySelector(".ytp-caption-window-container");
  if (!container) return "";

  return Array.from(container.querySelectorAll(".ytp-caption-segment"))
    .map((segment) => segment.textContent?.trim() || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function nativeYouTubeCaptionsAreVisible() {
  return Boolean(getNativeYouTubeCaptionText());
}

function nativeYouTubeCaptionsAreEnabled() {
  const player = getYouTubePlayer();
  if (!player) return false;
  let apiEnabled;

  try {
    if (typeof player.getOption === "function") {
      const track = player.getOption("captions", "track");
      if (track && (typeof track !== "object" || Object.keys(track).length)) {
        return true;
      }
      if (
        track === false ||
        (track && typeof track === "object" && Object.keys(track).length === 0)
      ) {
        apiEnabled = false;
      }
    }
  } catch {
    // Fall through to the visible controls when the player API is unavailable.
  }

  const subtitlesButton = player.querySelector(".ytp-subtitles-button");
  const pressed = subtitlesButton?.getAttribute?.("aria-pressed");
  if (pressed === "true") return true;
  if (pressed === "false") return false;
  if (apiEnabled === false) return false;

  return nativeYouTubeCaptionsAreVisible();
}

function findActiveBilingualCaption(currentTime) {
  const adjustedTime = Math.max(0, Number(currentTime || 0));
  let activeIndex = -1;

  for (let index = 0; index < ytdBilingualCaptionSources.length; index += 1) {
    const caption = ytdBilingualCaptionSources[index];
    if (caption.start > adjustedTime) break;
    activeIndex = index;
  }

  if (activeIndex < 0) return null;
  const caption = ytdBilingualCaptionSources[activeIndex];
  if (caption.end !== null && adjustedTime >= caption.end) return null;
  return caption;
}

function normalizeBilingualCaptionMatchText(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function scoreBilingualCaptionTextMatch(nativeMatchText, captionMatchText) {
  if (!nativeMatchText || !captionMatchText) return 0;
  if (nativeMatchText === captionMatchText) return 10_000;

  const maxProbe = Math.min(18, captionMatchText.length);
  for (let length = maxProbe; length >= 6; length -= 1) {
    const prefix = captionMatchText.slice(0, length);
    const position = nativeMatchText.indexOf(prefix);
    if (position >= 0) {
      return 5_000 + length * 100 - position;
    }
  }

  const nativePrefix = nativeMatchText.slice(
    0,
    Math.min(12, nativeMatchText.length),
  );
  if (nativePrefix.length >= 6 && captionMatchText.includes(nativePrefix)) {
    return 3_000 + nativePrefix.length * 100;
  }
  return 0;
}

function findNativeBilingualCaption(nativeText, currentTime) {
  const nativeMatchText = normalizeBilingualCaptionMatchText(nativeText);
  if (nativeMatchText.length < 4) return null;

  if (ytdBilingualActiveCaptionId) {
    const active = ytdBilingualCaptionSources.find(
      (caption) => caption.id === ytdBilingualActiveCaptionId,
    );
    const activeMatchText = active
      ? ytdBilingualCaptionMatchKeys.get(active.id) || ""
      : "";
    if (
      active &&
      scoreBilingualCaptionTextMatch(
        nativeMatchText,
        activeMatchText,
      ) > 0
    ) {
      return active;
    }
  }

  let activeIndex = -1;
  for (let index = 0; index < ytdBilingualCaptionSources.length; index += 1) {
    if (ytdBilingualCaptionSources[index].start > currentTime) break;
    activeIndex = index;
  }
  const startIndex = Math.max(
    0,
    (activeIndex < 0 ? 0 : activeIndex) - 6,
  );
  const endIndex = Math.min(
    ytdBilingualCaptionSources.length,
    (activeIndex < 0 ? 0 : activeIndex) + 7,
  );
  const candidates = ytdBilingualCaptionSources
    .slice(startIndex, endIndex)
    .map((caption) => ({
      caption,
      matchText:
        ytdBilingualCaptionMatchKeys.get(caption.id) ||
        normalizeBilingualCaptionMatchText(caption.text),
    }))
    .filter((item) => item.matchText);

  let best = null;
  let bestScore = 0;
  candidates.forEach((item) => {
    const score = scoreBilingualCaptionTextMatch(
      nativeMatchText,
      item.matchText,
    );
    if (score > bestScore) {
      best = item.caption;
      bestScore = score;
    }
  });
  return best;
}

function findClosestBilingualCaption(currentTime) {
  let best = null;
  let bestDistance = Infinity;

  ytdBilingualCaptionSources.forEach((caption) => {
    const start = Number(caption.start);
    const end = Number(caption.end);
    if (!Number.isFinite(start)) return;
    if (
      Number.isFinite(end) &&
      currentTime >= start &&
      currentTime <= end
    ) {
      best = caption;
      bestDistance = 0;
      return;
    }

    const distance = Math.min(
      Math.abs(currentTime - start),
      Number.isFinite(end) ? Math.abs(currentTime - end) : Infinity,
    );
    if (distance < bestDistance) {
      best = caption;
      bestDistance = distance;
    }
  });

  return bestDistance <= 3 ? best : null;
}

function updatePlayerBilingualCaption() {
  if (ytdBilingualCaptionSelectionActive) return;

  const player = getYouTubePlayer();
  const overlay = ytdBilingualCaptionOverlay;
  if (!player || !overlay || !ytdBilingualCaptionSources.length) {
    if (overlay) overlay.hidden = true;
    player?.classList.remove(BILINGUAL_CAPTION_HIDE_CLASS);
    return;
  }
  syncNativeCaptionObserver();

  const video = player.querySelector("video.html5-main-video");
  const currentTime = video?.currentTime || 0;
  const nativeText = getNativeYouTubeCaptionText();
  const nativeCaption = nativeText
    ? findNativeBilingualCaption(nativeText, currentTime)
    : null;
  const clockCaption = findActiveBilingualCaption(currentTime);
  // Supadata-backed clock timing must win whenever it has a cue. Native DOM
  // captions can update a few frames late; preferring them here makes the
  // overlay fall back to the previous sentence and look delayed.
  const caption =
    clockCaption ||
    nativeCaption ||
    findClosestBilingualCaption(currentTime);
  if (!caption) {
    overlay.hidden = true;
    player.classList.remove(BILINGUAL_CAPTION_HIDE_CLASS);
    return;
  }
  ytdBilingualActiveCaptionId = caption.id;

  const source = overlay.querySelector(".ytd-bilingual-caption-source");
  const translation = overlay.querySelector(
    ".ytd-bilingual-caption-translation",
  );
  const translatedText = ytdBilingualCaptionTranslations.get(caption.id) || "";
  const showSource = ytdBilingualCaptionDisplayMode !== "zh";
  const showTranslation = ytdBilingualCaptionDisplayMode !== "original";

  source.textContent = caption.text;
  source.hidden = !showSource;
  translation.hidden = !showTranslation;
  translation.textContent = showTranslation
    ? translatedText || "Translating..."
    : "";
  translation.classList.toggle(
    "pending",
    showTranslation && !translatedText,
  );
  overlay.hidden = false;
  player.classList.add(BILINGUAL_CAPTION_HIDE_CLASS);
}

function getPlayerCaptionOverlay() {
  return document.getElementById("ytd-bilingual-caption-overlay");
}

function getPlayerCaptionById(captionId) {
  return (
    ytdBilingualCaptionSources.find(
      (caption) => caption.id === captionId,
    ) || null
  );
}

function getPlayerCaptionTranscriptContext(captionId) {
  const index = ytdBilingualCaptionSources.findIndex(
    (caption) => caption.id === captionId,
  );
  if (index < 0) return "";
  return ytdBilingualCaptionSources
    .slice(Math.max(0, index - 4), index + 5)
    .map((caption) => {
      const translation = ytdBilingualCaptionTranslations.get(caption.id);
      return translation
        ? `${caption.text} | ${translation}`
        : caption.text;
    })
    .join("\n");
}

function createPlayerCaptionExplainModal(selectedText) {
  const player = getYouTubePlayer();
  if (!player) return null;

  document.getElementById("ytd-caption-explain-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "ytd-caption-explain-overlay";
  overlay.className = "ytd-caption-explain-overlay";
  overlay.innerHTML = `
    <div class="ytd-caption-explain-modal" role="dialog" aria-modal="true" aria-label="Explain selected subtitle">
      <div class="ytd-caption-explain-header">
        <div class="ytd-caption-explain-title">Explain</div>
        <button class="ytd-caption-explain-close" type="button">Close</button>
      </div>
      <div class="ytd-caption-explain-selection">"${escapeHtmlForContent(
        selectedText.slice(0, 240),
      )}${selectedText.length > 240 ? "..." : ""}"</div>
      <div class="ytd-caption-explain-content" id="ytd-caption-explain-content">
        Analyzing...
      </div>
    </div>
  `;
  player.appendChild(overlay);

  const close = () => dismissPlayerCaptionSelectionActions(true);
  overlay
    .querySelector(".ytd-caption-explain-close")
    ?.addEventListener("click", close);
  overlay.addEventListener("mousedown", (event) => {
    event.stopPropagation();
    if (event.target === overlay) close();
  });
  return overlay;
}

async function explainPlayerCaptionSelection(selectedText) {
  const modal = createPlayerCaptionExplainModal(selectedText);
  if (!modal) return;
  const content = modal.querySelector("#ytd-caption-explain-content");
  const selection = ytdBilingualCaptionSelection;
  const videoInfo = extractVideoInfo();

  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText,
      transcriptContext: getPlayerCaptionTranscriptContext(
        selection?.captionId || "",
      ),
      videoTitle: videoInfo.title,
    });
    if (!content) return;
    if (result?.success) {
      content.textContent = result.explanation;
      content.classList.remove("error");
    } else {
      content.textContent = `Failed to get explanation: ${
        result?.error || "Unknown error"
      }`;
      content.classList.add("error");
    }
  } catch (error) {
    if (!content) return;
    content.textContent = `Error: ${error.message}`;
    content.classList.add("error");
  }
}

async function savePlayerCaptionSelectionAsNote(button) {
  const selection = ytdBilingualCaptionSelection;
  if (!selection?.text) return;

  const videoId = new URLSearchParams(window.location.search).get("v");
  if (!videoId) return;
  const videoInfo = extractVideoInfo();
  const originalLabel = button.textContent;
  button.textContent = "Saving...";
  button.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId,
      timestamp: selection.timestampSeconds,
      videoTitle: videoInfo.title,
      channelName: videoInfo.channelName,
      selectedText: selection.text,
    });
    if (!result?.success) {
      throw new Error(result?.error || "Could not save note");
    }
    button.textContent = "Saved";
    showNoteSavedToast(result.note);
    setTimeout(() => {
      button.textContent = originalLabel;
      button.disabled = false;
      dismissPlayerCaptionSelectionActions(true);
    }, 700);
  } catch (error) {
    console.error("[YouTube Digest] Save subtitle selection note error:", error);
    button.textContent = "Error";
    setTimeout(() => {
      button.textContent = originalLabel;
      button.disabled = false;
    }, 1400);
  }
}

function ensurePlayerCaptionSelectionToolbar() {
  const player = getYouTubePlayer();
  if (!player) return null;

  const existing = document.getElementById("ytd-caption-selection-toolbar");
  if (existing) {
    if (existing.parentElement !== player) {
      existing.remove();
    } else {
      ytdBilingualCaptionSelectionToolbar = existing;
      return existing;
    }
  }
  if (ytdBilingualCaptionSelectionToolbar?.isConnected) {
    return ytdBilingualCaptionSelectionToolbar;
  }

  const toolbar = document.createElement("div");
  toolbar.id = "ytd-caption-selection-toolbar";
  toolbar.className = "ytd-caption-selection-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Selected subtitle actions");
  toolbar.innerHTML = `
    <button class="ytd-caption-explain-btn" type="button">Explain</button>
    <button class="ytd-caption-note-btn" type="button">Note</button>
  `;
  toolbar.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  toolbar.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  toolbar.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  toolbar
    .querySelector(".ytd-caption-explain-btn")
    ?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const selection = ytdBilingualCaptionSelection;
      if (!selection?.text) return;
      toolbar.style.display = "none";
      void explainPlayerCaptionSelection(selection.text);
    });
  toolbar
    .querySelector(".ytd-caption-note-btn")
    ?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void savePlayerCaptionSelectionAsNote(event.currentTarget);
    });

  player.appendChild(toolbar);
  ytdBilingualCaptionSelectionToolbar = toolbar;
  return toolbar;
}

function showPlayerCaptionSelectionActions() {
  const selection = window.getSelection?.();
  const text = selection?.toString().trim() || "";
  const range =
    selection?.rangeCount && selection.getRangeAt
      ? selection.getRangeAt(0)
      : null;
  const overlay = getPlayerCaptionOverlay();
  const player = getYouTubePlayer();
  if (
    !text ||
    !range ||
    !overlay ||
    !player ||
    !overlay.contains(range.startContainer) ||
    !overlay.contains(range.endContainer)
  ) {
    return false;
  }

  const activeCaption = getPlayerCaptionById(ytdBilingualActiveCaptionId);
  const video = player.querySelector("video.html5-main-video");
  ytdBilingualCaptionSelection = {
    text,
    captionId: activeCaption?.id || "",
    timestampSeconds: Math.max(
      0,
      Math.floor(
        Number(activeCaption?.start) ||
          Number(video?.currentTime) ||
          0,
      ),
    ),
  };

  const toolbar = ensurePlayerCaptionSelectionToolbar();
  if (!toolbar) return false;
  const selectionRect = range.getBoundingClientRect();
  const playerRect = player.getBoundingClientRect();
  const centeredLeft =
    selectionRect.left -
    playerRect.left +
    selectionRect.width / 2;
  const maxLeft = Math.max(70, playerRect.width - 70);
  const belowSelection = selectionRect.bottom - playerRect.top + 8;
  const aboveSelection = selectionRect.top - playerRect.top - 42;
  const toolbarTop =
    belowSelection + 38 <= playerRect.height
      ? belowSelection
      : Math.max(8, aboveSelection);
  toolbar.style.left = `${Math.max(70, Math.min(maxLeft, centeredLeft))}px`;
  toolbar.style.top = `${toolbarTop}px`;
  toolbar.style.display = "flex";
  return true;
}

function dismissPlayerCaptionSelectionActions(clearSelection = false) {
  if (ytdBilingualCaptionSelectionToolbar) {
    ytdBilingualCaptionSelectionToolbar.style.display = "none";
  }
  document.getElementById("ytd-caption-explain-overlay")?.remove();
  ytdBilingualCaptionSelectionActive = false;
  ytdBilingualCaptionSelection = null;
  if (clearSelection) {
    window.getSelection?.()?.removeAllRanges();
  }
}

function bindPlayerCaptionSelectionActions() {
  if (ytdBilingualCaptionSelectionListenersBound) return;
  ytdBilingualCaptionSelectionListenersBound = true;

  document.addEventListener(
    "mousedown",
    (event) => {
      const overlay = getPlayerCaptionOverlay();
      const toolbar = ytdBilingualCaptionSelectionToolbar;
      if (toolbar?.contains(event.target)) return;
      if (overlay?.contains(event.target)) {
        event.stopPropagation();
        ytdBilingualCaptionSelectionActive = true;
        const video = getYouTubePlayer()?.querySelector(
          "video.html5-main-video",
        );
        video?.pause?.();
        if (toolbar) toolbar.style.display = "none";
        return;
      }
      if (
        !document
          .getElementById("ytd-caption-explain-overlay")
          ?.contains(event.target)
      ) {
        dismissPlayerCaptionSelectionActions();
      }
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    (event) => {
      const toolbar = ytdBilingualCaptionSelectionToolbar;
      if (toolbar?.contains(event.target)) return;
      if (!ytdBilingualCaptionSelectionActive) return;
      event.stopPropagation();
      setTimeout(() => {
        if (!showPlayerCaptionSelectionActions()) {
          ytdBilingualCaptionSelectionActive = false;
        }
      }, 0);
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      dismissPlayerCaptionSelectionActions(true);
    }
  });
}

function escapeHtmlForContent(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function getSafeTimestampedNoteUrl(note) {
  const videoId = String(note?.videoId || "").trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return "";
  const timestampSeconds = Math.max(
    0,
    Math.floor(Number(note?.timestampSeconds) || 0),
  );
  return `https://www.youtube.com/watch?v=${videoId}&t=${timestampSeconds}s`;
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * YouTube is a "Single Page Application" (SPA). This means when you
 * click on a new video, the page doesn't fully reload — YouTube
 * dynamically swaps out the content. So our content script stays alive
 * but needs to detect when the video changes.
 *
 * We watch for URL changes using the `yt-navigate-finish` event,
 * which YouTube fires after navigation completes. When that happens,
 * we clean up old markers and re-inject the button.
 */
document.addEventListener("yt-navigate-finish", () => {
  clearPlayerBilingualCaptions();

  // Clean up old key moment markers when navigating to a new video
  const existingMarkers = document.querySelectorAll(".ytd-key-moment-markers");
  existingMarkers.forEach((m) => m.remove());

  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll("#ytd-digest-button")
    .forEach((button) => button.remove());
  ytdDigestButton = null;
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
    digestButtonReconcileTimer = null;
  }

  const existingNoteButton = document.getElementById("ytd-note-button");
  if (existingNoteButton) existingNoteButton.remove();

  // Reset note button state
  ytdNoteButton = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Remove any toasts
  const existingToast = document.getElementById("ytd-note-toast");
  if (existingToast) existingToast.remove();

  // Re-inject buttons for the new video (with a small delay for YouTube to render)
  setTimeout(() => {
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
});
