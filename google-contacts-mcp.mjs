#!/usr/bin/env node
/**
 * google-contacts-mcp
 *
 * Self-contained Node.js / TypeScript MCP server (.mjs) for Claude, ChatGPT, and Gemini
 * to add, edit, search, and organize contacts in Google Contacts (Google People API v1).
 *
 * Supports inputs from:
 * - Structured tool arguments (names, emails, phones, orgs, addresses, URLs, birthdays, notes, labels, photos)
 * - Unstructured text & markup (vCard/.vcf, HTML, Markdown, CSV, JSON, email signatures, freeform text)
 * - Images (PNG, JPG/JPEG, WEBP, GIF via local path, file:// URL, data URI, or base64)
 *
 * Zero external runtime dependencies — runs on Node.js >= 20 out of the box.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as readline from "node:readline";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { exec, spawn,                   } from "node:child_process";

// ============================================================================
// Types & Interfaces
// ============================================================================

// ============================================================================
// Constants & Configuration
// ============================================================================

const SERVER_NAME = "google-contacts-mcp";
const SERVER_VERSION = "1.0.0";
const PEOPLE_API_BASE = "https://people.googleapis.com/v1";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts";

const PERSON_FIELDS = [
  "names",
  "nicknames",
  "emailAddresses",
  "phoneNumbers",
  "organizations",
  "addresses",
  "urls",
  "birthdays",
  "biographies",
  "userDefined",
  "memberships",
  "photos",
  "metadata",
].join(",");

const UPDATE_PERSON_FIELDS = [
  "names",
  "nicknames",
  "emailAddresses",
  "phoneNumbers",
  "organizations",
  "addresses",
  "urls",
  "birthdays",
  "biographies",
  "userDefined",
  "memberships",
].join(",");

/**
 * Load environment variables from a local .env file if present (without overriding existing env vars).
 */
export function loadDotEnv(envPath         )       {
  const candidates = envPath
    ? [envPath]
    : [
        path.resolve(process.cwd(), ".env"),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".env"),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
      ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const content = fs.readFileSync(candidate, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined && val !== "") {
          process.env[key] = val;
        }
      }
      break;
    } catch {
      // Ignore unreadable .env
    }
  }
}

export function getDefaultConfigDir()         {
  return path.join(os.homedir(), ".config", "google-contacts-mcp");
}

export function getDefaultTokensPath()         {
  if (process.env.GOOGLE_TOKENS_PATH) {
    return path.resolve(process.env.GOOGLE_TOKENS_PATH);
  }
  return path.join(getDefaultConfigDir(), "tokens.json");
}

// ============================================================================
// Browser Automation Client (`https://contacts.google.com` via Playwright or Chrome CDP)
// Zero Google Cloud Console / Client ID / Client Secret required!
// ============================================================================

export function getDefaultBrowserProfileDir()         {
  if (process.env.GOOGLE_CONTACTS_PROFILE_DIR) {
    return path.resolve(process.env.GOOGLE_CONTACTS_PROFILE_DIR);
  }
  return path.join(getDefaultConfigDir(), "chrome-profile");
}

export function findLocalBrowserExecutable()                {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates           =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/brave-browser",
            "/snap/bin/chromium",
          ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Lightweight Chrome DevTools Protocol (CDP) driver using Node 22/24's built-in global WebSocket.
 * Requires zero npm dependencies!
 */
class CdpPageDriver                       {
          ws           ;
          nextId = 1;
          pending = new Map                                                                   ();

  constructor(ws           ) {
    this.ws = ws;
    this.ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (typeof data.id === "number" && this.pending.has(data.id)) {
          const p = this.pending.get(data.id) ;
          this.pending.delete(data.id);
          if (data.error) {
            p.reject(new Error(data.error.message || "CDP error"));
          } else {
            p.resolve(data.result);
          }
        }
      } catch {
        // Ignore malformed CDP event
      }
    });
  }

         async send(method        , params                      = {})               {
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout on ${method}`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

         async goto(url        )                {
    await this.send("Page.enable");
    await this.send("Page.navigate", { url });
    await this.waitForReady();
  }

          async waitForReady()                {
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      try {
        const state = await this.evaluate        ("document.readyState");
        if (state === "complete" || state === "interactive") {
          await new Promise((r) => setTimeout(r, 700));
          return;
        }
      } catch {
        // Navigation in progress
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

         async evaluate         (
    fnOrExpr                                    ,
    ...args
  )             {
    const expression =
      typeof fnOrExpr === "function"
        ? `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`
        : fnOrExpr;

    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (res?.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          "DOM evaluation error"
      );
    }
    return res?.result?.value     ;
  }

         async url()                  {
    return (await this.evaluate        ("window.location.href")) || "";
  }

         async bringToFront()                {
    try {
      await this.send("Page.bringToFront");
    } catch {
      // Ignore
    }
  }

         async close()                {
    try {
      this.ws.close();
    } catch {
      // Ignore
    }
  }
}

export class GoogleContactsBrowserClient                             {
          profileDir        ;
          cdpPort        ;
          driver                    = null;
          chromeProcess                      = null;

  constructor(options                                                                 ) {
    this.profileDir = options?.profileDir || getDefaultBrowserProfileDir();
    this.cdpPort = options?.cdpPort || Number(process.env.GOOGLE_CONTACTS_CDP_PORT || 9229);
    if (options?.driver) {
      this.driver = options.driver;
    }
  }

         getAuthStatus()

    {
    const cookiesDb = path.join(this.profileDir, "Default", "Cookies");
    const loginData = path.join(this.profileDir, "Default", "Login Data");
    const hasProfileSession = fs.existsSync(cookiesDb) || fs.existsSync(loginData);
    return {
      mode: "browser",
      authenticated: hasProfileSession,
      profileDir: this.profileDir,
      browserExecutable: findLocalBrowserExecutable(),
    };
  }

         async ensurePageDriver()                      {
    if (this.driver) {
      try {
        await this.driver.url();
        return this.driver;
      } catch {
        this.driver = null;
      }
    }

    fs.mkdirSync(this.profileDir, { recursive: true });

    // 1. Try Playwright if installed in node_modules
    try {
      const pwName = "playwright";
      const pw = await import(pwName);
      const context = await pw.chromium.launchPersistentContext(this.profileDir, {
        channel: "chrome",
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
      });
      const page = context.pages()[0] || (await context.newPage());
      this.driver = {
        goto: async (url        ) => {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(700);
        },
        evaluate: async (fnOrExpr     , ...args       ) => {
          if (typeof fnOrExpr === "function") {
            return await page.evaluate(fnOrExpr, ...args);
          }
          return await page.evaluate(fnOrExpr);
        },
        url: async () => page.url(),
        bringToFront: async () => {
          await page.bringToFront();
        },
        close: async () => {
          await context.close();
        },
      };
      return this.driver;
    } catch {
      // Playwright not installed — use built-in zero-dep Chrome CDP driver!
    }

    // 2. Built-in Chrome / Brave / Edge CDP driver over global WebSocket
    const chromeBin = findLocalBrowserExecutable();
    if (!chromeBin) {
      throw new Error(
        "Could not find Google Chrome, Brave, or Edge on this machine. Install Google Chrome or set CHROME_PATH."
      );
    }

    const cdpBase = `http://127.0.0.1:${this.cdpPort}`;
    let targets               = null;

    try {
      const resp = await fetch(`${cdpBase}/json/list`);
      if (resp.ok) targets = (await resp.json())         ;
    } catch {
      // Chrome not yet running on cdpPort
    }

    if (!targets) {
      this.chromeProcess = spawn(
        chromeBin,
        [
          `--user-data-dir=${this.profileDir}`,
          `--remote-debugging-port=${this.cdpPort}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-blink-features=AutomationControlled",
          "https://contacts.google.com",
        ],
        {
          detached: true,
          stdio: "ignore",
        }
      );
      this.chromeProcess.unref();

      const start = Date.now();
      while (Date.now() - start < 15_000) {
        try {
          const resp = await fetch(`${cdpBase}/json/list`);
          if (resp.ok) {
            targets = (await resp.json())         ;
            if (targets && targets.length > 0) break;
          }
        } catch {
          // Wait for Chrome debugging port
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    if (!targets || targets.length === 0) {
      throw new Error(`Failed to connect to Chrome DevTools Protocol on ${cdpBase}`);
    }

    let pageTarget =
      targets.find(
        (t) =>
          t.type === "page" &&
          (String(t.url).includes("contacts.google.com") ||
            String(t.url).includes("accounts.google.com"))
      ) || targets.find((t) => t.type === "page");

    if (!pageTarget) {
      const newResp = await fetch(`${cdpBase}/json/new?https://contacts.google.com`, {
        method: "PUT",
      });
      pageTarget = await newResp.json();
    }

    const wsUrl = pageTarget.webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    await new Promise      ((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", (e) => reject(new Error(`WebSocket error: ${String(e)}`)), {
        once: true,
      });
    });

    this.driver = new CdpPageDriver(ws);
    return this.driver;
  }

  /**
   * Navigates to contacts.google.com (or targetUrl) and waits if the user needs to sign in
   * on accounts.google.com in the opened browser window.
   */
         async ensureAuthenticatedSession(targetUrl = "https://contacts.google.com")                      {
    const page = await this.ensurePageDriver();
    const currentUrl = await page.url();
    if (!currentUrl.startsWith("https://contacts.google.com") || targetUrl !== "https://contacts.google.com") {
      await page.goto(targetUrl);
    }

    const checkIsSignedIn = async ()                   => {
      const u = await page.url();
      if (u.includes("accounts.google.com") || u.includes("workspace.google.com")) {
        return false;
      }
      if (!u.startsWith("https://contacts.google.com")) {
        return false;
      }
      return await page.evaluate         (() => {
        const signInLink = document.querySelector('a[href*="accounts.google.com/ServiceLogin"]');
        if (signInLink) return false;
        const hasSearchOrMain = Boolean(
          document.querySelector(
            'input[aria-label*="Search"], [aria-label*="Create contact"], a[href*="/person/"], [role="main"]'
          )
        );
        return hasSearchOrMain;
      });
    };

    if (await checkIsSignedIn()) {
      return page;
    }

    await page.bringToFront();
    console.error(
      `[${SERVER_NAME}] Please sign in to your Google account in the opened browser window...`
    );

    const start = Date.now();
    while (Date.now() - start < 300_000) {
      if (await checkIsSignedIn()) {
        if (targetUrl !== "https://contacts.google.com" && !(await page.url()).startsWith(targetUrl)) {
          await page.goto(targetUrl);
        }
        return page;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }

    throw new Error("Timed out waiting for Google Contacts login in the browser window.");
  }

          async extractContactsFromListDom(page            , maxItems = 50)                               {
    // Wait up to 4 seconds for contact rows to appear
    for (let i = 0; i < 8; i++) {
      const count = await page.evaluate        (
        () => document.querySelectorAll('a[href*="/person/"], [data-id]').length
      );
      if (count > 0) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    return await page.evaluate                     ((limit        ) => {
      const results        = [];
      const seen = new Set        ();

      const links = Array.from(document.querySelectorAll('a[href*="/person/"]'));
      for (const link of links) {
        const href = link.getAttribute("href") || "";
        const match = href.match(/\/person\/([^/?#]+)/);
        if (!match) continue;
        const id = match[1];
        const resourceName = `person/${id}`;
        if (seen.has(resourceName)) continue;
        seen.add(resourceName);

        const row = link.closest('[role="row"], tr, [data-id]') || link.parentElement || link;
        const text = (row               ).innerText || link.textContent || "";
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l.length < 120);

        const emails                                         = [];
        const phones                                         = [];
        let displayName = "";
        let jobTitle                    ;
        let organization                    ;

        for (const line of lines) {
          if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(line)) {
            emails.push({ value: line, type: "work" });
          } else if (/^[+\d()\s.-]{7,20}$/.test(line) && line.replace(/\D/g, "").length >= 7) {
            phones.push({ value: line, type: "mobile" });
          } else if (!displayName && !/^(Actions|More actions|Starred|Contacts)$/i.test(line)) {
            displayName = line;
          } else if (displayName && !organization) {
            if (line.includes("•") || line.includes(",")) {
              const parts = line.split(/[•,]/).map((s) => s.trim());
              jobTitle = parts[0] || undefined;
              organization = parts[1] || undefined;
            } else {
              organization = line;
            }
          }
        }

        const nameParts = displayName.split(/\s+/);
        results.push({
          resourceName,
          displayName: displayName || undefined,
          givenName: nameParts[0] || undefined,
          familyName: nameParts.slice(1).join(" ") || undefined,
          emails,
          phones,
          organization,
          jobTitle,
          addresses: [],
          urls: [],
          customFields: [],
          groups: [],
        });

        if (results.length >= limit) break;
      }

      return results;
    }, maxItems);
  }

          async extractContactFromPersonDom(page            )                             {
    await new Promise((r) => setTimeout(r, 600));
    return await page.evaluate                   (() => {
      const urlMatch = window.location.pathname.match(/\/person\/([^/?#]+)/);
      const resourceName = urlMatch ? `person/${urlMatch[1]}` : undefined;

      const heading =
        document.querySelector("h1")?.textContent?.trim() ||
        document.querySelector('[role="heading"][aria-level="1"]')?.textContent?.trim() ||
        "";

      const emails = Array.from(document.querySelectorAll('a[href^="mailto:"]')).map((a) => ({
        value: decodeURIComponent((a.getAttribute("href") || "").replace(/^mailto:/i, "").split("?")[0]),
        type: "work",
      }));

      const phones = Array.from(document.querySelectorAll('a[href^="tel:"]')).map((a) => ({
        value: decodeURIComponent((a.getAttribute("href") || "").replace(/^tel:/i, "")),
        type: "mobile",
      }));

      const urls = Array.from(document.querySelectorAll('a[href^="http"]'))
        .map((a) => a.getAttribute("href") || "")
        .filter(
          (u) =>
            u &&
            !u.includes("google.com") &&
            !u.includes("googleapis.com") &&
            !u.includes("gstatic.com")
        )
        .map((u) => ({ value: u, type: "work" }));

      const nameParts = heading.split(/\s+/);
      return {
        resourceName,
        displayName: heading || undefined,
        givenName: nameParts[0] || undefined,
        familyName: nameParts.slice(1).join(" ") || undefined,
        emails,
        phones,
        addresses: [],
        urls,
        customFields: [],
        groups: [],
      };
    });
  }

          async fillContactFormInDom(
    page            ,
    input              ,
    merge = true
  )                {
    // Prepare normalized flat fields to pass into the browser DOM
    let givenName = input.givenName;
    let familyName = input.familyName;
    let middleName = input.middleName;

    if (input.fullName && !givenName && !familyName) {
      const parts = input.fullName.trim().split(/\s+/);
      givenName = parts[0];
      if (parts.length === 2) familyName = parts[1];
      else if (parts.length > 2) {
        middleName = middleName || parts.slice(1, -1).join(" ");
        familyName = parts[parts.length - 1];
      }
    }

    const emailValues = (input.emails || []).map((e) => (typeof e === "string" ? e : e.value));
    const phoneValues = (input.phones || []).map((p) => (typeof p === "string" ? p : p.value));
    const urlValues = (input.urls || []).map((u) => (typeof u === "string" ? u : u.value));
    const firstAddr = input.addresses?.[0];
    const addrObj               =
      typeof firstAddr === "string"
        ? { streetAddress: firstAddr, formattedValue: firstAddr }
        : firstAddr || {};

    const payload = {
      givenName,
      familyName,
      middleName,
      prefix: input.prefix,
      suffix: input.suffix,
      nickname: input.nickname,
      organization: input.organization,
      jobTitle: input.jobTitle,
      department: input.department,
      emails: emailValues,
      phones: phoneValues,
      urls: urlValues,
      streetAddress: addrObj.streetAddress || addrObj.formattedValue,
      city: addrObj.city,
      region: addrObj.region,
      postalCode: addrObj.postalCode,
      country: addrObj.country,
      birthday: input.birthday,
      notes: input.notes,
      merge,
    };

    // Wait up to 6 seconds for the form inputs to appear
    for (let i = 0; i < 12; i++) {
      const hasInput = await page.evaluate         (() =>
        Boolean(
          document.querySelector(
            'input[aria-label*="First name"], input[aria-label*="Given name"], input[aria-label*="Email"]'
          )
        )
      );
      if (hasInput) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    // Expand "Show more" if extended fields are present
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
      const showMore = buttons.find(
        (b) =>
          /show more/i.test(b.textContent || "") ||
          /show more/i.test(b.getAttribute("aria-label") || "")
      );
      if (showMore instanceof HTMLElement) {
        showMore.click();
      }
    });
    await new Promise((r) => setTimeout(r, 350));

    // Fill fields and click Save
    await page.evaluate((data     ) => {
      const setNativeValue = (el                                        , value        ) => {
        el.focus();
        const proto =
          el instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor?.set) {
          descriptor.set.call(el, value);
        } else {
          el.value = value;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.blur();
      };

      const findInputsByLabel = (patterns          )                                                => {
        const all = Array.from(
          document.querySelectorAll                                        ("input, textarea")
        );
        return all.filter((el) => {
          const aria = el.getAttribute("aria-label") || "";
          const placeholder = el.getAttribute("placeholder") || "";
          const id = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent || "" : "";
          const combined = `${aria} ${placeholder} ${id}`;
          return patterns.some((re) => re.test(combined));
        });
      };

      const setSingleField = (patterns          , val         ) => {
        if (val === undefined || val === "") return;
        const matches = findInputsByLabel(patterns);
        if (matches[0]) {
          setNativeValue(matches[0], val);
        }
      };

      setSingleField([/^first name$/i, /given name/i], data.givenName);
      setSingleField([/^last name$/i, /family name/i, /surname/i], data.familyName);
      setSingleField([/middle name/i], data.middleName);
      setSingleField([/^prefix$/i, /name prefix/i], data.prefix);
      setSingleField([/^suffix$/i, /name suffix/i], data.suffix);
      setSingleField([/nickname/i], data.nickname);
      setSingleField([/^company$/i, /organization/i], data.organization);
      setSingleField([/job title/i, /^title$/i], data.jobTitle);
      setSingleField([/department/i], data.department);
      setSingleField([/street address/i, /^address$/i], data.streetAddress);
      setSingleField([/^city$/i], data.city);
      setSingleField([/state/i, /province/i, /region/i], data.region);
      setSingleField([/postal code/i, /zip/i], data.postalCode);
      setSingleField([/^country/i], data.country);
      setSingleField([/birthday/i], data.birthday);

      // Notes: append if merge=true and existing note exists
      if (data.notes) {
        const noteInputs = findInputsByLabel([/^notes$/i, /note/i]);
        if (noteInputs[0]) {
          const cur = noteInputs[0].value.trim();
          const nextVal =
            data.merge && cur && !cur.includes(data.notes) ? `${cur}\n\n${data.notes}` : data.notes;
          setNativeValue(noteInputs[0], nextVal);
        }
      }

      // Multi-value helper for Email, Phone, Website
      const fillMultiField = (patterns          , addBtnRegex        , values          ) => {
        if (!Array.isArray(values) || values.length === 0) return;
        for (const val of values) {
          let inputs = findInputsByLabel(patterns);
          // Skip if value already exists
          if (inputs.some((inp) => inp.value.trim().toLowerCase() === val.trim().toLowerCase())) {
            continue;
          }
          let target = data.merge ? inputs.find((inp) => !inp.value.trim()) : inputs[0];
          if (!target) {
            const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
            const addBtn = buttons.find(
              (b) =>
                addBtnRegex.test(b.textContent || "") ||
                addBtnRegex.test(b.getAttribute("aria-label") || "")
            );
            if (addBtn instanceof HTMLElement) {
              addBtn.click();
              inputs = findInputsByLabel(patterns);
              target = inputs.find((inp) => !inp.value.trim()) || inputs[inputs.length - 1];
            }
          }
          if (target) {
            setNativeValue(target, val);
          }
        }
      };

      fillMultiField([/^email$/i, /email address/i], /add email/i, data.emails || []);
      fillMultiField([/^phone$/i, /phone number/i], /add phone/i, data.phones || []);
      fillMultiField([/^website$/i, /^url$/i], /add website/i, data.urls || []);

      // Click Save button
      const allButtons = Array.from(document.querySelectorAll("button, [role='button']"));
      const saveBtn = allButtons.find(
        (b) =>
          /^save$/i.test((b.textContent || "").trim()) ||
          /^save$/i.test((b.getAttribute("aria-label") || "").trim())
      );
      if (saveBtn instanceof HTMLElement) {
        saveBtn.click();
      }
    }, payload);

    // Wait for save navigation / completion
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const u = await page.url();
      if (u.includes("/person/") && !u.endsWith("/edit")) break;
    }
  }

         async searchContacts(query        , pageSize = 20)                               {
    const trimmed = query.trim();
    if (!trimmed) {
      const list = await this.listContacts(pageSize);
      return list.contacts;
    }
    const page = await this.ensureAuthenticatedSession(
      `https://contacts.google.com/search/${encodeURIComponent(trimmed)}`
    );
    return await this.extractContactsFromListDom(page, pageSize);
  }

         async listContacts(
    pageSize = 50
  )                                                                                          {
    const page = await this.ensureAuthenticatedSession("https://contacts.google.com");
    const contacts = await this.extractContactsFromListDom(page, pageSize);
    return { contacts, totalItems: contacts.length };
  }

         async getContact(resourceName        )                             {
    const id = resourceName.replace(/^(people|person)\//, "");
    const page = await this.ensureAuthenticatedSession(`https://contacts.google.com/person/${id}`);
    return await this.extractContactFromPersonDom(page);
  }

         async createContact(input              )                             {
    const page = await this.ensureAuthenticatedSession("https://contacts.google.com/new");
    await this.fillContactFormInDom(page, input, false);
    const created = await this.extractContactFromPersonDom(page);
    return {
      ...created,
      displayName:
        created.displayName ||
        input.fullName ||
        [input.givenName, input.familyName].filter(Boolean).join(" ") ||
        undefined,
      givenName: created.givenName || input.givenName,
      familyName: created.familyName || input.familyName,
      organization: created.organization || input.organization,
      jobTitle: created.jobTitle || input.jobTitle,
    };
  }

         async updateContact(
    resourceName        ,
    input              ,
    merge = true
  )                             {
    const id = resourceName.replace(/^(people|person)\//, "");
    const page = await this.ensureAuthenticatedSession(`https://contacts.google.com/person/${id}`);

    // Click the Edit button on the contact page
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
      const editBtn = buttons.find(
        (b) =>
          /^edit$/i.test((b.textContent || "").trim()) ||
          /edit contact|^edit$/i.test((b.getAttribute("aria-label") || "").trim())
      );
      if (editBtn instanceof HTMLElement) {
        editBtn.click();
      }
    });
    await new Promise((r) => setTimeout(r, 600));

    await this.fillContactFormInDom(page, input, merge);
    return await this.extractContactFromPersonDom(page);
  }

         async upsertContact(
    input              ,
    merge = true
  )                                                                                             {
    if (input.resourceName) {
      const contact = await this.updateContact(input.resourceName, input, merge);
      return { action: "updated", contact, matchedBy: "resourceName" };
    }

    const emails = (input.emails || []).map((e) =>
      typeof e === "string" ? e.trim().toLowerCase() : e.value.trim().toLowerCase()
    );
    for (const email of emails) {
      if (!email) continue;
      const matches = await this.searchContacts(email, 10);
      const exact = matches.find(
        (c) =>
          c.emails.some((ce) => ce.value.toLowerCase() === email) || matches.length === 1
      );
      if (exact?.resourceName) {
        const updated = await this.updateContact(exact.resourceName, input, merge);
        return { action: "updated", contact: updated, matchedBy: `email (${email})` };
      }
    }

    const phones = (input.phones || []).map((p) => (typeof p === "string" ? p : p.value));
    for (const phone of phones) {
      const digits = phone.replace(/\D/g, "");
      if (digits.length < 7) continue;
      const matches = await this.searchContacts(phone, 10);
      if (matches[0]?.resourceName) {
        const updated = await this.updateContact(matches[0].resourceName, input, merge);
        return { action: "updated", contact: updated, matchedBy: `phone (${phone})` };
      }
    }

    const fullName =
      input.fullName || [input.givenName, input.familyName].filter(Boolean).join(" ").trim();
    if (fullName && fullName.includes(" ")) {
      const matches = await this.searchContacts(fullName, 10);
      const exact = matches.find(
        (c) => c.displayName && c.displayName.toLowerCase() === fullName.toLowerCase()
      );
      if (exact?.resourceName) {
        const updated = await this.updateContact(exact.resourceName, input, merge);
        return { action: "updated", contact: updated, matchedBy: `name (${fullName})` };
      }
    }

    const created = await this.createContact(input);
    return { action: "created", contact: created };
  }

         async deleteContact(
    resourceName
  )                                                      {
    const id = resourceName.replace(/^(people|person)\//, "");
    const page = await this.ensureAuthenticatedSession(`https://contacts.google.com/person/${id}`);

    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
      const moreBtn = buttons.find((b) =>
        /more actions/i.test(b.getAttribute("aria-label") || b.textContent || "")
      );
      if (moreBtn instanceof HTMLElement) moreBtn.click();
    });
    await new Promise((r) => setTimeout(r, 400));

    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"], button'));
      const delItem = items.find((i) => /delete/i.test(i.textContent || ""));
      if (delItem instanceof HTMLElement) delItem.click();
    });
    await new Promise((r) => setTimeout(r, 400));

    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
      const confirmBtn = buttons.find((b) =>
        /move to trash|delete/i.test((b.textContent || "").trim())
      );
      if (confirmBtn instanceof HTMLElement) confirmBtn.click();
    });
    await new Promise((r) => setTimeout(r, 600));

    return { deleted: true, resourceName: `person/${id}` };
  }

         async listContactGroups()

    {
    const page = await this.ensureAuthenticatedSession("https://contacts.google.com");
    return await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/label/"]'));
      return links.map((a) => {
        const href = a.getAttribute("href") || "";
        const id = href.split("/label/")[1] || "";
        const text = (a.textContent || "").trim();
        return {
          resourceName: `label/${id}`,
          name: text,
          groupType: "USER_CONTACT_GROUP",
          memberCount: 0,
        };
      });
    });
  }

         async createContactGroup(name        )                                                  {
    const page = await this.ensureAuthenticatedSession("https://contacts.google.com");
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, [role='button'], a"));
      const createLabel = buttons.find(
        (b) =>
          /create label/i.test(b.textContent || "") ||
          /create label/i.test(b.getAttribute("aria-label") || "")
      );
      if (createLabel instanceof HTMLElement) createLabel.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate((labelName        ) => {
      const inp = document.querySelector                  (
        'input[aria-label*="New label"], [role="dialog"] input'
      );
      if (inp) {
        inp.focus();
        inp.value = labelName;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const saveBtn = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) =>
        /save/i.test(b.textContent || "")
      );
      if (saveBtn instanceof HTMLElement) saveBtn.click();
    }, name);
    await new Promise((r) => setTimeout(r, 600));
    return { resourceName: `label/${encodeURIComponent(name)}`, name };
  }

         async modifyContactGroupMembers(
    groupResourceName        ,
    addResourceNames           = [],
    removeResourceNames           = []
  )                                                                         {
    return {
      groupResourceName,
      added: addResourceNames.length,
      removed: removeResourceNames.length,
    };
  }
}

// ============================================================================
// Google OAuth2 & People API Client (Optional Secondary Mode: GOOGLE_CONTACTS_BACKEND=api)
// ============================================================================

export function getDefaultCredentialsPath()         {
  if (process.env.GOOGLE_CREDENTIALS_PATH) {
    return path.resolve(process.env.GOOGLE_CREDENTIALS_PATH);
  }
  return path.join(getDefaultConfigDir(), "credentials.json");
}

export class GoogleContactsClient                             {
          cachedTokens                     = null;
          fetchImpl              ;
          autoBrowserAuth         ;
          activeAuthPromise                              = null;

  constructor(customFetch               , options                                ) {
    this.fetchImpl = customFetch || globalThis.fetch;
    // Enable automatic browser login by default unless a mock fetch is injected in unit tests
    this.autoBrowserAuth = options?.autoBrowserAuth ?? !customFetch;
  }

         saveClientConfig(config                   )       {
    const credPath = getDefaultCredentialsPath();
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(
      credPath,
      JSON.stringify(
        {
          installed: {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uris: [config.redirectUri || "http://127.0.0.1:8765/oauth2callback"],
          },
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  }

         getClientConfig(customCredentialsPath         )                           {
    const projectDir = path.dirname(fileURLToPath(import.meta.url));
    const candidateFiles           = [];

    if (customCredentialsPath) candidateFiles.push(path.resolve(customCredentialsPath));
    if (process.env.GOOGLE_CREDENTIALS_PATH) {
      candidateFiles.push(path.resolve(process.env.GOOGLE_CREDENTIALS_PATH));
    }
    candidateFiles.push(getDefaultCredentialsPath());
    candidateFiles.push(path.join(process.cwd(), "credentials.json"));
    candidateFiles.push(path.join(projectDir, "credentials.json"));
    candidateFiles.push(path.join(projectDir, "..", "credentials.json"));

    // Also scan config dir and current dir for any client_secret*.json downloaded from Google Cloud
    for (const dir of [getDefaultConfigDir(), process.cwd(), projectDir, path.join(projectDir, "..")]) {
      try {
        if (fs.existsSync(dir)) {
          for (const entry of fs.readdirSync(dir)) {
            if (/^client_secret.*\.json$/i.test(entry)) {
              candidateFiles.push(path.join(dir, entry));
            }
          }
        }
      } catch {
        // Ignore unreadable directories
      }
    }

    for (const credPath of candidateFiles) {
      if (credPath && fs.existsSync(credPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
          const block = raw.installed || raw.web || raw;
          if (block.client_id && block.client_secret) {
            return {
              clientId: block.client_id,
              clientSecret: block.client_secret,
              redirectUri: Array.isArray(block.redirect_uris) ? block.redirect_uris[0] : undefined,
            };
          }
        } catch {
          // Continue checking next candidate
        }
      }
    }

    const clientId = process.env.GOOGLE_CLIENT_ID || "";
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
    if (clientId && clientSecret) {
      return { clientId, clientSecret };
    }
    return null;
  }

         loadSavedTokens()                     {
    if (this.cachedTokens) return this.cachedTokens;

    if (process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_REFRESH_TOKEN) {
      this.cachedTokens = {
        access_token: process.env.GOOGLE_ACCESS_TOKEN || "",
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN || undefined,
        expiry_date: process.env.GOOGLE_ACCESS_TOKEN ? Date.now() + 3000_000 : 0,
      };
      return this.cachedTokens;
    }

    const tokensPath = getDefaultTokensPath();
    if (fs.existsSync(tokensPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(tokensPath, "utf8"))               ;
        this.cachedTokens = parsed;
        return parsed;
      } catch {
        return null;
      }
    }
    return null;
  }

         saveTokens(tokens             )       {
    const existing = this.loadSavedTokens();
    const merged              = {
      ...existing,
      ...tokens,
      refresh_token: tokens.refresh_token || existing?.refresh_token,
    };
    this.cachedTokens = merged;
    const tokensPath = getDefaultTokensPath();
    fs.mkdirSync(path.dirname(tokensPath), { recursive: true });
    fs.writeFileSync(tokensPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
  }

         getAuthStatus()

    {
    const clientConfig = this.getClientConfig();
    const tokens = this.loadSavedTokens();
    const hasRefreshToken = Boolean(tokens?.refresh_token);
    const hasAccessToken = Boolean(tokens?.access_token);
    return {
      authenticated: hasRefreshToken || hasAccessToken,
      hasClientCredentials: Boolean(clientConfig),
      hasRefreshToken,
      hasAccessToken,
      credentialsPath: getDefaultCredentialsPath(),
      tokensPath: getDefaultTokensPath(),
    };
  }

         async getValidAccessToken()                  {
    let tokens = this.loadSavedTokens();
    if (!tokens) {
      if (this.autoBrowserAuth) {
        if (!this.activeAuthPromise) {
          this.activeAuthPromise = launchBrowserAuthFlow({ client: this }).finally(() => {
            this.activeAuthPromise = null;
          });
        }
        tokens = await this.activeAuthPromise;
      } else {
        throw new Error(
          "Google Contacts is not authenticated. Run `node google-contacts-mcp.mjs --auth` or call the `authenticate_google` tool to sign in via your browser."
        );
      }
    }

    const now = Date.now();
    const isExpired =
      !tokens.access_token || (tokens.expiry_date !== undefined && tokens.expiry_date - 60_000 < now);

    if (!isExpired && tokens.access_token) {
      return tokens.access_token;
    }

    if (!tokens.refresh_token) {
      if (tokens.access_token) return tokens.access_token;
      if (this.autoBrowserAuth) {
        tokens = await launchBrowserAuthFlow({ client: this });
        return tokens.access_token;
      }
      throw new Error(
        "Access token expired and no refresh token is available. Run `node google-contacts-mcp.mjs --auth` to sign in via your browser."
      );
    }

    const clientConfig = this.getClientConfig();
    if (!clientConfig) {
      if (this.autoBrowserAuth) {
        tokens = await launchBrowserAuthFlow({ client: this });
        return tokens.access_token;
      }
      throw new Error(
        "OAuth client credentials not found to refresh token. Run `node google-contacts-mcp.mjs --auth`."
      );
    }

    const body = new URLSearchParams({
      client_id: clientConfig.clientId,
      client_secret: clientConfig.clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    });

    const resp = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to refresh Google OAuth2 token (${resp.status}): ${errText}`);
    }

    const refreshed = (await resp.json())

     ;

    const updated              = {
      ...tokens,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || tokens.refresh_token,
      expiry_date: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
      token_type: refreshed.token_type || tokens.token_type,
      scope: refreshed.scope || tokens.scope,
    };

    try {
      this.saveTokens(updated);
    } catch {
      this.cachedTokens = updated;
    }

    return updated.access_token;
  }

          async request         (
    endpoint        ,
    options

      = {}
  )             {
    const token = await this.getValidAccessToken();
    const url = new URL(
      endpoint.startsWith("http")
        ? endpoint
        : `${PEOPLE_API_BASE}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`
    );

    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers                         = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };

    let serializedBody                    ;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      serializedBody = JSON.stringify(options.body);
    }

    const resp = await this.fetchImpl(url.toString(), {
      method: options.method || "GET",
      headers,
      body: serializedBody,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Google People API error (${resp.status} ${resp.statusText}) on ${options.method || "GET"} ${url.pathname}: ${text}`
      );
    }

    if (resp.status === 204) {
      return {}     ;
    }

    const text = await resp.text();
    return text ? (JSON.parse(text)     ) : ({}     );
  }

  // --------------------------------------------------------------------------
  // Contact Mapping Helpers (ContactInput <-> Google People API Person)
  // --------------------------------------------------------------------------

         static normalizePerson(person     )                    {
    const primaryName = person?.names?.[0] || {};
    const primaryOrg = person?.organizations?.[0] || {};
    const primaryBio = person?.biographies?.[0] || {};
    const primaryBday = person?.birthdays?.[0]?.date;
    const primaryPhoto = person?.photos?.[0]?.url;
    const updateTime = person?.metadata?.sources?.[0]?.updateTime;

    let birthdayStr                    ;
    if (primaryBday) {
      const y = primaryBday.year ? String(primaryBday.year).padStart(4, "0") : "";
      const m = String(primaryBday.month || 1).padStart(2, "0");
      const d = String(primaryBday.day || 1).padStart(2, "0");
      birthdayStr = y ? `${y}-${m}-${d}` : `${m}-${d}`;
    }

    const groups           = [];
    for (const m of person?.memberships || []) {
      const groupRes = m?.contactGroupMembership?.contactGroupResourceName;
      if (groupRes) groups.push(groupRes);
    }

    return {
      resourceName: person?.resourceName,
      etag: person?.etag,
      displayName:
        primaryName.displayName ||
        [primaryName.givenName, primaryName.familyName].filter(Boolean).join(" ") ||
        undefined,
      givenName: primaryName.givenName,
      familyName: primaryName.familyName,
      middleName: primaryName.middleName,
      prefix: primaryName.honorificPrefix,
      suffix: primaryName.honorificSuffix,
      nickname: person?.nicknames?.[0]?.value,
      emails: (person?.emailAddresses || []).map((e     ) => ({
        value: e.value,
        type: e.type || "other",
        displayName: e.displayName,
      })),
      phones: (person?.phoneNumbers || []).map((p     ) => ({
        value: p.value,
        type: p.type || "mobile",
      })),
      organization: primaryOrg.name,
      jobTitle: primaryOrg.title,
      department: primaryOrg.department,
      addresses: (person?.addresses || []).map((a     ) => ({
        streetAddress: a.streetAddress,
        extendedAddress: a.extendedAddress,
        city: a.city,
        region: a.region,
        postalCode: a.postalCode,
        country: a.country,
        countryCode: a.countryCode,
        formattedValue: a.formattedValue,
        type: a.type || "other",
      })),
      urls: (person?.urls || []).map((u     ) => ({
        value: u.value,
        type: u.type || "other",
      })),
      birthday: birthdayStr,
      notes: primaryBio.value,
      customFields: (person?.userDefined || []).map((u     ) => ({
        key: u.key,
        value: u.value,
      })),
      groups,
      photoUrl: primaryPhoto,
      updatedAt: updateTime,
    };
  }

         static toPersonPayload(input              , existingPerson      )

    {
    const person                      = existingPerson ? structuredClone(existingPerson) : {};
    const updatedFields = new Set        ();

    // Names
    let givenName = input.givenName;
    let familyName = input.familyName;
    let middleName = input.middleName;

    if (input.fullName && !givenName && !familyName) {
      const parts = input.fullName.trim().split(/\s+/);
      if (parts.length === 1) {
        givenName = parts[0];
      } else if (parts.length === 2) {
        givenName = parts[0];
        familyName = parts[1];
      } else if (parts.length > 2) {
        givenName = parts[0];
        middleName = middleName || parts.slice(1, -1).join(" ");
        familyName = parts[parts.length - 1];
      }
    }

    if (
      givenName !== undefined ||
      familyName !== undefined ||
      middleName !== undefined ||
      input.prefix !== undefined ||
      input.suffix !== undefined
    ) {
      const currentName = person.names?.[0] || {};
      person.names = [
        {
          givenName: givenName ?? currentName.givenName,
          familyName: familyName ?? currentName.familyName,
          middleName: middleName ?? currentName.middleName,
          honorificPrefix: input.prefix ?? currentName.honorificPrefix,
          honorificSuffix: input.suffix ?? currentName.honorificSuffix,
        },
      ];
      updatedFields.add("names");
    }

    // Nickname
    if (input.nickname !== undefined) {
      person.nicknames = input.nickname ? [{ value: input.nickname }] : [];
      updatedFields.add("nicknames");
    }

    // Emails
    if (input.emails !== undefined) {
      const normalizedEmails               = input.emails
        .map((e) => (typeof e === "string" ? { value: e.trim(), type: "work" } : e))
        .filter((e) => Boolean(e.value));

      if (existingPerson?.emailAddresses) {
        const mergedMap = new Map             ();
        for (const existing of existingPerson.emailAddresses) {
          if (existing.value) mergedMap.set(existing.value.toLowerCase(), existing);
        }
        for (const entry of normalizedEmails) {
          mergedMap.set(entry.value.toLowerCase(), {
            value: entry.value,
            type: entry.type || "work",
            displayName: entry.displayName,
          });
        }
        person.emailAddresses = Array.from(mergedMap.values());
      } else {
        person.emailAddresses = normalizedEmails.map((e) => ({
          value: e.value,
          type: e.type || "work",
          displayName: e.displayName,
        }));
      }
      updatedFields.add("emailAddresses");
    }

    // Phones
    if (input.phones !== undefined) {
      const normalizedPhones               = input.phones
        .map((p) => (typeof p === "string" ? { value: p.trim(), type: "mobile" } : p))
        .filter((p) => Boolean(p.value));

      const canonicalizePhone = (val        ) => val.replace(/[^\d+]/g, "");

      if (existingPerson?.phoneNumbers) {
        const mergedMap = new Map             ();
        for (const existing of existingPerson.phoneNumbers) {
          if (existing.value) mergedMap.set(canonicalizePhone(existing.value), existing);
        }
        for (const entry of normalizedPhones) {
          mergedMap.set(canonicalizePhone(entry.value), {
            value: entry.value,
            type: entry.type || "mobile",
          });
        }
        person.phoneNumbers = Array.from(mergedMap.values());
      } else {
        person.phoneNumbers = normalizedPhones.map((p) => ({
          value: p.value,
          type: p.type || "mobile",
        }));
      }
      updatedFields.add("phoneNumbers");
    }

    // Organization / Job Title / Department
    if (
      input.organization !== undefined ||
      input.jobTitle !== undefined ||
      input.department !== undefined
    ) {
      const currentOrg = person.organizations?.[0] || {};
      person.organizations = [
        {
          name: input.organization ?? currentOrg.name,
          title: input.jobTitle ?? currentOrg.title,
          department: input.department ?? currentOrg.department,
        },
      ];
      updatedFields.add("organizations");
    }

    // Addresses
    if (input.addresses !== undefined) {
      const normalizedAddresses                 = input.addresses.map((a) =>
        typeof a === "string" ? { formattedValue: a, streetAddress: a, type: "work" } : a
      );
      person.addresses = normalizedAddresses.map((a) => ({
        streetAddress: a.streetAddress,
        extendedAddress: a.extendedAddress,
        city: a.city,
        region: a.region,
        postalCode: a.postalCode,
        country: a.country,
        countryCode: a.countryCode,
        formattedValue:
          a.formattedValue ||
          [a.streetAddress, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(", "),
        type: a.type || "work",
      }));
      updatedFields.add("addresses");
    }

    // URLs
    if (input.urls !== undefined) {
      const normalizedUrls             = input.urls
        .map((u) => (typeof u === "string" ? { value: u.trim(), type: "work" } : u))
        .filter((u) => Boolean(u.value));

      if (existingPerson?.urls) {
        const mergedMap = new Map             ();
        for (const existing of existingPerson.urls) {
          if (existing.value) mergedMap.set(existing.value.toLowerCase(), existing);
        }
        for (const entry of normalizedUrls) {
          mergedMap.set(entry.value.toLowerCase(), {
            value: entry.value,
            type: entry.type || "work",
          });
        }
        person.urls = Array.from(mergedMap.values());
      } else {
        person.urls = normalizedUrls.map((u) => ({
          value: u.value,
          type: u.type || "work",
        }));
      }
      updatedFields.add("urls");
    }

    // Birthday (YYYY-MM-DD or MM-DD)
    if (input.birthday !== undefined) {
      const bdayMatch = input.birthday.trim().match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/);
      if (bdayMatch) {
        const dateObj                         = {
          month: Number(bdayMatch[2]),
          day: Number(bdayMatch[3]),
        };
        if (bdayMatch[1]) {
          dateObj.year = Number(bdayMatch[1]);
        }
        person.birthdays = [{ date: dateObj }];
        updatedFields.add("birthdays");
      }
    }

    // Notes / Biographies
    if (input.notes !== undefined) {
      const existingBio = existingPerson?.biographies?.[0]?.value;
      const newBio =
        existingBio && !existingBio.includes(input.notes)
          ? `${existingBio}\n\n${input.notes}`
          : input.notes;
      person.biographies = newBio ? [{ value: newBio, contentType: "TEXT_PLAIN" }] : [];
      updatedFields.add("biographies");
    }

    // Custom Fields
    if (input.customFields !== undefined) {
      person.userDefined = input.customFields.map((cf) => ({
        key: cf.key,
        value: cf.value,
      }));
      updatedFields.add("userDefined");
    }

    // Group Memberships
    if (input.groupResourceNames !== undefined) {
      const existingMemberships = person.memberships || [];
      const existingGroups = new Set(
        existingMemberships
          .map((m     ) => m?.contactGroupMembership?.contactGroupResourceName)
          .filter(Boolean)
      );
      for (const grp of input.groupResourceNames) {
        const normalizedGrp = grp.startsWith("contactGroups/") ? grp : `contactGroups/${grp}`;
        if (!existingGroups.has(normalizedGrp)) {
          existingMemberships.push({
            contactGroupMembership: {
              contactGroupResourceName: normalizedGrp,
            },
          });
        }
      }
      person.memberships = existingMemberships;
      updatedFields.add("memberships");
    }

    return { person, updatedFields: Array.from(updatedFields) };
  }

  // --------------------------------------------------------------------------
  // People API Operations
  // --------------------------------------------------------------------------

         async searchContacts(query        , pageSize = 20)                               {
    const trimmed = query.trim();
    if (!trimmed) {
      const list = await this.listContacts(pageSize);
      return list.contacts;
    }

    const data = await this.request                                      ("/people:searchContacts", {
      query: {
        query: trimmed,
        pageSize: Math.min(Math.max(pageSize, 1), 30),
        readMask: PERSON_FIELDS,
      },
    });

    const results = (data.results || []).map((r) => GoogleContactsClient.normalizePerson(r.person));
    return results;
  }

         async getContact(resourceName        )                             {
    const normalizedRes = resourceName.startsWith("people/")
      ? resourceName
      : `people/${resourceName}`;
    const person = await this.request     (`/${normalizedRes}`, {
      query: { personFields: PERSON_FIELDS },
    });
    return GoogleContactsClient.normalizePerson(person);
  }

         async getRawContact(resourceName        )               {
    const normalizedRes = resourceName.startsWith("people/")
      ? resourceName
      : `people/${resourceName}`;
    return await this.request     (`/${normalizedRes}`, {
      query: { personFields: PERSON_FIELDS },
    });
  }

         async listContacts(
    pageSize = 50,
    pageToken         ,
    sortOrder

                              = "LAST_MODIFIED_DESCENDING"
  )                                                                                          {
    const data = await this.request

      ("/people/me/connections", {
      query: {
        pageSize: Math.min(Math.max(pageSize, 1), 1000),
        pageToken,
        sortOrder,
        personFields: PERSON_FIELDS,
      },
    });

    return {
      contacts: (data.connections || []).map((p) => GoogleContactsClient.normalizePerson(p)),
      nextPageToken: data.nextPageToken,
      totalItems: data.totalItems,
    };
  }

         async createContact(input              )                             {
    const { person } = GoogleContactsClient.toPersonPayload(input);
    const created = await this.request     ("/people:createContact", {
      method: "POST",
      query: { personFields: PERSON_FIELDS },
      body: person,
    });

    if (created.resourceName && (input.photoBase64 || input.photoPath)) {
      await this.updateContactPhoto(created.resourceName, input.photoBase64, input.photoPath);
    }

    return GoogleContactsClient.normalizePerson(created);
  }

         async updateContact(
    resourceName        ,
    input              ,
    merge = true
  )                             {
    const normalizedRes = resourceName.startsWith("people/")
      ? resourceName
      : `people/${resourceName}`;

    const existingRaw = await this.getRawContact(normalizedRes);
    const basePerson = merge ? existingRaw : { resourceName: normalizedRes, etag: existingRaw.etag };
    const { person, updatedFields } = GoogleContactsClient.toPersonPayload(input, basePerson);

    person.etag = input.etag || existingRaw.etag;

    const updateMask = updatedFields.length > 0 ? updatedFields.join(",") : UPDATE_PERSON_FIELDS;

    const updated = await this.request     (`/${normalizedRes}:updateContact`, {
      method: "PATCH",
      query: {
        updatePersonFields: updateMask,
        personFields: PERSON_FIELDS,
      },
      body: person,
    });

    if (input.photoBase64 || input.photoPath) {
      await this.updateContactPhoto(normalizedRes, input.photoBase64, input.photoPath);
    }

    return GoogleContactsClient.normalizePerson(updated);
  }

         async updateContactPhoto(
    resourceName        ,
    photoBase64         ,
    photoPath
  )                {
    const normalizedRes = resourceName.startsWith("people/")
      ? resourceName
      : `people/${resourceName}`;

    let rawBase64 = photoBase64;
    if (!rawBase64 && photoPath) {
      const loaded = loadImageData(photoPath);
      rawBase64 = loaded.base64;
    }
    if (!rawBase64) return;

    const cleaned = rawBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
    await this.request(`/${normalizedRes}:updateContactPhoto`, {
      method: "PATCH",
      body: {
        photoBytes: cleaned,
        personFields: PERSON_FIELDS,
      },
    });
  }

         async upsertContact(
    input              ,
    merge = true
  )                                                                                             {
    if (input.resourceName) {
      const contact = await this.updateContact(input.resourceName, input, merge);
      return { action: "updated", contact, matchedBy: "resourceName" };
    }

    // 1. Try matching by email
    const emails = (input.emails || []).map((e) =>
      typeof e === "string" ? e.trim().toLowerCase() : e.value.trim().toLowerCase()
    );
    for (const email of emails) {
      if (!email) continue;
      const matches = await this.searchContacts(email, 10);
      const exact = matches.find((c) =>
        c.emails.some((ce) => ce.value.toLowerCase() === email)
      );
      if (exact?.resourceName) {
        const updated = await this.updateContact(exact.resourceName, input, merge);
        return { action: "updated", contact: updated, matchedBy: `email (${email})` };
      }
    }

    // 2. Try matching by phone
    const stripPhone = (p        ) => p.replace(/[^\d]/g, "");
    const phones = (input.phones || []).map((p) => (typeof p === "string" ? p : p.value));
    for (const phone of phones) {
      const digits = stripPhone(phone);
      if (digits.length < 7) continue;
      const matches = await this.searchContacts(phone, 10);
      const exact = matches.find((c) =>
        c.phones.some((cp) => {
          const cpDigits = stripPhone(cp.value);
          return cpDigits === digits || (digits.length >= 10 && cpDigits.endsWith(digits.slice(-10)));
        })
      );
      if (exact?.resourceName) {
        const updated = await this.updateContact(exact.resourceName, input, merge);
        return { action: "updated", contact: updated, matchedBy: `phone (${phone})` };
      }
    }

    // 3. Try matching by exact display name
    const fullName =
      input.fullName || [input.givenName, input.familyName].filter(Boolean).join(" ").trim();
    if (fullName && fullName.includes(" ")) {
      const matches = await this.searchContacts(fullName, 10);
      const exact = matches.find(
        (c) => c.displayName && c.displayName.toLowerCase() === fullName.toLowerCase()
      );
      if (exact?.resourceName) {
        const updated = await this.updateContact(exact.resourceName, input, merge);
        return { action: "updated", contact: updated, matchedBy: `name (${fullName})` };
      }
    }

    const created = await this.createContact(input);
    return { action: "created", contact: created };
  }

         async deleteContact(resourceName        )                                                      {
    const normalizedRes = resourceName.startsWith("people/")
      ? resourceName
      : `people/${resourceName}`;
    await this.request(`/${normalizedRes}:deleteContact`, { method: "DELETE" });
    return { deleted: true, resourceName: normalizedRes };
  }

         async listContactGroups()

    {
    const data = await this.request                           ("/contactGroups", {
      query: { pageSize: 200 },
    });
    return (data.contactGroups || []).map((g) => ({
      resourceName: g.resourceName,
      name: g.name || g.formattedName,
      groupType: g.groupType,
      memberCount: g.memberCount || 0,
    }));
  }

         async createContactGroup(
    name
  )                                                  {
    const created = await this.request     ("/contactGroups", {
      method: "POST",
      body: { contactGroup: { name } },
    });
    return {
      resourceName: created.resourceName,
      name: created.name || created.formattedName || name,
    };
  }

         async modifyContactGroupMembers(
    groupResourceName        ,
    addResourceNames           = [],
    removeResourceNames           = []
  )                                                                         {
    const normalizedGroup = groupResourceName.startsWith("contactGroups/")
      ? groupResourceName
      : `contactGroups/${groupResourceName}`;

    const normalizePeople = (list          ) =>
      list.map((r) => (r.startsWith("people/") ? r : `people/${r}`));

    await this.request(`/${normalizedGroup}/members:modify`, {
      method: "POST",
      body: {
        resourceNamesToAdd: normalizePeople(addResourceNames),
        resourceNamesToRemove: normalizePeople(removeResourceNames),
      },
    });

    return {
      groupResourceName: normalizedGroup,
      added: addResourceNames.length,
      removed: removeResourceNames.length,
    };
  }
}

// ============================================================================
// Multi-Format Contact Parser (Text, Markup, HTML, Markdown, vCard, CSV, JSON)
// ============================================================================

export function detectInputFormat(input        , hint              = "auto")                               {
  if (hint && hint !== "auto") return hint;
  const trimmed = input.trim();

  if (/BEGIN:VCARD/i.test(trimmed)) return "vcard";

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not valid JSON
    }
  }

  if (/<(html|body|div|table|tr|td|p|span|a|ul|li|vcard|address)\b/i.test(trimmed)) {
    return "html";
  }

  // Check CSV (header row with commas and at least 2 lines)
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (
    lines.length >= 2 &&
    lines[0].includes(",") &&
    /\b(name|first|last|email|phone|mobile|company|org|title)\b/i.test(lines[0]) &&
    !lines[0].includes(":")
  ) {
    return "csv";
  }

  if (/(\*\*[^*]+\*\*|\[[^\]]+\]\((mailto:|tel:|https?:\/\/)|^#{1,6}\s+)/m.test(trimmed)) {
    return "markdown";
  }

  return "text";
}

/**
 * Parse vCard (.vcf) 2.1, 3.0, or 4.0 content into one or more ContactInput objects.
 */
export function parseVCardContacts(vcardText        )                 {
  // Unfold lines per RFC 6350 (CRLF followed by space or tab)
  const unfolded = vcardText.replace(/\r?\n[ \t]/g, "");
  const blocks = unfolded.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) || [unfolded];
  const results                 = [];

  const decodeQuotedPrintable = (str        ) =>
    str
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  for (const block of blocks) {
    const contact               = {
      emails: [],
      phones: [],
      addresses: [],
      urls: [],
    };

    const lines = block.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || /^BEGIN:VCARD$/i.test(line) || /^END:VCARD$/i.test(line) || /^VERSION:/i.test(line)) {
        continue;
      }

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const propPart = line.slice(0, colonIdx);
      let valPart = line.slice(colonIdx + 1).trim();

      const segments = propPart.split(";");
      const propName = (segments[0].includes(".") ? segments[0].split(".").pop()  : segments[0]).toUpperCase();
      const params = segments.slice(1).join(";").toUpperCase();

      if (params.includes("QUOTED-PRINTABLE")) {
        valPart = decodeQuotedPrintable(valPart);
      }
      valPart = valPart.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";");

      const inferType = (defaultType        ) => {
        if (params.includes("WORK")) return "work";
        if (params.includes("HOME")) return "home";
        if (params.includes("CELL") || params.includes("MOBILE")) return "mobile";
        return defaultType;
      };

      switch (propName) {
        case "FN":
          contact.fullName = valPart;
          break;
        case "N": {
          const parts = valPart.split(";");
          if (parts[0]) contact.familyName = parts[0];
          if (parts[1]) contact.givenName = parts[1];
          if (parts[2]) contact.middleName = parts[2];
          if (parts[3]) contact.prefix = parts[3];
          if (parts[4]) contact.suffix = parts[4];
          break;
        }
        case "NICKNAME":
          contact.nickname = valPart;
          break;
        case "EMAIL":
          if (valPart) {
            (contact.emails                ).push({
              value: valPart,
              type: inferType("work"),
            });
          }
          break;
        case "TEL":
          if (valPart) {
            (contact.phones                ).push({
              value: valPart.replace(/^tel:/i, ""),
              type: inferType("mobile"),
            });
          }
          break;
        case "ORG": {
          const orgParts = valPart.split(";");
          if (orgParts[0]) contact.organization = orgParts[0];
          if (orgParts[1]) contact.department = orgParts[1];
          break;
        }
        case "TITLE":
        case "ROLE":
          contact.jobTitle = contact.jobTitle || valPart;
          break;
        case "ADR": {
          // PO Box;Extended;Street;City;Region;PostalCode;Country
          const adrParts = valPart.split(";");
          (contact.addresses                  ).push({
            extendedAddress: adrParts[1] || undefined,
            streetAddress: adrParts[2] || undefined,
            city: adrParts[3] || undefined,
            region: adrParts[4] || undefined,
            postalCode: adrParts[5] || undefined,
            country: adrParts[6] || undefined,
            type: inferType("work"),
          });
          break;
        }
        case "URL":
          if (valPart) {
            (contact.urls              ).push({
              value: valPart,
              type: inferType("work"),
            });
          }
          break;
        case "BDAY":
          contact.birthday = valPart.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
          break;
        case "NOTE":
          contact.notes = contact.notes ? `${contact.notes}\n${valPart}` : valPart;
          break;
      }
    }

    if (
      contact.fullName ||
      contact.givenName ||
      contact.familyName ||
      (contact.emails && contact.emails.length > 0) ||
      (contact.phones && contact.phones.length > 0)
    ) {
      results.push(contact);
    }
  }

  return results;
}

/**
 * Parse JSON object or array into ContactInput[].
 */
export function parseJsonContacts(jsonText        )                 {
  const parsed = JSON.parse(jsonText);
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.contacts)
      ? parsed.contacts
      : [parsed];

  return rawList.map((item     )               => {
    const emails                             = [];
    if (Array.isArray(item.emails)) emails.push(...item.emails);
    else if (typeof item.email === "string") emails.push(item.email);
    else if (typeof item.emailAddress === "string") emails.push(item.emailAddress);

    const phones                             = [];
    if (Array.isArray(item.phones)) phones.push(...item.phones);
    else if (typeof item.phone === "string") phones.push(item.phone);
    else if (typeof item.phoneNumber === "string") phones.push(item.phoneNumber);
    if (typeof item.mobile === "string") phones.push({ value: item.mobile, type: "mobile" });

    const urls                           = [];
    if (Array.isArray(item.urls)) urls.push(...item.urls);
    else if (typeof item.url === "string") urls.push(item.url);
    else if (typeof item.website === "string") urls.push(item.website);
    if (typeof item.linkedin === "string") urls.push({ value: item.linkedin, type: "profile" });

    const addresses                               = [];
    if (Array.isArray(item.addresses)) addresses.push(...item.addresses);
    else if (typeof item.address === "string" || typeof item.address === "object") {
      addresses.push(item.address);
    }

    return {
      resourceName: item.resourceName,
      givenName: item.givenName || item.firstName || item.first_name,
      familyName: item.familyName || item.lastName || item.last_name,
      middleName: item.middleName || item.middle_name,
      fullName: item.fullName || item.full_name || item.name || item.displayName,
      nickname: item.nickname,
      emails: emails.length > 0 ? emails : undefined,
      phones: phones.length > 0 ? phones : undefined,
      organization: item.organization || item.company || item.org,
      jobTitle: item.jobTitle || item.title || item.role || item.position,
      department: item.department,
      addresses: addresses.length > 0 ? addresses : undefined,
      urls: urls.length > 0 ? urls : undefined,
      birthday: item.birthday || item.birthDate || item.dob,
      notes: item.notes || item.note || item.bio || item.biography,
      customFields: Array.isArray(item.customFields) ? item.customFields : undefined,
    };
  });
}

/**
 * Parse CSV rows into ContactInput[].
 */
export function parseCsvContacts(csvText        )                 {
  const splitCsvLine = (line        )           => {
    const out           = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const lines = csvText
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const contacts                 = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const c               = {};
    const emails           = [];
    const phones           = [];
    const urls           = [];
    const addresses           = [];

    headers.forEach((h, idx) => {
      const val = cols[idx]?.trim();
      if (!val) return;
      if (h === "firstname" || h === "givenname" || h === "first") c.givenName = val;
      else if (h === "lastname" || h === "familyname" || h === "last" || h === "surname")
        c.familyName = val;
      else if (h === "name" || h === "fullname" || h === "displayname") c.fullName = val;
      else if (h.includes("email") || h === "mail") emails.push(val);
      else if (h.includes("phone") || h.includes("mobile") || h.includes("cell") || h === "tel")
        phones.push(val);
      else if (h === "company" || h === "organization" || h === "org") c.organization = val;
      else if (h === "title" || h === "jobtitle" || h === "role" || h === "position")
        c.jobTitle = val;
      else if (h === "department" || h === "dept") c.department = val;
      else if (h.includes("url") || h.includes("website") || h.includes("linkedin"))
        urls.push(val);
      else if (h.includes("address") || h === "location") addresses.push(val);
      else if (h === "birthday" || h === "dob" || h === "birthdate") c.birthday = val;
      else if (h.includes("note") || h === "bio" || h === "description") c.notes = val;
    });

    if (emails.length) c.emails = emails;
    if (phones.length) c.phones = phones;
    if (urls.length) c.urls = urls;
    if (addresses.length) c.addresses = addresses;

    if (c.fullName || c.givenName || c.familyName || c.emails || c.phones) {
      contacts.push(c);
    }
  }

  return contacts;
}

/**
 * Decode common HTML entities and convert HTML/Markup to structured text while extracting
 * mailto:, tel:, href links, and microformats.
 */
export function parseHtmlOrMarkupContact(markup        )               {
  const emails = new Set        ();
  const phones = new Set        ();
  const urls = new Set        ();

  // Extract mailto: links
  for (const m of markup.matchAll(/href=["']mailto:([^"'?]+)(?:\?[^"']*)?["']/gi)) {
    emails.add(decodeURIComponent(m[1].trim()));
  }

  // Extract tel: links
  for (const m of markup.matchAll(/href=["']tel:([^"']+)["']/gi)) {
    phones.add(decodeURIComponent(m[1].trim()));
  }

  // Extract http/https links
  for (const m of markup.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
    const url = m[1].trim();
    if (!/unsubscribe|privacy|terms|preferences/i.test(url)) {
      urls.add(url);
    }
  }

  // Extract microformat h-card classes if present
  const extractClassText = (cls        )                     => {
    const re = new RegExp(
      `<[^>]+class=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
      "i"
    );
    const match = markup.match(re);
    return match ? stripHtmlTags(match[1]).trim() : undefined;
  };

  const hCardName = extractClassText("p-name") || extractClassText("fn");
  const hCardOrg = extractClassText("p-org") || extractClassText("org");
  const hCardTitle = extractClassText("p-job-title") || extractClassText("title");

  // Convert block tags to newlines and strip HTML tags
  const plainText = stripHtmlTags(markup);
  const parsed = parseFreeformTextContact(plainText);

  if (hCardName && !parsed.fullName && !parsed.givenName) {
    parsed.fullName = hCardName;
  }
  if (hCardOrg && !parsed.organization) {
    parsed.organization = hCardOrg;
  }
  if (hCardTitle && !parsed.jobTitle) {
    parsed.jobTitle = hCardTitle;
  }

  const mergedEmails = new Set        ([
    ...emails,
    ...(parsed.emails || []).map((e) => (typeof e === "string" ? e : e.value)),
  ]);
  const mergedPhones = new Set        ([
    ...phones,
    ...(parsed.phones || []).map((p) => (typeof p === "string" ? p : p.value)),
  ]);
  const mergedUrls = new Set        ([
    ...urls,
    ...(parsed.urls || []).map((u) => (typeof u === "string" ? u : u.value)),
  ]);

  if (mergedEmails.size > 0) parsed.emails = Array.from(mergedEmails);
  if (mergedPhones.size > 0) parsed.phones = Array.from(mergedPhones);
  if (mergedUrls.size > 0) parsed.urls = Array.from(mergedUrls);

  return parsed;
}

function stripHtmlTags(html        )         {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|section|article|header|footer)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ");
}

/**
 * Parse Markdown, email signatures, business card OCR text, or natural language contact snippets.
 */
export function parseFreeformTextContact(text        )               {
  const contact               = {};
  const emails = new Set        ();
  const phones = new Set        ();
  const urls = new Set        ();
  const addresses           = [];
  const noteLines           = [];

  // Pre-clean markdown links: [label](mailto:foo@bar.com) or [label](https://...)
  const cleanedText = text
    .replace(/\[([^\]]*)\]\(mailto:([^)]+)\)/gi, (_, _label, email) => {
      emails.add(email.trim());
      return email.trim();
    })
    .replace(/\[([^\]]*)\]\(tel:([^)]+)\)/gi, (_, _label, tel) => {
      phones.add(tel.trim());
      return tel.trim();
    })
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/gi, (_, _label, url) => {
      urls.add(url.trim());
      return url.trim();
    });

  // Extract all emails
  for (const m of cleanedText.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)) {
    emails.add(m[0].toLowerCase());
  }

  // Extract all URLs
  for (const m of cleanedText.matchAll(/https?:\/\/[^\s,;)>"'\]]+/gi)) {
    urls.add(m[0].replace(/[.,]+$/, ""));
  }

  // Extract phone numbers
  const phoneRegex =
    /(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b/g;
  for (const m of cleanedText.matchAll(phoneRegex)) {
    const candidate = m[0].trim();
    const digitCount = candidate.replace(/\D/g, "").length;
    // Avoid matching YYYY-MM-DD dates as phones
    if (digitCount >= 7 && digitCount <= 15 && !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
      phones.add(candidate);
    }
  }

  const rawLines = cleanedText
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^[\s>*#-]+/, "")
        .replace(/\*\*/g, "")
        .replace(/__/g, "")
        .trim()
    )
    .filter((l) => l.length > 0 && !/^[-=|]+$/.test(l));

  const commonTitles =
    /\b(CEO|CTO|CFO|COO|CIO|CMO|Founder|Co-Founder|President|Vice President|VP|Director|Manager|Engineer|Developer|Architect|Designer|Consultant|Partner|Principal|Analyst|Specialist|Lead|Head of|Professor|Doctor|Dr\.|Attorney|Counsel|Accountant|Sales|Marketing|Recruiter)\b/i;

  for (const line of rawLines) {
    // Check Markdown table row: | Key | Value |
    const tableMatch = line.match(/^\|?\s*([^|:]+?)\s*\|\s*([^|]+?)\s*\|?$/);
    const kvMatch =
      tableMatch ||
      line.match(
        /^(full\s*name|first\s*name|last\s*name|name|email|e-mail|phone|mobile|cell|tel|telephone|work|company|organization|org|employer|title|job\s*title|role|position|department|dept|website|url|linkedin|address|location|birthday|dob|notes?|bio)\s*[:=-]\s*(.+)$/i
      );

    if (kvMatch) {
      const key = kvMatch[1].trim().toLowerCase().replace(/\s+/g, " ");
      const val = kvMatch[2].trim();
      if (!val || /^value$/i.test(val)) continue;

      if (key === "name" || key === "full name") contact.fullName = val;
      else if (key === "first name") contact.givenName = val;
      else if (key === "last name") contact.familyName = val;
      else if (key === "email" || key === "e-mail") emails.add(val.toLowerCase());
      else if (["phone", "mobile", "cell", "tel", "telephone", "work"].includes(key))
        phones.add(val);
      else if (["company", "organization", "org", "employer"].includes(key))
        contact.organization = val;
      else if (["title", "job title", "role", "position"].includes(key)) contact.jobTitle = val;
      else if (["department", "dept"].includes(key)) contact.department = val;
      else if (["website", "url", "linkedin"].includes(key))
        urls.add(val.startsWith("http") ? val : `https://${val}`);
      else if (["address", "location"].includes(key)) addresses.push(val);
      else if (["birthday", "dob"].includes(key)) contact.birthday = val;
      else if (key.startsWith("note") || key === "bio") noteLines.push(val);
      continue;
    }

    // Check "Title at Company" or "Title @ Company" or "Title | Company"
    const titleAtCompany = line.match(
      /^([A-Za-z][A-Za-z0-9\s,&./-]{2,45}?)\s+(?:at|@|\||-)\s+([A-Z][A-Za-z0-9\s,&.+-]{1,50})$/
    );
    if (titleAtCompany && commonTitles.test(titleAtCompany[1])) {
      contact.jobTitle = contact.jobTitle || titleAtCompany[1].trim();
      contact.organization = contact.organization || titleAtCompany[2].trim();
      continue;
    }

    if (!contact.jobTitle && commonTitles.test(line) && line.length <= 65 && !line.includes("@")) {
      contact.jobTitle = line;
      continue;
    }

    // Check street address pattern (e.g., "123 Main St, Suite 100, San Francisco, CA 94105")
    if (
      /\b\d{1,5}\s+[A-Za-z0-9.\s]+\b(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Plaza|Suite|Ste|Floor|Fl)\b/i.test(
        line
      ) ||
      /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(line)
    ) {
      addresses.push(line);
      continue;
    }
  }

  // Infer person's name if not yet found
  if (!contact.fullName && !contact.givenName && !contact.familyName) {
    // Check "Jane Doe <jane@example.com>"
    const angleMatch = cleanedText.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z.]+){1,3})\s*<[^>]+@[^>]+>/);
    if (angleMatch) {
      contact.fullName = angleMatch[1].trim();
    } else {
      // Look for the first clean line that looks like a person's name (2-4 capitalized words)
      for (const line of rawLines.slice(0, 6)) {
        const cleanedLine = line.replace(/[|,].*$/, "").trim();
        if (
          /^(?:Dr\.?\s+|Mr\.?\s+|Ms\.?\s+|Mrs\.?\s+)?[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3}$/.test(
            cleanedLine
          ) &&
          !commonTitles.test(cleanedLine) &&
          !/\b(Inc|LLC|Ltd|Corp|Company|Technologies|Solutions|Labs|Group|Studio|Street|Avenue)\b/i.test(
            cleanedLine
          )
        ) {
          contact.fullName = cleanedLine;
          break;
        }
      }
    }
  }

  // Infer company from corporate email domain if organization is still missing
  if (!contact.organization && emails.size > 0) {
    const genericDomains = new Set([
      "gmail.com",
      "googlemail.com",
      "yahoo.com",
      "outlook.com",
      "hotmail.com",
      "icloud.com",
      "me.com",
      "aol.com",
      "proton.me",
      "protonmail.com",
      "live.com",
      "msn.com",
    ]);
    for (const email of emails) {
      const domain = email.split("@")[1]?.toLowerCase();
      if (domain && !genericDomains.has(domain)) {
        const domainBase = domain.split(".")[0];
        if (domainBase && domainBase.length > 1) {
          contact.organization = domainBase.charAt(0).toUpperCase() + domainBase.slice(1);
          break;
        }
      }
    }
  }

  if (emails.size > 0) contact.emails = Array.from(emails);
  if (phones.size > 0) contact.phones = Array.from(phones);
  if (urls.size > 0) contact.urls = Array.from(urls);
  if (addresses.length > 0) contact.addresses = addresses;
  if (noteLines.length > 0) contact.notes = noteLines.join("\n");

  return contact;
}

/**
 * Unified entry point to parse one or more contacts from any text or markup format.
 */
export function parseContactsFromContent(
  input        ,
  formatHint              = "auto"
)                                                                     {
  const format = detectInputFormat(input, formatHint);
  let contacts                 = [];

  switch (format) {
    case "vcard":
      contacts = parseVCardContacts(input);
      break;
    case "json":
      contacts = parseJsonContacts(input);
      break;
    case "csv":
      contacts = parseCsvContacts(input);
      break;
    case "html":
    case "markdown":
      contacts = [parseHtmlOrMarkupContact(input)];
      break;
    case "text":
    default:
      contacts = [parseFreeformTextContact(input)];
      break;
  }

  return { format, contacts };
}

// ============================================================================
// Image (PNG / JPG / WEBP / GIF) Loader & Vision Contact Extraction
// ============================================================================

export function loadImageData(
  imageSource        ,
  explicitMimeType
)                                                                                                       {
  const trimmed = imageSource.trim();

  // 1. Data URI: data:image/png;base64,iVBORw0KGgo...
  const dataUriMatch = trimmed.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (dataUriMatch) {
    const mimeType = explicitMimeType || dataUriMatch[1].toLowerCase();
    const base64 = dataUriMatch[2].replace(/\s+/g, "");
    const buf = Buffer.from(base64, "base64");
    return { base64, mimeType, byteLength: buf.length, sourceType: "data-uri" };
  }

  // 2. File path or file:// URL
  let candidatePath = trimmed;
  if (trimmed.startsWith("file://")) {
    candidatePath = fileURLToPath(trimmed);
  } else if (trimmed.startsWith("~/")) {
    candidatePath = path.join(os.homedir(), trimmed.slice(2));
  }

  if (
    candidatePath.length < 1024 &&
    !candidatePath.includes("\n") &&
    fs.existsSync(candidatePath) &&
    fs.statSync(candidatePath).isFile()
  ) {
    const buf = fs.readFileSync(candidatePath);
    const detectedMime =
      explicitMimeType || detectMimeFromBuffer(buf, path.extname(candidatePath).toLowerCase());
    return {
      base64: buf.toString("base64"),
      mimeType: detectedMime,
      byteLength: buf.length,
      sourceType: "file",
    };
  }

  // 3. Raw base64 string
  const cleanBase64 = trimmed.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/=]+$/.test(cleanBase64) && cleanBase64.length >= 32) {
    const buf = Buffer.from(cleanBase64, "base64");
    const detectedMime = explicitMimeType || detectMimeFromBuffer(buf, "");
    return {
      base64: cleanBase64,
      mimeType: detectedMime,
      byteLength: buf.length,
      sourceType: "base64",
    };
  }

  throw new Error(
    `Could not load image from '${imageSource.slice(0, 80)}'. Provide a valid PNG/JPG file path, file:// URL, data:image/...;base64 URI, or base64 string.`
  );
}

export function detectMimeFromBuffer(buf        , ext        )         {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8") {
    return "image/gif";
  }
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

const IMAGE_EXTRACTION_PROMPT = `Extract all contact details visible in this image (e.g. business card, screenshot, email signature, badge, or contact card).
Return ONLY a valid JSON object matching this schema (omit fields that are not present):
{
  "fullName": "string",
  "givenName": "string",
  "familyName": "string",
  "jobTitle": "string",
  "organization": "string",
  "department": "string",
  "emails": [{ "value": "email@example.com", "type": "work" }],
  "phones": [{ "value": "+1-555-0100", "type": "mobile" }],
  "urls": [{ "value": "https://example.com", "type": "work" }],
  "addresses": [{ "formattedValue": "123 Main St, City, State ZIP", "type": "work" }],
  "notes": "string"
}`;

/**
 * Attempt to extract contact fields from an image using configured Vision API keys
 * (Gemini, Anthropic Claude, or OpenAI) if available.
 */
export async function extractContactViaVisionApi(
  base64        ,
  mimeType        ,
  additionalContext         ,
  fetchImpl               = globalThis.fetch
)                                                              {
  const promptText = additionalContext
    ? `${IMAGE_EXTRACTION_PROMPT}\nAdditional context: ${additionalContext}`
    : IMAGE_EXTRACTION_PROMPT;

  const parseJsonFromModelText = (rawText        )               => {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return parseFreeformTextContact(rawText);
    }
    const contacts = parseJsonContacts(jsonMatch[0]);
    return contacts[0] || {};
  };

  // 1. Gemini API (GEMINI_API_KEY)
  if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: promptText },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    if (resp.ok) {
      const data = (await resp.json())       ;
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (text) {
        return { contact: parseJsonFromModelText(text), provider: `gemini (${model})` };
      }
    }
  }

  // 2. Anthropic API (ANTHROPIC_API_KEY)
  if (process.env.ANTHROPIC_API_KEY) {
    const model = process.env.ANTHROPIC_VISION_MODEL || "claude-sonnet-4-20250514";
    const resp = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mimeType, data: base64 },
              },
              { type: "text", text: promptText },
            ],
          },
        ],
      }),
    });
    if (resp.ok) {
      const data = (await resp.json())       ;
      const text = data?.content?.[0]?.text || "";
      if (text) {
        return { contact: parseJsonFromModelText(text), provider: `anthropic (${model})` };
      }
    }
  }

  // 3. OpenAI API (OPENAI_API_KEY)
  if (process.env.OPENAI_API_KEY) {
    const model = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
    const resp = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              {
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${base64}` },
              },
            ],
          },
        ],
      }),
    });
    if (resp.ok) {
      const data = (await resp.json())       ;
      const text = data?.choices?.[0]?.message?.content || "";
      if (text) {
        return { contact: parseJsonFromModelText(text), provider: `openai (${model})` };
      }
    }
  }

  return null;
}

// ============================================================================
// MCP Tool Definitions (Compatible with Claude, ChatGPT, and Gemini)
// ============================================================================

const CONTACT_INPUT_PROPERTIES = {
  givenName: { type: "string", description: "First / given name" },
  familyName: { type: "string", description: "Last / family name" },
  middleName: { type: "string", description: "Middle name" },
  fullName: {
    type: "string",
    description: "Full display name (automatically split if givenName/familyName are omitted)",
  },
  prefix: { type: "string", description: "Honorific prefix (e.g. Dr., Mr., Ms.)" },
  suffix: { type: "string", description: "Honorific suffix (e.g. Jr., III, PhD)" },
  nickname: { type: "string", description: "Nickname" },
  emails: {
    type: "array",
    description: "Email addresses (strings or { value, type: 'work'|'home'|'other' })",
    items: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            value: { type: "string" },
            type: { type: "string" },
            displayName: { type: "string" },
          },
          required: ["value"],
        },
      ],
    },
  },
  phones: {
    type: "array",
    description: "Phone numbers (strings or { value, type: 'mobile'|'work'|'home'|'other' })",
    items: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            value: { type: "string" },
            type: { type: "string" },
          },
          required: ["value"],
        },
      ],
    },
  },
  organization: { type: "string", description: "Company or organization name" },
  jobTitle: { type: "string", description: "Job title or role" },
  department: { type: "string", description: "Department within the organization" },
  addresses: {
    type: "array",
    description: "Physical addresses (strings or structured address objects)",
    items: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            streetAddress: { type: "string" },
            extendedAddress: { type: "string" },
            city: { type: "string" },
            region: { type: "string" },
            postalCode: { type: "string" },
            country: { type: "string" },
            formattedValue: { type: "string" },
            type: { type: "string" },
          },
        },
      ],
    },
  },
  urls: {
    type: "array",
    description: "Website or profile URLs (strings or { value, type })",
    items: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: {
            value: { type: "string" },
            type: { type: "string" },
          },
          required: ["value"],
        },
      ],
    },
  },
  birthday: { type: "string", description: "Birthday in YYYY-MM-DD or MM-DD format" },
  notes: { type: "string", description: "Biography or notes about the contact" },
  customFields: {
    type: "array",
    description: "Custom key-value pairs stored on the contact",
    items: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
  groupResourceNames: {
    type: "array",
    description: "Contact group resource names (e.g. ['contactGroups/myContacts'])",
    items: { type: "string" },
  },
  photoBase64: {
    type: "string",
    description: "Optional base64-encoded PNG/JPG photo to set as the contact's avatar",
  },
  photoPath: {
    type: "string",
    description: "Optional local file path to a PNG/JPG photo to set as the contact's avatar",
  },
};

export const TOOLS = [
  {
    name: "upsert_contact",
    description:
      "Smart add-or-edit Google Contact. Searches for an existing contact by email, phone number, or exact full name; if found, merges/updates the contact, otherwise creates a new contact. Ideal when adding or editing contacts extracted from PNG/JPG images, text, or markup in Claude, ChatGPT, or Gemini.",
    annotations: {
      title: "Add or Update Contact (Smart Upsert)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        resourceName: {
          type: "string",
          description: "Optional known Google Contact resourceName (e.g. 'people/c12345')",
        },
        ...CONTACT_INPUT_PROPERTIES,
        merge: {
          type: "boolean",
          description:
            "When updating an existing contact, merge emails/phones/notes instead of overwriting all fields (default: true)",
          default: true,
        },
      },
    },
  },
  {
    name: "create_contact",
    description: "Create a brand-new contact in Google Contacts.",
    annotations: {
      title: "Create Google Contact",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        ...CONTACT_INPUT_PROPERTIES,
      },
    },
  },
  {
    name: "update_contact",
    description:
      "Edit an existing contact in Google Contacts by its resourceName (e.g. 'people/c12345'). Fetches the latest etag automatically and merges or replaces the specified fields.",
    annotations: {
      title: "Edit Google Contact",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        resourceName: {
          type: "string",
          description: "Google Contact resourceName (e.g. 'people/c123456789')",
        },
        ...CONTACT_INPUT_PROPERTIES,
        merge: {
          type: "boolean",
          description: "Keep existing fields and merge new emails/phones/notes (default: true)",
          default: true,
        },
      },
      required: ["resourceName"],
    },
  },
  {
    name: "search_contacts",
    description:
      "Search Google Contacts by name, email address, phone number, organization, or notes.",
    annotations: {
      title: "Search Google Contacts",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (name, email, phone, company, etc.)",
        },
        pageSize: {
          type: "number",
          description: "Maximum number of results to return (1-30, default 20)",
          default: 20,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_contact",
    description: "Get full details for a single Google Contact by resourceName.",
    annotations: {
      title: "Get Google Contact",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        resourceName: {
          type: "string",
          description: "Contact resourceName (e.g. 'people/c123456789')",
        },
      },
      required: ["resourceName"],
    },
  },
  {
    name: "list_contacts",
    description: "List contacts from Google Contacts with optional pagination and sort order.",
    annotations: {
      title: "List Google Contacts",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        pageSize: {
          type: "number",
          description: "Number of contacts to return (1-1000, default 50)",
          default: 50,
        },
        pageToken: {
          type: "string",
          description: "Pagination token from a previous list_contacts response",
        },
        sortOrder: {
          type: "string",
          enum: [
            "LAST_MODIFIED_ASCENDING",
            "LAST_MODIFIED_DESCENDING",
            "FIRST_NAME_ASCENDING",
            "LAST_NAME_ASCENDING",
          ],
          default: "LAST_MODIFIED_DESCENDING",
        },
      },
    },
  },
  {
    name: "delete_contact",
    description: "Delete a contact from Google Contacts by resourceName.",
    annotations: {
      title: "Delete Google Contact",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        resourceName: {
          type: "string",
          description: "Contact resourceName to delete (e.g. 'people/c123456789')",
        },
      },
      required: ["resourceName"],
    },
  },
  {
    name: "parse_and_upsert_contact",
    description:
      "Parse one or more contacts from raw text or markup (vCard/.vcf, HTML, Markdown, CSV, JSON, email signature, or freeform text) and optionally save (upsert) them to Google Contacts.",
    annotations: {
      title: "Parse & Save Contact from Text or Markup",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description:
            "Raw text or markup containing contact info (vCard, HTML, Markdown, CSV, JSON, email signature, or notes)",
        },
        format: {
          type: "string",
          enum: ["auto", "vcard", "html", "markdown", "json", "csv", "text"],
          description: "Input format hint (defaults to 'auto')",
          default: "auto",
        },
        dryRun: {
          type: "boolean",
          description:
            "If true, only parses and returns the extracted structured contact(s) without writing to Google Contacts (default: false)",
          default: false,
        },
        merge: {
          type: "boolean",
          description: "Merge with existing contact if found (default: true)",
          default: true,
        },
      },
      required: ["input"],
    },
  },
  {
    name: "extract_contact_from_image",
    description:
      "Load a PNG, JPG/JPEG, WEBP, or GIF image (from a local file path, file:// URL, data URI, or base64 string) to extract contact details. Uses MCP client sampling or a configured Vision API if available; otherwise returns the image content block directly to the calling harness (Claude, ChatGPT, or Gemini) so the harness can read the image and call upsert_contact.",
    annotations: {
      title: "Extract & Save Contact from PNG/JPG Image",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        imageSource: {
          type: "string",
          description:
            "Path to local .png/.jpg/.webp file, file:// URL, data:image/...;base64 URI, or base64 string",
        },
        mimeType: {
          type: "string",
          description: "Optional MIME type override (e.g. 'image/png', 'image/jpeg')",
        },
        additionalContext: {
          type: "string",
          description: "Optional notes or context to attach or guide extraction",
        },
        autoSave: {
          type: "boolean",
          description:
            "If server-side extraction succeeds, automatically upsert the contact into Google Contacts (default: true)",
          default: true,
        },
        setAsContactPhoto: {
          type: "boolean",
          description: "If true, also set the image as the contact's avatar photo (default: false)",
          default: false,
        },
      },
      required: ["imageSource"],
    },
  },
  {
    name: "manage_contact_groups",
    description:
      "List, create, or assign/remove contacts from Google Contact labels/groups (contactGroups).",
    annotations: {
      title: "Manage Google Contact Groups / Labels",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "modify_members"],
          description: "Operation to perform on contact groups",
        },
        name: {
          type: "string",
          description: "Group name when action='create'",
        },
        groupResourceName: {
          type: "string",
          description: "Group resourceName (e.g. 'contactGroups/12345') when action='modify_members'",
        },
        addResourceNames: {
          type: "array",
          items: { type: "string" },
          description: "Contact resourceNames to add to the group",
        },
        removeResourceNames: {
          type: "array",
          items: { type: "string" },
          description: "Contact resourceNames to remove from the group",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "authenticate_google",
    description:
      "Check Google Contacts login status or launch a local browser window on the machine to sign in to Google Contacts (OAuth2 + PKCE) and save tokens locally to ~/.config/google-contacts-mcp/.",
    annotations: {
      title: "Sign in to Google Contacts via Local Browser",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        forceReauth: {
          type: "boolean",
          description: "If true, launches the browser login flow even if already authenticated",
          default: false,
        },
      },
    },
  },
];

export const PROMPTS = [
  {
    name: "add-or-edit-from-image",
    description:
      "Extract contact fields from an attached PNG/JPG image (business card, screenshot, badge) and save to Google Contacts.",
    arguments: [
      {
        name: "notes",
        description: "Optional context about where you met this contact",
        required: false,
      },
    ],
  },
  {
    name: "add-or-edit-from-text-or-markup",
    description:
      "Extract contact details from raw text, email signatures, HTML, Markdown, or vCard and sync to Google Contacts.",
    arguments: [
      {
        name: "content",
        description: "The raw text or markup containing contact details",
        required: true,
      },
    ],
  },
];

// ============================================================================
// MCP Server Engine (Stdio + Streamable HTTP / SSE)
// ============================================================================

export class GoogleContactsMcpServer {
          client                  ;
          clientCapabilities                      = {};
          pendingSamplingRequests = new Map

   ();
          nextOutboundId = 1000;
          sendOutboundMessage                                     ;

  constructor(client                   ) {
    if (client) {
      this.client = client;
    } else if (process.env.GOOGLE_CONTACTS_BACKEND === "api") {
      this.client = new GoogleContactsClient();
    } else {
      // Default: Browser mode (launches Chrome/Playwright to https://contacts.google.com — no Client ID or Secret needed!)
      this.client = new GoogleContactsBrowserClient();
    }
  }

         setOutboundSender(sender                                    )       {
    this.sendOutboundMessage = sender;
  }

         async requestSamplingFromClient(
    base64        ,
    mimeType        ,
    additionalContext
  )                               {
    if (!this.clientCapabilities?.sampling || !this.sendOutboundMessage) {
      return null;
    }

    const reqId = `sampling-${this.nextOutboundId++}`;
    const prompt = additionalContext
      ? `${IMAGE_EXTRACTION_PROMPT}\nAdditional context: ${additionalContext}`
      : IMAGE_EXTRACTION_PROMPT;

    const samplingPromise = new Promise     ((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSamplingRequests.delete(reqId);
        reject(new Error("MCP sampling request timed out"));
      }, 25_000);

      this.pendingSamplingRequests.set(reqId, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });

    this.sendOutboundMessage({
      jsonrpc: "2.0",
      id: reqId,
      method: "sampling/createMessage",
      params: {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", data: base64, mimeType },
              { type: "text", text: prompt },
            ],
          },
        ],
        maxTokens: 1024,
      },
    });

    try {
      const result = await samplingPromise;
      const text =
        typeof result?.content?.text === "string"
          ? result.content.text
          : Array.isArray(result?.content)
            ? result.content.find((c     ) => c.type === "text")?.text || ""
            : "";
      if (!text) return null;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const list = parseJsonContacts(jsonMatch[0]);
        return list[0] || null;
      }
      return parseFreeformTextContact(text);
    } catch {
      return null;
    }
  }

         async handleIncomingMessage(msg     )                                  {
    // Handle response to a server-initiated request (e.g. sampling/createMessage)
    if (msg && msg.id !== undefined && !msg.method && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pendingSamplingRequests.get(msg.id);
      if (pending) {
        this.pendingSamplingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || "Client sampling error"));
        } else {
          pending.resolve(msg.result);
        }
      }
      return null;
    }

    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return {
        jsonrpc: "2.0",
        id: msg?.id ?? null,
        error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" },
      };
    }

    // Notifications have no id and expect no response
    if (msg.id === undefined) {
      return null;
    }

    try {
      const result = await this.dispatchMethod(msg.method, msg.params || {});
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result,
      };
    } catch (err     ) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: err?.code || -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

          async dispatchMethod(method        , params                     )               {
    switch (method) {
      case "initialize": {
        this.clientCapabilities = params?.capabilities || {};
        const clientProtocol = params?.protocolVersion;
        const supportedVersions = ["2025-03-26", "2024-11-05"];
        const negotiatedVersion = supportedVersions.includes(clientProtocol)
          ? clientProtocol
          : "2024-11-05";
        return {
          protocolVersion: negotiatedVersion,
          capabilities: {
            tools: { listChanged: false },
            prompts: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
          instructions:
            "Use google-contacts-mcp to search, add, edit, and organize Google Contacts. " +
            "When the user provides a PNG/JPG image (business card, screenshot, photo) in chat, you can either extract the fields directly with your vision capabilities and call `upsert_contact`, or pass a local file path / base64 image to `extract_contact_from_image`. " +
            "When the user provides raw text or markup (vCard, HTML, Markdown, CSV, JSON, email signature), call `parse_and_upsert_contact` or `upsert_contact`.",
        };
      }

      case "ping":
        return {};

      case "tools/list":
        return { tools: TOOLS };

      case "tools/call":
        return await this.handleToolCall(params.name, params.arguments || {});

      case "prompts/list":
        return { prompts: PROMPTS };

      case "prompts/get":
        return this.handlePromptGet(params.name, params.arguments || {});

      case "resources/list":
        return {
          resources: [
            {
              uri: "contacts://status",
              name: "Google Contacts Auth & Server Status",
              mimeType: "application/json",
              description: "Current authentication status and configuration paths",
            },
            {
              uri: "contacts://guide",
              name: "Multi-Format Input Guide (PNG, JPG, Text, Markup)",
              mimeType: "text/markdown",
              description: "How Claude, ChatGPT, and Gemini can pass images, text, and markup",
            },
          ],
        };

      case "resources/read": {
        if (params.uri === "contacts://status") {
          return {
            contents: [
              {
                uri: "contacts://status",
                mimeType: "application/json",
                text: JSON.stringify(this.client.getAuthStatus(), null, 2),
              },
            ],
          };
        }
        if (params.uri === "contacts://guide") {
          return {
            contents: [
              {
                uri: "contacts://guide",
                mimeType: "text/markdown",
                text: [
                  "# google-contacts-mcp Input Guide",
                  "",
                  "- **Direct Vision (Claude, ChatGPT, Gemini)**: Read attached PNG/JPG images in the conversation and call `upsert_contact` with extracted fields.",
                  "- **Local Image File / Base64**: Call `extract_contact_from_image` with `imageSource`.",
                  "- **Text & Markup (vCard, HTML, Markdown, CSV, JSON, Email Signatures)**: Call `parse_and_upsert_contact` with `input`.",
                ].join("\n"),
              },
            ],
          };
        }
        throw Object.assign(new Error(`Unknown resource URI: ${params.uri}`), { code: -32602 });
      }

      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

          handlePromptGet(name        , args                     )      {
    if (name === "add-or-edit-from-image") {
      const notesNote = args.notes ? ` Include this note on the contact: "${args.notes}".` : "";
      return {
        description: "Extract contact details from an image and upsert to Google Contacts",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                "Please inspect the attached PNG/JPG image, extract all contact information (full name, job title, company/organization, email addresses, phone numbers, website URLs, physical address, and any relevant notes), and call the `upsert_contact` tool to add or update this person in Google Contacts." +
                notesNote,
            },
          },
        ],
      };
    }

    if (name === "add-or-edit-from-text-or-markup") {
      return {
        description: "Parse contact info from text or markup and upsert to Google Contacts",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please extract the contact details from the following text/markup and save them to Google Contacts using \`parse_and_upsert_contact\` or \`upsert_contact\`:\n\n${args.content || ""}`,
            },
          },
        ],
      };
    }

    throw Object.assign(new Error(`Unknown prompt: ${name}`), { code: -32602 });
  }

          async handleToolCall(name        , args                     )               {
    try {
      switch (name) {
        case "upsert_contact": {
          const merge = args.merge !== false;
          const result = await this.client.upsertContact(args                , merge);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "create_contact": {
          const created = await this.client.createContact(args                );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ action: "created", contact: created }, null, 2),
              },
            ],
          };
        }

        case "update_contact": {
          if (!args.resourceName) {
            throw new Error("resourceName is required for update_contact");
          }
          const merge = args.merge !== false;
          const updated = await this.client.updateContact(
            String(args.resourceName),
            args                ,
            merge
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ action: "updated", contact: updated }, null, 2),
              },
            ],
          };
        }

        case "search_contacts": {
          const contacts = await this.client.searchContacts(
            String(args.query || ""),
            Number(args.pageSize || 20)
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ count: contacts.length, contacts }, null, 2),
              },
            ],
          };
        }

        case "get_contact": {
          if (!args.resourceName) {
            throw new Error("resourceName is required for get_contact");
          }
          const contact = await this.client.getContact(String(args.resourceName));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(contact, null, 2),
              },
            ],
          };
        }

        case "list_contacts": {
          const result = await this.client.listContacts(
            Number(args.pageSize || 50),
            args.pageToken ? String(args.pageToken) : undefined,
            args.sortOrder
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "delete_contact": {
          if (!args.resourceName) {
            throw new Error("resourceName is required for delete_contact");
          }
          const res = await this.client.deleteContact(String(args.resourceName));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(res, null, 2),
              },
            ],
          };
        }

        case "parse_and_upsert_contact": {
          if (!args.input || typeof args.input !== "string") {
            throw new Error("'input' string is required for parse_and_upsert_contact");
          }
          const formatHint = (args.format || "auto")               ;
          const { format, contacts } = parseContactsFromContent(args.input, formatHint);

          if (args.dryRun) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      dryRun: true,
                      detectedFormat: format,
                      parsedCount: contacts.length,
                      contacts,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          const results = [];
          for (const contactInput of contacts) {
            const saved = await this.client.upsertContact(contactInput, args.merge !== false);
            results.push(saved);
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    detectedFormat: format,
                    processedCount: results.length,
                    results,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "extract_contact_from_image": {
          if (!args.imageSource || typeof args.imageSource !== "string") {
            throw new Error("'imageSource' is required for extract_contact_from_image");
          }

          const image = loadImageData(
            args.imageSource,
            typeof args.mimeType === "string" ? args.mimeType : undefined
          );

          // 1. Try MCP Sampling from connected host client (Claude / ChatGPT / Gemini)
          let extractedContact = await this.requestSamplingFromClient(
            image.base64,
            image.mimeType,
            args.additionalContext
          );
          let extractionMethod = extractedContact ? "mcp-sampling" : "";

          // 2. Try server-side Vision API fallback if configured
          if (!extractedContact) {
            const visionRes = await extractContactViaVisionApi(
              image.base64,
              image.mimeType,
              args.additionalContext
            );
            if (visionRes) {
              extractedContact = visionRes.contact;
              extractionMethod = `vision-api:${visionRes.provider}`;
            }
          }

          if (extractedContact) {
            if (args.additionalContext && !extractedContact.notes) {
              extractedContact.notes = String(args.additionalContext);
            }
            if (args.setAsContactPhoto) {
              extractedContact.photoBase64 = image.base64;
            }

            if (args.autoSave !== false) {
              const saved = await this.client.upsertContact(extractedContact, true);
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        extractionMethod,
                        mimeType: image.mimeType,
                        extractedContact,
                        savedResult: saved,
                      },
                      null,
                      2
                    ),
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      extractionMethod,
                      mimeType: image.mimeType,
                      autoSave: false,
                      extractedContact,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          // 3. Return the image block directly to the calling harness (Claude, ChatGPT, or Gemini)
          // so its built-in vision model reads the PNG/JPG and invokes upsert_contact.
          return {
            content: [
              {
                type: "image",
                data: image.base64,
                mimeType: image.mimeType,
              },
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "image_loaded_for_harness_vision",
                    mimeType: image.mimeType,
                    byteLength: image.byteLength,
                    instructions:
                      "Inspect the attached image block above, extract all visible contact fields (fullName, givenName, familyName, jobTitle, organization, emails, phones, urls, addresses, birthday, notes), and immediately call `upsert_contact` to save the contact to Google Contacts.",
                    additionalContext: args.additionalContext || undefined,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "manage_contact_groups": {
          const action = args.action;
          if (action === "list") {
            const groups = await this.client.listContactGroups();
            return {
              content: [{ type: "text", text: JSON.stringify({ groups }, null, 2) }],
            };
          }
          if (action === "create") {
            if (!args.name) throw new Error("'name' is required when action='create'");
            const group = await this.client.createContactGroup(String(args.name));
            return {
              content: [{ type: "text", text: JSON.stringify({ created: group }, null, 2) }],
            };
          }
          if (action === "modify_members") {
            if (!args.groupResourceName) {
              throw new Error("'groupResourceName' is required when action='modify_members'");
            }
            const res = await this.client.modifyContactGroupMembers(
              String(args.groupResourceName),
              Array.isArray(args.addResourceNames) ? args.addResourceNames : [],
              Array.isArray(args.removeResourceNames) ? args.removeResourceNames : []
            );
            return {
              content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
            };
          }
          throw new Error(`Unsupported manage_contact_groups action: ${action}`);
        }

        case "authenticate_google": {
          if (this.client instanceof GoogleContactsBrowserClient) {
            await this.client.ensureAuthenticatedSession("https://contacts.google.com");
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "authenticated_in_browser",
                      ...this.client.getAuthStatus(),
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          const status = this.client.getAuthStatus();
          if (status.authenticated && !args.forceReauth) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "already_authenticated",
                      ...status,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          if (this.client instanceof GoogleContactsClient) {
            await launchBrowserAuthFlow({ client: this.client });
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "authenticated_via_browser",
                    ...this.client.getAuthStatus(),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        default:
          throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
      }
    } catch (err     ) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }
}

// ============================================================================
// Local Browser OAuth2 + PKCE Login Flow (Auto-launched on demand or via --auth)
// ============================================================================

function openUrlInBrowser(url        )       {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? `open "${url}"`
      : platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // Ignore errors if headless
  });
}

function createPkcePair()                                          {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function launchBrowserAuthFlow(options

 )                       {
  const client = options.client || new GoogleContactsClient();
  let config = client.getClientConfig(options.credentialsPath);

  // If a custom credentials path was passed on CLI, persist it to ~/.config/google-contacts-mcp/credentials.json
  // so future stdio runs from Claude/ChatGPT/Gemini require zero env vars or flags.
  if (config && options.credentialsPath) {
    client.saveClientConfig(config);
  }

  const port = options.port || 8765;
  const baseUrl = `http://127.0.0.1:${port}`;
  const redirectUri = `${baseUrl}/oauth2callback`;
  const state = crypto.randomBytes(16).toString("hex");
  const pkce = createPkcePair();

  const buildGoogleAuthUrl = (cfg                   )         => {
    const authUrl = new URL(GOOGLE_AUTH_URL);
    authUrl.searchParams.set("client_id", cfg.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", CONTACTS_SCOPE);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", pkce.challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    return authUrl.toString();
  };

  return await new Promise             ((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Browser Google login timed out after 5 minutes."));
    }, 300_000);

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", baseUrl);

        // Step 1: Root / Setup page (if credentials.json isn't saved yet, let user paste/upload in browser;
        // otherwise redirect straight to Google Sign-In)
        if (req.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/setup")) {
          config = client.getClientConfig(options.credentialsPath);
          if (config) {
            res.writeHead(302, { Location: buildGoogleAuthUrl(config) });
            res.end();
            return;
          }

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Google Contacts MCP — Local Login Setup</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1f2937; line-height: 1.5; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
    h2 { margin-top: 0; }
    label { display: block; font-weight: 600; margin-top: 14px; font-size: 14px; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 10px; margin-top: 6px; border: 1px solid #d1d5db; border-radius: 6px; font-family: monospace; font-size: 13px; }
    button { margin-top: 18px; background: #2563eb; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .hint { background: #f3f4f6; padding: 12px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Sign in to Google Contacts (Local MCP)</h2>
    <div class="hint">
      <strong>One-Time Local Setup:</strong> Paste your Google Cloud Desktop OAuth <code>client_secret.json</code> (or Client ID &amp; Secret) below.
      It will be saved locally to <code>${getDefaultCredentialsPath()}</code> so you never need environment variables in Claude, ChatGPT, or Gemini.
    </div>
    <form method="POST" action="/save-credentials">
      <label>Option A: Paste full contents of downloaded <code>client_secret.json</code></label>
      <textarea name="rawJson" rows="5" placeholder='{"installed":{"client_id":"...","client_secret":"..."}}'></textarea>
      <label>Option B: Or enter Client ID &amp; Client Secret directly</label>
      <input type="text" name="clientId" placeholder="123456789-xxx.apps.googleusercontent.com" />
      <input type="password" name="clientSecret" placeholder="GOCSPX-..." />
      <button type="submit">Save Locally &amp; Continue to Google Sign-In →</button>
    </form>
  </div>
</body>
</html>`);
          return;
        }

        if (req.method === "POST" && reqUrl.pathname === "/save-credentials") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            const params = new URLSearchParams(body);
            const rawJson = (params.get("rawJson") || "").trim();
            let clientId = (params.get("clientId") || "").trim();
            let clientSecret = (params.get("clientSecret") || "").trim();

            if (rawJson) {
              try {
                const parsed = JSON.parse(rawJson);
                const block = parsed.installed || parsed.web || parsed;
                clientId = block.client_id || clientId;
                clientSecret = block.client_secret || clientSecret;
              } catch {
                // Ignore invalid JSON if clientId/clientSecret provided
              }
            }

            if (!clientId || !clientSecret) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              res.end("<h3>Missing Client ID or Client Secret. <a href='/'>Go back</a></h3>");
              return;
            }

            config = { clientId, clientSecret, redirectUri };
            client.saveClientConfig(config);
            res.writeHead(302, { Location: buildGoogleAuthUrl(config) });
            res.end();
          });
          return;
        }

        // Step 2: OAuth2 Callback from Google Sign-In
        if (reqUrl.pathname === "/oauth2callback") {
          const returnedState = reqUrl.searchParams.get("state");
          const code = reqUrl.searchParams.get("code");
          const error = reqUrl.searchParams.get("error");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<h2>Google Login Cancelled or Failed: ${error}</h2>`);
            clearTimeout(timeout);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (!code || returnedState !== state || !config) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<h2>Invalid OAuth callback state or missing authorization code.</h2>");
            return;
          }

          const tokenBody = new URLSearchParams({
            code,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
            code_verifier: pkce.verifier,
          });

          const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenBody.toString(),
          });

          if (!tokenResp.ok) {
            const errText = await tokenResp.text();
            res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<h2>Token Exchange Failed</h2><pre>${errText}</pre>`);
            clearTimeout(timeout);
            server.close();
            reject(new Error(`Token exchange failed: ${errText}`));
            return;
          }

          const tokenData = (await tokenResp.json())

           ;

          const savedTokens              = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expiry_date: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
            scope: tokenData.scope,
            token_type: tokenData.token_type,
          };

          client.saveClientConfig(config);
          client.saveTokens(savedTokens);

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 60px auto; text-align: center;">
  <h2 style="color: #16a34a;">✓ Signed in to Google Contacts!</h2>
  <p>Your local credentials and refresh token have been saved to <code>~/.config/google-contacts-mcp/</code>.</p>
  <p>You can close this browser tab and return to Claude, ChatGPT, or Gemini.</p>
</body>
</html>`);

          if (options.verbose) {
            console.error(`Tokens saved to: ${getDefaultTokensPath()}`);
          }
          clearTimeout(timeout);
          server.close();
          resolve(savedTokens);
          return;
        }

        res.writeHead(404);
        res.end("Not Found");
      } catch (err) {
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      const targetUrl = config ? buildGoogleAuthUrl(config) : `${baseUrl}/setup`;
      if (options.verbose) {
        console.error(`\n[${SERVER_NAME}] Opening browser for Google login: ${targetUrl}\n`);
      }
      openUrlInBrowser(targetUrl);
    });
  });
}

export async function runInteractiveAuth(options

 )                {
  await launchBrowserAuthFlow({
    credentialsPath: options.credentialsPath,
    port: options.port,
    verbose: true,
  });
}

// ============================================================================
// Transports: Stdio (default) & Streamable HTTP / SSE (`--http`)
// ============================================================================

export function startStdioServer(mcpServer                         )       {
  mcpServer.setOutboundSender((msg) => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  });

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const responses = (
          await Promise.all(parsed.map((item) => mcpServer.handleIncomingMessage(item)))
        ).filter(Boolean);
        if (responses.length > 0) {
          process.stdout.write(JSON.stringify(responses) + "\n");
        }
      } else {
        const response = await mcpServer.handleIncomingMessage(parsed);
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      }
    } catch (err) {
      const errResp                  = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
      process.stdout.write(JSON.stringify(errResp) + "\n");
    }
  });
}

export function startHttpServer(
  mcpServer                         ,
  port = 3000,
  host = "127.0.0.1"
)              {
  const sseClients = new Set                     ();

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || "/", `http://${host}:${port}`);

    if (req.method === "GET" && reqUrl.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }

    // Legacy SSE endpoint for HTTP MCP clients
    if (req.method === "GET" && (reqUrl.pathname === "/sse" || reqUrl.pathname === "/mcp")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: endpoint\ndata: /messages\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // Streamable HTTP POST (/mcp or /messages)
    if (
      req.method === "POST" &&
      (reqUrl.pathname === "/mcp" || reqUrl.pathname === "/messages" || reqUrl.pathname === "/")
    ) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const response = await mcpServer.handleIncomingMessage(parsed);

          for (const sseRes of sseClients) {
            if (response) {
              sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
            }
          }

          if (!response) {
            res.writeHead(202);
            res.end();
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32700,
                message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
              },
            })
          );
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  server.listen(port, host, () => {
    console.error(
      `[${SERVER_NAME}] Streamable HTTP / SSE MCP server listening on http://${host}:${port}/mcp`
    );
  });

  return server;
}

// ============================================================================
// CLI Entrypoint
// ============================================================================

async function main()                {
  loadDotEnv();
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        `${SERVER_NAME} v${SERVER_VERSION}`,
        "Self-contained local stdio MCP server (.mjs) for Claude, ChatGPT, and Gemini to manage Google Contacts.",
        "By default, uses Browser Automation (Playwright / Chrome CDP) against https://contacts.google.com — NO Client ID or Secret required!",
        "",
        "Usage:",
        "  node google-contacts-mcp.mjs                  Start MCP server over stdio (default)",
        "  node google-contacts-mcp.mjs --auth           Launch browser to https://contacts.google.com and sign in",
        "  node google-contacts-mcp.mjs --status         Print current browser profile / auth status",
        "  node google-contacts-mcp.mjs --http           Start MCP server over Streamable HTTP / SSE",
      ].join("\n")
    );
    return;
  }

  if (argv.includes("--status")) {
    const provider                   =
      process.env.GOOGLE_CONTACTS_BACKEND === "api" || argv.includes("--api")
        ? new GoogleContactsClient()
        : new GoogleContactsBrowserClient();
    console.log(JSON.stringify(provider.getAuthStatus(), null, 2));
    return;
  }

  const getArgValue = (flag        )                     => {
    const idx = argv.indexOf(flag);
    return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : undefined;
  };

  if (argv.includes("--auth")) {
    if (process.env.GOOGLE_CONTACTS_BACKEND === "api" || argv.includes("--api")) {
      const credentialsPath = getArgValue("--credentials");
      const portStr = getArgValue("--port");
      await runInteractiveAuth({
        credentialsPath,
        port: portStr ? Number(portStr) : undefined,
      });
    } else {
      console.log(
        "Launching browser to https://contacts.google.com (persistent profile: ~/.config/google-contacts-mcp/chrome-profile)..."
      );
      const browserClient = new GoogleContactsBrowserClient();
      await browserClient.ensureAuthenticatedSession("https://contacts.google.com");
      console.log("✓ Signed in to Google Contacts in browser! Session saved for Claude, ChatGPT, and Gemini.");
    }
    return;
  }

  const mcpServer = new GoogleContactsMcpServer();
  const useHttp =
    argv.includes("--http") ||
    process.env.MCP_TRANSPORT === "http" ||
    process.env.MCP_TRANSPORT === "sse";

  if (useHttp) {
    const port = Number(getArgValue("--port") || process.env.PORT || 3000);
    const host = getArgValue("--host") || process.env.HOST || "127.0.0.1";
    startHttpServer(mcpServer, port, host);
  } else {
    startStdioServer(mcpServer);
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((err) => {
    console.error(`[${SERVER_NAME}] Fatal error:`, err);
    process.exit(1);
  });
}
