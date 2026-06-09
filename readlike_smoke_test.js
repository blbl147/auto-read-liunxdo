import fs from "fs";
import dotenv from "dotenv";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import {
  getProxyConfig,
  getPuppeteerProxyArgs,
  getCurrentIP,
} from "./src/proxy_config.js";

dotenv.config();
if (fs.existsSync(".env.local")) {
  const envConfig = dotenv.parse(fs.readFileSync(".env.local"));
  for (const key in envConfig) process.env[key] = envConfig[key];
  console.log("[env] Loaded .env.local");
} else {
  console.log("[env] Loaded process env and .env defaults if present");
}

puppeteer.use(StealthPlugin());

const loginUrl = normalizeBaseUrl(process.env.WEBSITE || "https://linux.do");
const smokeSeconds = readIntegerEnv("SMOKE_TEST_SECONDS", 90);
const topicCount = Math.max(1, readIntegerEnv("SMOKE_TOPIC_COUNT", 2));
const accountIndex = Math.max(0, readIntegerEnv("SMOKE_ACCOUNT_INDEX", 0));
const usernames = splitEnvList(process.env.USERNAMES);
const passwords = splitEnvList(process.env.PASSWORDS);
const cookies = splitEnvList(process.env.COOKIES);
const username = usernames[accountIndex] || usernames[0] || "";
const password = passwords[accountIndex] || passwords[0] || "";
const cookie = cookies[accountIndex] || cookies[0] || "";

const artifactsDir = "smoke-artifacts";
fs.mkdirSync(artifactsDir, { recursive: true });

let browser = null;
let page = null;

process.on("unhandledRejection", (reason) => {
  console.warn("[unhandledRejection]", reason && reason.message ? reason.message : reason);
});

try {
  console.log(`[config] WEBSITE=${loginUrl}`);
  console.log(`[config] SMOKE_TEST_SECONDS=${smokeSeconds}`);
  console.log(`[config] SMOKE_TOPIC_COUNT=${topicCount}`);
  console.log(`[config] BROWSER_HEADLESS=${browserHeadlessMode()}`);
  console.log(
    `[config] CF_WAIT_TIMEOUT_SECONDS=${readIntegerEnv("CF_WAIT_TIMEOUT_SECONDS", Math.round(readIntegerEnv("CF_WAIT_TIMEOUT_MS", 45000) / 1000))}`,
  );
  console.log(`[config] account=${mask(username)} cookie=${cookie ? "yes" : "no"}`);
  console.log(`[network] current ip=${(await getCurrentIP()) || "unknown"}`);

  ({ browser, page } = await createBrowserPage());
  attachDiagnostics(page);

  await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(readIntegerEnv("NAV_TIMEOUT_MS", 120000));

  if (cookie) {
    await preloadCookies(cookie);
    await navigateAndWait(loginUrl);
  } else {
    await navigateAndWait(loginUrl);
    if (!username || !password) {
      throw new Error("Missing USERNAMES/PASSWORDS or COOKIES for smoke test.");
    }
    await loginWithPassword(username, password);
  }

  await assertLoggedIn("after login");
  const topicUrls = await resolveTopicUrls();
  console.log(`[topics] ${topicUrls.join(", ")}`);

  const perTopicSeconds = Math.max(15, Math.floor(smokeSeconds / topicUrls.length));
  for (let index = 0; index < topicUrls.length; index++) {
    await smokeReadTopic(topicUrls[index], index + 1, perTopicSeconds);
  }

  console.log("[result] SMOKE_TEST_PASS browsing and scrolling completed");
} catch (error) {
  console.error("[result] SMOKE_TEST_FAIL", error && error.stack ? error.stack : error);
  if (page) await saveFailureArtifacts(page);
  process.exitCode = 1;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      console.warn("[cleanup] browser close failed", error && error.message ? error.message : error);
    }
  }
}

function splitEnvList(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readIntegerEnv(name, fallback) {
  const parsed = parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBooleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, "");
}

function mask(value) {
  if (!value) return "***";
  return `${value[0]}***`;
}

function browserHeadlessMode() {
  const ciDefault = process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true";
  return readBooleanEnv("BROWSER_HEADLESS", ciDefault ? true : process.env.ENVIRONMENT !== "dev");
}

function browserArgs() {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
  ];
  const proxyConfig = getProxyConfig();
  if (proxyConfig) args.push(...getPuppeteerProxyArgs(proxyConfig));
  return args;
}

function resolveChromeExecutablePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : null,
    process.platform === "win32"
      ? "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
      : null,
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : null,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

async function createBrowserPage() {
  const options = {
    headless: browserHeadlessMode(),
    args: browserArgs(),
  };

  const proxyConfig = getProxyConfig();
  if (proxyConfig?.username && proxyConfig?.password) {
    options.proxy = {
      host: proxyConfig.host,
      port: proxyConfig.port,
      username: proxyConfig.username,
      password: proxyConfig.password,
    };
  }

  const retries = Math.max(1, readIntegerEnv("BROWSER_LAUNCH_RETRIES", 2));
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { connect } = await import("puppeteer-real-browser");
      console.log(`[browser] puppeteer-real-browser attempt ${attempt}/${retries}`);
      return await connect(options);
    } catch (error) {
      lastError = error;
      console.warn(`[browser] real-browser failed: ${error.message}`);
      await delay(2000 * attempt);
    }
  }

  const launchOptions = {
    ...options,
    defaultViewport: { width: 1280, height: 800 },
  };
  delete launchOptions.proxy;
  const executablePath = resolveChromeExecutablePath();
  if (executablePath) launchOptions.executablePath = executablePath;
  else launchOptions.channel = process.env.PUPPETEER_CHANNEL || "chrome";

  console.warn(
    `[browser] fallback puppeteer.launch after real-browser failure: ${
      lastError && lastError.message ? lastError.message : lastError
    }`,
  );
  const launchedBrowser = await puppeteer.launch(launchOptions);
  const launchedPage = await launchedBrowser.newPage();
  if (proxyConfig?.username && proxyConfig?.password) {
    await launchedPage.authenticate({
      username: proxyConfig.username,
      password: proxyConfig.password,
    });
  }
  return { browser: launchedBrowser, page: launchedPage };
}

function attachDiagnostics(targetPage) {
  targetPage.on("console", (message) => {
    const text = message.text();
    if (text.length > 500) console.log(`[page:${message.type()}] ${text.slice(0, 500)}...`);
    else console.log(`[page:${message.type()}] ${text}`);
  });
  targetPage.on("pageerror", (error) => {
    console.error(`[pageerror] ${error.message}`);
  });
  targetPage.on("requestfailed", (request) => {
    console.warn(`[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`);
  });
  targetPage.on("response", (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && url.startsWith(loginUrl)) {
      console.warn(`[response:${status}] ${url}`);
    }
  });
  targetPage.on("framenavigated", async (frame) => {
    if (frame.parentFrame() !== null) return;
    console.log(`[nav] ${frame.url()}`);
  });
}

async function navigateAndWait(url) {
  console.log(`[goto] ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: readIntegerEnv("NAV_TIMEOUT_MS", 120000),
  });
  await waitForCloudflare();
  const diagnostics = await pageDiagnostics();
  console.log(`[page] title="${diagnostics.title}" url=${diagnostics.url}`);
}

async function waitForCloudflare(
  timeoutMs = readIntegerEnv(
    "CF_WAIT_TIMEOUT_MS",
    readIntegerEnv("CF_WAIT_TIMEOUT_SECONDS", 45) * 1000,
  ),
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const title = await safeTitle();
    if (!title.includes("Just a moment") && !title.includes("\u8bf7\u7a0d\u5019")) return;
    console.log(`[cloudflare] waiting title="${title}" elapsed=${Math.round((Date.now() - start) / 1000)}s`);
    await delay(2000);
  }
  const diagnostics = await pageDiagnostics();
  throw new Error(
    `Cloudflare challenge did not clear during smoke test. ${formatDiagnostics(diagnostics)}`,
  );
}

async function preloadCookies(cookieString) {
  console.log("[login] preloading cookie before first navigation");
  const cookieObjects = parseCookieString(cookieString);
  if (cookieObjects.length === 0) throw new Error("COOKIES is set but no valid cookie pairs were parsed.");
  await page.setCookie(...cookieObjects);
  console.log(`[login] preloaded ${cookieObjects.length} cookies`);
}

function parseCookieString(cookieString) {
  return cookieString
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .map((part) => {
      const eqIndex = part.indexOf("=");
      return {
        name: part.slice(0, eqIndex).trim(),
        value: part.slice(eqIndex + 1).trim(),
        url: loginUrl,
        path: "/",
      };
    });
}

async function loginWithPassword(account, accountPassword) {
  console.log(`[login] using password for ${mask(account)}`);
  await openLoginForm();
  await page.click("#login-account-name", { clickCount: 3 });
  await page.type("#login-account-name", account, { delay: 80 });
  await page.click("#login-account-password", { clickCount: 3 });
  await page.type("#login-account-password", accountPassword, { delay: 80 });

  const navigation = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 })
    .catch(() => null);
  await page.click("#login-button", { force: true });
  await navigation;
  await delay(3000);

  const alertText = await getLoginAlertText();
  if (alertText) throw new Error(`Login form returned alert: ${alertText}`);
}

async function openLoginForm() {
  if (await waitForLoginForm(2000)) return;
  if (await clickVisibleLoginButton()) {
    await delay(1500);
    if (await waitForLoginForm(8000)) return;
  }

  await navigateAndWait(`${loginUrl}/login`);
  if (await waitForLoginForm(10000)) return;
  if (await clickVisibleLoginButton()) {
    await delay(1500);
    if (await waitForLoginForm(8000)) return;
  }

  const diagnostics = await pageDiagnostics();
  throw new Error(`Login form did not open. ${formatDiagnostics(diagnostics)}`);
}

async function waitForLoginForm(timeout) {
  try {
    await page.waitForSelector("#login-account-name", { timeout });
    await page.waitForSelector("#login-account-password", { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function clickVisibleLoginButton() {
  return await page.evaluate(() => {
    const keywords = ["login", "log in", "sign in", "\u767b\u5f55", "\u767b\u5165"];
    const candidates = Array.from(document.querySelectorAll("button, a, .login-button"));
    const button = candidates.find((element) => {
      const text = [
        element.textContent || "",
        element.getAttribute("title") || "",
        element.getAttribute("aria-label") || "",
        typeof element.className === "string" ? element.className : "",
      ]
        .join(" ")
        .toLowerCase();
      return element.classList.contains("login-button") || keywords.some((keyword) => text.includes(keyword));
    });
    if (!button) return false;
    button.click();
    return true;
  });
}

async function getLoginAlertText() {
  const alert = await page.$(".alert.alert-error");
  if (!alert) return "";
  return await page.evaluate((element) => element.innerText, alert);
}

async function assertLoggedIn(label) {
  await delay(2000);
  const avatar = await page.$("img.avatar");
  const authButtons = await page.$("span.auth-buttons, .login-button");
  if (avatar) {
    console.log(`[login] ok ${label}`);
    return;
  }
  const diagnostics = await pageDiagnostics();
  if (authButtons) throw new Error(`Still logged out ${label}. ${formatDiagnostics(diagnostics)}`);
  console.warn(`[login] avatar not found, continuing with diagnostics: ${formatDiagnostics(diagnostics)}`);
}

async function resolveTopicUrls() {
  const configured = splitEnvList(process.env.SMOKE_TOPIC_URLS);
  if (configured.length > 0) return configured.slice(0, topicCount);

  await navigateAndWait(loginUrl);
  const topics = await page.evaluate(async (count) => {
    const response = await fetch("/latest.json?no_definitions=true&page=0");
    if (!response.ok) throw new Error(`latest.json status ${response.status}`);
    const data = await response.json();
    return (data.topic_list?.topics || [])
      .filter((topic) => topic && topic.id && topic.posts_count < 1000)
      .slice(0, count)
      .map((topic) => `/t/topic/${topic.id}`);
  }, topicCount);

  if (topics.length === 0) {
    return [loginUrl === "https://linux.do" ? "https://linux.do/t/topic/13716/790" : `${loginUrl}/t/topic/1`];
  }
  return topics.map((topicPath) => new URL(topicPath, loginUrl).toString());
}

async function smokeReadTopic(url, index, seconds) {
  console.log(`[read:${index}] start ${url}`);
  await navigateAndWait(url);
  await page.screenshot({ path: `${artifactsDir}/topic-${index}-start.png`, fullPage: false });

  const startMetrics = await scrollMetrics();
  console.log(`[read:${index}] metrics start ${JSON.stringify(startMetrics)}`);

  const endAt = Date.now() + seconds * 1000;
  let step = 0;
  while (Date.now() < endAt) {
    await page.evaluate(() => window.scrollBy(0, Math.max(250, Math.floor(window.innerHeight * 0.6))));
    await delay(1200);
    step++;
    if (step % 3 === 0) {
      const metrics = await scrollMetrics();
      console.log(`[read:${index}] scroll ${JSON.stringify(metrics)}`);
      if (metrics.scrollY + metrics.innerHeight >= metrics.scrollHeight - 80) {
        console.log(`[read:${index}] reached bottom`);
        break;
      }
    }
  }

  const endMetrics = await scrollMetrics();
  await page.screenshot({ path: `${artifactsDir}/topic-${index}-end.png`, fullPage: false });
  if (endMetrics.scrollY <= startMetrics.scrollY && endMetrics.scrollHeight > endMetrics.innerHeight + 100) {
    throw new Error(
      `Topic ${index} did not scroll. start=${JSON.stringify(startMetrics)} end=${JSON.stringify(endMetrics)}`,
    );
  }
  console.log(`[read:${index}] ok end ${JSON.stringify(endMetrics)}`);
}

async function scrollMetrics() {
  return await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight || document.body.scrollHeight,
  }));
}

async function pageDiagnostics() {
  let title = "";
  let body = "";
  try {
    title = await page.title();
  } catch {}
  try {
    body = await page.evaluate(() =>
      (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
    );
  } catch {}
  return { url: page.url(), title, body };
}

function formatDiagnostics(diagnostics) {
  return `url=${diagnostics.url} title="${diagnostics.title}" body="${diagnostics.body}"`;
}

async function safeTitle() {
  try {
    return await page.title();
  } catch {
    return "";
  }
}

async function saveFailureArtifacts(targetPage) {
  try {
    await targetPage.screenshot({ path: `${artifactsDir}/failure.png`, fullPage: true });
  } catch (error) {
    console.warn(`[artifact] screenshot failed: ${error.message}`);
  }
  try {
    const html = await targetPage.content();
    fs.writeFileSync(`${artifactsDir}/failure.html`, html);
  } catch (error) {
    console.warn(`[artifact] html save failed: ${error.message}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
