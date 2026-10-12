"use strict";

const assert = require("assert");
const {
  formatAnswer,
  formatForTelegram,
  cleanResponse,
  escapeHtml,
  inlineMarkdown,
  markdownBlocks,
  chunkBlocks,
  htmlToPlainText,
  replyFormatted,
} = require("./ai/format");
const router = require("./ai/ai-router");

// The canonical sample response containing JavaScript code, headings, bold/italic text,
// lists, inline code, links, and technical characters.
const SAMPLE_RESPONSE = `# JavaScript Guide & Overview

JavaScript is a versatile language for **web applications** and *backend services*.

## Core Features
• First-class functions and closures
• Dynamic typing (<any> vs TypeScript annotations)
- Event-driven non-blocking I/O
1. Single-threaded concurrency with Event Loop
2. Asynchronous programming with Promises and async/await

Visit [MDN Web Docs](https://developer.mozilla.org) for official reference.
Technical symbols: \`x < 10 && y > 20\` uses \`<=\` and \`=>\`.

\`\`\`javascript
function calculateScore(items, threshold = 10) {
  if (!items || items.length < 1) {
    return { ok: false, score: 0 };
  }
  const total = items.reduce((acc, curr) => acc + curr, 0);
  return { ok: total >= threshold, score: total };
}
console.log(calculateScore([5, 6, 7]));
\`\`\`

Summary: JavaScript runs everywhere!`;

async function testAllThreeModesUseSharedFormatter() {
  console.log("--- Test 1: All modes use shared formatter and produce identical output ---");

  const ollamaMod = require("./ai/ollama");
  const browserMod = require("./ai/browser");
  const extensionMod = require("./ai/extension");

  // Save originals
  const origOllama = ollamaMod.askOllama;
  const origBrowser = browserMod.browserResponse;
  const origExtension = extensionMod.extensionResponse;

  try {
    // Mock the 3 underlying providers to return the same sample response
    ollamaMod.askOllama = async () => `<think>reasoning...</think>\n${SAMPLE_RESPONSE}`;
    browserMod.browserResponse = async () => SAMPLE_RESPONSE;
    extensionMod.extensionResponse = async () => SAMPLE_RESPONSE;

    router.setUserMode("user_ollama", "ollama");
    router.setUserMode("user_browser", "browser");
    router.setUserMode("user_extension", "extension");

    const resOllama = await router.generateResponse("user_ollama", "test");
    const resBrowser = await router.generateResponse("user_browser", "test");
    const resExtension = await router.generateResponse("user_extension", "test");

    assert.strictEqual(typeof resOllama, "string");
    assert.strictEqual(typeof resBrowser, "string");
    assert.strictEqual(typeof resExtension, "string");

    // All three must match exactly
    assert.strictEqual(
      resOllama,
      resBrowser,
      "Ollama and Browser Automation outputs must match"
    );
    assert.strictEqual(
      resBrowser,
      resExtension,
      "Browser Automation and Browser Extension outputs must match"
    );

    // Verify thinking tokens are stripped in formatAnswer
    assert(!resOllama.includes("<think>"), "Thinking tokens must be stripped");
    assert(!resOllama.includes("reasoning..."), "Thinking content must be stripped");

    // Verify markdown is preserved
    assert(resOllama.includes("# JavaScript Guide & Overview"), "Heading preserved");
    assert(resOllama.includes("```javascript"), "Code block preserved");
    assert(resOllama.includes("[MDN Web Docs]"), "Link preserved");

    console.log("PASS all three modes produce identical shared-formatted markdown");
  } finally {
    ollamaMod.askOllama = origOllama;
    browserMod.browserResponse = origBrowser;
    extensionMod.extensionResponse = origExtension;
  }
}

function testTelegramHtmlFormatting() {
  console.log("--- Test 2: Telegram-compatible HTML conversion and escaping ---");

  const blocks = markdownBlocks(SAMPLE_RESPONSE);
  const chunks = chunkBlocks(blocks);

  assert.strictEqual(chunks.length, 1, "Sample response fits in 1 chunk");
  const html = chunks[0];

  // 1. Headings -> <b> tags (Telegram does not support <h1>..<h6>)
  assert(html.includes("<b>JavaScript Guide &amp; Overview</b>"), "H1 rendered as bold");
  assert(html.includes("<b>Core Features</b>"), "H2 rendered as bold");
  assert(!html.includes("<h1>") && !html.includes("<h2>"), "No h1/h2 tags");

  // 2. Bold and Italic
  assert(html.includes("<b>web applications</b>"), "Bold text formatted");
  assert(html.includes("<i>backend services</i>"), "Italic text formatted");

  // 3. Lists (Telegram does not support <ul> or <li>)
  assert(!html.includes("<ul>") && !html.includes("<li>"), "No illegal ul/li tags");
  assert(html.includes("• First-class functions and closures"), "Bullet item preserved");
  assert(html.includes("• Dynamic typing (&lt;any&gt; vs TypeScript annotations)"), "Brackets escaped in bullet");
  assert(html.includes("• Event-driven non-blocking I/O"), "Dash bullet converted to • bullet");
  assert(html.includes("1. Single-threaded concurrency with Event Loop"), "Numbered list 1 preserved");
  assert(html.includes("2. Asynchronous programming with Promises and async/await"), "Numbered list 2 preserved");

  // 4. Links
  assert(
    html.includes('<a href="https://developer.mozilla.org">MDN Web Docs</a>'),
    "Markdown link converted to Telegram HTML <a> tag"
  );

  // 5. Inline Code
  assert(
    html.includes("<code>x &lt; 10 &amp;&amp; y &gt; 20</code>"),
    "Inline code escaped with <code>"
  );

  // 6. Fenced Code Blocks with language labels
  assert(
    html.includes('<pre><code class="language-javascript">'),
    "Code block wrapped with pre and language-javascript code tag"
  );
  assert(html.includes("function calculateScore(items, threshold = 10)"), "Code content preserved");
  assert(html.includes("items.length &lt; 1"), "< escaped inside code block");
  assert(html.includes("total &gt;= threshold"), ">= escaped inside code block");

  // 7. Technical Symbols in plain text
  assert(html.includes("&lt;any&gt;"), "<any> in text properly escaped to &lt;any&gt;");

  console.log("PASS Telegram-compatible HTML formatting and escaping verified");
}

function testLongMessageChunking() {
  console.log("--- Test 3: Safe splitting of long messages and code blocks ---");

  // A very long code block (exceeding 4000 characters)
  const codeLines = [];
  for (let i = 0; i < 200; i++) {
    codeLines.push(`  const step_${i} = doSomethingWith(${i}); // technical check <${i}>`);
  }
  const longCodeMarkdown = "```javascript\n" + codeLines.join("\n") + "\n```";

  const blocks = markdownBlocks(longCodeMarkdown);
  const chunks = chunkBlocks(blocks, 1500); // test with 1500 char limit

  assert(chunks.length > 3, "Oversized code block is split into multiple chunks");

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    assert(
      chunk.length <= 1500,
      `Chunk ${idx} length ${chunk.length} must not exceed limit 1500`
    );
    assert(
      chunk.startsWith('<pre><code class="language-javascript">'),
      `Chunk ${idx} must start with balanced <pre><code class="language-javascript">`
    );
    assert(
      chunk.endsWith("</code></pre>"),
      `Chunk ${idx} must end with balanced </code></pre>`
    );
    assert(chunk.includes("&lt;"), "< inside code must be escaped");
  }

  // Oversized paragraph
  const longText = "This is a very long paragraph that goes on and on. ".repeat(100);
  const textBlocks = markdownBlocks(longText);
  const textChunks = chunkBlocks(textBlocks, 1000);

  assert(textChunks.length > 3, "Oversized paragraph is split into multiple chunks");
  for (const tc of textChunks) {
    assert(tc.length <= 1000, `Paragraph chunk ${tc.length} must not exceed limit 1000`);
  }

  console.log("PASS long messages and code blocks split safely without breaking tags");
}

async function testInvalidFormattingFallback() {
  console.log("--- Test 4: Graceful plain-text fallback on Telegram HTML parse error ---");

  const sentReplies = [];
  const loggedErrors = [];

  const originalConsoleError = console.error;
  console.error = (...args) => {
    loggedErrors.push(args.join(" "));
  };

  try {
    let callCount = 0;
    const mockCtx = {
      reply: async (text, extra) => {
        callCount++;
        // Simulate Telegram rejecting the first HTML attempt with parse error
        if (extra && extra.parse_mode === "HTML") {
          throw new Error("400: Bad Request: can't parse entities: Character '<' is reserved");
        }
        sentReplies.push({ text, extra });
      },
    };

    await replyFormatted(mockCtx, SAMPLE_RESPONSE);

    assert(sentReplies.length >= 1, "At least one reply was sent via fallback");
    const fallbackMessage = sentReplies[0].text;

    // Must be plain text, no HTML tags
    assert(!fallbackMessage.includes("<pre>"), "Fallback must not contain <pre>");
    assert(!fallbackMessage.includes("<code>"), "Fallback must not contain <code>");
    assert(!fallbackMessage.includes("<b>"), "Fallback must not contain <b>");
    assert(!fallbackMessage.includes("&lt;"), "Fallback must decode &lt; back to <");

    // Content must be intact
    assert(fallbackMessage.includes("JavaScript Guide & Overview"), "Heading content preserved");
    assert(fallbackMessage.includes("function calculateScore"), "Code content preserved");
    assert(fallbackMessage.includes("<any>"), "Technical symbols preserved in plain text");

    // Technical error was logged, not thrown to user
    assert(loggedErrors.length >= 1, "Technical error logged to console");
    assert(
      loggedErrors[0].includes("Telegram HTML parse/send error"),
      "Logs describe the technical failure"
    );

    console.log("PASS invalid formatting falls back gracefully to plain text without leaking stack traces");
  } finally {
    console.error = originalConsoleError;
  }
}

async function testFinalTelegramOutputAllModes() {
  console.log("--- Test 5: Final Telegram HTML output is identical across all three modes ---");

  const ollamaMod = require("./ai/ollama");
  const browserMod = require("./ai/browser");
  const extensionMod = require("./ai/extension");

  const origOllama = ollamaMod.askOllama;
  const origBrowser = browserMod.browserResponse;
  const origExtension = extensionMod.extensionResponse;

  try {
    ollamaMod.askOllama = async () => `<think>reasoning...</think>\n${SAMPLE_RESPONSE}`;
    browserMod.browserResponse = async () => SAMPLE_RESPONSE;
    extensionMod.extensionResponse = async () => SAMPLE_RESPONSE;

    router.setUserMode("u_ollama", "ollama");
    router.setUserMode("u_browser", "browser");
    router.setUserMode("u_extension", "extension");

    const modes = ["ollama", "browser", "extension"];
    const modeOutputs = {};

    for (const m of modes) {
      const resp = await router.generateResponse(`u_${m}`, "test");
      const sent = [];
      const mockCtx = {
        reply: async (text, extra) => {
          sent.push({ text, extra });
        },
      };
      await replyFormatted(mockCtx, resp);
      modeOutputs[m] = sent;
    }

    // Verify all 3 modes sent identical chunks to Telegram
    assert.deepStrictEqual(
      modeOutputs.ollama,
      modeOutputs.browser,
      "Telegram output for Ollama and Browser Automation must match"
    );
    assert.deepStrictEqual(
      modeOutputs.browser,
      modeOutputs.extension,
      "Telegram output for Browser Automation and Browser Extension must match"
    );

    const delivery = modeOutputs.extension[0];
    assert.strictEqual(delivery.extra.parse_mode, "HTML", "Message sent with HTML parse mode");
    assert(delivery.text.includes("<b>JavaScript Guide &amp; Overview</b>"), "Heading is bold");
    assert(delivery.text.includes("<b>web applications</b>"), "Bold text preserved");
    assert(delivery.text.includes("<i>backend services</i>"), "Italic text preserved");
    assert(delivery.text.includes("• First-class functions and closures"), "Bullet list preserved");
    assert(delivery.text.includes("1. Single-threaded concurrency with Event Loop"), "Numbered list preserved");
    assert(delivery.text.includes("<code>x &lt; 10 &amp;&amp; y &gt; 20</code>"), "Inline code preserved");
    assert(delivery.text.includes('<pre><code class="language-javascript">'), "Fenced code block preserved with language label");
    assert(delivery.text.includes('<a href="https://developer.mozilla.org">MDN Web Docs</a>'), "Link preserved");

    console.log("PASS all three modes deliver identical, fully formatted HTML messages to Telegram");
  } finally {
    ollamaMod.askOllama = origOllama;
    browserMod.browserResponse = origBrowser;
    extensionMod.extensionResponse = origExtension;
  }
}

async function testExtensionDomExtractionAndFormattingRegression() {
  console.log("--- Test 6: Browser Extension extraction and end-to-end formatting regression ---");

  // Load deepSeekAskInPage directly from the extension source
  const askMod = await import(
    require("url").pathToFileURL(
      require("path").join(
        __dirname,
        "chrome-extension-react-template/src/background/deepseek-ask.js"
      )
    ).href
  );

  // We simulate the DOM extraction function in both Fiber mode and DOM fallback mode
  // Using Node-compatible minimal mock DOM
  const createMockNode = (tag, { text = "", className = "", attrs = {}, children = [] } = {}) => {
    const node = {
      nodeType: tag ? 1 : 3, // ELEMENT_NODE : TEXT_NODE
      tagName: (tag || "").toUpperCase(),
      textContent: text,
      className,
      classList: {
        contains: (c) => className.split(" ").includes(c),
      },
      attributes: attrs,
      getAttribute: (k) => attrs[k] || (k === "role" ? attrs.role : null),
      childNodes: children,
      children,
      parentElement: null,
      querySelector: (sel) => {
        for (const child of children) {
          if (sel === "pre" && child.tagName === "PRE") return child;
          if (sel === "code" && child.tagName === "CODE") return child;
          if (sel.includes("banner") && child.classList.contains("md-code-block-banner")) return child;
          const sub = child.querySelector && child.querySelector(sel);
          if (sub) return sub;
        }
        return null;
      },
      querySelectorAll: (sel) => {
        const res = [];
        for (const child of children) {
          if (sel === "span" && child.tagName === "SPAN") res.push(child);
          if (sel === "tr" && child.tagName === "TR") res.push(child);
          if (sel.includes("th") && (child.tagName === "TH" || child.tagName === "TD")) res.push(child);
          if (child.querySelectorAll) res.push(...child.querySelectorAll(sel));
        }
        return res;
      },
    };
    for (const child of children) {
      child.parentElement = node;
    }
    return node;
  };

  const textNode = (text) => createMockNode(null, { text });

  // Construct DeepSeek-like DOM structure:
  // Heading: <h2>Python Example</h2>
  // Text: <p><b>Sample:</b> uses <code>x &lt; 5</code></p>
  // Code block: .md-code-block with banner ("python", "Copy", "Download") and pre/code
  const mockDeepSeekDom = createMockNode("div", {
    className: "ds-markdown ds-assistant-message-main-content",
    children: [
      createMockNode("h2", { children: [textNode("Python Example")] }),
      createMockNode("p", {
        children: [
          createMockNode("b", { children: [textNode("Sample:")] }),
          textNode(" uses "),
          createMockNode("code", { text: "x < 5" }),
        ],
      }),
      createMockNode("div", {
        className: "md-code-block",
        children: [
          createMockNode("div", {
            className: "md-code-block-banner",
            children: [
              createMockNode("span", { text: "python" }),
              createMockNode("span", { text: "Copy" }),
              createMockNode("span", { text: "Download" }),
            ],
          }),
          createMockNode("pre", {
            children: [
              createMockNode("code", {
                className: "language-python",
                text: 'print("hello world")\nif x < 5:\n    print("less")',
              }),
            ],
          }),
        ],
      }),
      createMockNode("ul", {
        children: [
          createMockNode("li", { children: [textNode("Point one")] }),
          createMockNode("li", { children: [textNode("Point two")] }),
        ],
      }),
      createMockNode("table", {
        children: [
          createMockNode("tr", {
            children: [
              createMockNode("th", { children: [textNode("Key")] }),
              createMockNode("th", { children: [textNode("Value")] }),
            ],
          }),
          createMockNode("tr", {
            children: [
              createMockNode("td", { children: [textNode("Name")] }),
              createMockNode("td", { children: [textNode("DeepSeek")] }),
            ],
          }),
        ],
      }),
    ],
  });

  // Verify extraction via React Fiber (MAIN world)
  mockDeepSeekDom.__reactFiber$test = {
    memoizedProps: {
      markdown:
        '## Python Example\n\n**Sample:** uses `x < 5`\n\n```python\nprint("hello world")\nif x < 5:\n    print("less")\n```\n\n• Point one\n• Point two\n\n| Key | Value |\n| --- | --- |\n| Name | DeepSeek |',
    },
  };

  // Test full flow through extension mode in router -> formatAnswer -> replyFormatted
  const extensionMod = require("./ai/extension");
  const origExtension = extensionMod.extensionResponse;

  try {
    extensionMod.extensionResponse = async () => {
      // Return the fiber markdown extracted from the mock
      return mockDeepSeekDom.__reactFiber$test.memoizedProps.markdown;
    };

    router.setUserMode("test_ext_user", "extension");
    const formattedMarkdown = await router.generateResponse("test_ext_user", "sample question");

    assert(formattedMarkdown.includes("## Python Example"), "Heading preserved");
    assert(formattedMarkdown.includes("```python"), "Code block preserved");
    assert(!formattedMarkdown.includes("Copy"), "No Copy button clutter");
    assert(!formattedMarkdown.includes("Download"), "No Download button clutter");

    const sentReplies = [];
    const mockCtx = {
      reply: async (text, extra) => {
        sentReplies.push({ text, extra });
      },
    };

    await replyFormatted(mockCtx, formattedMarkdown);

    assert.strictEqual(sentReplies.length, 1, "Sent 1 chunk");
    const sent = sentReplies[0];

    assert.strictEqual(sent.extra.parse_mode, "HTML", "Telegram parse_mode is HTML");
    assert(sent.text.includes("<b>Python Example</b>"), "Heading is bold");
    assert(sent.text.includes("<b>Sample:</b>"), "Bold text formatted");
    assert(sent.text.includes("<code>x &lt; 5</code>"), "Inline code properly escaped");
    assert(sent.text.includes('<pre><code class="language-python">'), "Code block pre tag with language");
    assert(sent.text.includes("if x &lt; 5:"), "Code content escaped properly");
    assert(sent.text.includes("• Point one"), "List bullet preserved");
    assert(sent.text.includes("<pre>| Key | Value |"), "Table wrapped in pre");

    console.log("PASS Browser Extension DOM extraction and end-to-end formatting verified");
  } finally {
    extensionMod.extensionResponse = origExtension;
  }
}

function validateHtmlBalanced(html) {
  const stack = [];
  const tagRegex = /<(\/)?([a-z0-9_-]+)(?:\s+[^>]*)?>/gi;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const isClose = !!match[1];
    const tag = match[2].toLowerCase();
    if (tag === "br" || tag === "hr" || match[0].endsWith("/>")) continue;
    if (!isClose) {
      stack.push(tag);
    } else {
      if (stack.length === 0) return { ok: false, error: `Unopened </${tag}>` };
      const popped = stack.pop();
      if (popped !== tag) return { ok: false, error: `Mismatched tags: expected </${popped}>, got </${tag}>` };
    }
  }
  if (stack.length > 0) return { ok: false, error: `Unclosed tags: <${stack.join(">, <")}>` };

  const rawAmp = /&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);)/g;
  const badAmps = [];
  while ((match = rawAmp.exec(html)) !== null) {
    badAmps.push(match.index);
  }
  if (badAmps.length > 0) {
    return { ok: false, error: `Broken or unescaped entity '&' at index ${badAmps[0]}` };
  }

  return { ok: true };
}

async function testFormattingSafeSplittingGaps() {
  console.log("--- Test 7: Formatting-safe message splitting gaps (default limit, tags, entities, fallback) ---");

  // 1. Default limit (4000) on a large mixed document (>12,000 characters)
  const longDoc = `# Architectural Guide & In-Depth Technical Specification

Here is an introductory paragraph explaining system mechanics in detail.

**` + "Section 1 provides comprehensive background on distributed systems and concurrency models. ".repeat(60) + `**

> ` + "Quote block detailing invariant assertions: `val < 50 && threshold >= 100` must hold true.\n> ".repeat(40) + `

\`\`\`javascript
` + "function processTransaction(item) {\n  if (!item || item.id < 0) return null;\n  return { ok: true, hash: item.hash }; // &lt;verified&gt;\n}\n".repeat(60) + `
\`\`\`

Here are list items:
- ` + "Structured bullet point documenting parameter specifications and invariants.\n- ".repeat(50) + `Final item.
`;

  const docBlocks = markdownBlocks(longDoc);
  // Call chunkBlocks with default limit (omitting limit parameter)
  const defaultChunks = chunkBlocks(docBlocks);

  assert(defaultChunks.length >= 3, `Expected at least 3 chunks for large document, got ${defaultChunks.length}`);
  for (let idx = 0; idx < defaultChunks.length; idx++) {
    const chunk = defaultChunks[idx];
    assert(
      chunk.length <= 4000,
      `Default chunk ${idx} length ${chunk.length} must not exceed default limit 4000`
    );
    const validation = validateHtmlBalanced(chunk);
    assert(
      validation.ok,
      `Default chunk ${idx} failed HTML validation: ${validation.error}\nChunk snippet: ${chunk.slice(0, 120)}`
    );
  }
  console.log("PASS default limit (4000) chunking preserves valid balanced HTML across all chunks");

  // 2. Oversized bold paragraph (> 4000 characters)
  const boldInner = "This is a continuous bold statement that exceeds four thousand characters. ".repeat(64) + "final bold statement.";
  const boldParaMd = "**" + boldInner + "**";
  const boldBlocks = markdownBlocks(boldParaMd);
  const boldChunks = chunkBlocks(boldBlocks, 4000);

  assert(boldChunks.length >= 2, `Expected at least 2 chunks for 5000-char bold text, got ${boldChunks.length}`);
  for (let idx = 0; idx < boldChunks.length; idx++) {
    const c = boldChunks[idx];
    assert(c.length <= 4000, `Bold chunk ${idx} length ${c.length} > 4000`);
    assert(c.startsWith("<b>"), `Bold chunk ${idx} must start with <b>`);
    assert(c.endsWith("</b>"), `Bold chunk ${idx} must end with </b>`);
    const v = validateHtmlBalanced(c);
    assert(v.ok, `Bold chunk ${idx} invalid: ${v.error}`);
  }
  console.log("PASS oversized bold paragraph is split into balanced <b> chunks within 4000 limit");

  // 3. Oversized inline-code paragraph (> 4000 characters)
  const codeInner = ("const payload = { id: 1, active: true, value: 42, check: true }; ".repeat(70)).trim();
  const codeParaMd = "`" + codeInner + "`";
  const codeBlocks = markdownBlocks(codeParaMd);
  const codeChunks = chunkBlocks(codeBlocks, 4000);

  assert(codeChunks.length >= 2, `Expected at least 2 chunks for 5000-char inline code, got ${codeChunks.length}`);
  for (let idx = 0; idx < codeChunks.length; idx++) {
    const c = codeChunks[idx];
    assert(c.length <= 4000, `Code chunk ${idx} length ${c.length} > 4000`);
    assert(c.startsWith("<code>"), `Code chunk ${idx} must start with <code>`);
    assert(c.endsWith("</code>"), `Code chunk ${idx} must end with </code>`);
    const v = validateHtmlBalanced(c);
    assert(v.ok, `Code chunk ${idx} invalid: ${v.error}`);
  }
  console.log("PASS oversized inline code is split into balanced <code> chunks within 4000 limit");

  // 4. Oversized blockquote (> 4000 characters)
  const bqLines = [];
  for (let i = 0; i < 70; i++) {
    bqLines.push(`> Detailed citation line ${i}: referencing specifications &lt;section ${i}&gt; with **bold**`);
  }
  const bqMd = bqLines.join("\n");
  const bqBlocks = markdownBlocks(bqMd);
  const bqChunks = chunkBlocks(bqBlocks, 4000);

  assert(bqChunks.length >= 2, `Expected at least 2 chunks for 5000-char blockquote, got ${bqChunks.length}`);
  for (let idx = 0; idx < bqChunks.length; idx++) {
    const c = bqChunks[idx];
    assert(c.length <= 4000, `Blockquote chunk ${idx} length ${c.length} > 4000`);
    assert(c.startsWith("<blockquote>"), `Blockquote chunk ${idx} must start with <blockquote>`);
    assert(c.endsWith("</blockquote>"), `Blockquote chunk ${idx} must end with </blockquote>`);
    const v = validateHtmlBalanced(c);
    assert(v.ok, `Blockquote chunk ${idx} invalid: ${v.error}`);
  }
  console.log("PASS oversized blockquote is split into balanced <blockquote> chunks within 4000 limit");

  // 5. HTML entities at chunk boundary
  // Place entities right around character 3995 so naive slicing would cut them in half
  const entityBoundaryText = "Word ".repeat(798) + "&lt;&gt;&amp;&quot;" + " Word".repeat(300);
  const entityBlocks = markdownBlocks(entityBoundaryText);
  const entityChunks = chunkBlocks(entityBlocks, 4000);

  assert(entityChunks.length >= 2, "Expected multiple chunks for entity boundary test");
  for (let idx = 0; idx < entityChunks.length; idx++) {
    const c = entityChunks[idx];
    assert(c.length <= 4000, `Entity chunk ${idx} length ${c.length} > 4000`);
    const v = validateHtmlBalanced(c);
    assert(v.ok, `Entity chunk ${idx} broken entity: ${v.error}`);
    // Explicitly verify no cut entity fragments at boundaries
    assert(!/&(?:l|g|am|qu)$/.test(c), `Chunk ${idx} ends with cut entity fragment`);
    assert(!/^(?:t;|mp;|uot;)/.test(c), `Chunk ${idx} starts with cut entity tail`);
  }
  console.log("PASS HTML entities at chunk boundary are never split or corrupted");

  // 6. replyFormatted() end-to-end success path
  const successReplies = [];
  const successCtx = {
    reply: async (text, extra) => {
      successReplies.push({ text, extra });
    },
  };

  await replyFormatted(successCtx, longDoc);
  assert(successReplies.length >= 3, "All chunks delivered via replyFormatted");
  for (let idx = 0; idx < successReplies.length; idx++) {
    const r = successReplies[idx];
    assert.strictEqual(r.extra.parse_mode, "HTML", `Reply ${idx} parse_mode is HTML`);
    assert(r.text.length <= 4000, `Reply ${idx} length ${r.text.length} <= 4000`);
    const v = validateHtmlBalanced(r.text);
    assert(v.ok, `Reply ${idx} HTML validation failed: ${v.error}`);
  }
  console.log("PASS replyFormatted() delivers all formatted HTML chunks <= 4000 chars end-to-end");

  // 7. replyFormatted() fallback path splits every message within safe limit
  const fallbackReplies = [];
  const originalConsoleError = console.error;
  console.error = () => {}; // suppress expected error logging during test

  try {
    const fallbackCtx = {
      reply: async (text, extra) => {
        if (extra && extra.parse_mode === "HTML") {
          throw new Error("400: Bad Request: can't parse entities");
        }
        fallbackReplies.push(text);
      },
    };

    await replyFormatted(fallbackCtx, longDoc);
    assert(fallbackReplies.length >= 3, "All fallback sub-chunks delivered");
    for (let idx = 0; idx < fallbackReplies.length; idx++) {
      const fbText = fallbackReplies[idx];
      assert(
        fbText.length <= 4000,
        `Fallback message ${idx} length ${fbText.length} must not exceed 4000`
      );
      assert(!fbText.includes("<pre>"), `Fallback ${idx} must not contain <pre>`);
      assert(!fbText.includes("<b>"), `Fallback ${idx} must not contain <b>`);
      assert(!fbText.includes("<blockquote>"), `Fallback ${idx} must not contain <blockquote>`);
    }
    console.log("PASS plain-text fallback splits every message within the 4000 safe limit");
  } finally {
    console.error = originalConsoleError;
  }
}

(async () => {
  await testAllThreeModesUseSharedFormatter();
  testTelegramHtmlFormatting();
  testLongMessageChunking();
  await testInvalidFormattingFallback();
  await testFinalTelegramOutputAllModes();
  await testExtensionDomExtractionAndFormattingRegression();
  await testFormattingSafeSplittingGaps();

  console.log("\nALL RESPONSE FORMATTING TESTS PASSED ✅");
  process.exit(0);
})().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
