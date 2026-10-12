"use strict";

// Shared Telegram response formatting for all AI modes (Ollama, Browser Automation,
// Browser Extension).
//
// 1. ai-router.js runs every mode's raw response through formatAnswer(text)
//    to clean thinking tags (<think>...</think>) and normalize excessive whitespace
//    without destroying markdown syntax or code fences.
// 2. replyFormatted(ctx, text) converts markdown into Telegram-compatible HTML,
//    safely chunks messages under 4000 characters without breaking code blocks,
//    and falls back to safe plain text if Telegram rejects parsing.

function cleanResponse(text) {
  if (!text) return "";
  // Strip DeepSeek-R1 reasoning tokens (<think>...</think>).
  return String(text).replace(/[\s\S]*?<\/think>/g, "").trim();
}

/**
 * Normalizes raw model output without altering code blocks or stripping
 * Markdown formatting (headings, lists, bold/italics, code fences, links).
 */
function formatAnswer(text) {
  if (text == null) return "";
  const cleaned = cleanResponse(text);

  const lines = cleaned.split("\n");
  const result = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      result.push(line);
      continue;
    }
    if (inFence) {
      result.push(line);
    } else {
      result.push(line.trimEnd());
    }
  }

  // Collapse 3+ blank lines outside code fences down to 2 blank lines
  return result
    .join("\n")
    .replace(/(?:\r?\n){3,}/g, "\n\n")
    .trim();
}

// Backwards-compatible alias for existing callers
const formatForTelegram = formatAnswer;

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Languages Telegram knows how to syntax-highlight inside <pre><code>.
const TELEGRAM_LANGS = new Set([
  "javascript", "typescript", "python", "java", "c", "c++", "c#", "go",
  "rust", "php", "ruby", "swift", "kotlin", "scala", "sql", "html", "xml",
  "css", "json", "yaml", "bash", "shell", "plain text", "markdown", "lua",
  "perl", "r", "diff",
]);

const LANG_ALIASES = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", python3: "python",
  sh: "shell", zsh: "shell", bash: "bash",
  ps1: "shell", powershell: "shell",
  yml: "yaml", md: "markdown",
  txt: "plain text", text: "plain text",
  cpp: "c++", csharp: "c#", cs: "c#",
  node: "javascript", html5: "html",
  golang: "go", rb: "ruby", rs: "rust",
};

function normalizeLang(lang) {
  if (!lang) return null;
  const key = lang.trim().toLowerCase();
  const resolved = LANG_ALIASES[key] || key;
  if (TELEGRAM_LANGS.has(resolved)) return resolved;
  if (/^[a-z0-9_+#.-]+$/i.test(key)) return key;
  return null;
}

function wrapPre(content, lang) {
  return lang
    ? `<pre><code class="language-${lang}">${content}</code></pre>`
    : `<pre>${content}</pre>`;
}

function parsePre(block) {
  let m = block.match(
    /^<pre><code class="language-([a-z0-9_+#. -]+)">([\s\S]*)<\/code><\/pre>$/i
  );
  if (m) return { lang: m[1], content: m[2] };
  m = block.match(/^<pre>([\s\S]*)<\/pre>$/i);
  if (m) return { lang: null, content: m[1] };
  return null;
}

function inlineMarkdown(text) {
  if (!text) return "";

  // 1. Extract inline code blocks first so their contents are never
  // modified by subsequent markdown rules (e.g. `*` or `_` or `&`).
  const codes = [];
  let out = String(text).replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // 2. Escape HTML special characters in the text outside code
  out = escapeHtml(out);

  // 3. Markdown links: [label](https://...) -> <a href="...">label</a>
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, label, url) => {
      const cleanUrl = url.replace(/"/g, "&quot;");
      return `<a href="${cleanUrl}">${label}</a>`;
    }
  );

  // 4. Bold and Italic formatting
  // Bold Italic: ***text***
  out = out.replace(/\*\*\*(?!\s)([^*]+?)(?<!\s)\*\*\*/g, "<b><i>$1</i></b>");
  // Bold: **text**
  out = out.replace(/\*\*(?!\s)([^*]+?)(?<!\s)\*\*/g, "<b>$1</b>");
  // Italic: *text* (word boundary aware)
  out = out.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=[^\w*]|$)/g, "$1<i>$2</i>");
  // Italic: _text_ (boundary check so identifier_with_underscore is untouched)
  out = out.replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?;:])/g, "$1<i>$2</i>");
  // Strikethrough: ~~text~~
  out = out.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");

  // 5. Restore inline code with full HTML escaping
  out = out.replace(
    /\u0000(\d+)\u0000/g,
    (_, i) => `<code>${escapeHtml(codes[+i])}</code>`
  );

  return out;
}

const BLOCK_START = /^\s*(?:```|#{1,6}\s|>|[-*+•]\s|\d+\.\s|\|)/;

function markdownBlocks(text) {
  if (!text) return [];
  const lines = String(text).split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code block
    if (/^\s*```/.test(line)) {
      const rawLang = line.trim().slice(3).trim();
      const lang = normalizeLang(rawLang);
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing fence (or EOF)
      blocks.push(wrapPre(escapeHtml(buf.join("\n")), lang));
      continue;
    }

    // Headings: # Title
    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) {
      blocks.push(`<b>${inlineMarkdown(heading[1].trim())}</b>`);
      i += 1;
      continue;
    }

    // Blockquotes: > Quote
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(`<blockquote>${inlineMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // Bulleted lists: - item, * item, + item, • item
    if (/^\s*[-*+•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+•]\s+/.test(lines[i])) {
        const indent = lines[i].match(/^(\s*)/)[1];
        const content = lines[i].replace(/^\s*[-*+•]\s+/, "");
        items.push(`${indent}• ${inlineMarkdown(content)}`);
        i += 1;
      }
      blocks.push(items.join("\n"));
      continue;
    }

    // Numbered lists: 1. item
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)(\d+\.)\s+(.*)/);
        if (m) {
          items.push(`${m[1]}${m[2]} ${inlineMarkdown(m[3])}`);
        } else {
          items.push(inlineMarkdown(lines[i]));
        }
        i += 1;
      }
      blocks.push(items.join("\n"));
      continue;
    }

    // Tables: | col | col | (wrapped in monospace <pre> for clean alignment without unsupported <table> tags)
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim());
        i += 1;
      }
      blocks.push(`<pre>${escapeHtml(rows.join("\n"))}</pre>`);
      continue;
    }

    // Normal paragraph
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !BLOCK_START.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    blocks.push(inlineMarkdown(buf.join("\n")));
  }

  return blocks;
}

function tokenizeHtml(html) {
  const tokens = [];
  let i = 0;
  const len = html.length;

  while (i < len) {
    if (html[i] === "<") {
      const tagMatch = html.slice(i).match(/^<(\/)?([a-z0-9_-]+)(?:\s+[^>]*)?>/i);
      if (tagMatch) {
        const fullTag = tagMatch[0];
        const isClose = !!tagMatch[1];
        const tagName = tagMatch[2].toLowerCase();
        const isSelfClosing = fullTag.endsWith("/>") || /^(?:br|hr|img)$/i.test(tagName);
        tokens.push({
          text: fullTag,
          isTag: true,
          isOpenTag: !isClose && !isSelfClosing,
          isCloseTag: isClose,
          isSelfClosing,
          tagName,
          isEntity: false,
          isNewline: false,
          isWhitespace: false,
        });
        i += fullTag.length;
        continue;
      }
    }

    if (html[i] === "&") {
      const entityMatch = html.slice(i).match(/^&[a-zA-Z0-9#]+;/);
      if (entityMatch) {
        const entity = entityMatch[0];
        tokens.push({
          text: entity,
          isTag: false,
          isOpenTag: false,
          isCloseTag: false,
          isSelfClosing: false,
          tagName: null,
          isEntity: true,
          isNewline: false,
          isWhitespace: false,
        });
        i += entity.length;
        continue;
      }
    }

    const char = html[i];
    tokens.push({
      text: char,
      isTag: false,
      isOpenTag: false,
      isCloseTag: false,
      isSelfClosing: false,
      tagName: null,
      isEntity: false,
      isNewline: char === "\n",
      isWhitespace: /\s/.test(char),
    });
    i += 1;
  }

  return tokens;
}

function splitHtmlBlock(html, limit = 4000) {
  if (!html || html.length <= limit) return [html || ""];
  const tokens = tokenizeHtml(html);
  if (!tokens.length) return [""];

  const pieces = [];
  let carryTags = [];
  let startIdx = 0;

  while (startIdx < tokens.length) {
    const prefix = carryTags.map((t) => t.openText).join("");
    let simulatedStack = carryTags.slice();

    let bestNewlineIdx = -1;
    let bestNewlineStack = null;
    let bestSpaceIdx = -1;
    let bestSpaceStack = null;
    let bestAnyIdx = -1;
    let bestAnyStack = null;

    let currentTokensLen = 0;
    let j = startIdx;

    while (j < tokens.length) {
      const tok = tokens[j];

      if (tok.isOpenTag) {
        simulatedStack.push({
          tagName: tok.tagName,
          openText: tok.text,
          closeText: `</${tok.tagName}>`,
        });
      } else if (tok.isCloseTag) {
        for (let k = simulatedStack.length - 1; k >= 0; k--) {
          if (simulatedStack[k].tagName === tok.tagName) {
            simulatedStack.splice(k, 1);
            break;
          }
        }
      }

      currentTokensLen += tok.text.length;
      const suffix = simulatedStack
        .slice()
        .reverse()
        .map((t) => t.closeText)
        .join("");
      const totalLen = prefix.length + currentTokensLen + suffix.length;

      if (totalLen <= limit) {
        if (tok.isNewline) {
          bestNewlineIdx = j + 1;
          bestNewlineStack = simulatedStack.slice();
        } else if (tok.isWhitespace) {
          bestSpaceIdx = j + 1;
          bestSpaceStack = simulatedStack.slice();
        }
        bestAnyIdx = j + 1;
        bestAnyStack = simulatedStack.slice();
        j++;
      } else {
        break;
      }
    }

    let chosenEnd = -1;
    let chosenStack = null;

    const halfLimit = Math.floor(limit * 0.5);
    if (bestNewlineIdx !== -1 && bestNewlineIdx > startIdx) {
      const newlineLen = tokens
        .slice(startIdx, bestNewlineIdx)
        .reduce((acc, t) => acc + t.text.length, 0);
      if (newlineLen >= halfLimit || bestSpaceIdx === -1) {
        chosenEnd = bestNewlineIdx;
        chosenStack = bestNewlineStack;
      }
    }

    if (chosenEnd === -1 && bestSpaceIdx !== -1 && bestSpaceIdx > startIdx) {
      chosenEnd = bestSpaceIdx;
      chosenStack = bestSpaceStack;
    }

    if (chosenEnd === -1 && bestNewlineIdx !== -1 && bestNewlineIdx > startIdx) {
      chosenEnd = bestNewlineIdx;
      chosenStack = bestNewlineStack;
    }

    if (chosenEnd === -1 && bestAnyIdx !== -1 && bestAnyIdx > startIdx) {
      chosenEnd = bestAnyIdx;
      chosenStack = bestAnyStack;
    }

    if (chosenEnd === -1 || chosenEnd <= startIdx) {
      chosenEnd = Math.min(startIdx + 1, tokens.length);
      simulatedStack = carryTags.slice();
      const tok = tokens[startIdx];
      if (tok.isOpenTag) {
        simulatedStack.push({
          tagName: tok.tagName,
          openText: tok.text,
          closeText: `</${tok.tagName}>`,
        });
      } else if (tok.isCloseTag) {
        for (let k = simulatedStack.length - 1; k >= 0; k--) {
          if (simulatedStack[k].tagName === tok.tagName) {
            simulatedStack.splice(k, 1);
            break;
          }
        }
      }
      chosenStack = simulatedStack;
    }

    const pieceContent = tokens
      .slice(startIdx, chosenEnd)
      .map((t) => t.text)
      .join("");
    const suffix = chosenStack
      .slice()
      .reverse()
      .map((t) => t.closeText)
      .join("");
    const piece = prefix + pieceContent + suffix;

    if (piece) pieces.push(piece);
    carryTags = chosenStack.slice();
    startIdx = chosenEnd;
  }

  return pieces;
}

function splitCodeBlock(pre, limit = 4000) {
  const overhead = wrapPre("", pre.lang).length;
  const maxContentLen = Math.max(limit - overhead, 100);
  const content = pre.content;

  if (content.length <= maxContentLen) {
    return [wrapPre(content, pre.lang)];
  }

  const lines = content.split("\n");
  const slices = [];
  let buf = "";

  const flushBuf = () => {
    if (buf) {
      slices.push(buf);
      buf = "";
    }
  };

  const splitLongLine = (line) => {
    let pos = 0;
    while (pos < line.length) {
      const remaining = line.length - pos;
      if (remaining <= maxContentLen) {
        slices.push(line.slice(pos));
        break;
      }

      let end = pos + maxContentLen;

      // Prevent cutting through an HTML entity: &[a-zA-Z0-9#]+;
      const lookback = Math.max(pos, end - 12);
      const ampIdx = line.lastIndexOf("&", end - 1);
      if (ampIdx >= lookback) {
        const semiIdx = line.indexOf(";", ampIdx);
        if (semiIdx >= end && semiIdx - ampIdx <= 12) {
          end = ampIdx;
        }
      }

      // Try splitting on space
      const minCut = pos + Math.floor(maxContentLen * 0.5);
      const lastSpace = line.lastIndexOf(" ", end - 1);
      if (lastSpace >= minCut) {
        end = lastSpace + 1;
      }

      if (end <= pos) {
        end = pos + maxContentLen;
      }

      slices.push(line.slice(pos, end));
      pos = end;
    }
  };

  for (const line of lines) {
    if (line.length > maxContentLen) {
      flushBuf();
      splitLongLine(line);
      continue;
    }

    if (buf && buf.length + 1 + line.length > maxContentLen) {
      flushBuf();
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }

  flushBuf();
  return slices.map((s) => wrapPre(s, pre.lang));
}

function chunkBlocks(blocks, limit = 4000) {
  const chunks = [];
  let current = "";

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  const append = (piece) => {
    if (!piece) return;
    if (current && current.length + 2 + piece.length > limit) {
      flush();
    }
    current = current ? `${current}\n\n${piece}` : piece;
  };

  for (const block of blocks) {
    if (!block) continue;

    if (block.length <= limit) {
      append(block);
      continue;
    }

    // Flush any pending small block so the oversized block starts fresh
    flush();

    const pre = parsePre(block);
    if (pre) {
      const pieces = splitCodeBlock(pre, limit);
      for (const piece of pieces) {
        append(piece);
      }
      continue;
    }

    const pieces = splitHtmlBlock(block, limit);
    for (const piece of pieces) {
      append(piece);
    }
  }

  flush();
  return chunks;
}

function chunkText(text, limit = 4000) {
  if (!text || text.length <= limit) return [text || ""];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let sliceIndex = remaining.lastIndexOf("\n", limit);
    if (sliceIndex === -1 || sliceIndex < limit * 0.5) {
      sliceIndex = remaining.lastIndexOf(" ", limit);
      if (sliceIndex === -1 || sliceIndex < limit * 0.5) {
        sliceIndex = limit;
      }
    }
    chunks.push(remaining.slice(0, sliceIndex));
    remaining = remaining.slice(sliceIndex).trimStart();
  }
  return chunks;
}

function htmlToPlainText(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function replyFormatted(ctx, text, limit = 4000) {
  const rawText = text || "No response generated.";
  const blocks = markdownBlocks(rawText);
  const chunks = chunkBlocks(blocks, limit);

  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch (err) {
      console.error("Telegram HTML parse/send error:", err.message);
      // Safe plain-text fallback - never expose internal errors to Telegram
      const plain = htmlToPlainText(chunk);
      const subChunks = chunkText(plain, limit);
      for (const sub of subChunks) {
        try {
          await ctx.reply(sub);
        } catch (fallbackErr) {
          console.error("Telegram plain-text fallback error:", fallbackErr.message);
        }
      }
    }
  }
}

module.exports = {
  cleanResponse,
  formatAnswer,
  formatForTelegram,
  escapeHtml,
  normalizeLang,
  wrapPre,
  parsePre,
  inlineMarkdown,
  markdownBlocks,
  chunkBlocks,
  chunkText,
  htmlToPlainText,
  replyFormatted,
  tokenizeHtml,
  splitHtmlBlock,
  splitCodeBlock,
};
