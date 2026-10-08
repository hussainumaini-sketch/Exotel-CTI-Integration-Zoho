/* =========================================================================
   Exotel CTI for Zoho CRM

   One page, four places in Zoho:
     Dock        the phone at the bottom right of Lead and Contact pages (a
                 Client Script flyout, cti.html). Minimised to one line; an
                 incoming call opens it with the caller.
     Phone tab   a web tab (phone.html) that can stay open all day. Its SIP
                 line registers once and stays.
     Call button the button widget on a Lead or Contact (cti.html), which is
                 also what the Zoho phone app shows.
     Call history the same page opened on its history (history.html).
   One page holds the SIP line: the Phone tab when it is open, otherwise a
   dock. The others hand it their calls and mirror it.

   Calls go out through Exotel's Connect Two Numbers (cti_api "call"):
     SIP       Exotel rings the RM's SIP line, which this page answers by
               itself, then the customer.
     Number    Exotel rings the RM's own phone, then the customer.
   What the RM sees while it connects is only: Agent connecting, Agent
   connected, Connecting customer, Customer connected. The timer starts when
   the customer picks up (Exotel's per-leg "answered" events, which
   cti_webhook keeps for cti_api "status").

   Incoming calls are routed by cti_route (Exotel Programmable Connect). One
   that rings this page's SIP line pops up here with the caller's record,
   which opens in Zoho when it is answered.
   ========================================================================= */
(function () {
  "use strict";

  const C = window.CTI;
  const { api, initials, clock, when, fullWhen, seconds, recordingFrom, digits, outcome, tone, settingsFrom, sleep, h, icon } = C;
  const $ = (id) => document.getElementById(id);
  const FINAL = new Set(["completed", "failed", "busy", "no-answer", "canceled"]);
  const STAGES = {
    agentConnecting: "Agent connecting…",
    agentConnected: "Agent connected",
    customerConnecting: "Connecting customer…",
    customerConnected: "Customer connected",
    incoming: "Incoming call",
    alert: "Pick up on your phone",
    onPhone: "On your phone",
    dropped: "Connection lost",
  };
  const KEYS = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
    ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", "+"], ["#", ""]];

  const TAB = document.body.dataset.host === "tab";
  const HISTORY_ONLY = document.body.dataset.view === "history";
  // The Zoho phone app runs Client Scripts too, so it gets the dock as well;
  // but a page there can't hold a call, so the dock steps aside on phones
  // and the Call button stays the phone app's CTI.
  const ON_PHONE = /Android|iPhone|iPad|iPod|Mobile|ZohoCRM/i.test(navigator.userAgent)
    || !!(window.matchMedia && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches);
  const S = {
    host: TAB ? "tab" : "button",   // "tab" = the Phone tab, "button" = a Call button popup
    booted: false,
    user: "",            // the signed-in Zoho user's email
    crmUrl: "",          // https://crm.zoho.in/crm/org…, for opening records from the Phone tab
    appUrl: "",          // the Call button widget's address (its bridge.html)
    phoneUrl: "",        // the Phone tab's address
    released: false,     // this Phone tab gave the line to another one
    engine: false,       // this dock holds the line (no Phone tab is open)
    lastEnd: null,       // how the last call ended, for a mirroring Call button
    recoverDone: false,  // a saved call has been looked at (see "carrying a call over")
    view: "dial",
    isAdmin: false,
    agent: null,         // { id, enabled, callerId, personalNumber, mode, sipId, status }
    settings: settingsFrom(null),
    ctx: null,           // the record in view: { module, id, name, org, status, numbers, number }
    padOpen: true,
    call: null,          // { sid, dir, mode, number, name, org, module, id, stage, legs, startedAt, hungUp }
    wrap: null,          // { sid, name, status, talk, d1, d2, note, later }
    pollTimer: null,
    tick: null,
    sip: { phone: null, ready: false, starting: null, active: false, muted: false, held: false,
      expectUntil: 0, wanted: false, retry: 0, retryTimer: null, onRegistered: null },
    hist: { filter: "all", agent: "", dir: "", since: "", disp: "", q: "", next: 0, people: null },
  };
  // How this page reaches the Phone tab (see "the Phone tab and the Call
  // button" below). Only a Call button is ever "on" (linked).
  const CHANNEL = "exotel-cti";
  const link = { bc: null, frame: null, on: false, user: "", snap: null, at: 0, waiter: null };
  // This page's id, to tell pages apart on the channel.
  const pageId = Math.random().toString(36).slice(2);
  // The page holding the SIP line and placing and taking calls: the Phone
  // tab, or with none open, one dock (S.engine). Every other page mirrors it.
  const isEngine = () => S.host === "tab" || S.engine;

  /* ---------------- small UI helpers ---------------- */

  function notice(text, toneName, label, onClick) {
    $("notice").hidden = !text;
    $("notice").dataset.tone = toneName || "warn";
    $("noticeText").textContent = text || "";
    $("noticeBtn").hidden = !label;
    $("noticeBtn").textContent = label || "";
    $("noticeBtn").onclick = onClick ? () => { notice(null); onClick(); } : null;
  }

  function show(view) {
    // The Call history button has no dialer: it comes back to the history,
    // freshly loaded.
    const backToHistory = HISTORY_ONLY && view === "dial";
    if (backToHistory) view = "hist";
    S.view = view;
    $("vDial").hidden = view !== "dial";
    $("vLive").hidden = view !== "live";
    $("vWrap").hidden = view !== "wrap";
    $("vHist").hidden = view !== "hist";
    $("vSet").hidden = view !== "set";
    $("histBack").hidden = HISTORY_ONLY && !S.call && !S.wrap;
    if (backToHistory && S.booted) loadHistory();
    // A ringing call opens the dock. A call or disposition opens it on the
    // page holding the call (not on one only mirroring it), unless it was put
    // away during this call.
    if (S.host === "dock" && !dock.open && (view === "live" || view === "wrap")) {
      const item = S.call || S.wrap;
      if (dockRinging() || (isEngine() && dock.minFor !== item)) dockSize(true);
    }
    paintDock();
    persist();
    share();
  }

  function paintHeader() {
    const a = S.agent;
    const hasSip = !!(a && a.sipId);
    const locked = !a || !a.enabled || !!S.call;
    // The device the person works on (Desktop: calls in and out on SIP;
    // Phone: calls in ring their number). Settings: outgoing on SIP or
    // their Number.
    paintSeg($("inSeg"), a && a.incoming, locked, {});
    paintSeg($("outSeg"), a && a.mode, locked, { SIP: !hasSip, Phone: !(a && a.personalNumber) });
    $("outSeg").title = hasSip ? "" : "No SIP line yet. Ask your admin.";
    $("setIn").textContent = !a ? "-" : a.incoming === "Phone" ? `Ring ${a.personalNumber || "your number"}` : "Ring here (SIP)";
    $("setNum").textContent = (a && a.personalNumber) || "-";
    $("setCid").textContent = (a && a.callerId) || "-";
    paintLine();
  }

  function paintSeg(seg, value, locked, unavailable) {
    seg.classList.toggle("locked", locked);
    for (const b of seg.querySelectorAll("button")) {
      const on = b.dataset.v === value;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
      b.disabled = locked || (!on && !!unavailable[b.dataset.v]);
    }
  }

  // Is this page on the device the person works on?
  function onThisDevice() {
    const a = S.agent;
    if (!a) return true;
    return ON_PHONE ? a.incoming === "Phone" : a.incoming !== "Phone";
  }

  // Working on the desktop, calls come in on SIP, so a desktop page keeps
  // the line up. Working on the phone, calls come in on their number, and
  // no page keeps a line for them.
  function sipWanted() {
    const a = S.agent;
    return !!(a && a.enabled && a.sipId && !ON_PHONE && a.incoming !== "Phone");
  }

  // A Call button (or Call history) popup only needs it to place calls.
  function lineNeeded() {
    return S.host === "button" ? sipUsed() : sipWanted();
  }

  // Calls out go over SIP (the line comes up for the call), unless
  // Settings says Number: then Exotel rings their phone first.
  function sipUsed() {
    const a = S.agent;
    return !!(a && a.enabled && a.sipId && a.mode === "SIP");
  }

  const callWay = () => (sipUsed() ? "SIP" : "Phone");

  function paintLine() {
    const a = S.agent;
    let state = "down";
    let text = "Calling is off";
    const line = link.on && link.snap && link.snap.line;
    if (line) {
      // The Phone tab's line, which this page's calls go through.
      state = line.state;
      text = lineNeeded() && link.role === "tab" ? `${line.text} · Phone tab` : line.text;
    } else if (S.host === "dock" && lineNeeded() && !isEngine()) {
      state = "wait";
      text = "Connecting";
    } else if (a && a.enabled) {
      if (lineNeeded()) {
        // "Connecting" only while it is; between retries it is offline.
        state = S.sip.ready ? "ready" : S.sip.starting ? "wait" : "down";
        text = { ready: "SIP ready", wait: "SIP connecting", down: "SIP offline" }[state];
      } else {
        state = "ready";
        text = `Rings ${a.personalNumber || "your phone"}`;
      }
    }
    $("lineDot").dataset.state = state;
    $("lineText").textContent = text;
    $("lineFix").hidden = !(state === "down" && lineNeeded());
    $("cidText").textContent = a && a.callerId ? `Caller ID ${a.callerId}` : "";
    $("phoneLink").hidden = S.host === "tab" || S.host === "dock" || link.on || !S.phoneUrl || !sipWanted();
    paintDock();
    share();
  }

  /* ---------------- the dock ----------------
     On Lead and Contact pages a Client Script opens this page in a flyout
     at the bottom right. Zoho closes it whenever the page changes, so it
     holds no SIP line: calls go through the Phone tab, and the dock mirrors
     them like a Call button. Minimised it is one line; a call opens it. */

  // minFor: the call (or disposition) the dock was put away during, so
  // updates to it don't open it again.
  const dock = { open: false, beat: null, minFor: null };
  const DOCK_W = 400, DOCK_OPEN_H = 600, DOCK_BAR_H = 48;

  function dockSize(open) {
    if (S.host !== "dock") return;
    dock.open = open;
    if (open) dock.minFor = null;
    document.body.classList.toggle("collapsed", !open);
    $("dockBar").hidden = open;
    $("dockMin").hidden = !open;
    // Opening asks for the full size; fitWindow shrinks it if the window is
    // smaller.
    frameSize(open ? DOCK_OPEN_H : DOCK_BAR_H, DOCK_W, open);
    paintDock();
    fitZoom();
  }

  /* The window decides how big the CTI can be. Zoho sizes the frame to what
     is asked for, and the frame can't see the Zoho window, but it can see
     how much of itself is on screen: when part is cut off, it asks for
     only what fits. It asks for the full size again each time it opens. */
  const frame = { h: 0, w: 0, fullH: 0, fullW: 0 };
  function frameSize(h, w, full) {
    frame.h = h;
    frame.w = w;
    if (full !== undefined) {
      frame.fullH = full ? h : 0;
      frame.fullW = full ? w : 0;
    }
    try {
      Promise.resolve(ZOHO.CRM.UI.Resize({ height: String(h), width: String(w) })).catch(() => {});
    } catch (e) {}
  }

  // Zoho slides the flyout in: a frame measured half-way in would shrink
  // for nothing. So it is measured once it has kept still.
  let fitTimer = null;
  function fitWindow(entries) {
    const e = entries[entries.length - 1];
    clearTimeout(fitTimer);
    if (e) fitTimer = setTimeout(() => fitNow(e), 700);
  }

  function fitNow(e) {
    if (!frame.h || (S.host === "dock" && !dock.open)) return;
    const seenH = Math.floor(e.intersectionRect.height);
    const seenW = Math.floor(e.intersectionRect.width);
    if (!seenH || !seenW) return;
    const h = seenH < frame.h - 4 ? Math.max(320, seenH - 8) : frame.h;
    const w = seenW < frame.w - 4 ? Math.max(300, seenW - 8) : frame.w;
    if (h !== frame.h || w !== frame.w) frameSize(h, w);
  }
  if (window.IntersectionObserver) {
    new IntersectionObserver(fitWindow, { threshold: [0, 0.2, 0.4, 0.6, 0.8, 0.9, 0.95, 0.99, 1] })
      .observe(document.documentElement);
  }

  // A frame smaller than the CTI's own size shows all of it, smaller,
  // rather than squashing it and scrolling; never below 80%, where it stops
  // being easy to read (then the list inside scrolls a little).
  function fitZoom() {
    let z = 1;
    if (frame.fullH && !(S.host === "dock" && !dock.open)) {
      z = Math.min(1, window.innerHeight / frame.fullH, window.innerWidth / frame.fullW);
      z = Math.max(0.8, Math.floor(z * 100) / 100);
    }
    document.documentElement.style.zoom = z === 1 ? "" : String(z);
  }
  window.addEventListener("resize", fitZoom);

  // Put away by hand, or by a click anywhere else on the page.
  function dockAway() {
    if (S.host !== "dock" || !dock.open) return;
    dock.minFor = S.call || S.wrap || null;
    dockSize(false);
  }

  function dockRinging() {
    const c = S.call;
    return !!c && c.dir === "in" && !S.sip.active && (c.stage === "incoming" || c.stage === "alert");
  }

  // The minimised bar: who and how long, and the one thing to do now.
  function paintDock() {
    if (S.host !== "dock") return;
    const c = S.call;
    const ringing = dockRinging();
    $("dockDot").dataset.state = $("lineDot").dataset.state || "down";
    const who = c && (c.name || c.number);
    let text = $("lineText").textContent;
    if (c) {
      const when = c.startedAt ? clock((Date.now() - c.startedAt) / 1000) : STAGES[c.stage] || "";
      text = ringing ? `Incoming: ${who}` : `${who} · ${when}`;
    } else if (S.wrap) {
      text = `Disposition · ${S.wrap.name || "last call"}`;
    }
    $("dockText").textContent = text;
    document.body.classList.toggle("ringing-bar", ringing);
    const ctx = S.ctx;
    let act = "";
    let label = "";
    if (c) {
      if (ringing && !c.alert) {
        act = "answer";
        label = "Answer";
      } else if (c.mode === "SIP" && !c.alert && !c.dropped) {
        act = "end";
        label = "End";
      }
    } else if (S.wrap) {
      act = "wrap";
      label = "Disposition";
    } else if (ctx && ctx.number && S.agent && S.agent.enabled) {
      act = "call";
      label = `Call ${ctx.first || "now"}`;
    }
    const btn = $("dockCall");
    btn.hidden = !act;
    btn.dataset.act = act;
    btn.textContent = label;
  }

  function buildKeys(el, onKey) {
    el.replaceChildren(...KEYS.map(([d, l]) =>
      h("button", { type: "button", class: "key", "data-k": d }, h("b", null, d), h("small", null, l))));
    el.addEventListener("click", (e) => {
      const b = e.target.closest(".key");
      if (b) onKey(b.dataset.k);
    });
  }

  function openRecord(module, id) {
    if (!module || !id) return;
    // The Phone tab, and a dock holding a call, have to stay where they are,
    // so records open in another tab.
    if (S.host === "tab" || (S.engine && S.call && S.call.mode === "SIP" && !S.call.alert && !S.call.dropped)) {
      if (S.crmUrl) window.open(`${S.crmUrl}/tab/${module}/${id}`, "exotel_record");
      return;
    }
    ZOHO.CRM.UI.Record.open({ Entity: module, RecordID: id }).catch(() => {});
  }

  /* ---------------- the record ---------------- */

  function contextFrom(module, r) {
    const lead = module === "Leads";
    const name = r.Full_Name || [r.First_Name, r.Last_Name].filter(Boolean).join(" ") || "";
    const company = lead ? r.Company : (r.Account_Name && r.Account_Name.name) || "";
    const title = lead ? r.Designation : r.Title;
    const numbers = [["Mobile", r.Mobile], ["Phone", r.Phone]]
      .filter(([, v]) => v)
      .map(([label, value]) => ({ label, value: String(value) }));
    const status = lead && r.Lead_Status && r.Lead_Status !== "-None-" ? r.Lead_Status : "";
    // What to call them: their first name, never a salutation ("Mr.").
    const first = String(r.First_Name || name.replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, "").split(/\s+/)[0] || "");
    return {
      module, id: String(r.id), name, first, status, numbers,
      org: [title, company].filter(Boolean).join(" · "),
      number: numbers.length ? numbers[0].value : "",
    };
  }

  async function loadRecord(module, id) {
    const resp = await ZOHO.CRM.API.getRecord({ Entity: module, RecordID: id });
    const r = resp && resp.data && resp.data[0];
    return r ? contextFrom(module, r) : null;
  }

  // A Lead or Contact by phone number, if Zoho has one.
  async function findByNumber(num) {
    const local = digits(num).replace(/^\+/, "").slice(-10);
    if (local.length < 6) return null;
    for (const module of ["Leads", "Contacts"]) {
      try {
        const r = await ZOHO.CRM.API.searchRecord({ Entity: module, Type: "phone", Query: local });
        const row = r && r.data && r.data[0];
        if (row) {
          const ctx = contextFrom(module, row);
          const same = ctx.numbers.find((n) => digits(n.value).slice(-10) === local);
          if (same) ctx.number = same.value;
          return ctx;
        }
      } catch (e) {}
    }
    return null;
  }

  function setContext(ctx) {
    S.ctx = ctx || null;
    const c = S.ctx;
    $("contact").hidden = !c;
    $("histRecTab").hidden = !c;
    if (c) {
      $("histRecTab").textContent = c.module === "Contacts" ? "This contact" : "This lead";
      $("cInitials").textContent = initials(c.name);
      $("cName").textContent = c.name || "Unnamed record";
      $("cOrg").textContent = c.org;
      $("cOrg").hidden = !c.org;
      $("cStatus").textContent = c.status;
      $("cStatus").hidden = !c.status;
      const nums = $("cNums");
      if (!c.numbers.length) {
        nums.replaceChildren(h("div", { class: "c-none" }, "No phone number on this record."));
      } else {
        nums.replaceChildren(...c.numbers.map((n) => {
          const b = h("button", { type: "button", class: "num" + (n.value === c.number ? " on" : ""), role: "radio",
            "aria-checked": String(n.value === c.number) }, h("small", null, n.label), h("b", null, n.value), h("i"));
          b.addEventListener("click", () => {
            c.number = n.value;
            for (const x of nums.children) {
              const on = x === b;
              x.classList.toggle("on", on);
              x.setAttribute("aria-checked", String(on));
            }
            updateCallBtn();
          });
          return b;
        }));
      }
    } else if (S.hist.filter === "record") {
      S.hist.filter = "all";
    }
    setPad(!c);
    updateCallBtn();
  }

  function setPad(open) {
    S.padOpen = open;
    $("pad").hidden = !open;
    $("padBtn").classList.toggle("on", open && !!S.ctx);
    if (open && S.ctx) setTimeout(() => $("dialInput").focus(), 0);
  }

  function typed() {
    return digits($("dialInput").value);
  }

  function updateCallBtn() {
    const a = S.agent;
    const t = typed().replace("+", "");
    const useTyped = t.length >= 6 && (S.padOpen || !S.ctx);
    const fromRecord = !!(S.ctx && S.ctx.number) && !(S.padOpen && t.length);
    $("callBtn").disabled = !(a && a.enabled) || !!S.call || !(useTyped || fromRecord);
    $("dialDel").hidden = !$("dialInput").value;
    $("padBtn").style.visibility = S.ctx ? "" : "hidden";
  }

  /* ---------------- placing a call ---------------- */

  function blockedByWrap() {
    if (S.wrap && !S.wrap.later && S.settings.required) {
      show("wrap");
      notice("Save the disposition first.", "warn");
      return true;
    }
    return false;
  }

  async function placeCall() {
    if (S.call || !S.agent || !S.agent.enabled || blockedByWrap()) return;
    const t = typed();
    const useTyped = t.replace("+", "").length >= 6 && (S.padOpen || !S.ctx);
    const number = useTyped ? t : S.ctx && S.ctx.number;
    if (!number) {
      C.sound("error");
      notice(S.ctx ? "This record has no phone number." : "Enter a number.", "warn");
      return;
    }
    const ctx = S.ctx && (!useTyped || digits(S.ctx.number).slice(-10) === t.slice(-10)) ? S.ctx : null;
    startOutbound({ number, name: ctx ? ctx.name : "", org: ctx ? ctx.org : "", module: ctx ? ctx.module : "", id: ctx ? ctx.id : "" });
    if (!ctx) {
      // A typed number may still be a Lead or Contact: show its name.
      const call = S.call;
      findByNumber(number).then((found) => {
        if (found && S.call === call && !call.name) {
          Object.assign(call, { name: found.name, org: found.org, module: found.module, id: found.id });
          paintLive();
        }
      });
    }
  }

  async function startOutbound(t) {
    notice(null);
    if (link.on) return dialOnPhoneTab(t);
    const mode = callWay();
    const call = { sid: null, dir: "out", mode, number: t.number, name: t.name || "", org: t.org || "",
      module: t.module || "", id: t.id || "", stage: null, legs: 0, startedAt: 0, hungUp: false };
    S.call = call;
    $("hangBtn").disabled = false;
    paintLive();
    setStage("agentConnecting");
    C.sound("dial");
    if (mode === "SIP") {
      S.sip.expectUntil = Date.now() + 60000;
      try {
        // Exotel rings this SIP line first, and it is answered at once, which
        // needs the microphone then and there. So the browser asks for it
        // now, on the Call click, not in the middle of that ring (where a
        // first call failed as "busy").
        await askMic();
        await withTimeout(startSip(), 15000, "The SIP line isn't connected.");
      } catch (err) {
        return failCall(call, err.message, true);
      }
    }
    try {
      const r = await api("call", { mode, to: t.number, module: call.module, recordId: call.id });
      if (S.call !== call) return;
      call.sid = r.sid;
      if (r.warning) notice(r.warning, "warn");
      schedulePoll(1500);
    } catch (err) {
      failCall(call, err.message, mode === "SIP");
    }
  }

  function withTimeout(p, ms, message) {
    return Promise.race([p, sleep(ms).then(() => { throw new Error(message); })]);
  }

  function failCall(call, message, offerPhone) {
    if (S.call !== call) return;
    stopTimers();
    S.call = null;
    S.sip.expectUntil = 0;
    S.lastEnd = { status: message, talk: 0 };
    C.sound("error");
    show("dial");
    paintHeader();
    updateCallBtn();
    const phone = offerPhone && S.agent && S.agent.personalNumber && S.agent.mode === "SIP";
    notice(message, "bad", phone ? "Use Number" : null, phone ? () => setMode("Phone") : null);
  }

  function paintLive() {
    const c = S.call;
    if (!c) return;
    $("lInitials").textContent = c.name ? initials(c.name) : "#";
    $("lName").textContent = c.name || c.number || "Unknown number";
    $("lName").disabled = !c.id;
    $("lSub").textContent = c.name ? [c.org, c.number].filter(Boolean).join(" · ") : c.org;
    $("lOpen").hidden = !c.id;
    $("lOpen").textContent = c.module === "Contacts" ? "Open contact" : "Open lead";
    const sip = c.mode === "SIP" && !c.alert;
    const ringing = c.dir === "in" && !S.sip.active && !c.alert && !c.dropped && c.stage !== "onPhone";
    $("ctls").hidden = !(sip && S.sip.active);
    if ($("ctls").hidden) $("dtmf").hidden = true;
    $("kpBtn").classList.toggle("on", !$("dtmf").hidden);
    $("vLive").classList.toggle("pad-open", !$("dtmf").hidden);
    $("answerBtn").hidden = !ringing;
    // Number, or Phone for incoming: the call is on the RM's phone, so it
    // ends there. A dropped browser call has nothing left to end.
    $("hangBtn").hidden = !sip || !!c.dropped;
    $("hangBtn").title = ringing ? "Decline" : "End call";
    $("vLive").classList.toggle("ringing", ringing || (c.alert && c.stage === "alert"));
    $("lTimer").hidden = !c.startedAt;
    paintCtl();
    show("live");
    paintHeader();
  }

  function setStage(stage) {
    const c = S.call;
    if (!c || c.stage === stage) return;
    c.stage = stage;
    paintStage(stage);
    if (stage === "agentConnected") C.sound("agent");
    if (stage === "customerConnected") {
      if (c.dir === "out") C.sound("customer");
      startTimer();
    }
    share();
  }

  function paintStage(stage) {
    $("lState").textContent = STAGES[stage] || "";
    $("lState").dataset.tone = stage === "customerConnected" ? "ok" : "";
  }

  // Moves the stages on as legs answer: 1 = the RM is on, 2 = the customer.
  function advance() {
    const c = S.call;
    if (!c) return;
    if (c.legs >= 2) return setStage("customerConnected");
    if (c.legs >= 1 && c.stage === "agentConnecting") {
      setStage("agentConnected");
      setTimeout(() => {
        if (S.call === c && c.stage === "agentConnected") setStage("customerConnecting");
      }, 900);
    }
  }

  function schedulePoll(ms) {
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    const c = S.call;
    if (!c || !c.sid) return;
    let r = null;
    try {
      r = await api("status", { sid: c.sid });
    } catch (e) {
      // Exotel may not know the call for a second or two; try again.
    }
    if (S.call !== c) return;
    if (r) {
      if (FINAL.has(r.status)) return finish(c, r);
      if (c.alert || c.dir === "in") {
        // Picked up on the phone (or still going after a reload).
        const up = Number(r.talk) > 0 || /in-progress|answered|completed/.test(String(r.leg2 || ""));
        if (up && !c.dropped && c.stage !== "onPhone" && c.stage !== "customerConnected") {
          C.ring.stop();
          setStage("onPhone");
          startTimer();
        }
      } else {
        const leg2Up = /in-progress|answered/.test(String(r.leg2 || ""));
        c.legs = Math.max(c.legs, Number(r.legs) || 0, c.mode === "SIP" && S.sip.active ? 1 : 0, leg2Up ? 2 : 0);
        advance();
      }
    }
    // Once the customer is on a SIP call, the SIP line reports the end.
    if (c.mode === "SIP" && c.stage === "customerConnected") return;
    schedulePoll(c.stage === "customerConnected" ? 3000 : 2000);
  }

  // The SIP line hung up; Exotel has the final status a moment later.
  async function settle(c) {
    clearTimeout(S.pollTimer);
    clearInterval(S.tick);
    if (!c.sid) {
      await sleep(4000);
      if (S.call === c && !c.sid) finish(c, null);
      return;
    }
    for (let i = 0; i < 8 && S.call === c; i++) {
      try {
        const r = await api("status", { sid: c.sid });
        if (FINAL.has(r.status)) return finish(c, r);
      } catch (e) {}
      await sleep(1500);
    }
    if (S.call === c) finish(c, null);
  }

  function finish(c, r) {
    if (S.call !== c) return;
    stopTimers();
    if (S.sip.active) {
      try { S.sip.phone.HangupCall(); } catch (e) {}
    }
    S.call = null;
    S.sip.expectUntil = 0;
    let status;
    let talk;
    if (c.dir === "in" && r && (c.alert || c.recovered)) {
      talk = Number(r.talk) || 0;
      status = talk > 0 || r.leg2 === "completed" ? "Answered" : "Missed call";
    } else if (c.dir === "in") {
      status = c.startedAt ? "Answered" : "Missed call";
      talk = c.startedAt ? (Date.now() - c.startedAt) / 1000 : 0;
    } else if (r) {
      status = outcome(r);
      talk = Number(r.talk) || 0;
    } else {
      status = c.startedAt ? "Answered" : c.sid ? "Customer unanswered" : "Not connected";
      talk = c.startedAt ? (Date.now() - c.startedAt) / 1000 : 0;
    }
    if (!c.hungUp) C.sound("ended");
    S.lastEnd = { status, talk };
    // A call out on the other device switched Exotel's devices for the
    // call; put them back.
    const ag = S.agent;
    const keepOn = ag && ag.sipId && ag.incoming !== "Phone" ? "SIP" : "Phone";
    if (c.dir === "out" && ag && c.mode !== keepOn) api("devices").catch(() => {});
    // A Phone tab opened during this call takes over the line now.
    if (!isEngine() && !link.on) linkSend({ t: "ping" });
    paintHeader();
    // Every call out asks for a disposition (even one nobody picked up);
    // a call in, once answered.
    const reached = c.dir === "in" ? status === "Answered" : true;
    if (c.sid && reached && S.settings.dispositions.length) {
      openWrap({ sid: c.sid, name: c.name || c.number, status, talk });
    } else {
      show("dial");
      updateCallBtn();
      notice(talk && status === "Answered" ? `${status} · ${clock(talk)}` : status, tone(status) === "ok" ? "ok" : "warn");
    }
    if (c.dropped) {
      notice("The call dropped: the connection was lost.", "bad", "Call back",
        () => callBack({ number: c.number, recordId: c.id, module: c.module, name: c.name }));
    }
    loadRecent();
  }

  function startTimer() {
    const c = S.call;
    if (!c) return;
    if (!c.startedAt) c.startedAt = Date.now();
    $("lTimer").hidden = false;
    clearInterval(S.tick);
    const paint = () => {
      if (S.call !== c) return;
      $("lTimer").textContent = clock((Date.now() - c.startedAt) / 1000);
      paintDock();
    };
    paint();
    S.tick = setInterval(paint, 1000);
  }

  function stopTimers() {
    clearInterval(S.tick);
    clearTimeout(S.pollTimer);
    S.tick = S.pollTimer = null;
    C.ring.stop();
  }

  /* ---------------- in-call controls ---------------- */

  function paintCtl() {
    $("muteBtn").classList.toggle("on", S.sip.muted);
    $("muteBtn").querySelector("use").setAttribute("href", S.sip.muted ? "#i-micoff" : "#i-mic");
    $("holdBtn").classList.toggle("on", S.sip.held);
    share();
  }

  // quiet: a mirroring Call button already played the key's tone.
  function sendDtmf(k, quiet) {
    if (!S.sip.active || !/^[0-9*#]$/.test(k)) return;
    if (!quiet) C.sound("dtmf", k);
    $("dtmfEcho").textContent = ($("dtmfEcho").textContent + k).slice(-18);
    if (link.on) return linkSend({ t: "cmd", cmd: "dtmf", args: { k } });
    try { S.sip.phone.SendDTMF(k); } catch (e) {}
  }

  function toggleMute() {
    if (link.on) return linkSend({ t: "cmd", cmd: "mute" });
    if (S.sip.active) S.sip.phone.ToggleMute();
  }

  function toggleHold() {
    if (link.on) return linkSend({ t: "cmd", cmd: "hold" });
    if (S.sip.active) S.sip.phone.ToggleHold();
  }

  function answer() {
    C.ring.stop();
    if (link.on) return linkSend({ t: "cmd", cmd: "answer" });
    try { S.sip.phone.AcceptCall(); } catch (e) {}
  }

  function hangUp() {
    const c = S.call;
    if (!c) return;
    if (c.mirror) {
      if (!(c.dir === "in" && !S.sip.active)) {
        c.hungUp = true;
        $("hangBtn").disabled = true;
      }
      return linkSend({ t: "cmd", cmd: "hangup" });
    }
    if (c.dir === "in" && !S.sip.active) {
      // Declining: Exotel moves on to the next person, not this person's
      // phone. The route is told first that it was on purpose, then the
      // line hangs up (at most 4 s later).
      C.ring.stop();
      S.call = null;
      C.sound("hangup");
      show("dial");
      paintHeader();
      updateCallBtn();
      const drop = () => { try { S.sip.phone.HangupCall(); } catch (e) {} };
      if (c.alert) drop();
      else Promise.race([api("decline").catch(() => {}), sleep(4000)]).then(drop);
      return;
    }
    c.hungUp = true;
    $("hangBtn").disabled = true;
    C.sound("hangup");
    if (S.sip.active) {
      try { S.sip.phone.HangupCall(); } catch (e) {}
    }
    // If the SIP line isn't up yet, it is refused when Exotel rings it, and
    // the poll picks up Exotel's final status.
  }

  /* ---------------- SIP line (browser) ---------------- */

  // Connecting the SIP line needs no microphone; a call does. So this only
  // asks the browser when the answer is already known (allowed or blocked),
  // and otherwise leaves the one question to the first call, which the
  // browser then remembers. Asking at every connect (the dock connects on
  // every page) would keep prompting wherever the choice isn't remembered.
  // The microphone, asked for (if it must be) from a click: once allowed,
  // the browser doesn't ask again.
  let micOk = false;
  async function askMic() {
    if (micOk) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser can't use a microphone here.");
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      micOk = true;
    } catch (err) {
      throw new Error(err && err.name === "NotAllowedError"
        ? "The microphone is blocked. Allow it for Zoho."
        : `The microphone isn't available (${(err && err.name) || "error"}).`);
    }
  }

  async function micCheck() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser can't use a microphone here.");
    }
    let state = "";
    try {
      state = (await navigator.permissions.query({ name: "microphone" })).state;
    } catch (e) {
      // Safari and app web views may not say; then don't ask now either.
      return;
    }
    if (state === "denied") throw new Error("The microphone is blocked. Allow it for Zoho.");
    if (state !== "granted") return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (err) {
      throw new Error(err && err.name === "NotAllowedError"
        ? "The microphone is blocked. Allow it for Zoho."
        : `The microphone isn't available (${(err && err.name) || "error"}).`);
    }
  }

  // Registers the SIP line. Called when the CTI loads (so it is ready before
  // the first call) and again after a drop.
  function startSip(pre) {
    if (S.sip.ready) return Promise.resolve();
    if (S.sip.starting) return S.sip.starting;
    S.sip.wanted = true;
    clearTimeout(S.sip.retryTimer);
    S.sip.retryTimer = null;
    S.sip.starting = (async () => {
      if (!window.ExotelCRMWebSDK) throw new Error("The SIP library didn't load.");
      paintLine();
      if (lineNeeded()) await micCheck();
      const t = pre && pre.token ? pre : await api("sip_token");
      const registered = new Promise((resolve, reject) => {
        S.sip.onRegistered = resolve;
        setTimeout(() => reject(new Error("The SIP line didn't connect.")), 20000);
      });
      if (S.sip.phone) {
        try { S.sip.phone.UnRegisterDevice(); } catch (e) {}
      }
      // The SDK puts the id straight into a URL; encode it so "+" survives.
      const sdk = new window.ExotelCRMWebSDK(t.token, encodeURIComponent(t.userId), true);
      const phone = await sdk.Initialize(onSipCall, onSipRegister, onSipSession);
      if (!phone) throw new Error("Exotel couldn't find your SIP line. Ask your admin to create it again.");
      S.sip.phone = phone;
      await registered;
      // A Phone tab took the line over while this was connecting.
      if (!S.sip.wanted) {
        try { phone.UnRegisterDevice(); } catch (e) {}
        S.sip.ready = false;
      }
    })();
    const p = S.sip.starting;
    p.then(
      () => { S.sip.starting = null; S.sip.retry = 0; paintLine(); },
      () => { S.sip.starting = null; paintLine(); scheduleSipRetry(); }
    );
    return p;
  }

  function scheduleSipRetry() {
    if (!S.sip.wanted || S.sip.retryTimer || S.sip.ready || !lineNeeded()) return;
    const delay = [3, 8, 20, 45, 90][Math.min(S.sip.retry, 4)] * 1000;
    S.sip.retry++;
    S.sip.retryTimer = setTimeout(() => {
      S.sip.retryTimer = null;
      startSip().catch(() => {});
    }, delay);
    paintLine();
  }

  function stopSip() {
    S.sip.wanted = false;
    clearTimeout(S.sip.retryTimer);
    S.sip.retryTimer = null;
    if (S.sip.phone) {
      try { S.sip.phone.UnRegisterDevice(); } catch (e) {}
    }
    S.sip.ready = false;
    paintLine();
  }

  function sipFailed(err) {
    const phone = S.agent && S.agent.personalNumber;
    notice(err.message, "bad", phone ? "Use Number" : null, phone ? () => setMode("Phone") : null);
  }

  function onSipRegister(state) {
    const st = String(state || "");
    if (st === "registered") {
      S.sip.ready = true;
      S.sip.retry = 0;
      if (S.sip.onRegistered) S.sip.onRegistered();
    } else if (/unregistered|terminated|failed|disconnect/i.test(st)) {
      const was = S.sip.ready;
      S.sip.ready = false;
      if (was && !S.sip.active) scheduleSipRetry();
    }
    paintLine();
  }

  function onSipSession(state) {
    if (String(state || "").indexOf("permission_denied") !== -1) {
      notice("The microphone is blocked. Allow it for Zoho.", "bad");
    }
  }

  function onSipCall(type, data) {
    switch (type) {
      case "incoming": return onIncoming(data);
      case "connected": {
        S.sip.active = true;
        C.ring.stop();
        const c = S.call;
        if (!c) break;
        if (c.dir === "in") {
          setStage("customerConnected");
        } else {
          c.legs = Math.max(c.legs, 1);
          advance();
          if (c.sid) schedulePoll(1500);
        }
        paintLive();
        break;
      }
      case "callEnded": {
        C.ring.stop();
        const was = S.sip.active;
        S.sip.active = false;
        S.sip.muted = S.sip.held = false;
        const c = S.call;
        if (!c) break;
        // The alert to Zoho was turned down; the call goes on to the phone.
        if (c.alert) break;
        if (!navigator.onLine) c.dropped = true;
        if (c.dir === "in") {
          if (c.startedAt) {
            finish(c, null);
          } else {
            S.call = null;
            C.sound("ended");
            show("dial");
            paintHeader();
            updateCallBtn();
            const who = c.name || c.number;
            notice(who ? `Missed call from ${who}` : "Missed call", "warn");
            loadRecent();
          }
        } else if (was || c.sid) {
          settle(c);
        }
        break;
      }
      case "mutetoggle":
        S.sip.muted = !S.sip.muted;
        C.sound(S.sip.muted ? "mute" : "unmute");
        paintCtl();
        break;
      case "holdtoggle":
        S.sip.held = !S.sip.held;
        C.sound(S.sip.held ? "hold" : "unhold");
        paintCtl();
        break;
      default:
        break;
    }
  }

  function onIncoming(data) {
    const c0 = S.call;
    // Exotel ringing the SIP line for a call placed here: pick up at once.
    if (c0 && c0.dir === "out" && c0.mode === "SIP" && !S.sip.active && Date.now() < S.sip.expectUntil) {
      S.sip.expectUntil = 0;
      try {
        if (c0.hungUp) S.sip.phone.HangupCall();
        else S.sip.phone.AcceptCall();
      } catch (e) {}
      return;
    }
    // Already on a call: leave it; Exotel moves on when this one isn't answered.
    if (c0) return;
    const num = String((data && (data.callFromNumber || data.remoteId || data.remoteDisplayName)) || "");
    // Calls on Number: Exotel rang the SIP line only so Zoho shows who is
    // calling. Show it, turn the line down at once so the phone rings
    // straight away, and follow the call there.
    const call = { sid: null, dir: "in", mode: "SIP", alert: false, number: num, name: "", org: "",
      module: "", id: "", stage: null, legs: 0, startedAt: 0, hungUp: false };
    S.call = call;
    $("hangBtn").disabled = false;
    notice(null);
    paintLive();
    setStage("incoming");
    C.ring.start();
    stillHere(call);
    identifyIncoming(call);
  }

  // Who is calling: cti_route noted the caller and the CallSid when it sent
  // the call here; failing that, the number Exotel showed the SIP line.
  async function identifyIncoming(call) {
    let routed = null;
    try { routed = await api("incoming"); } catch (e) {}
    if (S.call !== call) return;
    if (routed && routed.sid) {
      call.sid = routed.sid;
      if (routed.from) call.number = routed.from;
    }
    let ctx = null;
    if (routed && routed.module && routed.recordId) {
      try { ctx = await loadRecord(routed.module, routed.recordId); } catch (e) {}
    }
    if (!ctx && call.number) ctx = await findByNumber(call.number);
    if (S.call !== call) return;
    if (ctx) Object.assign(call, { name: ctx.name, org: ctx.org, module: ctx.module, id: ctx.id });
    paintLive();
    if (call.alert && call.sid) schedulePoll(2000);
  }

  // The SDK plays ringtones through audio elements. The CTI plays its own
  // cues, and an outbound call's line is answered without ringing, so only
  // the call's audio (a MediaStream) and the CTI's own players may play.
  // If the browser blocks the call's audio, the next tap starts it.
  (function guardSound() {
    const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (!proto || proto.__ctiPatched) return;
    const orig = proto.play;
    const blocked = new Set();
    const resume = () => {
      if (!blocked.size) return;
      const nodes = [...blocked];
      blocked.clear();
      nodes.forEach((n) => n.play().catch(() => {}));
      notice(null);
    };
    proto.play = function () {
      if (!this.srcObject && !(this.dataset && this.dataset.cti)) return Promise.resolve();
      const p = orig.apply(this, arguments);
      if (p && p.catch && this.srcObject) {
        p.catch((err) => {
          if (err && err.name === "NotAllowedError") {
            blocked.add(this);
            notice("Sound is blocked.", "bad", "Turn on sound", resume);
          }
        });
      }
      return p;
    };
    proto.__ctiPatched = true;
    ["pointerdown", "keydown"].forEach((t) => document.addEventListener(t, resume, true));
  })();

  /* ---------------- status and mode ---------------- */

  // Keeps the SIP line up exactly when it is needed (see sipWanted).
  function syncSip() {
    if (link.on || S.released) return;
    if (lineNeeded() && (S.host !== "dock" || isEngine())) startSip().catch(sipFailed);
    else if (!lineNeeded()) stopSip();
  }

  // mode: how calls go out ("SIP" or "Phone", shown as Number).
  // incoming: where incoming calls ring ("Desktop" or "Phone").
  async function setChoice(key, value) {
    const a = S.agent;
    if (!a || S.call || a[key] === value) return paintHeader();
    const prev = a[key];
    a[key] = value;
    paintHeader();
    // The Phone tab owns the line; it switches and tells this page.
    if (link.on) return linkSend({ t: "cmd", cmd: key, args: { [key]: value } });
    syncSip();
    try {
      const r = await api(key === "mode" ? "set_mode" : "set_incoming", { [key]: value });
      notice(r.warning || null, "warn");
      if (lineNeeded()) await micCheck().catch((e) => notice(e.message, "bad"));
    } catch (err) {
      a[key] = prev;
      syncSip();
      paintHeader();
      notice(err.message, "bad");
    }
  }

  const setMode = (mode) => setChoice("mode", mode);
  const setIncoming = (incoming) => setChoice("incoming", incoming);

  /* ---------------- wrap-up (disposition) ---------------- */

  function chip(text, on, onClick) {
    const b = h("button", { type: "button", class: "chip" + (on ? " on" : ""), "aria-pressed": String(on) }, text);
    b.addEventListener("click", onClick);
    return b;
  }

  function openWrap(w) {
    S.wrap = Object.assign({ d1: "", d2: "", note: "" }, w);
    $("wName").textContent = w.name || "Call";
    $("wStatus").textContent = w.status || "";
    $("wStatus").dataset.tone = tone(w.status);
    $("wStatus").hidden = !w.status;
    $("wDur").textContent = w.talk && w.status === "Answered" ? clock(w.talk) : "";
    $("dNote").value = S.wrap.note || "";
    $("dSkip").hidden = S.settings.required && !w.later;
    $("dSkip").textContent = w.later ? "Cancel" : "Skip";
    $("dMsg").textContent = "";
    $("dMsg").className = "form-msg";
    paintChips();
    show("wrap");
  }

  function paintChips() {
    const w = S.wrap;
    const list = S.settings.dispositions;
    $("d1").replaceChildren(...list.map((d) => chip(d.name, w.d1 === d.name, () => {
      w.d1 = d.name;
      w.d2 = "";
      paintChips();
    })));
    const cur = list.find((d) => d.name === w.d1);
    const subs = S.settings.twoLevels && cur ? cur.subs : [];
    $("d2Wrap").hidden = !subs.length;
    $("d2").replaceChildren(...subs.map((s) => chip(s, w.d2 === s, () => {
      w.d2 = s;
      paintChips();
    })));
    $("dSave").disabled = !w.d1 || (subs.length > 0 && !subs.includes(w.d2));
  }

  async function saveWrap() {
    const w = S.wrap;
    if (!w) return;
    $("dSave").disabled = true;
    $("dMsg").textContent = "";
    try {
      const r = await api("dispose", { sid: w.sid, disposition: w.d1, sub: S.settings.twoLevels ? w.d2 : "", note: $("dNote").value.trim() });
      S.wrap = null;
      if (w.remote) linkSend({ t: "cmd", cmd: "wrapDone", args: { sid: w.sid } });
      notice(r.warning || null, "warn");
      if (w.later) showHistory();
      else show("dial");
      updateCallBtn();
      loadRecent();
    } catch (err) {
      $("dMsg").textContent = err.message;
      $("dSave").disabled = false;
    }
  }

  function closeWrap() {
    const w = S.wrap;
    S.wrap = null;
    if (w && w.remote) linkSend({ t: "cmd", cmd: "wrapDone", args: { sid: w.sid } });
    if (w && w.later) showHistory();
    else show("dial");
    updateCallBtn();
  }

  /* ---------------- history ---------------- */

  const isMissed = (c) => c.type === "Missed" || /missed|no one|hung up/i.test(c.status || "");

  function histRow(c, opts) {
    const dir = c.type === "Outbound" ? "out" : "in";
    const status = c.status || (c.type === "Missed" ? "Missed call" : "");
    const t = status ? tone(status) : "ok";
    const ic = dir === "in" && t !== "ok" ? "i-miss" : dir === "out" ? "i-out" : "i-in";
    const title = c.name || c.number || c.subject || "Unknown";
    const meta = [status || (dir === "out" ? "Outgoing" : "Incoming"), c.disposition].filter(Boolean).join(" · ");
    const secs = seconds(c.duration);
    const todo = !c.disposition && c.mine;
    const row = h("button", { type: "button", class: "h-row", "aria-expanded": "false" },
      h("span", { class: "h-ic", "data-tone": t, "data-dir": dir }, icon(ic)),
      h("span", { class: "h-main" },
        h("div", { class: "h-name", "data-tone": dir === "in" && t === "bad" ? "bad" : null }, title,
          todo ? h("span", { class: "h-todo", title: "No disposition" }) : null),
        h("div", { class: "h-meta" }, meta)),
      h("span", { class: "h-side" }, h("div", null, when(c.start)), h("div", { class: "h-dur" }, t === "ok" && secs ? clock(secs) : "")));
    const li = h("li", null, row);
    row.addEventListener("click", () => {
      const open = li.querySelector(".h-detail");
      row.setAttribute("aria-expanded", String(!open));
      if (open) open.remove();
      else li.append(histDetail(c, opts || {}));
    });
    return li;
  }

  function actBtn(iconId, text, onClick) {
    const b = h("button", { type: "button", class: "btn" }, icon(iconId), text);
    b.addEventListener("click", onClick);
    return b;
  }

  function histDetail(c, opts) {
    const dl = h("dl");
    const add = (k, v) => { if (v) dl.append(h("dt", null, k), h("dd", null, v)); };
    const status = c.status || c.type;
    const secs = seconds(c.duration);
    add("Number", c.number);
    add("Status", status);
    add("Disposition", [c.disposition, c.sub].filter(Boolean).join(" › "));
    add("Note", c.note);
    add("Talk time", tone(status) === "ok" && secs ? clock(secs) : "");
    add("When", fullWhen(c.start));
    add("Caller ID", c.callerId);
    if (opts.showOwner) add("Agent", c.owner);
    const acts = h("div", { class: "h-acts" });
    const box = h("div", { class: "h-detail" }, dl, acts);
    const rec = recordingFrom(c.description);
    if (rec && c.sid) acts.append(actBtn("i-play", "Recording", () => playRecording(c, box)));
    if (c.recordId) {
      acts.append(actBtn("i-open", c.module === "Contacts" ? "Open contact" : "Open lead",
        () => openRecord(c.module || "Leads", c.recordId)));
    }
    if (c.number || c.recordId) acts.append(actBtn("i-phone", "Call back", () => callBack(c)));
    if (c.mine && c.sid) {
      acts.append(actBtn("i-tag", c.disposition ? "Change disposition" : "Add disposition", () => openWrap({
        sid: c.sid, name: c.name || c.number, status, talk: secs, later: true,
        d1: c.disposition, d2: c.sub, note: c.note,
      })));
    }
    return box;
  }

  // Exotel's recordings need the account's key, so cti_api fetches the file
  // and it plays from memory, right here. Each is fetched once per page.
  const recordings = new Map();
  async function playRecording(c, box) {
    const open = box.querySelector("audio, .rec-msg");
    if (open) {
      open.remove();
      return;
    }
    const msg = h("div", { class: "rec-msg" }, "Loading the recording…");
    box.append(msg);
    try {
      let url = recordings.get(c.sid);
      if (!url) {
        const r = await api("recording", { sid: c.sid });
        const bytes = Uint8Array.from(atob(r.data || ""), (ch) => ch.charCodeAt(0));
        if (!bytes.length) throw new Error("The recording is empty.");
        url = URL.createObjectURL(new Blob([bytes], { type: r.type || "audio/mpeg" }));
        recordings.set(c.sid, url);
      }
      const audio = h("audio", { controls: true, src: url, "data-cti": "1" });
      msg.replaceWith(audio);
      audio.play().catch(() => {});
    } catch (err) {
      msg.textContent = err.message;
    }
  }

  async function callBack(c) {
    if (S.call || !S.agent || !S.agent.enabled || blockedByWrap()) return;
    let ctx = null;
    if (c.recordId) {
      try { ctx = await loadRecord(c.module || "Leads", c.recordId); } catch (e) {}
    }
    if (ctx) setContext(ctx);
    const number = c.number || (ctx && ctx.number);
    if (!number) return notice("No number to call.", "warn");
    show("dial");
    startOutbound({ number, name: ctx ? ctx.name : c.name, org: ctx ? ctx.org : "", module: ctx ? ctx.module : "", id: ctx ? ctx.id : "" });
  }

  function setHistFilter(f) {
    if (f === "record" && !S.ctx) f = "all";
    S.hist.filter = f;
    for (const b of $("histTabs").querySelectorAll("button")) b.classList.toggle("on", b.dataset.f === f);
    // An admin sees everyone's calls, or one person's; an RM, their own.
    $("fAgent").hidden = !S.isAdmin || f === "record";
  }

  function showHistory(filter) {
    setHistFilter(filter || S.hist.filter);
    fillDispositions();
    show("hist");
    return loadHistory();
  }

  function fillDispositions() {
    const sel = $("fDisp");
    if (sel.options.length > 1) return;
    for (const d of S.settings.dispositions) sel.append(h("option", { value: d.name }, d.name));
  }

  function fillPeople(people) {
    S.hist.people = people;
    const sel = $("fAgent");
    const keep = sel.value;
    sel.replaceChildren(h("option", { value: "" }, "Everyone"), h("option", { value: "me" }, "My calls"),
      ...people.map((p) => h("option", { value: p.id }, p.name)));
    sel.value = keep;
  }

  // yyyy-MM-dd, n days ago (0 = today).
  function dayOffset(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  let histSeq = 0;
  async function loadHistory(more) {
    const seq = ++histSeq;
    const list = $("histList");
    const f = S.hist.filter;
    const H = S.hist;
    if (!more) {
      list.replaceChildren(h("li", { class: "empty" }, "Loading…"));
      H.next = 0;
    }
    $("histMore").hidden = true;
    const args = { limit: 50, page: more ? H.next : 1, dir: H.dir, disposition: H.disp, q: H.q };
    if (H.since !== "") args.since = dayOffset(Number(H.since));
    if (f === "record" && S.ctx) args.recordId = S.ctx.id;
    else if (S.isAdmin) args.agent = H.agent;
    if (f === "missed" || f === "todo") args.kind = f;
    if (S.isAdmin && !H.people) args.people = true;
    try {
      const r = await api("history", args);
      if (seq !== histSeq) return;
      if (r.people) fillPeople(r.people);
      const showOwner = f === "record" || (S.isAdmin && H.agent !== "me");
      const rows = (r.calls || []).map((c) => histRow(c, { showOwner }));
      if (more) {
        list.append(...rows);
      } else {
        const filtered = H.dir || H.since || H.disp || H.q || (S.isAdmin && H.agent);
        const none = { missed: "No missed calls.", todo: "Every call has a disposition." }[f] || (filtered ? "No calls match." : "No calls yet.");
        list.replaceChildren(...(rows.length ? rows : [h("li", { class: "empty" }, none)]));
      }
      H.next = r.next || 0;
      $("histMore").hidden = !H.next;
    } catch (err) {
      if (seq !== histSeq) return;
      if (more) notice(err.message, "bad");
      else list.replaceChildren(h("li", { class: "empty" }, err.message));
    }
  }

  // The last few calls, under the dialer: with this record, or the RM's own.
  let recentSeq = 0;
  async function loadRecent() {
    if (!S.agent || HISTORY_ONLY) return;
    const seq = ++recentSeq;
    const ctx = S.ctx;
    try {
      const r = await api("history", ctx ? { recordId: ctx.id, limit: 3 } : { agent: "me", limit: 4 });
      if (seq !== recentSeq) return;
      const calls = r.calls || [];
      $("recent").hidden = !calls.length;
      const first = ctx && ctx.first;
      $("recentTitle").textContent = ctx ? `Calls with ${first || "this record"}` : "Recent calls";
      $("recentList").replaceChildren(...calls.map((c) => histRow(c, { showOwner: !!ctx })));
    } catch (e) {
      if (seq === recentSeq) $("recent").hidden = true;
    }
  }

  /* ---------------- wiring ---------------- */

  buildKeys($("keys"), (k) => {
    C.sound("dtmf", k);
    const input = $("dialInput");
    input.value += k;
    updateCallBtn();
  });
  buildKeys($("dtmfKeys"), sendDtmf);

  $("dialInput").addEventListener("input", updateCallBtn);
  $("dialInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("callBtn").disabled) placeCall();
  });
  $("dialDel").addEventListener("click", () => {
    const input = $("dialInput");
    input.value = input.value.slice(0, -1);
    updateCallBtn();
  });
  $("padBtn").addEventListener("click", () => {
    setPad(!S.padOpen);
    updateCallBtn();
  });
  $("callBtn").addEventListener("click", placeCall);
  $("histBtn").addEventListener("click", () => showHistory(S.ctx ? "record" : "all"));
  $("recentAll").addEventListener("click", () => showHistory(S.ctx ? "record" : "all"));
  $("cName").addEventListener("click", () => S.ctx && openRecord(S.ctx.module, S.ctx.id));
  $("lName").addEventListener("click", () => S.call && openRecord(S.call.module, S.call.id));
  $("lOpen").addEventListener("click", () => S.call && openRecord(S.call.module, S.call.id));
  $("dockOpen").addEventListener("click", () => dockSize(true));
  $("dockMin").addEventListener("click", dockAway);
  $("dockText").addEventListener("click", () => dockSize(true));
  $("dockCall").addEventListener("click", () => {
    const act = $("dockCall").dataset.act;
    if (act === "answer") return answer();
    if (act === "end") return hangUp();
    dockSize(true);
    if (act === "call") placeCall();
  });
  // A click anywhere else on the Zoho page puts the dock away, except while
  // a call is ringing.
  window.addEventListener("blur", () => {
    if (!dockRinging()) dockAway();
  });

  $("answerBtn").addEventListener("click", () => {
    const c = S.call;
    answer();
    // The screen pop: in the Phone tab, the caller's record opens in a tab
    // of its own (a browser only allows that on a click).
    if (S.host === "tab" && c && c.id) openRecord(c.module, c.id);
  });
  $("hangBtn").addEventListener("click", hangUp);
  $("muteBtn").addEventListener("click", toggleMute);
  $("holdBtn").addEventListener("click", toggleHold);
  // Reconnect the SIP line, here or on the page holding it.
  $("lineFix").addEventListener("click", () => {
    if (link.on) return linkSend({ t: "cmd", cmd: "reconnect" });
    S.sip.retry = 0;
    clearTimeout(S.sip.retryTimer);
    S.sip.retryTimer = null;
    notice(null);
    startSip().catch(sipFailed);
  });
  $("phoneLink").addEventListener("click", () => {
    if (S.phoneUrl) window.open(S.phoneUrl, "exotel_phone");
  });
  $("kpBtn").addEventListener("click", () => {
    $("dtmf").hidden = !$("dtmf").hidden;
    $("kpBtn").classList.toggle("on", !$("dtmf").hidden);
    $("vLive").classList.toggle("pad-open", !$("dtmf").hidden);
  });

  $("dSave").addEventListener("click", saveWrap);
  $("dSkip").addEventListener("click", closeWrap);

  $("histBack").addEventListener("click", () => show(S.call ? "live" : S.wrap ? "wrap" : "dial"));
  $("histRefresh").addEventListener("click", () => loadHistory());
  $("histTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    setHistFilter(b.dataset.f);
    loadHistory();
  });
  // Filters: each change reloads; typing waits for a pause.
  for (const [id, key] of [["fAgent", "agent"], ["fDir", "dir"], ["fSince", "since"], ["fDisp", "disp"]]) {
    $(id).addEventListener("change", () => {
      S.hist[key] = $(id).value;
      loadHistory();
    });
  }
  let searchTimer = null;
  $("fSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      S.hist.q = $("fSearch").value.trim();
      loadHistory();
    }, 400);
  });
  $("histMore").addEventListener("click", () => loadHistory(true));

  $("inSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b && !b.disabled) setIncoming(b.dataset.v);
  });
  $("setBtn").addEventListener("click", () => { if (!S.call) show(S.view === "set" ? "dial" : "set"); });
  $("setBack").addEventListener("click", () => show("dial"));
  $("outSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b && !b.disabled) setMode(b.dataset.v);
  });
  document.addEventListener("keydown", (e) => {
    const typing = e.target && e.target.closest && e.target.closest("input, textarea, select");
    if (S.view === "live" && S.sip.active && !typing && /^[0-9*#]$/.test(e.key)) sendDtmf(e.key);
  });

  window.addEventListener("offline", () => {
    const c = S.call;
    notice(c && c.mode === "SIP" && !c.alert
      ? "No internet. This call may drop."
      : "No internet. A call on your phone carries on.", "bad");
  });
  window.addEventListener("online", () => {
    notice(null);
    if (S.sip.wanted && !S.sip.ready) startSip().catch(() => {});
    // Catch up with the call: Exotel knows how it went meanwhile.
    if (S.call && S.call.sid && !S.call.mirror) schedulePoll(500);
  });
  window.addEventListener("pagehide", () => {
    if (isEngine()) linkSend({ t: "bye" });
    if (S.sip.phone) {
      try { S.sip.phone.UnRegisterDevice(); } catch (e) {}
    }
  });

  /* Settings changed elsewhere (another computer, the Zoho app, an admin)
     reach an open CTI too: the page holding the line reads them again when
     it comes back into view, and every 2 minutes. Pages that mirror it get
     them from it. */
  let agentReadAt = Date.now();
  async function refreshAgent(force) {
    if (!S.user || !S.agent || S.call || S.released || link.on) return;
    if (!force && Date.now() - agentReadAt < 30000) return;
    agentReadAt = Date.now();
    let me;
    try { me = await api("me"); } catch (e) { return; }
    const a = me.agent;
    if (!a || S.call || link.on) return;
    const keys = ["enabled", "mode", "incoming", "personalNumber", "callerId", "sipId"];
    if (keys.every((k) => a[k] === S.agent[k])) return;
    S.agent = a;
    if (S.host === "dock" && !a.enabled) return closeDock();
    notice(a.enabled ? null : "Calling isn't on for you yet. Ask your admin.", "warn");
    paintHeader();
    if (isEngine() || S.host === "button") {
      if (lineNeeded()) startSip().catch(sipFailed);
      else stopSip();
    }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAgent(); });
  window.addEventListener("focus", () => refreshAgent());
  setInterval(() => refreshAgent(true), 2 * 60 * 1000);

  // Closes the flyout the dock lives in (Zoho's Client Script opens it).
  function closeDock() {
    S.released = true;
    stopSip();
    document.body.hidden = true;
    try { if (window.$Client && $Client.close) $Client.close(); } catch (e) {}
  }

  // A call is ringing this page's SIP line, but the person may have picked
  // the other device since this page last read their settings. If so, the
  // page lets the call go: it stops ringing, turns the call down (Exotel
  // then rings their phone) and gives up its line.
  async function stillHere(call) {
    if (Date.now() - agentReadAt < 15000) return;
    agentReadAt = Date.now();
    let me;
    try { me = await withTimeout(api("me"), 4000, "slow"); } catch (e) { return; }
    if (!me || !me.agent) return;
    S.agent = me.agent;
    paintHeader();
    if (onThisDevice()) return;
    if (S.call === call && !call.startedAt && !S.sip.active) {
      C.ring.stop();
      try { S.sip.phone.HangupCall(); } catch (e) {}
      S.call = null;
      show("dial");
      updateCallBtn();
      if (S.host === "dock") dockSize(false);
    }
    stopSip();
  }

  /* ---------------- carrying a call over ----------------
     Power, internet or a page change can take this page away mid-call. The
     page holding the line keeps the call (and a disposition still owed) in
     the browser, and the next one to hold it picks it up: a call on the
     phone carries on and is followed again; a browser call that dropped is
     shown as dropped, with Call back; either way the disposition follows. */

  const SAVE_CALL = "cti.call";
  const SAVE_WRAP = "cti.wrap";

  function persist() {
    if (!S.recoverDone || !(isEngine() || (S.host === "button" && !link.on))) return;
    const c = S.call;
    if (c && !c.mirror && c.sid) {
      C.store(SAVE_CALL, JSON.stringify({ sid: c.sid, dir: c.dir, mode: c.mode, alert: !!c.alert, number: c.number,
        name: c.name, org: c.org, module: c.module, id: c.id, stage: c.stage, startedAt: c.startedAt, at: Date.now() }));
    } else if (!c) {
      C.store(SAVE_CALL, "");
    }
    const w = S.wrap;
    if (w && !w.later && !w.remote) {
      C.store(SAVE_WRAP, JSON.stringify({ sid: w.sid, name: w.name, status: w.status, talk: w.talk }));
    } else if (!w) {
      C.store(SAVE_WRAP, "");
    }
  }

  function saved(key) {
    try { return JSON.parse(C.store(key) || "null"); } catch (e) { return null; }
  }

  // Exotel rings whichever device is ON there. The page holding the line
  // makes Exotel match the CTI's status and choices each time it starts, in
  // case a toggle was flipped in Exotel's own dashboard.
  function syncDevices() {
    if (!S.agent || !S.agent.enabled) return;
    api("devices").then((r) => { if (r && r.warning) notice(r.warning, "warn"); }).catch(() => {});
  }

  function recover() {
    if (S.recoverDone) return;
    S.recoverDone = true;
    const w = saved(SAVE_WRAP);
    const c = saved(SAVE_CALL);
    if (w && w.sid && !S.wrap && !S.call && S.settings.dispositions.length) openWrap(w);
    if (!c || !c.sid || S.call || Date.now() - (c.at || 0) > 3 * 3600 * 1000) {
      syncDevices();
      return persist();
    }
    const call = Object.assign({ legs: 0, hungUp: false }, c, { recovered: true });
    // A browser call can't outlive its page; one on the phone carries on.
    call.dropped = c.mode === "SIP" && !c.alert;
    S.call = call;
    paintLive();
    paintStage(call.dropped ? "dropped" : call.stage);
    if (call.startedAt && !call.dropped) startTimer();
    schedulePoll(800);
  }

  /* ---------------- the Phone tab and the Call button ----------------
     The Phone tab registers the SIP line once and keeps it. A Call button
     (or Call history) opened while it is open registers no line of its own:
     its calls go through the Phone tab, and it mirrors them (status, timer,
     controls, disposition). They are different Zoho widgets, so they meet on
     a BroadcastChannel in the Call button widget's origin; a page of any
     other widget joins it through that widget's bridge.html.

     Phone tab to buttons: here (to a ping), state (on each change and every
     15 s), refused, bye. Buttons to the Phone tab: ping, and cmd (dial,
     hangup, answer, mute, hold, dtmf, mode, status, wrapDone). Each message
     carries the Zoho user's email, so two people in one browser never mix. */

  function linkSend(msg) {
    const m = Object.assign({ u: S.user }, msg);
    try {
      if (link.bc) link.bc.postMessage(m);
      else if (link.frame && link.frame.contentWindow) link.frame.contentWindow.postMessage({ ctiLink: m }, "*");
    } catch (e) {}
  }

  // The Call button widget's own pages open the channel themselves; other
  // pages load its bridge.html. Until "me" says where that widget lives, a
  // Call button takes itself to be it.
  function linkOpen() {
    let origin = "";
    try { origin = S.appUrl ? new URL(S.appUrl).origin : ""; } catch (e) {}
    if (origin ? origin === location.origin : S.host !== "tab") {
      if (!link.bc && window.BroadcastChannel) {
        link.bc = new BroadcastChannel(CHANNEL);
        link.bc.onmessage = (e) => onLink(e.data);
      }
      return;
    }
    if (link.bc) {
      link.bc.close();
      link.bc = null;
    }
    if (origin && !link.frame) {
      link.frame = h("iframe", { src: S.appUrl.replace(/\/+$/, "") + "/bridge.html", title: "Phone link", hidden: true });
      document.body.append(link.frame);
    }
  }

  window.addEventListener("message", (e) => {
    const m = link.frame && e.source === link.frame.contentWindow && e.data && e.data.ctiLink;
    if (m) onLink(m);
  });

  function onLink(m) {
    if (!m || typeof m !== "object" || !m.t) return;
    if (m.t === "bridge") {
      if (isEngine()) phoneSay("here");
      else linkSend({ t: "ping" });
      return;
    }
    if (isEngine()) onPhoneLink(m);
    else onButtonLink(m);
  }

  // ---- the Phone tab's side ----

  function snapshot() {
    const c = S.call;
    const w = S.wrap && !S.wrap.later ? S.wrap : null;
    return {
      agent: S.agent,
      line: { state: $("lineDot").dataset.state || "down", text: $("lineText").textContent },
      sip: { active: S.sip.active, muted: S.sip.muted, held: S.sip.held },
      call: c ? { dir: c.dir, mode: c.mode, alert: !!c.alert, dropped: !!c.dropped, number: c.number, name: c.name,
        org: c.org, module: c.module, id: c.id, stage: c.stage, startedAt: c.startedAt, sid: c.sid } : null,
      wrap: w ? { sid: w.sid, name: w.name, status: w.status, talk: w.talk } : null,
      ended: S.lastEnd,
    };
  }

  function phoneSay(t) {
    if (isEngine() && S.user && !S.released) linkSend({ t, role: S.host, pid: pageId, snap: snapshot() });
  }

  // Tells open Call buttons what the Phone tab shows, once per change.
  let shareQueued = false;
  function share() {
    if (!isEngine() || shareQueued) return;
    shareQueued = true;
    Promise.resolve().then(() => {
      shareQueued = false;
      phoneSay("state");
    });
  }

  function onPhoneLink(m) {
    if (!S.user || S.released || (m.u && m.u !== S.user)) return;
    // Another page holds the line too. A Phone tab always keeps it; of two
    // docks, one steps back. Never in the middle of a call.
    if ((m.t === "here" || m.t === "state") && m.pid && m.pid !== pageId) {
      // The better line wins (ready, then connecting, then down); between
      // equals, the Phone tab, then the older page.
      const rank = { ready: 2, wait: 1 };
      const theirs = rank[m.snap && m.snap.line && m.snap.line.state] || 0;
      const mine = rank[$("lineDot").dataset.state] || 0;
      const giveWay = theirs > mine || (theirs === mine && (m.role === "tab" || m.pid < pageId));
      if (S.host === "dock" && !S.call && giveWay) {
        S.engine = false;
        stopSip();
        onButtonLink(m);
      }
      return;
    }
    if (m.t === "ping") return phoneSay("here");
    if (m.t !== "cmd") return;
    const a = m.args || {};
    switch (m.cmd) {
      case "dial": {
        let why = "";
        if (S.call) why = "Finish the current call first.";
        else if (!S.agent || !S.agent.enabled) why = "Calling isn't on for you yet. Ask your admin.";
        else if (blockedByWrap()) why = "Save the disposition first.";
        if (why) return linkSend({ t: "refused", why });
        show("dial");
        startOutbound({ number: String(a.number || ""), name: a.name || "", org: a.org || "", module: a.module || "", id: a.id || "" });
        return;
      }
      case "hangup": return hangUp();
      case "reconnect":
        S.sip.retry = 0;
        clearTimeout(S.sip.retryTimer);
        S.sip.retryTimer = null;
        return startSip().catch(sipFailed);
      case "answer": return answer();
      case "mute": return toggleMute();
      case "hold": return toggleHold();
      case "dtmf": return sendDtmf(String(a.k || ""), true);
      case "mode": return setMode(a.mode === "SIP" ? "SIP" : "Phone");
      case "incoming": return setIncoming(a.incoming === "Desktop" ? "Desktop" : "Phone");
      case "wrapDone":
        if (S.wrap && !S.wrap.later && S.wrap.sid === a.sid) {
          closeWrap();
          loadRecent();
        }
        return;
      default:
    }
  }

  // One Phone tab holds the line; a second one offers to take it over.
  const tabId = Math.random().toString(36).slice(2);
  let tabs = null;

  async function claimLine() {
    if (!window.BroadcastChannel) return true;
    let taken = false;
    tabs = new BroadcastChannel("exotel-phone-tab");
    tabs.onmessage = (e) => {
      const m = e.data || {};
      if (m.u !== S.user || m.id === tabId) return;
      if (m.t === "hello" && !S.released) tabs.postMessage({ t: "taken", u: S.user, id: tabId });
      else if (m.t === "taken") taken = true;
      else if (m.t === "release" && !S.released && !S.call) giveLine();
    };
    tabs.postMessage({ t: "hello", u: S.user, id: tabId });
    await sleep(400);
    return !taken;
  }

  function giveLine() {
    S.released = true;
    stopSip();
    notice("The phone moved to another tab.", "warn", "Use this tab", takeLine);
  }

  function takeLine() {
    if (tabs) tabs.postMessage({ t: "release", u: S.user, id: tabId });
    S.released = false;
    notice(null);
    if (sipWanted()) startSip().catch(sipFailed);
    phoneSay("here");
  }

  async function startPhoneTab(me) {
    setInterval(() => phoneSay("state"), 15000);
    if (!(await claimLine())) {
      S.released = true;
      notice("The phone is open in another tab.", "warn", "Use this tab", takeLine);
      return;
    }
    if (sipWanted()) startSip(me.sip).catch(sipFailed);
    recover();
    phoneSay("here");
    // A browser keeps a page silent until it is clicked once, ringing too.
    if (!C.soundOn()) notice("Click once so calls can ring here.", "warn", "Turn on sound", () => C.sound("unhold"));
  }

  // ---- a Call button's side ----

  function onButtonLink(m) {
    if (S.user && m.u && m.u !== S.user) return;
    link.at = Date.now();
    if (m.t === "here" || m.t === "state") {
      // A dock doesn't follow a page whose SIP line is down: it takes the
      // line itself. (The settings come with the message, as this page may
      // not have its own yet.)
      const snap = m.snap || {};
      const ag = snap.agent || S.agent;
      const down = !!(snap.line && snap.line.state === "down" && !snap.call && ag && ag.enabled && ag.sipId);
      if (!link.on) {
        // Not while this page has a call of its own.
        if (S.call && !S.call.mirror) return;
        if (S.host === "dock" && down) return;
        linkUp(m.u, m.role);
      }
      mirror(m.snap || {});
    } else if (m.t === "bye") {
      linkDown(S.host === "dock" ? "" : "The Phone tab closed.");
    } else if (m.t === "refused") {
      if (S.call && S.call.mirror && !S.call.seen) {
        stopTimers();
        S.call = null;
        show("dial");
        updateCallBtn();
      }
      C.sound("error");
      notice(m.why || "The Phone tab didn't take the call.", "warn");
    }
  }

  function linkUp(user, role) {
    link.on = true;
    link.user = user || "";
    link.role = role || "";
    // The Phone tab has the line, so this page needs none of its own.
    if (S.sip.phone || S.sip.starting) stopSip();
    if (link.waiter) link.waiter();
  }

  function linkDown(why) {
    if (!link.on) return;
    link.on = false;
    link.snap = null;
    if (S.call && S.call.mirror) {
      stopTimers();
      S.call = null;
      show("dial");
      updateCallBtn();
    }
    if (why) notice(why, "warn");
    paintHeader();
    if (S.host === "dock") electDock();
    else if (lineNeeded()) startSip().catch(sipFailed);
  }

  // With no Phone tab answering, a dock takes the line itself, so desktop
  // calls ring with nothing but Zoho open. When several docks are open (two
  // Zoho tabs), the first to ask takes it and the others mirror it.
  async function electDock(pre) {
    if (S.host !== "dock" || isEngine() || !(S.agent && S.agent.enabled)) return;
    await sleep(80 + Math.random() * 320);
    if (link.on || isEngine()) return;
    linkSend({ t: "ping" });
    await waitForLink(450);
    if (link.on || isEngine()) return;
    S.engine = true;
    paintLine();
    if (sipWanted()) startSip(pre).catch(sipFailed);
    recover();
    phoneSay("here");
    if (!dock.beat) dock.beat = setInterval(() => phoneSay("state"), 15000);
  }

  function waitForLink(ms) {
    return new Promise((resolve) => {
      if (link.on) return resolve();
      link.waiter = resolve;
      setTimeout(resolve, ms);
    });
  }

  // A Phone tab speaks at least every 15 s; one silent for 45 s is gone.
  setInterval(() => {
    if (!isEngine() && link.on && Date.now() - link.at > 45000) linkDown(S.host === "dock" ? "" : "The Phone tab stopped answering.");
  }, 5000);

  // Shows the Phone tab's call here as if it were this page's own.
  function mirror(snap) {
    link.snap = snap;
    // The page holding the line has lost it for a while (retries between
    // count as lost): a dock takes over.
    const state = snap.line && snap.line.state;
    if (state === "ready" || snap.call || S.call) link.downSince = 0;
    else if (S.host === "dock" && state === "down" && sipWanted()) {
      if (!link.downSince) link.downSince = Date.now();
      else if (Date.now() - link.downSince > 8000) {
        link.downSince = 0;
        linkDown("");
        return;
      }
    }
    if (snap.agent) S.agent = snap.agent;
    const sip = snap.sip || {};
    S.sip.active = !!sip.active;
    S.sip.muted = !!sip.muted;
    S.sip.held = !!sip.held;
    const c = snap.call;
    if (c) {
      if (!S.call || !S.call.mirror) {
        S.call = { mirror: true, legs: 0, hungUp: false };
        $("hangBtn").disabled = false;
      }
      Object.assign(S.call, c, { seen: true });
      paintLive();
      paintStage(c.stage);
      if (c.startedAt && !S.tick) startTimer();
    } else if (S.call && S.call.mirror && S.call.seen) {
      // The call ended in the Phone tab.
      stopTimers();
      S.call = null;
      const e = snap.ended;
      if (snap.wrap) {
        openWrap(Object.assign({ remote: true }, snap.wrap));
      } else {
        show("dial");
        updateCallBtn();
        if (e && e.status) {
          notice(e.talk && e.status === "Answered" ? `${e.status} · ${clock(e.talk)}` : e.status, tone(e.status) === "ok" ? "ok" : "warn");
        }
      }
      loadRecent();
    } else if (snap.wrap && !S.wrap && !S.call && S.settings.required) {
      // A disposition the Phone tab still needs can be given here too.
      openWrap(Object.assign({ remote: true }, snap.wrap));
    } else if (!snap.wrap && S.wrap && S.wrap.remote) {
      // Given, or skipped, in the Phone tab.
      S.wrap = null;
      if (S.view === "wrap") {
        show("dial");
        updateCallBtn();
      }
    }
    paintHeader();
  }

  // A call from this page, placed by the Phone tab.
  function dialOnPhoneTab(t) {
    const args = { number: t.number, name: t.name || "", org: t.org || "", module: t.module || "", id: t.id || "" };
    const call = Object.assign({ mirror: true, dir: "out", mode: callWay(), stage: "agentConnecting",
      startedAt: 0, sid: null, legs: 0, hungUp: false }, args);
    S.call = call;
    $("hangBtn").disabled = false;
    paintLive();
    paintStage("agentConnecting");
    linkSend({ t: "cmd", cmd: "dial", args });
    // No word back: the Phone tab is gone, so this page calls by itself.
    setTimeout(() => {
      if (S.call !== call || call.seen) return;
      S.call = null;
      linkDown();
      startOutbound(t);
    }, 5000);
  }

  /* ---------------- start ---------------- */

  async function boot(page) {
    if (S.booted) return;
    S.booted = true;
    if (S.host === "dock") dockSize(false);
    if (S.host === "button") frameSize(640, 400, true);
    if (S.host !== "tab") {
      // Asked now, a Phone tab has answered by the time "me" is back.
      linkOpen();
      linkSend({ t: "ping" });
    }

    // The Call button widget says where it lives, so Phone tabs find its
    // bridge.html again after each upload.
    const app = (S.host === "button" || S.host === "dock") && !document.body.dataset.view
      ? location.origin + location.pathname.replace(/\/[^/]*$/, "")
      : "";
    let me;
    try {
      me = await api("me", { sip: true, app });
    } catch (err) {
      document.body.hidden = false;
      notice(err.message, "bad");
      paintLine();
      return;
    }
    S.user = String(me.email || "").toLowerCase();
    S.crmUrl = me.crmUrl || "";
    S.appUrl = me.appUrl || "";
    S.phoneUrl = me.phoneUrl || "";
    S.isAdmin = !!me.isAdmin;
    S.agent = me.agent || null;
    S.settings = settingsFrom(me.settings);
    // No dock until the admin has turned calling on and added their number.
    if (S.host === "dock" && !(S.agent && S.agent.enabled)) return closeDock();
    document.body.hidden = false;
    if (!S.agent || !S.agent.enabled) notice("Calling isn't on for you yet. Ask your admin.", "warn");
    // A Phone tab that answered the first ping may be someone else's.
    if (link.on && link.user && link.user !== S.user) linkDown();
    paintHeader();
    linkOpen();
    if (S.host === "tab") {
      startPhoneTab(me);
    } else if (S.host === "dock") {
      electDock(me.sip);
    } else if (lineNeeded()) {
      // Only without a Phone tab does this page register a line of its own.
      // The dock never does at load: it reloads with every page.
      waitForLink(link.bc ? 250 : 1500).then(() => {
        if (link.on) return;
        startSip(me.sip).catch(sipFailed);
        recover();
      });
    }

    let ctx = null;
    if (page) {
      try {
        ctx = await loadRecord(page.module, page.id);
      } catch (err) {
        notice(`Couldn't load the record: ${err.message}`, "warn");
      }
    }
    setContext(ctx);
    if (S.call) paintLive();
    else if (S.wrap) show("wrap");
    else if (document.body.dataset.view === "history") showHistory(S.ctx ? "record" : "all");
    else show("dial");
    loadRecent();
  }

  // The dock's flyout passes { host: "dock", module, recordId } from the
  // Client Script that opens it.
  function dockData(ctx) {
    const seen = [ctx, ctx && ctx.data, ctx && ctx.Data, ctx && ctx.data && ctx.data.data];
    return seen.find((x) => x && typeof x === "object" && x.host === "dock") || null;
  }

  ZOHO.embeddedApp.on("PageLoad", (ctx) => {
    if (TAB) return boot(null);
    const dock = dockData(ctx);
    if (dock && ON_PHONE) {
      closeDock();
      try { Promise.resolve(ZOHO.CRM.UI.Popup.close()).catch(() => {}); } catch (e) {}
      try { Promise.resolve(ZOHO.CRM.UI.Resize({ height: "1", width: "1" })).catch(() => {}); } catch (e) {}
      S.booted = true;
      return;
    }
    if (dock) {
      S.host = "dock";
      document.body.dataset.host = "dock";
      // Shown only once "me" says this person can call.
      document.body.hidden = true;
      const rid = Array.isArray(dock.recordId) ? dock.recordId[0] : dock.recordId;
      return boot(dock.module && rid ? { module: dock.module, id: String(rid) } : null);
    }
    const module = ctx && ctx.Entity;
    const raw = ctx && ctx.EntityId;
    const id = Array.isArray(raw) ? raw[0] : raw;
    boot(module && id ? { module, id: String(id) } : null);
  });
  // A web tab may never get PageLoad; start anyway.
  Promise.resolve(ZOHO.embeddedApp.init()).then(() => {
    setTimeout(() => {
      if (!S.booted) boot(null);
    }, 1200);
  });
})();
