/* Timers a background tab can't slow down.

   Chrome runs a hidden tab's timers at most once a second, and after five
   minutes hidden, once a minute. The page holding the line (a Phone tab, or
   a dock in a Zoho tab left in the background) keeps the SIP line, ringing
   and call checks, which must keep time, so its timers run off a worker's
   clock instead. */
(function () {
  "use strict";
  if (!window.Worker || !window.Blob || !window.URL) return;

  let worker;
  try {
    const src = "var t={};onmessage=function(e){var d=e.data;" +
      "if(d.c){clearTimeout(t[d.i]);clearInterval(t[d.i]);delete t[d.i];return;}" +
      "t[d.i]=(d.r?setInterval:setTimeout)(function(){postMessage(d.i);if(!d.r)delete t[d.i];},d.ms);};";
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  } catch (e) {
    return;
  }

  const nativeClear = window.clearTimeout.bind(window);
  const jobs = new Map();
  let next = 1e7;

  worker.onmessage = (e) => {
    const job = jobs.get(e.data);
    if (!job) return;
    if (!job.repeat) jobs.delete(e.data);
    try {
      job.fn.apply(window, job.args);
    } catch (err) {
      // Report it as the browser would, without stopping other timers.
      Promise.reject(err);
    }
  };

  function add(fn, ms, args, repeat) {
    if (typeof fn !== "function") return 0;
    const id = next++;
    jobs.set(id, { fn, args, repeat });
    worker.postMessage({ i: id, ms: Math.max(0, Number(ms) || 0), r: repeat });
    return id;
  }

  function clear(id) {
    if (!jobs.has(id)) {
      // A timer set before this file loaded.
      if (typeof id === "number" && id < 1e7) nativeClear(id);
      return;
    }
    jobs.delete(id);
    worker.postMessage({ i: id, c: 1 });
  }

  window.setTimeout = (fn, ms, ...args) => add(fn, ms, args, false);
  window.setInterval = (fn, ms, ...args) => add(fn, ms, args, true);
  window.clearTimeout = clear;
  window.clearInterval = clear;
})();
