const { chromium } = require("playwright");

const CDP_URL = process.env.CDP_URL || "http://127.0.0.1:9333";

(async () => {
  console.log(`Connecting to Chrome at ${CDP_URL}...`);

  const browser = await chromium.connectOverCDP(CDP_URL);

  console.log("Connected to Chrome!");

  const contexts = browser.contexts();

  for (const context of contexts) {
    const pages = context.pages();

    console.log(`Pages in context: ${pages.length}`);

    for (const page of pages) {
      console.log("\n-----------------------------");
      console.log("URL:", page.url());

      try {
        console.log("TITLE:", await page.title());
      } catch {
        console.log("TITLE: <unable to read>");
      }
    }
  }

  console.log("\n========== SEARCHING DEEPSEEK ==========");

  let deepSeekPage = null;

  for (const context of contexts) {
    for (const page of context.pages()) {
      if (page.url().includes("chat.deepseek.com")) {
        deepSeekPage = page;
        break;
      }
    }

    if (deepSeekPage) break;
  }

  if (!deepSeekPage) {
    console.log("❌ DeepSeek page was not found.");
    console.log(
      "Please open https://chat.deepseek.com/ in the same Chrome window."
    );
    process.exit(1);
  }

  console.log("✅ DeepSeek page found!");
  console.log("URL:", deepSeekPage.url());
  console.log("TITLE:", await deepSeekPage.title());

  console.log("\n========== PAGE TEXT ==========");

  const text = await deepSeekPage.locator("body").innerText();

  console.log(text.slice(0, 3000));

  console.log("\n========== TEST COMPLETE ==========");
  process.exit(0);
})().catch((err) => {
  console.error("❌ Could not connect to Chrome:", err.message);
  console.error('Run "npm run chrome" first to launch your ammara profile.');
  process.exit(1);
});