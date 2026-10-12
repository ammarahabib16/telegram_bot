const { chromium } = require("playwright");

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9333";
const INPUT_SEL = 'textarea[placeholder="Message DeepSeek"]';
const SEND_SEL = 'div[role="button"].ds-button--primary.ds-button--circle';
const ASSISTANT_SEL = ".ds-markdown.ds-assistant-message-main-content";

const RANDOM_QUESTIONS = [
  "What is the capital of Australia? One line answer.",
  "Explain black holes in exactly 3 sentences.",
  "What are 5 practical tips to improve sleep quality?",
  "Write a haiku about the sea.",
  "What is the difference between TCP and UDP? Two sentences.",
  "Suggest a healthy 3-ingredient dinner recipe.",
  "What year did the first Moon landing happen?",
  "Give me a random interesting fact about octopuses.",
  "Summarize the plot of the movie Inception in 2 sentences.",
  "What is photosynthesis? Explain in one paragraph.",
];

function randomQuestion() {
  return RANDOM_QUESTIONS[Math.floor(Math.random() * RANDOM_QUESTIONS.length)];
}

async function findDeepSeekPage(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.url().includes("chat.deepseek.com")) return page;
    }
  }
  return null;
}

async function ask(question, options = {}) {
  const {
    timeoutMs = Number(process.env.CHAT_TIMEOUT_MS) || 120000,
    stablePolls = 3,
    pollMs = 300,
  } = options;

  if (!question || !question.trim()) {
    throw new Error("Question must not be empty.");
  }

  const browser = await chromium.connectOverCDP(CDP_URL);

  try {
    const page = await findDeepSeekPage(browser);
    if (!page) {
      throw new Error(
        'DeepSeek tab not found. Run "npm run chrome" and open https://chat.deepseek.com/'
      );
    }

    await page.evaluate(() => {
      if (window.__extractDeepSeekContent) return;
      window.__extractDeepSeekContent = (el) => {
        if (!el) return "";
        try {
          const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
          if (fiberKey && el[fiberKey]) {
            let curr = el[fiberKey];
            let depth = 0;
            while (curr && depth < 20) {
              if (curr.memoizedProps) {
                const mp = curr.memoizedProps;
                if (typeof mp.markdown === "string" && mp.markdown.trim()) {
                  return mp.markdown.trim();
                }
                if (typeof mp.content === "string" && mp.content.trim()) {
                  return mp.content.trim();
                }
              }
              curr = curr.return;
              depth++;
            }
          }
        } catch {}

        try {
          const nodeToMd = (node) => {
            if (node.nodeType === Node.TEXT_NODE) return node.textContent;
            if (node.nodeType !== Node.ELEMENT_NODE) return "";

            const tag = node.tagName.toLowerCase();
            if (tag === "svg" || node.getAttribute("role") === "button" || tag === "button") {
              return "";
            }

            if (node.classList && node.classList.contains("md-code-block")) {
              const pre = node.querySelector("pre");
              const codeText = pre ? (pre.innerText || pre.textContent || "").replace(/\r\n/g, "\n") : "";
              const banner = node.querySelector(".md-code-block-banner-wrap, .md-code-block-banner");
              let lang = "";
              if (banner) {
                const spans = banner.querySelectorAll("span");
                for (const s of spans) {
                  const t = (s.innerText || s.textContent || "").trim();
                  if (t && !/^(copy|download|run)$/i.test(t)) {
                    lang = t;
                    break;
                  }
                }
              }
              return `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n`;
            }

            if (/^h[1-6]$/.test(tag)) {
              const level = Number(tag[1]);
              const prefix = "#".repeat(level);
              return `\n\n${prefix} ${Array.from(node.childNodes).map(nodeToMd).join("").trim()}\n\n`;
            }

            if (tag === "p") {
              return `\n\n${Array.from(node.childNodes).map(nodeToMd).join("").trim()}\n\n`;
            }

            if (tag === "strong" || tag === "b") {
              return `**${Array.from(node.childNodes).map(nodeToMd).join("")}**`;
            }

            if (tag === "em" || tag === "i") {
              return `*${Array.from(node.childNodes).map(nodeToMd).join("")}*`;
            }

            if (tag === "s" || tag === "del" || tag === "strike") {
              return `~~${Array.from(node.childNodes).map(nodeToMd).join("")}~~`;
            }

            if (tag === "code") {
              return `\`${node.textContent}\``;
            }

            if (tag === "table") {
              const rows = Array.from(node.querySelectorAll("tr"));
              if (!rows.length) return "";
              const mdRows = [];
              rows.forEach((tr, idx) => {
                const cells = Array.from(tr.querySelectorAll("th, td")).map((c) =>
                  Array.from(c.childNodes).map(nodeToMd).join("").trim()
                );
                mdRows.push(`| ${cells.join(" | ")} |`);
                if (idx === 0) {
                  mdRows.push(`| ${cells.map(() => "---").join(" | ")} |`);
                }
              });
              return `\n\n${mdRows.join("\n")}\n\n`;
            }

            if (tag === "a") {
              const href = node.getAttribute("href") || "";
              const text = Array.from(node.childNodes).map(nodeToMd).join("");
              return href ? `[${text}](${href})` : text;
            }

            if (tag === "li") {
              return `\n• ${Array.from(node.childNodes).map(nodeToMd).join("").trim()}`;
            }

            if (tag === "blockquote") {
              return `\n> ${Array.from(node.childNodes).map(nodeToMd).join("").trim()}\n`;
            }

            return Array.from(node.childNodes).map(nodeToMd).join("");
          };

          const md = nodeToMd(el).trim().replace(/\n{3,}/g, "\n\n");
          if (md) return md;
        } catch {}

        return el.innerText ? el.innerText.trim() : "";
      };
    });

    // 1. Capture baseline state before sending new message
    const baseline = await page.evaluate((sel) => {
      const nodes = document.querySelectorAll(sel);
      const count = nodes.length;
      const extract = window.__extractDeepSeekContent || ((el) => el.innerText.trim());
      const lastText = count > 0 ? extract(nodes[count - 1]) : null;
      return { count, lastText };
    }, ASSISTANT_SEL);

    // 2. Locate textarea and fill question
    const input = page.locator(INPUT_SEL).first();
    await input.waitFor({ state: "visible", timeout: 15000 });
    await input.click();
    await input.fill(question.trim());

    // 3. Wait for send button to be enabled (active) and click
    await page
      .waitForFunction(
        (sel) => {
          const btn = document.querySelector(sel);
          return btn && !btn.className.includes("ds-button--disabled");
        },
        SEND_SEL,
        { timeout: 5000 }
      )
      .catch(() => {});

    const sendBtn = page.locator(SEND_SEL).first();
    await sendBtn.click({ timeout: 5000 }).catch(async () => {
      await input.press("Enter");
    });

    // 4. Wait for submission to register (textarea clears or assistant text changes)
    await page
      .waitForFunction(
        ({ inputSel, sel, baselineText, baselineCount }) => {
          const ta = document.querySelector(inputSel);
          const nodes = document.querySelectorAll(sel);
          const lastText =
            nodes.length > 0 ? nodes[nodes.length - 1].innerText.trim() : null;
          const textareaCleared = ta && ta.value === "";
          const countChanged = nodes.length !== baselineCount;
          const textChanged =
            lastText !== null && lastText !== baselineText;
          return textareaCleared || countChanged || textChanged;
        },
        {
          inputSel: INPUT_SEL,
          sel: ASSISTANT_SEL,
          baselineText: baseline.lastText,
          baselineCount: baseline.count,
        },
        { timeout: 15000 }
      )
      .catch(() => {});

    // 5. Poll for completion, handling virtual scrolling & streaming
    const deadline = Date.now() + timeoutMs;
    let prevText = null;
    let stable = 0;

    while (Date.now() < deadline) {
      await page.waitForTimeout(pollMs);

      const state = await page.evaluate((sel) => {
        const btn = document.querySelector(
          'div[role="button"].ds-button--primary.ds-button--circle'
        );
        const stopBtn = document.querySelector(
          'div[aria-label="Stop"], div[role="button"][class*="stop"]'
        );
        const nodes = document.querySelectorAll(sel);
        const count = nodes.length;
        const extract = window.__extractDeepSeekContent || ((el) => el.innerText.trim());
        const lastText =
          count > 0 ? extract(nodes[count - 1]) : "";

        // Check if generation is finished / page is idle
        const isStop = !!stopBtn;
        const btnDisabled = btn
          ? btn.className.includes("ds-button--disabled")
          : false;
        const hasSendSvg = btn
          ? !!btn.querySelector('svg[width="16"]')
          : false;
        const isIdle = !isStop && (btnDisabled || hasSendSvg);

        return {
          isIdle,
          count,
          lastText,
        };
      }, ASSISTANT_SEL);

      const hasNewResponse =
        state.lastText &&
        (baseline.lastText === null ||
          state.lastText !== baseline.lastText ||
          state.count > baseline.count);

      if (state.isIdle && hasNewResponse) {
        if (state.lastText === prevText) {
          stable += 1;
          if (stable >= stablePolls) {
            return state.lastText;
          }
        } else {
          prevText = state.lastText;
          stable = 0;
        }
      } else {
        stable = 0;
        if (state.lastText && state.lastText !== baseline.lastText) {
          prevText = state.lastText;
        }
      }
    }

    throw new Error(
      `Timed out after ${Math.round(timeoutMs / 1000)} seconds waiting for DeepSeek response.`
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { ask, randomQuestion, CDP_URL };

if (require.main === module) {
  const question =
    process.argv.slice(2).join(" ").trim() || randomQuestion();

  console.log("Question:", question);
  console.log("");

  ask(question)
    .then((text) => {
      console.log("Response:");
      console.log(text);
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌", err.message);
      process.exit(1);
    });
}
