/**
 * Connects this dialer to a Zoho CRM org. Run it once per org.
 *
 *   npm run zoho:auth                 prints the steps and the scopes to paste
 *   npm run zoho:auth -- <code>       finishes the connection
 *
 * The steps, in short:
 *   1. In the Zoho API Console (api-console.zoho.in for India,
 *      api-console.zoho.com for the US, and so on) add a "Self Client". Put its
 *      Client ID and Client Secret in .env as ZOHO_CLIENT_ID and
 *      ZOHO_CLIENT_SECRET.
 *   2. In that Self Client open "Generate Code", paste the scopes below,
 *      choose 10 minutes, and create the code.
 *   3. Run this script with the code before it expires.
 *
 * It swaps the code for a long-lived refresh token, works out which Zoho data
 * centre the org lives in, writes ZOHO_ACCOUNTS_URL and ZOHO_REFRESH_TOKEN
 * into .env, and checks the connection by reading the org's users.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createZohoClient } = require("../zoho");

const ENV_PATH = path.join(__dirname, "..", ".env");

// Read and update Leads/Contacts (the card, and `npm run zoho:links`), create
// Calls (the log), read Notes (the card) and Users (who owns the log).
const SCOPES = [
  "ZohoCRM.modules.leads.READ",
  "ZohoCRM.modules.leads.UPDATE",
  "ZohoCRM.modules.contacts.READ",
  "ZohoCRM.modules.contacts.UPDATE",
  "ZohoCRM.modules.calls.CREATE",
  "ZohoCRM.modules.notes.READ",
  "ZohoCRM.users.READ",
].join(",");

// A Self Client exists in exactly one data centre, and the others answer
// invalid_client for it, so trying each in turn finds the org's region.
const ACCOUNTS = [
  "https://accounts.zoho.in",
  "https://accounts.zoho.com",
  "https://accounts.zoho.eu",
  "https://accounts.zoho.com.au",
  "https://accounts.zoho.jp",
  "https://accounts.zohocloud.ca",
  "https://accounts.zoho.sa",
  "https://accounts.zoho.uk",
  "https://accounts.zoho.com.cn",
];

const c = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const ok = (m) => console.log(`  ${c.g("✓")} ${m}`);
const warn = (m) => console.log(`  ${c.y("!")} ${m}`);
const fail = (m) => console.log(`  ${c.r("✗")} ${m}`);
const step = (m) => console.log(`\n${c.b(m)}`);

// Update or append a KEY=value line in .env.
function setEnv(key, value) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : text.trimEnd() + `\n${line}\n`;
  fs.writeFileSync(ENV_PATH, text);
}

function printSteps() {
  step("Connect the dialer to Zoho CRM");
  console.log(`
  1. Open the Zoho API Console for the org's data centre:
       India  https://api-console.zoho.in      US  https://api-console.zoho.com
       EU     https://api-console.zoho.eu      (and so on for other regions)
     Sign in as a Zoho CRM admin, choose "Add Client", then "Self Client".

  2. Copy its Client ID and Client Secret into .env:
       ZOHO_CLIENT_ID=...
       ZOHO_CLIENT_SECRET=...

  3. In the Self Client, open "Generate Code" and paste these scopes:

       ${SCOPES}

     Time duration: 10 minutes. Description: Exotel dialer. Create.

  4. Within those 10 minutes run:

       npm run zoho:auth -- <the code>
`);
}

async function exchange(code, clientId, clientSecret) {
  const order = [process.env.ZOHO_ACCOUNTS_URL, ...ACCOUNTS].filter(Boolean);
  for (const accounts of [...new Set(order.map((u) => u.replace(/\/+$/, "")))]) {
    let j;
    try {
      const r = await fetch(`${accounts}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code }),
      });
      j = await r.json();
    } catch (e) {
      continue; // that data centre is unreachable from here; try the next
    }
    if (j.refresh_token) return { accounts, ...j };
    if (j.error === "invalid_client") continue;
    throw new Error(
      j.error === "invalid_code"
        ? "Zoho says the code is invalid. Codes work once and expire; generate a new one and run this again."
        : `Zoho refused the code (${j.error || "no refresh token in the reply"}).`
    );
  }
  throw new Error(
    "No Zoho data centre recognised this Client ID. Check ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET in .env."
  );
}

(async () => {
  const code = (process.argv[2] || "").trim();
  const clientId = process.env.ZOHO_CLIENT_ID || "";
  const clientSecret = process.env.ZOHO_CLIENT_SECRET || "";

  if (!code || !clientId || !clientSecret) {
    printSteps();
    if (code) fail("ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be in .env first (step 2).");
    process.exitCode = 1;
    return;
  }

  step("Exchanging the code for a refresh token");
  const t = await exchange(code, clientId, clientSecret);
  ok(`Org found on ${t.accounts} (API ${t.api_domain})`);
  setEnv("ZOHO_ACCOUNTS_URL", t.accounts);
  setEnv("ZOHO_REFRESH_TOKEN", t.refresh_token);
  ok("Saved ZOHO_ACCOUNTS_URL and ZOHO_REFRESH_TOKEN to .env");

  step("Checking the connection");
  const zoho = createZohoClient({ accountsUrl: t.accounts, clientId, clientSecret, refreshToken: t.refresh_token });
  const me = await zoho.api("GET", "/users?type=CurrentUser");
  const user = me && me.users && me.users[0];
  ok(`Connected as ${user ? `${user.full_name} <${user.email}>` : "the Self Client's user"}`);

  const ownerEmail = process.env.ZOHO_OWNER_EMAIL || process.env.EXOTEL_WEBRTC_USER_ID || "";
  if (ownerEmail) {
    const ownerId = await zoho.userIdByEmail(ownerEmail);
    if (ownerId) ok(`Call logs will be owned by the Zoho user ${ownerEmail}`);
    else warn(`No active Zoho user has the email ${ownerEmail}, so call logs will be owned by the user above. Set ZOHO_OWNER_EMAIL to the RM's Zoho login to change that.`);
  }

  console.log(`\n  Restart the dialer (npm start) to pick this up. On Railway, add the
  ZOHO_* lines from .env to the service's Variables (node railway-env.js prints them).\n`);
})().catch((err) => {
  fail(err.message || String(err));
  process.exitCode = 1;
});
