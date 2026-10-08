/* =========================================================================
   CTI Admin: a Zoho web tab for admins.

   People: every Zoho user is listed, straight from Zoho. Setting someone up
   is one click on their row: it saves their CTI Agents record (caller ID,
   personal number, where incoming calls ring, how calls go out), creates
   their SIP line in Exotel the first time calling is on, and switches their
   Exotel devices to match (the incoming device ON while Available, all OFF
   while Offline). Remove stops their calling and deletes their Exotel
   agent; their Zoho user is left alone.

   Dispositions and Incoming calls are kept in the cti_settings variable,
   which the CTI and cti_route read.

   Caller ID is always one of the account's Exotel virtual numbers
   (ExoPhones). The personal number is the person's own phone, which rings
   for incoming calls on Phone and first for calls out on Number; customers
   never see it.
   ========================================================================= */
(function () {
  "use strict";

  const { api, h, settingsFrom } = window.CTI;
  const $ = (id) => document.getElementById(id);
  const MODULE = "CTI_Agents";
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  const S = { users: [], agents: new Map(), exophones: [], settings: settingsFrom(null) };

  function notice(text, tone) {
    $("notice").hidden = !text;
    $("notice").dataset.tone = tone || "warn";
    $("noticeText").textContent = text || "";
  }

  // Zoho's record API answers in a few shapes; this reads the first result.
  function firstResult(resp) {
    const row = resp && resp.data && resp.data[0];
    if (!row) throw new Error("Zoho gave no answer.");
    if (row.code && row.code !== "SUCCESS") {
      throw new Error(`${row.code}: ${row.message || ""} ${row.details && row.details.api_name ? "(" + row.details.api_name + ")" : ""}`.trim());
    }
    return row;
  }

  const clean = (n) => String(n || "").replace(/[^\d+]/g, "");

  /* ---------------- loading ---------------- */

  async function loadAll() {
    notice(null);
    $("summary").textContent = "Loading…";
    const me = await api("me");
    if (!me.isAdmin) {
      $("summary").textContent = "Only an admin can manage calling.";
      $("rows").replaceChildren();
      return;
    }
    S.settings = settingsFrom(me.settings);
    paintSettings();
    const [usersResp, agentsResp, phones] = await Promise.all([
      ZOHO.CRM.API.getAllUsers({ Type: "AllUsers" }),
      ZOHO.CRM.API.getAllRecords({ Entity: MODULE, sort_order: "asc", per_page: 200, page: 1 }).catch(() => null),
      api("exophones").catch((err) => {
        notice(`Couldn't list your Exotel virtual numbers: ${err.message}`, "bad");
        return { exophones: [] };
      }),
    ]);
    S.users = ((usersResp && usersResp.users) || [])
      .filter((u) => !/deleted|disabled|deactive/i.test(String(u.status || "active")))
      .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
    S.exophones = phones.exophones || [];
    if (!S.exophones.length && phones.note) notice(`Exotel listed no virtual numbers for this account. It said: ${phones.note}`, "bad");
    S.agents = new Map();
    for (const a of (agentsResp && agentsResp.data) || []) {
      if (a.Zoho_User_Id) S.agents.set(String(a.Zoho_User_Id), a);
    }
    await syncNames();
    render();
  }

  // A rename done directly in Zoho still shows up here.
  async function syncNames() {
    for (const u of S.users) {
      const a = S.agents.get(String(u.id));
      if (!a || (a.Name === u.full_name && a.Zoho_Email === u.email)) continue;
      try {
        firstResult(await ZOHO.CRM.API.updateRecord({
          Entity: MODULE, APIData: { id: a.id, Name: u.full_name, Zoho_Email: u.email }, Trigger: [],
        }));
        a.Name = u.full_name;
        a.Zoho_Email = u.email;
      } catch (e) {}
    }
  }

  function fillSelect(sel, items, value, placeholder) {
    sel.replaceChildren(h("option", { value: "" }, placeholder));
    for (const it of items) sel.append(h("option", { value: it.value }, it.label));
    if (value && ![...sel.options].some((o) => o.value === value)) sel.append(h("option", { value }, `${value} (not in this account)`));
    sel.value = value || "";
  }

  const phoneChoices = () => S.exophones.map((p) => ({
    value: p.number,
    label: p.name && p.name !== p.number ? `${p.name} (${p.number})` : p.number,
  }));

  async function saveAgent(record, data) {
    if (record) {
      firstResult(await ZOHO.CRM.API.updateRecord({ Entity: MODULE, APIData: Object.assign({ id: record.id }, data), Trigger: [] }));
      return Object.assign(record, data);
    }
    const res = firstResult(await ZOHO.CRM.API.insertRecord({ Entity: MODULE, APIData: data, Trigger: [] }));
    return Object.assign({ id: res.details.id }, data);
  }

  // Exotel's devices follow the record: returns a warning, or "".
  async function applyDevices(record) {
    if (!record || !record.Exotel_User_Id) return "";
    try {
      const r = await api("apply_devices", { id: String(record.id) });
      return r.warning || "";
    } catch (err) {
      return err.message;
    }
  }

  /* ---------------- the table ---------------- */

  function render() {
    const calling = S.users.filter((u) => {
      const a = S.agents.get(String(u.id));
      return a && a.Calling_Enabled && a.Personal_Number;
    }).length;
    $("summary").textContent = `${S.users.length} Zoho user${S.users.length === 1 ? "" : "s"} · ${calling} can call`;
    $("rows").replaceChildren(...S.users.map(row));
  }

  function toggle(checked, title) {
    const input = h("input", { type: "checkbox" });
    input.checked = !!checked;
    return { input, el: h("label", { class: "switch", title }, input, h("span")) };
  }

  // What went wrong, in words an admin can act on: only what Exotel
  // actually replied, never a guess at the cause.
  function explain(err) {
    const m = String((err && err.message) || err || "Something went wrong.");
    const reply = (m.match(/^Exotel replied: ([\s\S]*)$/) || [])[1];
    if (!reply) return m;
    let what = "";
    if (/trial account/i.test(reply)) what = " This is a trial Exotel account, where SIP (WebRTC) users can't be created.";
    else if (/email already exists/i.test(reply)) what = " This email, and its +sip version, belong to another Exotel account: give them a different email in Zoho.";
    else if (/device already exists/i.test(reply)) what = " Their number is already on another Exotel user.";
    return `Their SIP line wasn't created. Exotel replied: "${reply.trim()}".${what} Switch Calling off and on to try again.`;
  }

  function row(u) {
    let record = S.agents.get(String(u.id)) || null;
    const first = String(u.first_name || u.full_name || "them").split(" ")[0];
    const msg = h("div", { class: "row-msg" });
    const say = (text, tone) => { msg.textContent = text || ""; msg.className = "row-msg " + (tone || "bad"); };
    // A failure shows on the row and at the top of the page.
    const fail = (err) => {
      const why = explain(err);
      say(why, "bad");
      notice(`${u.full_name || u.email}: ${why}`, "bad");
    };

    // Calling starts off. Turned on (calls both ways), it asks for their
    // number; once that is in, their SIP line is made. Everything saves as
    // it changes.
    const enabled = toggle(record ? record.Calling_Enabled : false, "Calling");

    const cid = h("select");
    fillSelect(cid, phoneChoices(), (record && record.Caller_ID) || (S.exophones[0] && S.exophones[0].number) || "", "Choose a virtual number");

    // A caller ID whose ExoPhone is no longer in Exotel moves to the first
    // one the account has (saved below, once the row is built).
    const goneCid = record && record.Caller_ID && S.exophones.length && !S.exophones.some((p) => p.number === record.Caller_ID)
      ? record.Caller_ID : "";
    if (goneCid) cid.value = S.exophones[0].number;

    const num = h("input", { type: "tel", placeholder: "+919876543210" });
    num.value = (record && record.Personal_Number) || "";
    const numberOk = () => clean(num.value).replace("+", "").length >= 10;

    // The device they work on in Zoho, and how they take every call.
    const ringsOn = h("select", {},
      h("option", { value: "Desktop" }, "Desktop"), h("option", { value: "Phone" }, "Phone"));
    ringsOn.value = (record && record.Incoming_On) || "Desktop";
    const mode = h("select", {},
      h("option", { value: "SIP" }, "SIP"), h("option", { value: "Phone" }, "Number"));
    mode.value = (record && record.Default_Mode) || "SIP";

    const sipState = h("div", { class: "sip-state" });
    const paintSip = () => sipState.replaceChildren(
      h("span", { class: "dot " + (record && record.SIP_Id ? "ok" : "") }),
      record && record.SIP_Id ? record.SIP_Id : "-");
    paintSip();


    async function saveRow(extra) {
      const data = Object.assign({
        Name: u.full_name, Zoho_User_Id: String(u.id), Zoho_Email: u.email,
        Calling_Enabled: enabled.input.checked, Caller_ID: cid.value,
        Personal_Number: clean(num.value), Default_Mode: mode.value, Incoming_On: ringsOn.value,
      }, extra || {});
      if (data.Calling_Enabled && !data.Caller_ID) throw new Error("Choose the virtual number customers will see.");
      const before = record && record.Personal_Number;
      record = await saveAgent(record, data);
      S.agents.set(String(u.id), record);
      // Keep their Zoho profile's mobile the same as the number calls ring.
      if (data.Personal_Number && data.Personal_Number !== before && data.Personal_Number !== clean(u.mobile)) {
        api("update_user", { userId: String(u.id), mobile: data.Personal_Number }).catch(() => {});
      }
      return applyDevices(record);
    }

    // Their SIP line in Exotel, tied to the chosen caller ID, under their
    // email; when Exotel already has a user with that email, under
    // name+sip@ the same domain. What Exotel already had (that email or
    // number on someone else) is noted on the row.
    let lineNote = "";
    async function createLine() {
      if (!cid.value) throw new Error("Choose a virtual number first: Exotel ties the SIP line to one.");
      const email = String(u.email || "").trim();
      if (!EMAIL_RE.test(email)) throw new Error("This Zoho user has no email for Exotel.");
      // Exotel gets the name with each word capitalised: "TEST login" got no
      // SIP line from Exotel, "Test Login" did (everything else the same).
      const name = String(u.full_name || "").toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
      const ask = (e) => api("provision_sip", { email: e, name, callerId: cid.value, number: clean(num.value) });
      let line;
      try {
        line = await ask(email);
      } catch (err) {
        if (!/email already exists/i.test(err.message)) throw err;
        const [local, domain] = email.split("@");
        line = await ask(`${local}+sip@${domain}`);
      }
      lineNote = line.note || "";
      return { SIP_Id: line.sipId, Exotel_Agent: line.exotelAgent, Exotel_User_Id: line.exotelUserId };
    }

    // Brings Zoho and Exotel in line with the row. One run at a time.
    async function sync() {
      const on = enabled.input.checked;
      num.classList.remove("need");
      if (!record && !on) return say("");
      if (num.value.trim() && !numberOk()) {
        num.classList.add("need");
        throw new Error("That number looks too short. Use the full mobile, e.g. +919876543210.");
      }
      if (on && !numberOk()) {
        // Kept on, but nothing reaches them until their number is in.
        if (!record || !record.Calling_Enabled) await saveRow();
        num.classList.add("need");
        num.focus();
        return say(`Add ${first}'s number to finish. Until then they get no calls and no phone in Zoho.`, "warn");
      }
      let extra = null;
      if (on && !(record && record.SIP_Id)) {
        say("Creating their SIP line in Exotel…", "ok");
        extra = await createLine();
      }
      say("Saving…", "ok");
      const warn = await saveRow(extra);
      if (extra) paintSip();
      if (warn) {
        say(`Saved, but Exotel said: ${warn}`, "bad");
        notice(`${u.full_name || u.email}: Exotel said: ${warn}`, "bad");
      } else {
        say(on ? (extra ? `SIP line created. Calling is on.${lineNote ? " " + lineNote : ""}` : "Saved.") : "Calling is off.", "ok");
      }
    }
    let running = Promise.resolve();
    const changed = () => {
      running = running.then(sync).catch(fail);
    };
    enabled.input.addEventListener("change", changed);
    for (const el of [cid, ringsOn, mode]) el.addEventListener("change", () => { if (record || enabled.input.checked) changed(); });
    num.addEventListener("change", changed);
    num.addEventListener("keydown", (e) => { if (e.key === "Enter") num.blur(); });
    if (goneCid) {
      running = running.then(async () => {
        await saveRow();
        say(`Caller ID ${goneCid} is no longer in Exotel; now ${cid.value}.`, "warn");
      }).catch(fail);
    }
    if (record && record.Calling_Enabled && !record.Personal_Number) {
      num.classList.add("need");
      say(`Add ${first}'s number to finish. Until then they get no calls and no phone in Zoho.`, "warn");
    }

    const tags = [];
    if (u.confirm === false) tags.push(h("span", { class: "tag2" }, "Invited"));
    if (u.profile && /administrator/i.test(u.profile.name)) tags.push(h("span", { class: "tag2 blue" }, "Admin"));

    return h("tr", null,
      h("td", null,
        h("div", { class: "u-name" }, u.full_name || "-", tags),
        h("div", { class: "u-mail" }, u.email || ""),
        h("div", { class: "u-role" }, [u.profile && u.profile.name, u.role && u.role.name].filter(Boolean).join(" · "))),
      h("td", null, enabled.el),
      h("td", null, cid),
      h("td", null, num),
      h("td", null, ringsOn),
      h("td", null, mode),
      h("td", null, sipState),
      h("td", null, msg));
  }

  /* ---------------- dispositions and incoming rules ---------------- */

  function dispRow(d) {
    const name = h("input", { type: "text", maxlength: "40", placeholder: "e.g. Interested" });
    name.value = d ? d.name : "";
    const subs = h("input", { type: "text", maxlength: "200", placeholder: "e.g. Demo booked, Send details" });
    subs.value = d ? d.subs.join(", ") : "";
    const del = h("button", { type: "button", class: "icon-btn", title: "Remove" }, "✕");
    const tr = h("tr", { class: "disp" }, h("td", null, name), h("td", { class: "sub-cell" }, subs), h("td", null, del));
    del.addEventListener("click", () => tr.remove());
    return tr;
  }

  function paintSettings() {
    const s = S.settings;
    $("sTwo").checked = s.twoLevels;
    $("sReq").checked = s.required;
    $("dispRows").replaceChildren(...s.dispositions.map(dispRow));
    paintLevels();
    $("sRing").value = s.ringSeconds;
    $("sOwner").value = String(s.ownerOnly);
    $("sNew").value = String(s.newLeads);
  }

  function paintLevels() {
    const two = $("sTwo").checked;
    $("subHead").hidden = !two;
    for (const c of document.querySelectorAll(".sub-cell")) c.hidden = !two;
  }

  function readDispositions() {
    const out = [];
    const seen = new Set();
    for (const tr of $("dispRows").querySelectorAll("tr.disp")) {
      const [name, subs] = tr.querySelectorAll("input");
      const n = name.value.trim();
      if (!n) continue;
      if (seen.has(n.toLowerCase())) throw new Error(`"${n}" is listed twice.`);
      seen.add(n.toLowerCase());
      out.push({ name: n, subs: [...new Set(subs.value.split(",").map((x) => x.trim()).filter(Boolean))] });
    }
    return out;
  }

  async function saveSettings(patch, msgEl, btn) {
    btn.disabled = true;
    msgEl.className = "row-msg";
    msgEl.textContent = "";
    try {
      const next = settingsFrom(Object.assign({}, S.settings, patch));
      const r = await api("save_settings", { settings: next });
      S.settings = next;
      paintSettings();
      msgEl.className = r.warning ? "row-msg bad" : "row-msg ok";
      msgEl.textContent = r.warning ? `Saved. ${r.warning}` : "Saved. Applies to the next call.";
    } catch (err) {
      msgEl.className = "row-msg bad";
      msgEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  $("sTwo").addEventListener("change", paintLevels);
  $("dispAdd").addEventListener("click", () => {
    const tr = dispRow(null);
    $("dispRows").append(tr);
    paintLevels();
    tr.querySelector("input").focus();
  });
  $("dispSave").addEventListener("click", () => {
    let dispositions;
    try {
      dispositions = readDispositions();
    } catch (err) {
      $("dispMsg").className = "row-msg bad";
      $("dispMsg").textContent = err.message;
      return;
    }
    saveSettings({ dispositions, twoLevels: $("sTwo").checked, required: $("sReq").checked }, $("dispMsg"), $("dispSave"));
  });
  $("inSave").addEventListener("click", () => {
    saveSettings({ ringSeconds: Number($("sRing").value) || 25, ownerOnly: $("sOwner").value === "true", newLeads: $("sNew").value === "true" }, $("inMsg"), $("inSave"));
  });

  /* ---------------- wiring ---------------- */

  $("pageTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    for (const x of $("pageTabs").querySelectorAll("button")) x.classList.toggle("on", x === b);
    for (const t of ["people", "dispositions", "incoming"]) $("tab-" + t).hidden = b.dataset.tab !== t;
  });
  $("reload").addEventListener("click", () => loadAll().catch((err) => notice(err.message, "bad")));

  ZOHO.embeddedApp.on("PageLoad", () => {
    loadAll().catch((err) => {
      $("summary").textContent = "";
      notice(err.message, "bad");
    });
  });
  ZOHO.embeddedApp.init();
})();
