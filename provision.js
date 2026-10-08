/**
 * Exotel WebRTC provisioning — one command sets everything up.
 *
 *   npm run provision
 *
 * It will, using the credentials in .env:
 *   1. Get a CUSTOMER token and make sure an App is registered (creates one if
 *      missing, and saves EXOTEL_APP_ID / EXOTEL_APP_SECRET back into .env).
 *   2. Get an APP token.
 *   3. Create the WebRTC user (agent) for EXOTEL_WEBRTC_USER_ID — this enables
 *      BOTH incoming and outgoing browser calls.
 *   4. Verify the user mapping.
 *
 * Safe to run again — it checks what already exists before creating anything.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const ICORE = process.env.EXOTEL_ICORE_BASE || "https://integrationscore.mum1.exotel.com";
const ENV_PATH = path.join(__dirname, ".env");

const env = {
  sid: process.env.EXOTEL_ACCOUNT_SID,
  key: process.env.EXOTEL_API_KEY,
  token: process.env.EXOTEL_API_TOKEN,
  domain: process.env.EXOTEL_EXOTEL_DOMAIN || "mumbai",
  callerId: process.env.EXOTEL_CALLER_ID,
  clientId: process.env.EXOTEL_CLIENT_ID,
  clientSecret: process.env.EXOTEL_CLIENT_SECRET,
  appName: process.env.EXOTEL_APP_NAME || "webdialer",
  appId: process.env.EXOTEL_APP_ID,
  appSecret: process.env.EXOTEL_APP_SECRET,
  userId: process.env.EXOTEL_WEBRTC_USER_ID,
  agentName: process.env.EXOTEL_AGENT_NAME,
  agentNumber: process.env.EXOTEL_AGENT_NUMBER,
};

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

async function token(entity, id, secret) {
  const res = await fetch(`${ICORE}/v2/integrations/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Id: id, Secret: secret, Entity: entity }),
  });
  const body = await res.json();
  if (body.Status !== "Success" || !body.Data) throw new Error(body.Error || `token failed (${res.status})`);
  return body.Data;
}

// Update or append a KEY=value line in .env.
function setEnv(key, value) {
  let text = fs.readFileSync(ENV_PATH, "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : text.trimEnd() + `\n${line}\n`;
  fs.writeFileSync(ENV_PATH, text);
}

async function ensureApp() {
  step("Step 1 — Application");
  const ctoken = await token("customer", env.clientId, env.clientSecret);
  ok("Customer token obtained");

  // If we already have app creds, verify they still work.
  if (env.appId && env.appSecret) {
    try {
      const atoken = await token("app", env.appId, env.appSecret);
      const r = await fetch(`${ICORE}/v2/integrations/app`, { headers: { Authorization: atoken } });
      const j = await r.json();
      if (j.Data && j.Data.AppID === env.appId) {
        ok(`App already registered: ${c.b(j.Data.AppName)} (${j.Data.ExotelAccountSid})`);
        return { ctoken, appId: env.appId, appSecret: env.appSecret };
      }
    } catch (e) {
      warn("Stored App credentials no longer valid — registering a fresh App.");
    }
  }

  const r = await fetch(`${ICORE}/v2/integrations/app`, {
    method: "POST",
    headers: { Authorization: ctoken, "Content-Type": "application/json" },
    body: JSON.stringify({
      AppName: env.appName,
      ExotelAccountSid: env.sid,
      ExotelApiKey: env.key,
      ExotelApiToken: env.token,
      ExotelDomain: env.domain,
      IsActive: true,
    }),
  });
  const j = await r.json();
  if (j.Status !== "Success" || !j.Data) throw new Error(`Register App failed: ${j.Error || r.status}`);
  ok(`App registered: ${c.b(j.Data.AppName)} on ${j.Data.ExotelAccountSid}`);
  setEnv("EXOTEL_APP_ID", j.Data.AppID);
  setEnv("EXOTEL_APP_SECRET", j.Data.AppSecret);
  ok("Saved EXOTEL_APP_ID / EXOTEL_APP_SECRET to .env");
  return { ctoken, appId: j.Data.AppID, appSecret: j.Data.AppSecret };
}

async function ensureUser(appId, appSecret) {
  step("Step 2 — WebRTC user (agent)");
  if (!env.userId) {
    warn("EXOTEL_WEBRTC_USER_ID is empty — set the agent email in .env, then re-run.");
    return false;
  }
  const atoken = await token("app", appId, appSecret);
  ok("App token obtained");

  // Already provisioned?
  const check = await fetch(
    `${ICORE}/v2/integrations/usermapping?user_id=${encodeURIComponent(env.userId)}`,
    { headers: { Authorization: atoken, "Content-Type": "application/json" } }
  );
  const checkJson = await check.json();
  if (check.ok && checkJson.Data) {
    ok(`Agent already provisioned: ${c.b(env.userId)}`);
    return true;
  }

  const entry = {
    AppUserId: env.userId,
    AppUsername: env.agentName || env.userId,
    Email: env.userId,
    ExotelAccountSid: env.sid,
    ExotelUserName: env.agentName || env.userId,
    VirtualNumber: env.callerId,
  };
  if (env.agentNumber) entry.AgentNumber = env.agentNumber;

  const r = await fetch(`${ICORE}/v2/integrations/usermapping`, {
    method: "POST",
    headers: { Authorization: atoken, "Content-Type": "application/json" },
    body: JSON.stringify([entry]),
  });
  const j = await r.json();
  if (j.Status === "Success") {
    ok(`Agent created: ${c.b(env.userId)} (incoming + outgoing enabled)`);
    return true;
  }
  if (/trial account/i.test(j.Error || "")) {
    fail("Exotel says: \"This is a trial account. Operation not permitted.\"");
    console.log(
      c.y(
        "\n  The account is on TRIAL. Everything else is set up correctly, but Exotel\n" +
        "  does not allow creating WebRTC agents on trial accounts.\n\n" +
        "  ACTION: ask your Exotel account manager to upgrade/enable this account for\n" +
        "  IP-PSTN WebRTC (agreement + KYC). Then simply run  npm run provision  again —\n" +
        "  no code changes needed. Click-to-Call keeps working meanwhile.\n"
      )
    );
    return false;
  }
  throw new Error(`Create user failed: ${j.Error || r.status}`);
}

// Recording for browser calls is an APP-level setting, not a per-call flag —
// the SDK's MakeCall payload has no record field. Turning it on here means
// every in-browser call is recorded.
async function ensureRecording(appId, appSecret) {
  step("Step 3 — Call recording");
  const atoken = await token("app", appId, appSecret);

  const current = await fetch(`${ICORE}/v2/integrations/app_setting`, {
    headers: { Authorization: atoken },
  });
  const cj = await current.json();
  const existing = (cj.Data || []).find((s) => s.Key === "record");
  if (existing && String(existing.Value) === "true") {
    ok("Recording already enabled for all calls");
    return true;
  }

  const r = await fetch(`${ICORE}/v2/integrations/app_setting`, {
    method: "POST",
    headers: { Authorization: atoken, "Content-Type": "application/json" },
    body: JSON.stringify({ Key: "record", Value: "true" }),
  });
  const j = await r.json();
  if (r.ok && j.Status === "Success") {
    ok("Recording enabled for all calls");
    return true;
  }
  warn(`Could not enable recording: ${j.Error || r.status}`);
  return false;
}

(async () => {
  console.log(c.b("\nExotel WebRTC provisioning\n=========================="));
  console.log(`  Account : ${env.sid}  (${env.domain})`);
  console.log(`  Agent   : ${env.userId || "(not set)"}`);
  try {
    const { appId, appSecret } = await ensureApp();
    const userReady = await ensureUser(appId, appSecret);
    await ensureRecording(appId, appSecret);

    step("Result");
    if (userReady) {
      ok("Provisioning complete. Restart the server (npm start) — in-browser calling is ready.");
    } else {
      warn("App is ready; agent is not yet provisioned (see message above). Click-to-Call works now.");
    }
  } catch (err) {
    fail(String(err.message || err));
    process.exitCode = 1;
  }
})();
