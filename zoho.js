/**
 * Zoho CRM client for the dialer.
 *
 * Two jobs: show the RM who they are calling (a Lead or a Contact, found by
 * record id or by phone number), and write every finished call into Zoho's
 * Calls module against that record.
 *
 * Auth is one server-side OAuth connection: a Zoho "Self Client" refresh token
 * created once with `npm run zoho:auth`. Access tokens last an hour and Zoho
 * throttles how often they can be minted, so one is cached and shared.
 *
 * Checked against the Zoho CRM v8 API docs:
 *   - A call links to a Contact through Who_Id, and to a Lead through What_Id
 *     plus "$se_module": "Leads". Who_Id only ever takes a contact.
 *   - Subject, Call_Type, Call_Start_Time and Call_Duration are mandatory for a
 *     completed call. Call_Duration is minutes:seconds ("10:00" reads back as
 *     600 in Call_Duration_in_seconds), and Zoho refuses a zero duration on an
 *     Inbound or Outbound call.
 *   - Search answers 204 with an empty body when nothing matches.
 */

const API_VERSION = "v8";

// The fields the dialer's lead card shows. All are standard Zoho fields.
const MODULES = {
  Leads: {
    kind: "Lead",
    fields: "Full_Name,First_Name,Last_Name,Company,Designation,Lead_Status,Lead_Source,Email,Phone,Mobile,Owner",
  },
  Contacts: {
    kind: "Contact",
    fields: "Full_Name,First_Name,Last_Name,Account_Name,Title,Lead_Source,Email,Phone,Mobile,Owner",
  },
};

// Zoho matches a phone number the way it was typed into the record, so a
// lookup tries the shapes a number is usually saved in, most likely first.
function phoneVariants(raw, countryCode = process.env.DEFAULT_COUNTRY_CODE || "91") {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 6) return [];
  const local = digits.slice(-10);
  const out = [digits];
  if (digits[0] !== "0") out.push("+" + digits);
  out.push(local, "0" + local);
  if (local.length === 10) out.push("+" + countryCode + local, countryCode + local);
  return [...new Set(out)];
}

// Zoho wants ISO 8601 with an explicit offset; UTC is fine.
const zohoTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

// minutes:seconds, never zero (see the header).
function zohoDuration(seconds) {
  const s = Math.max(1, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const describe = (j) =>
  j ? [j.code, j.message, j.details && j.details.api_name].filter(Boolean).join(" ") : "";

function createZohoClient(opts = {}) {
  const conf = {
    accountsUrl: String(opts.accountsUrl || process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.in").replace(/\/+$/, ""),
    clientId: opts.clientId || process.env.ZOHO_CLIENT_ID || "",
    clientSecret: opts.clientSecret || process.env.ZOHO_CLIENT_SECRET || "",
    refreshToken: opts.refreshToken || process.env.ZOHO_REFRESH_TOKEN || "",
  };

  let cached = null;   // { token, apiDomain, expiresAt }
  let inflight = null; // one refresh at a time, however many requests want it

  async function session() {
    if (cached && Date.now() < cached.expiresAt) return cached;
    if (!inflight) {
      inflight = (async () => {
        const r = await fetch(`${conf.accountsUrl}/oauth/v2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: conf.refreshToken,
            client_id: conf.clientId,
            client_secret: conf.clientSecret,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!j.access_token) {
          throw new Error(`Zoho sign-in failed (${j.error || "HTTP " + r.status}). Run: npm run zoho:auth`);
        }
        // Renew five minutes early so a token never lapses mid-request.
        const life = Math.max(60, (Number(j.expires_in) || 3600) - 300);
        cached = { token: j.access_token, apiDomain: j.api_domain || "https://www.zohoapis.in", expiresAt: Date.now() + life * 1000 };
        return cached;
      })().finally(() => { inflight = null; });
    }
    return inflight;
  }

  async function api(method, path, body) {
    const s = await session();
    const r = await fetch(`${s.apiDomain}/crm/${API_VERSION}${path}`, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${s.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (r.status === 401) cached = null; // revoked early: mint a fresh one next time
    if (!r.ok) throw new Error(`Zoho ${method} ${path.split("?")[0]}: ${describe(j) || "HTTP " + r.status}`);
    return j;
  }

  // The latest note on the record, or null. Never fails the lookup.
  async function lastNote(module, id) {
    try {
      const j = await api("GET", `/${module}/${id}/Notes?fields=Note_Title,Note_Content,Created_Time&per_page=10`);
      const notes = ((j && j.data) || []).sort((a, b) => String(b.Created_Time).localeCompare(String(a.Created_Time)));
      const n = notes[0];
      return n ? { title: n.Note_Title || "", text: n.Note_Content || "", at: n.Created_Time || "" } : null;
    } catch (e) {
      return null;
    }
  }

  // What the dialer's card shows. Plain values only; the browser renders them
  // as text.
  function shape(module, rec, note) {
    const lead = module === "Leads";
    return {
      module,
      id: String(rec.id),
      kind: MODULES[module].kind,
      name: rec.Full_Name || [rec.First_Name, rec.Last_Name].filter(Boolean).join(" ") || "",
      company: (lead ? rec.Company : rec.Account_Name && rec.Account_Name.name) || "",
      title: (lead ? rec.Designation : rec.Title) || "",
      status: rec.Lead_Status || "",
      source: rec.Lead_Source || "",
      email: rec.Email || "",
      phone: rec.Phone || "",
      mobile: rec.Mobile || "",
      owner: (rec.Owner && rec.Owner.name) || "",
      note,
    };
  }

  async function getPerson(module, id) {
    if (!MODULES[module]) throw new Error(`Unsupported module ${module}`);
    const j = await api("GET", `/${module}/${encodeURIComponent(id)}?fields=${MODULES[module].fields}`);
    const rec = j && j.data && j.data[0];
    return rec ? shape(module, rec, await lastNote(module, rec.id)) : null;
  }

  // Leads first: RMs mostly call leads, and Zoho leaves converted leads out of
  // a lead search, so a converted lead is found as its Contact instead.
  async function findByPhone(number) {
    for (const variant of phoneVariants(number)) {
      const q = encodeURIComponent(variant);
      const [leads, contacts] = await Promise.all([
        api("GET", `/Leads/search?phone=${q}&per_page=1`),
        api("GET", `/Contacts/search?phone=${q}&per_page=1`),
      ]);
      const hit = (leads && leads.data && leads.data[0] && ["Leads", leads.data[0]]) ||
        (contacts && contacts.data && contacts.data[0] && ["Contacts", contacts.data[0]]);
      if (hit) return getPerson(hit[0], hit[1].id);
    }
    return null;
  }

  // The RM's Zoho user id, so the call log is theirs rather than whoever ran
  // `npm run zoho:auth`. The user list is cached for an hour.
  let users = null;
  async function userIdByEmail(email) {
    if (!email) return null;
    if (!users || Date.now() > users.expiresAt) {
      const j = await api("GET", "/users?type=ActiveUsers&per_page=200");
      users = { list: (j && j.users) || [], expiresAt: Date.now() + 3600000 };
    }
    const u = users.list.find((x) => String(x.email || "").toLowerCase() === String(email).toLowerCase());
    return u ? String(u.id) : null;
  }

  // c: { direction: "Outbound" | "Inbound", subject, startedAt (ms), seconds,
  //      description, person: { module, id } | null, ownerId | null }
  async function logCall(c) {
    const rec = {
      Subject: c.subject,
      Call_Type: c.direction,
      Call_Start_Time: zohoTime(c.startedAt),
      Call_Duration: zohoDuration(c.seconds),
      Description: c.description || "",
    };
    if (c.direction === "Outbound") rec.Outbound_Call_Status = "Completed";
    if (c.person && c.person.module === "Contacts") {
      rec.Who_Id = { id: c.person.id };
    } else if (c.person && c.person.module === "Leads") {
      rec.What_Id = { id: c.person.id };
      rec.$se_module = "Leads";
    }
    if (c.ownerId) rec.Owner = { id: c.ownerId };

    const j = await api("POST", "/Calls", { data: [rec] });
    const row = j && j.data && j.data[0];
    if (!row || row.code !== "SUCCESS") {
      throw new Error(`Zoho refused the call log: ${describe(row) || "empty response"}`);
    }
    return row.details && row.details.id;
  }

  return {
    get ready() { return Boolean(conf.clientId && conf.clientSecret && conf.refreshToken); },
    secrets: [conf.clientSecret, conf.refreshToken].filter(Boolean),
    api,
    session,
    getPerson,
    findByPhone,
    userIdByEmail,
    logCall,
  };
}

module.exports = { createZohoClient, MODULES, phoneVariants, zohoDuration, zohoTime };
