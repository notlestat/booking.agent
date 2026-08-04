/**
 * Booking chat widget.
 *
 * Plain JavaScript with no build step and no framework, because the deployment
 * target is "paste one script tag onto whatever the gym's website already is".
 * A React bundle would be a worse fit for a WordPress site than 200 lines of DOM.
 *
 * Usage:
 *   <link rel="stylesheet" href="https://your-host/widget.css">
 *   <script src="https://your-host/widget.js" data-api="https://your-host"></script>
 */
(function () {
  "use strict";

  var script = document.currentScript;
  var API_BASE = (script && script.getAttribute("data-api")) || "";
  var STORAGE_KEY = "bkw.sessionId";

  var state = {
    sessionId: null,
    open: false,
    busy: false,
  };

  try {
    state.sessionId = window.sessionStorage.getItem(STORAGE_KEY);
  } catch (_) {
    // Private browsing or blocked storage. A fresh session each load is a fine
    // degradation — don't let it take the whole widget down.
  }

  // --- DOM -----------------------------------------------------------------

  var root = el("div", "bkw-root");

  var launcher = el("button", "bkw-launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open chat");
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.9A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 17 0z"/></svg>';

  var panel = el("div", "bkw-panel");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Booking chat");

  var header = el("div", "bkw-header");
  var headings = el("div");
  var title = el("div", "bkw-title", "Chat");
  var subtitle = el("div", "bkw-subtitle", "Usually replies instantly");
  headings.appendChild(title);
  headings.appendChild(subtitle);

  var close = el("button", "bkw-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close chat");

  header.appendChild(headings);
  header.appendChild(close);

  var log = el("div", "bkw-log");
  // Screen readers announce new messages without stealing focus.
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

  var suggestions = el("div", "bkw-suggestions");

  var composer = el("form", "bkw-composer");
  var input = el("textarea", "bkw-input");
  input.rows = 1;
  input.placeholder = "Ask a question, or book a session…";
  input.setAttribute("aria-label", "Message");

  var send = el("button", "bkw-send", "Send");
  send.type = "submit";

  composer.appendChild(input);
  composer.appendChild(send);

  panel.appendChild(header);
  panel.appendChild(log);
  panel.appendChild(suggestions);
  panel.appendChild(composer);
  root.appendChild(panel);
  root.appendChild(launcher);
  document.body.appendChild(root);

  // --- Behaviour -----------------------------------------------------------

  launcher.addEventListener("click", toggle);
  close.addEventListener("click", toggle);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.open) toggle();
  });

  composer.addEventListener("submit", function (event) {
    event.preventDefault();
    submit(input.value);
  });

  // Enter sends; Shift+Enter makes a newline. Standard chat behaviour.
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(input.value);
    }
  });

  // Grow the textarea with its content, up to the CSS max-height.
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  function toggle() {
    state.open = !state.open;
    panel.hidden = !state.open;
    launcher.setAttribute("aria-label", state.open ? "Close chat" : "Open chat");
    if (state.open) {
      input.focus();
      scrollToBottom();
    } else {
      launcher.focus();
    }
  }

  function submit(raw) {
    var text = (raw || "").trim();
    if (!text || state.busy) return;

    input.value = "";
    input.style.height = "auto";
    suggestions.textContent = "";

    addMessage(text, "user");
    sendToServer(text);
  }

  function sendToServer(text) {
    state.busy = true;
    send.disabled = true;
    var typing = addTyping();

    fetch(API_BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, message: text }),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        typing.remove();
        if (result.data && result.data.sessionId) {
          state.sessionId = result.data.sessionId;
          try {
            window.sessionStorage.setItem(STORAGE_KEY, state.sessionId);
          } catch (_) {}
        }
        if (result.data && result.data.reply) {
          addMessage(result.data.reply, "bot");
        } else {
          addMessage("Sorry, I didn't catch that. Could you try again?", "error");
        }
      })
      .catch(function () {
        typing.remove();
        addMessage(
          "I can't reach the booking system right now. Please try again in a moment.",
          "error"
        );
      })
      .then(function () {
        state.busy = false;
        send.disabled = false;
        input.focus();
      });
  }

  function addMessage(text, kind) {
    var node = el("div", "bkw-msg bkw-msg-" + kind);
    // textContent, never innerHTML: model output is untrusted input as far as
    // the DOM is concerned, and this closes off HTML injection entirely.
    node.textContent = text;
    log.appendChild(node);
    scrollToBottom();
    return node;
  }

  function addTyping() {
    var node = el("div", "bkw-msg bkw-msg-bot bkw-typing");
    node.innerHTML = "<span></span><span></span><span></span>";
    node.setAttribute("aria-label", "Assistant is typing");
    log.appendChild(node);
    scrollToBottom();
    return node;
  }

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // --- Boot ----------------------------------------------------------------

  // The greeting, business name, and suggestion chips come from the server so
  // that retargeting the bot to a different business updates the UI too.
  fetch(API_BASE + "/api/config")
    .then(function (r) { return r.json(); })
    .then(function (config) {
      title.textContent = config.name || "Chat";
      if (config.phone) subtitle.textContent = "or call " + config.phone;
      addMessage(config.greeting || "Hi! How can I help?", "bot");

      (config.suggestions || []).forEach(function (suggestion) {
        var chip = el("button", "bkw-chip", suggestion);
        chip.type = "button";
        chip.addEventListener("click", function () { submit(suggestion); });
        suggestions.appendChild(chip);
      });
    })
    .catch(function () {
      addMessage("Hi! How can I help?", "bot");
    });
})();
