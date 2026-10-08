/* Helpers shared by the CTI and the admin page. */
(function () {
  "use strict";

  // Every server action goes through the cti_api Zoho function. Zoho runs it
  // as the signed-in user, so the server always knows who is asking.
  async function api(action, args) {
    const res = await ZOHO.CRM.FUNCTIONS.execute("cti_api", {
      arguments: JSON.stringify(Object.assign({ action }, args || {})),
    });
    const raw = res && res.details && res.details.output;
    if (raw == null) {
      const why = (res && (res.message || res.code)) || "no answer";
      throw new Error(`The cti_api function did not answer (${why}). Is its REST API turned on?`);
    }
    let out;
    try {
      out = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      throw new Error("cti_api returned something that isn't JSON: " + String(raw).slice(0, 120));
    }
    if (!out.ok) throw new Error(out.error || "cti_api refused");
    return out;
  }

  function initials(name) {
    const parts = String(name || "?").replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "#";
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  const clock = (s) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600);
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${m}:${ss}` : `${m}:${ss}`;
  };

  // "2026-10-03T11:24:07+05:30" -> "3 Oct, 11:24" (today -> "11:24")
  function when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const t = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return t;
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `Yesterday, ${t}`;
    return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${t}`;
  }

  function fullWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  // "02:05" (Zoho's Call_Duration) -> seconds
  function seconds(mmss) {
    const p = String(mmss || "").split(":").map(Number);
    if (p.some(isNaN) || !p.length) return 0;
    return p.reduce((a, b) => a * 60 + b, 0);
  }

  // The Description holds "CallSid: …" and "Recording: <url or none>".
  function recordingFrom(description) {
    const m = /Recording:\s*(\S+)/.exec(description || "");
    return m && /^https?:\/\//.test(m[1]) ? m[1] : "";
  }

  const digits = (n) => String(n || "").replace(/[^\d+]/g, "");

  // How a placed call ended, from cti_api's status (Exotel's leg statuses).
  // The same wording as cti_webhook writes to Zoho.
  function outcome(r) {
    const talk = Number(r && r.talk) || 0;
    const l1 = (r && r.leg1) || "";
    const l2 = (r && r.leg2) || "";
    if (talk > 0 || (l1 === "completed" && l2 === "completed")) return "Answered";
    if (l1 && l1 !== "completed") {
      return { busy: "Agent busy", failed: "Agent unreachable", canceled: "Canceled" }[l1] || "Agent unanswered";
    }
    if (l2 === "busy") return "Customer busy";
    if (l2 === "failed" || (r && r.status === "failed")) return "Customer unreachable";
    if (l2 === "canceled") return "Canceled";
    return "Customer unanswered";
  }

  // ok (green), warn (amber) or bad (red), for any status wording.
  function tone(status) {
    const s = String(status || "").toLowerCase();
    if (!s) return "";
    if (s === "answered" || s === "inbound" || s === "outbound") return "ok";
    if (/busy|cancel|hung up/.test(s)) return "warn";
    return "bad";
  }

  // Dispositions and incoming rules, as cti_settings holds them.
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

  function settingsFrom(raw) {
    const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
    s.dispositions = (Array.isArray(s.dispositions) ? s.dispositions : [])
      .map((d) => ({
        name: String((d && d.name) || "").trim(),
        subs: (Array.isArray(d && d.subs) ? d.subs : []).map((x) => String(x).trim()).filter(Boolean),
      }))
      .filter((d) => d.name);
    s.twoLevels = s.twoLevels !== false && String(s.twoLevels) !== "false";
    s.required = s.required !== false && String(s.required) !== "false";
    s.ownerOnly = s.ownerOnly !== false && String(s.ownerOnly) !== "false";
    s.newLeads = s.newLeads !== false && String(s.newLeads) !== "false";
    s.ringSeconds = Math.min(60, Math.max(10, Number(s.ringSeconds) || 25));
    return s;
  }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) {
      return null;
    }
    return value;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Builds an element. Strings become text, never HTML.
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }

  // An inline SVG that uses a symbol from the page's sprite.
  function icon(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + id);
    svg.append(use);
    return svg;
  }

  window.CTI = Object.assign(window.CTI || {}, {
    api, initials, clock, when, fullWhen, seconds, recordingFrom, digits, outcome, tone,
    DEFAULT_SETTINGS, settingsFrom, store, sleep, h, icon,
  });
})();
