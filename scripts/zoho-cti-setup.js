/**
 * Prepares a Zoho CRM org for the Exotel CTI. Safe to run again.
 *
 *   npm run zoho:cti-setup
 *   npm run zoho:cti-setup -- --webhook <cti_webhook API key URL>
 *   npm run zoho:cti-setup -- --signal <signal namespace> --org <org id from the CRM URL>
 *   npm run zoho:cti-setup -- --sip-agent <exotel agent email> --number <+91...>
 *   npm run zoho:cti-setup -- --app <Exotel CTI widget base URL> --phone <Phone tab URL>
 *
 * It needs a Zoho connection with settings access: run `npm run zoho:auth`
 * with a code generated for the scopes printed below.
 *
 * What it does:
 *   1. Creates the "CTI Agents" module (one record per person who may call)
 *      and its fields. Admins can edit them; everyone else can only read,
 *      which is what lets cti_api look up the caller's own settings (an RM's
 *      own status and mode are written by cti_api through the admin's
 *      cti_crm connection).
 *   2. Gets Calls ready: finds Zoho's own call outcome field ("Call Result")
 *      and adds the dispositions to its picklist, and adds Exotel Call SID
 *      (each call is logged once), Exotel Call Status, Sub Disposition,
 *      Disposition Note, Customer Phone and Exotel Number. Everyone can
 *      edit these.
 *   3. Stores the Exotel settings from .env, Zoho's API domain and CRM URL,
 *      the outcome field's API name and the default dispositions
 *      (cti_settings, only if missing) as org variables, which the Zoho
 *      functions read. --webhook also stores cti_webhook_url; --signal stores
 *      the namespace of the "incoming call" signal (Setup > Experience
 *      Center > Signals). --app and --phone store where the Call button
 *      widget and the Phone web tab live (cti_app_url, cti_phone_url), which
 *      the Phone tab and the Call button use to find each other.
 *   4. With --sip-agent <an existing Exotel agent's email>, links that agent
 *      to the person running it. Otherwise everyone (the admin included) is
 *      switched on in the CTI Admin tab, which creates their SIP line.
 */
require("dotenv").config();
const { createZohoClient } = require("../zoho");

const SCOPES = "ZohoCRM.settings.ALL,ZohoCRM.modules.ALL,ZohoCRM.users.READ,ZohoCRM.org.READ";
const MODULE = "CTI_Agents";

const FIELDS = [
  { label: "Zoho User Id", api: "Zoho_User_Id", def: { data_type: "text", length: 30 } },
  { label: "Zoho Email", api: "Zoho_Email", def: { data_type: "email" } },
  { label: "Calling Enabled", api: "Calling_Enabled", def: { data_type: "boolean" } },
  { label: "Caller ID", api: "Caller_ID", def: { data_type: "text", length: 20 } },
  { label: "Personal Number", api: "Personal_Number", def: { data_type: "phone" } },
  {
    label: "Default Mode", api: "Default_Mode",
    def: {
      data_type: "picklist",
      pick_list_values: [
        { display_value: "Phone", actual_value: "Phone" },
        { display_value: "SIP", actual_value: "SIP" },
      ],
    },
  },
  // Where incoming calls ring: Desktop (their SIP line) or Phone (their number).
  // Default_Mode is how their own calls go out: SIP, or Phone ("Number").
  {
    label: "Incoming On", api: "Incoming_On",
    def: {
      data_type: "picklist",
      pick_list_values: [
        { display_value: "Desktop", actual_value: "Desktop" },
        { display_value: "Phone", actual_value: "Phone" },
      ],
    },
  },
  { label: "SIP Id", api: "SIP_Id", def: { data_type: "text", length: 100 } },
  { label: "Exotel Agent", api: "Exotel_Agent", def: { data_type: "email" } },
  { label: "Exotel User Id", api: "Exotel_User_Id", def: { data_type: "text", length: 64 } },
  // sid|from|module|recordId|ms of the last incoming call cti_route sent them
  { label: "Last Routed Call", api: "Last_Routed_Call", def: { data_type: "text", length: 255 } },
  // sid|legs answered|ms of the outbound call in progress
  { label: "Live Call", api: "Live_Call", def: { data_type: "text", length: 100 } },
  { label: "Pending Disposition", api: "Pending_Disposition", def: { data_type: "textarea", textarea: { type: "small" } } },
];

// On Calls, next to Zoho's own Call Result. Everyone can edit these.
const CALL_FIELDS = [
  { label: "Exotel Call SID", api: "Exotel_Call_SID", def: { data_type: "text", length: 64 } },
  { label: "Exotel Call Status", api: "Exotel_Call_Status", def: { data_type: "text", length: 50 } },
  { label: "Sub Disposition", api: "Sub_Disposition", def: { data_type: "text", length: 100 } },
  { label: "Disposition Note", api: "Disposition_Note", def: { data_type: "textarea", textarea: { type: "small" } } },
  { label: "Customer Phone", api: "Customer_Phone", def: { data_type: "text", length: 30 } },
  { label: "Exotel Number", api: "Exotel_Number", def: { data_type: "text", length: 20 } },
];

// The dispositions an org starts with; the admin edits them on CTI Admin.
const DEFAULT_SETTINGS = {
  dispositions: [
    { name: "Interested", subs: ["Demo booked", "Send details", "Call back later"] },
    { name: "Not interested", subs: ["Price", "No need", "Using another product"] },
    { name: "Call back", subs: ["Busy now", "Asked to call later"] },
    { name: "Not reachable", subs: ["No answer", "Switched off", "Busy"] },
    { name: "Wrong number", subs: [] },
  ],
  twoLevels: true,
  required: true,
  ringSeconds: 25,
  ownerOnly: true,
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

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] || "" : "";
}

const zoho = createZohoClient();

function rows(j, key) {
  const list = (j && j[key]) || [];
  const bad = list.filter((r) => r.code && r.code !== "SUCCESS");
  if (bad.length) throw new Error(bad.map((r) => `${r.code}: ${r.message}${r.details && r.details.api_name ? " (" + r.details.api_name + ")" : ""}`).join("; "));
  return list;
}

async function profiles() {
  const j = await zoho.api("GET", "/settings/profiles");
  const list = (j && j.profiles) || [];
  const admin = list.filter((p) => /^administrator$/i.test(p.name));
  if (!admin.length) throw new Error("No Administrator profile found.");
  return { all: list, admin: new Set(admin.map((p) => String(p.id))) };
}

// Admins edit; everyone else reads (cti_api runs as the caller and must read
// their own record).
const fieldProfiles = (p) => p.all.map((x) => ({ id: x.id, permission_type: p.admin.has(String(x.id)) ? "read_write" : "read_only" }));
const allWrite = (p) => p.all.map((x) => ({ id: x.id, permission_type: "read_write" }));

async function ensureModule(p) {
  step("1. The CTI Agents module");
  const j = await zoho.api("GET", "/settings/modules");
  if (((j && j.modules) || []).some((m) => m.api_name === MODULE)) {
    ok("CTI Agents already exists");
    return;
  }
  rows(await zoho.api("POST", "/settings/modules", {
    modules: [{
      plural_label: "CTI Agents",
      singular_label: "CTI Agent",
      api_name: MODULE,
      profiles: p.all.map((x) => ({ id: x.id })),
      display_field: { field_label: "Agent Name", data_type: "text" },
    }],
  }), "modules");
  ok("Created the CTI Agents module");
}

async function ensureFields(module, wanted, p, everyoneWrites) {
  const existing = await zoho.api("GET", `/settings/fields?module=${module}`);
  const have = new Set(((existing && existing.fields) || []).map((f) => f.api_name));
  const missing = wanted.filter((f) => !have.has(f.api));
  // A field with the same label but another API name blocks creating ours.
  const byLabel = new Map(((existing && existing.fields) || []).map((f) => [String(f.field_label).toLowerCase(), f]));
  const clash = missing.filter((f) => byLabel.has(f.label.toLowerCase()));
  if (clash.length) {
    throw new Error(`${module} already has ${clash.map((f) => `"${f.label}" as ${byLabel.get(f.label.toLowerCase()).api_name} (expected ${f.api})`).join(", ")}. Rename that field's API name to the expected one in Zoho, or rename its label, then run this again.`);
  }
  for (let i = 0; i < missing.length; i += 5) {
    const batch = missing.slice(i, i + 5);
    rows(await zoho.api("POST", `/settings/fields?module=${module}`, {
      fields: batch.map((f) => Object.assign({ field_label: f.label, profiles: everyoneWrites ? allWrite(p) : fieldProfiles(p) }, f.def)),
    }), "fields");
  }
  // Zoho names fields from their labels; check it named them as expected.
  const after = await zoho.api("GET", `/settings/fields?module=${module}`);
  const now = new Set(((after && after.fields) || []).map((f) => f.api_name));
  const off = wanted.filter((f) => !now.has(f.api));
  if (off.length) throw new Error(`${module} is missing ${off.map((f) => f.api).join(", ")}. Rename those fields' API names to match in Zoho, then run this again.`);
  ok(missing.length ? `${module}: added ${missing.map((f) => f.label).join(", ")}` : `${module}: all fields present`);
}

// Zoho's own call outcome picklist on Calls ("Call Result"), which takes the
// first level of the disposition. Returns its API name.
async function ensureOutcome(names) {
  const j = await zoho.api("GET", "/settings/fields?module=Calls");
  const fields = (j && j.fields) || [];
  const f = fields.find((x) => x.api_name === "Call_Result")
    || fields.find((x) => /call\s*(result|outcome)/i.test(x.field_label || "") && x.data_type === "picklist");
  if (!f) {
    warn("Calls has no Call Result field; dispositions go to Sub Disposition only.");
    return "";
  }
  const values = f.pick_list_values || [];
  const have = new Set(values.map((v) => String(v.actual_value || v.display_value).toLowerCase()));
  const add = names.filter((n) => !have.has(n.toLowerCase()));
  if (add.length) {
    try {
      rows(await zoho.api("PATCH", `/settings/fields/${f.id}?module=Calls`, {
        fields: [{
          id: f.id,
          pick_list_values: [
            ...values.map((v) => ({ id: v.id, display_value: v.display_value, actual_value: v.actual_value })),
            ...add.map((n) => ({ display_value: n, actual_value: n })),
          ],
        }],
      }), "fields");
      ok(`${f.field_label}: added ${add.join(", ")}`);
    } catch (err) {
      warn(`Couldn't add ${add.join(", ")} to ${f.field_label} (${err.message}). Add them in Setup > Modules > Calls.`);
    }
  } else {
    ok(`${f.field_label} (${f.api_name}) has every disposition`);
  }
  return f.api_name;
}

async function ensureVariables(outcomeField) {
  step("3. Exotel settings as Zoho org variables");
  const want = {
    exotel_sid: process.env.EXOTEL_ACCOUNT_SID,
    exotel_key: process.env.EXOTEL_API_KEY,
    exotel_token: process.env.EXOTEL_API_TOKEN,
    exotel_subdomain: process.env.EXOTEL_SUBDOMAIN || "api.in.exotel.com",
    exotel_icore: (process.env.EXOTEL_ICORE_BASE || "https://integrationscore.mum1.exotel.com").replace(/\/+$/, ""),
    exotel_app_id: process.env.EXOTEL_APP_ID,
    exotel_app_secret: process.env.EXOTEL_APP_SECRET,
    cti_admins: process.env.CTI_ADMINS || "",
  };
  // Exotel's user and device APIs answer on the CCM host, not the API one.
  want.exotel_ccm = want.exotel_subdomain.replace(/^api\./, "ccm-api.");
  // The functions call Zoho's own API (to add users) on this domain.
  want.zoho_api_domain = (await zoho.session()).apiDomain;
  // Links in the "incoming call" signal open records under this URL.
  want.zoho_crm_url = await crmUrl();
  if (outcomeField) want.cti_outcome_field = outcomeField;
  const hook = arg("webhook");
  if (hook) want.cti_webhook_url = hook;
  const signal = arg("signal");
  if (signal) want.cti_signal_namespace = signal;
  // --app <the Call button widget's address> (cti_api keeps it current after
  // that) and --phone <the Phone web tab's address>
  const app = arg("app");
  if (app) want.cti_app_url = app.replace(/\/+$/, "");
  const phone = arg("phone");
  if (phone) want.cti_phone_url = phone;

  const missing = Object.entries(want).filter(([k, v]) => !v && k !== "cti_admins").map(([k]) => k);
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(", ")}`);

  const groups = await zoho.api("GET", "/settings/variable_groups");
  const list = (groups && groups.variable_groups) || [];
  // A new org has no groups yet; naming one makes Zoho create it.
  const found = list.find((g) => /general/i.test(g.name || g.api_name || "")) || list[0];
  const group = found ? { id: found.id } : { name: "General" };

  const current = await zoho.api("GET", "/settings/variables");
  const byApi = new Map(((current && current.variables) || []).map((v) => [v.api_name, v]));
  const create = [], update = [];
  for (const [api, value] of Object.entries(want)) {
    const v = byApi.get(api);
    if (!v) create.push({ name: api, api_name: api, type: "text", value: String(value), variable_group: group });
    else if (String(v.value || "") !== String(value)) update.push({ id: v.id, value: String(value) });
  }
  for (const k of ["cti_webhook_url", "cti_signal_namespace", "cti_app_url", "cti_phone_url"]) {
    if (!want[k] && !byApi.has(k)) create.push({ name: k, api_name: k, type: "text", value: "set-me", variable_group: group });
  }
  // Created once; after that the admin owns it (CTI Admin > Dispositions).
  if (!byApi.has("cti_settings")) {
    create.push({ name: "cti_settings", api_name: "cti_settings", type: "textarea", value: JSON.stringify(DEFAULT_SETTINGS), variable_group: group });
  }
  if (create.length) rows(await zoho.api("POST", "/settings/variables", { variables: create }), "variables");
  if (update.length) rows(await zoho.api("PUT", "/settings/variables", { variables: update }), "variables");
  const same = Object.keys(want).filter((k) => byApi.has(k) && String(byApi.get(k).value || "") === String(want[k])).length;
  ok(`${create.length} created, ${update.length} updated, ${same} already right`);
  const hookNow = want.cti_webhook_url || (byApi.get("cti_webhook_url") || {}).value;
  if (!hookNow || hookNow === "set-me") warn("cti_webhook_url is not set yet. Re-run with --webhook <cti_webhook API key URL> once the function exists.");
  const sigNow = want.cti_signal_namespace || (byApi.get("cti_signal_namespace") || {}).value;
  if (!sigNow || sigNow === "set-me") warn("cti_signal_namespace is not set yet. Create the signal, then re-run with --signal <namespace>.");
}

// https://crm.zoho.in/crm/org60012345678, or without the org part if Zoho
// won't say (Zoho still finds the record).
async function crmUrl() {
  const accounts = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.in";
  const base = accounts.replace(/\/+$/, "").replace("://accounts.", "://crm.") + "/crm";
  // --org org60012345678 (from the CRM's address bar) when Zoho won't say
  if (/^org\d+$/.test(arg("org"))) return `${base}/${arg("org")}`;
  try {
    const j = await zoho.api("GET", "/org");
    const org = j && j.org && j.org[0];
    if (org && org.domain_name) return `${base}/${org.domain_name}`;
  } catch (e) {
    warn(`Couldn't read the org's URL (${e.message}); signal links use ${base}.`);
  }
  return base;
}

// The dispositions in use: the admin's, once they have saved some.
async function dispositionNames() {
  try {
    const current = await zoho.api("GET", "/settings/variables");
    const v = ((current && current.variables) || []).find((x) => x.api_name === "cti_settings");
    const s = v && v.value ? JSON.parse(v.value) : null;
    if (s && Array.isArray(s.dispositions)) return s.dispositions.map((d) => String(d.name || "").trim()).filter(Boolean);
  } catch (e) {}
  return DEFAULT_SETTINGS.dispositions.map((d) => d.name);
}

async function sipLine(email) {
  const icore = (process.env.EXOTEL_ICORE_BASE || "https://integrationscore.mum1.exotel.com").replace(/\/+$/, "");
  const t = await (await fetch(`${icore}/v2/integrations/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Id: process.env.EXOTEL_APP_ID, Secret: process.env.EXOTEL_APP_SECRET, Entity: "app" }),
  })).json();
  const r = await fetch(`${icore}/v2/integrations/usermapping?user_id=${encodeURIComponent(email)}`, {
    headers: { Authorization: t.Data, "Content-Type": "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.Data ? j.Data : null;
}

// The account's first virtual number (ExoPhone), read from Exotel, so nobody
// has to type it.
async function firstExoPhone() {
  const host = process.env.EXOTEL_SUBDOMAIN || "api.in.exotel.com";
  const auth = Buffer.from(`${process.env.EXOTEL_API_KEY}:${process.env.EXOTEL_API_TOKEN}`).toString("base64");
  try {
    const r = await fetch(`https://${host}/v1/Accounts/${process.env.EXOTEL_ACCOUNT_SID}/IncomingPhoneNumbers.json`, { headers: { Authorization: `Basic ${auth}` } });
    const j = await r.json();
    const list = [].concat(j.IncomingPhoneNumbers || j.IncomingPhoneNumber || []).map((x) => x.IncomingPhoneNumber || x);
    return (list[0] && list[0].PhoneNumber) || "";
  } catch (e) {
    return "";
  }
}

async function seedAdmin() {
  step("4. You, as the first agent");
  // Everyone, the admin included, starts with calling off and is switched on
  // in the CTI Admin tab (which creates their SIP line). Only an existing
  // Exotel agent named with --sip-agent is linked here.
  if (!arg("sip-agent")) {
    ok("Switch calling on for people (you included) in the CTI Admin tab.");
    return;
  }
  const me = (await zoho.api("GET", "/users?type=CurrentUser")).users[0];
  const found = await zoho.api("GET", `/${MODULE}/search?criteria=${encodeURIComponent(`(Zoho_Email:equals:${me.email})`)}`);
  if (found && found.data && found.data.length) {
    ok(`${me.full_name} already has a CTI record`);
    return;
  }
  const rec = {
    Name: me.full_name,
    Zoho_User_Id: String(me.id),
    Zoho_Email: me.email,
    Calling_Enabled: true,
    Caller_ID: process.env.EXOTEL_CALLER_ID || (await firstExoPhone()),
    Personal_Number: arg("number") || process.env.EXOTEL_AGENT_NUMBER || "",
    Default_Mode: "Phone",
  };
  const sipEmail = arg("sip-agent");
  if (sipEmail) {
    const line = await sipLine(sipEmail);
    if (line) {
      Object.assign(rec, { SIP_Id: line.SipId, Exotel_Agent: sipEmail, Exotel_User_Id: line.ExotelUserId, Default_Mode: "SIP" });
      if (!rec.Personal_Number && line.AgentNumber) rec.Personal_Number = line.AgentNumber;
      ok(`Linked the SIP line ${line.SipId}`);
    } else {
      warn(`Exotel has no agent ${sipEmail}; you can create a SIP line later on the CTI Admin tab.`);
    }
  }
  rows(await zoho.api("POST", `/${MODULE}`, { data: [rec], trigger: [] }), "data");
  ok(`Set up ${me.full_name}: calling on, caller ID ${rec.Caller_ID || "(none)"}, rings ${rec.Personal_Number || "(no number yet)"}`);
}

(async () => {
  if (!zoho.ready) {
    fail("Zoho is not connected. Run: npm run zoho:auth");
    process.exitCode = 1;
    return;
  }
  let p;
  try {
    p = await profiles();
  } catch (err) {
    if (/scope|OAUTH|401|NO_PERMISSION/i.test(err.message)) {
      fail("This Zoho connection can't change settings. Generate a new Self Client code with these scopes:");
      console.log(`\n    ${SCOPES}\n\n  then run  npm run zoho:auth -- <code>  and this again.\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  await ensureModule(p);
  await ensureFields(MODULE, FIELDS, p);
  step("2. Calls: Call Result and the CTI's fields");
  const outcomeField = await ensureOutcome(await dispositionNames());
  await ensureFields("Calls", CALL_FIELDS, p, true);
  await ensureVariables(outcomeField);
  await seedAdmin();
  console.log(`\n  Done. Next: create or update the cti_api, cti_webhook and cti_route functions (zoho-cti/functions).\n`);
})().catch((err) => {
  fail(err.message || String(err));
  process.exitCode = 1;
});
