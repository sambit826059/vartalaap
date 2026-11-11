// Chat UI. Two responsibilities worth calling out:
//
//   1. Safe rendering of assistant output. Everything is HTML-escaped first,
//      then a conservative markdown subset is reintroduced (bold/italic/code/
//      fenced code). No raw HTML pass-through, no images, no custom elements.
//
//   2. Link allowlist. The only hyperlinks we render in a given assistant
//      turn are those whose URLs appear in that turn's citations. Anything
//      else renders as inert text — the single defense that closes the
//      markdown-exfiltration channel at the UI layer.

// ---- state ----------------------------------------------------------------

const state = {
  conversationId: localStorage.getItem("conversationId") || null,
  conversations: [],
  busy: false,
};

const els = {
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  composer: document.getElementById("composer"),
  status: document.getElementById("status-bar"),
  convList: document.getElementById("conversation-list"),
  newChat: document.getElementById("new-chat"),
  backend: document.getElementById("backend-badge"),
  title: document.getElementById("conversation-title"),
};

// ---- safe rendering -------------------------------------------------------

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render assistant markdown safely.
 * Escapes everything first, then selectively reintroduces a tiny markdown
 * subset. Links are ONLY rendered if their href is in allowedUrls.
 */
function renderMarkdown(text, allowedUrls, citations) {
  // 1. Strip image markdown entirely — matches markdown-exfiltration defense.
  //    Also strips bare <img> and <script>-like constructs as a belt-and-
  //    suspenders measure (they'd be escaped anyway by escapeHtml).
  let s = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "[image removed]");

  // 2. Extract fenced code blocks before escaping so we can preserve them.
  const codeBlocks = [];
  s = s.replace(/```([a-z]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang, code });
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  // 3. Escape all HTML.
  s = escapeHtml(s);

  // 4. Reintroduce code blocks (contents escaped).
  s = s.replace(/\x00CODE(\d+)\x00/g, (_, i) => {
    const block = codeBlocks[Number(i)];
    return `<pre><code>${escapeHtml(block.code)}</code></pre>`;
  });

  // 5. Inline code — single backticks.
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);

  // 6. Bold (**x**) and italic (*x* / _x_). Keep these simple — we're not
  //    shipping a markdown spec.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
  s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<em>$1</em>");

  // 7. Links. Match both [text](url) and bare http(s) URLs.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    return renderLink(url.trim(), label);
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)<>"]+)/g, (_, pre, url) => {
    return pre + renderLink(url, url);
  });

  // 8. Citation markers like [1] [2,3]. These are NOT markdown links — they
  //    are references to the citations list and always safe because the URL
  //    lookup is server-provided.
  s = s.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, nums) => {
    const ids = nums
      .split(",")
      .map((n) => parseInt(n.trim(), 10))
      .filter((n) => Number.isFinite(n));
    const chips = ids.map((id) => {
      const c = citations.find((x) => x.id === id);
      if (!c) return `<span class="citation">${id}</span>`;
      return `<a class="citation" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(c.title)}">${id}</a>`;
    });
    return chips.join(" ");
  });

  // 9. Basic paragraphs: convert blank-line breaks.
  s = s
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

  return s;

  function renderLink(url, label) {
    // Reject anything that isn't http/https.
    if (!/^https?:\/\//i.test(url)) {
      return escapeHtml(label);
    }
    const safe = escapeHtml(url);
    const labelEsc = escapeHtml(label);
    if (!allowedUrls.has(url)) {
      // Blocked URL — show the text but not a live link. Tooltip explains.
      return `<a data-blocked href="#" title="Link blocked: not in this turn's citations">${labelEsc}</a>`;
    }
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${labelEsc}</a>`;
  }
}

// ---- DOM helpers ----------------------------------------------------------

function addMessage(role, initialText = "") {
  if (els.messages.querySelector(".welcome")) {
    els.messages.innerHTML = "";
  }
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  const label = role === "user" ? "You" : "Assistant";
  el.innerHTML = `
    <div class="msg-role">${label}</div>
    <div class="msg-body"></div>
  `;
  const body = el.querySelector(".msg-body");
  if (role === "user") {
    body.textContent = initialText;
  } else {
    body.innerHTML = `<span class="cursor"></span>`;
  }
  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
  return body;
}

// Compact inline status strip that lives under the assistant body.
// Replaces the older "chip row" with quieter, Mac-native text indicators.
function addStatus(parentBody, text, cls = "") {
  let strip = parentBody.querySelector(".status-strip");
  if (!strip) {
    strip = document.createElement("div");
    strip.className = "status-strip";
    parentBody.appendChild(strip);
  }
  const item = document.createElement("div");
  item.className = `status-item ${cls}`;
  item.textContent = text;
  strip.appendChild(item);
  return item;
}

function showWelcome() {
  els.messages.innerHTML = `
    <div class="welcome">
      <h2>What can I help with?</h2>
      <p>Search the web and remember our conversations.</p>
      <div class="suggestions">
        <div class="suggestion" data-prompt="What did we shortlist for CRMs?">
          What did we shortlist for CRMs?
          <span class="suggestion-hint">Pure memory recall</span>
        </div>
        <div class="suggestion" data-prompt="Has any of those CRM tools changed pricing since?">
          Has any of those CRM tools changed pricing since?
          <span class="suggestion-hint">Diffing memory against current web</span>
        </div>
        <div class="suggestion" data-prompt="When did I last ask about Postgres hosting?">
          When did I last ask about Postgres hosting?
          <span class="suggestion-hint">Dated semantic lookup</span>
        </div>
      </div>
    </div>`;
  for (const s of els.messages.querySelectorAll(".suggestion")) {
    s.addEventListener("click", () => {
      els.input.value = s.dataset.prompt;
      els.input.focus();
      els.composer.requestSubmit();
    });
  }
}

// ---- API ------------------------------------------------------------------

async function loadConversations() {
  try {
    const res = await fetch("/api/conversations");
    if (!res.ok) return;
    state.conversations = await res.json();
    renderConversationList();
  } catch (e) {
    console.warn("failed to load conversations", e);
  }
}

function renderConversationList() {
  els.convList.innerHTML = "";
  for (const c of state.conversations) {
    const li = document.createElement("li");
    if (c.id === state.conversationId) li.classList.add("active");
    const title = c.summary
      ? c.summary.slice(0, 60)
      : "(new conversation)";
    const date = new Date(c.last_activity_at).toLocaleDateString();
    li.innerHTML = `
      <span class="conv-title"></span>
      <span class="conv-date"></span>
    `;
    li.querySelector(".conv-title").textContent = title;
    li.querySelector(".conv-date").textContent = date;
    li.addEventListener("click", () => loadConversation(c.id));
    els.convList.appendChild(li);
  }
}

async function loadConversation(id) {
  try {
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    state.conversationId = id;
    localStorage.setItem("conversationId", id);
    els.messages.innerHTML = "";
    for (const m of data.messages) {
      const body = addMessage(m.role);
      if (m.role === "user") {
        body.textContent = m.content;
      } else {
        // Old assistant messages — render WITHOUT any allowed URLs (safe default)
        body.innerHTML = renderMarkdown(m.content, new Set(), []);
      }
    }
    els.title.textContent = data.conversation.summary
      ? data.conversation.summary.slice(0, 80)
      : "Conversation";
    renderConversationList();
  } catch (e) {
    console.warn("failed to load conversation", e);
  }
}

async function loadBackend() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return;
    const data = await res.json();
    const label = data.embeddings === "voyage" ? "Voyage" : "Local";
    els.backend.textContent = `${label} embeddings`;
  } catch {
    /* ignore */
  }
}

// ---- send -----------------------------------------------------------------

async function sendMessage(text) {
  if (state.busy) return;
  state.busy = true;
  els.send.disabled = true;
  els.status.textContent = "";

  addMessage("user", text);
  const assistantBody = addMessage("assistant");
  let streamingText = "";
  let citations = [];
  const allowedUrls = new Set();
  let recalled = null;

  const renderStreaming = () => {
    assistantBody.innerHTML =
      renderMarkdown(streamingText, allowedUrls, citations) +
      `<span class="cursor"></span>`;
    els.messages.scrollTop = els.messages.scrollHeight;
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: state.conversationId || undefined,
        message: text,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "request failed" }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE: split on \n\n
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleEvent(parseSse(raw));
      }
    }
  } catch (e) {
    els.status.innerHTML = `<span class="error">${escapeHtml(e.message)}</span>`;
  } finally {
    state.busy = false;
    els.send.disabled = false;
    els.input.focus();
    renderStreaming();
    // Final render without cursor
    assistantBody.innerHTML = renderMarkdown(
      streamingText,
      allowedUrls,
      citations,
    );
    if (citations.length) {
      const sources = document.createElement("div");
      sources.className = "sources";
      const list = citations
        .map(
          (c) =>
            `<li>[${c.id}] <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.title)}</a></li>`,
        )
        .join("");
      sources.innerHTML = `<ol>${list}</ol>`;
      assistantBody.appendChild(sources);
    }
    // Refresh sidebar after turn completes
    loadConversations();
  }

  function handleEvent({ event, data }) {
    if (!event) return;
    let parsed = {};
    try {
      parsed = JSON.parse(data);
    } catch {
      /* ignore */
    }

    if (event === "meta") {
      if (parsed.conversationId && !state.conversationId) {
        state.conversationId = parsed.conversationId;
        localStorage.setItem("conversationId", parsed.conversationId);
      }
      recalled = parsed.recalled || [];
      if (recalled.length) {
        const n = recalled.length;
        addStatus(
          assistantBody,
          `Recalled ${n} past exchange${n > 1 ? "s" : ""} from memory`,
          "recall",
        );
      }
    } else if (event === "tool_start") {
      addStatus(assistantBody, "Searching the web…", "pending");
    } else if (event === "tool_end") {
      const strip = assistantBody.querySelector(".status-strip");
      const pending = strip?.querySelector(".status-item.pending");
      if (pending) {
        const n = parsed.urls?.length ?? 0;
        pending.textContent = `Searched · ${n} result${n === 1 ? "" : "s"}`;
        pending.classList.remove("pending");
        pending.classList.add("done");
      }
    } else if (event === "text") {
      streamingText += parsed.delta || "";
      renderStreaming();
    } else if (event === "citations") {
      citations = parsed.citations || [];
      for (const c of citations) allowedUrls.add(c.url);
      renderStreaming();
    } else if (event === "done") {
      // handled in finally
    } else if (event === "error") {
      els.status.innerHTML = `<span class="error">${escapeHtml(parsed.message || "error")}</span>`;
    }
  }
}

function parseSse(raw) {
  const out = { event: "message", data: "" };
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) out.event = line.slice(6).trim();
    else if (line.startsWith("data:")) out.data = line.slice(5).trim();
  }
  return out;
}

// ---- wire -----------------------------------------------------------------

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  sendMessage(text);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

// Auto-grow the composer textarea — Mac-native feel, grows up to a cap.
els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
});

els.newChat.addEventListener("click", () => {
  state.conversationId = null;
  localStorage.removeItem("conversationId");
  showWelcome();
  els.title.textContent = "New conversation";
  renderConversationList();
  els.input.focus();
});

// ---- init -----------------------------------------------------------------

(async function init() {
  loadBackend();
  await loadConversations();
  if (state.conversationId) {
    await loadConversation(state.conversationId);
  } else {
    showWelcome();
  }
})();
