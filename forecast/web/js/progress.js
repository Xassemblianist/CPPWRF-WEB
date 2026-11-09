// SPDX-License-Identifier: GPL-3.0-or-later
// A running forecast: stages, simulated time, step rate, remaining time, the ready frames, the log of the stage, cancel.
import { $, h, t, api, num, fmtDur, fmtCycle } from "./util.js";

const STAGES = ["download", "wps", "real", "model", "post"];

export class Progress {
  constructor(app) {
    this.app = app;
    this.el = $("progress");
    this.es = null;
    this.run = null;
  }
  track(run) {
    this.close();
    this.run = run;
    this.started = Date.now();
    this.lastFrames = 0;
    this.el.hidden = false;
    this.paint({ status: run.status, stage: run.stage, queue_position: run.queue_position });
    this.es = api.events(run.id, (e) => this.update(e));
  }
  close() {
    if (this.es) this.es.close();
    this.es = null;
    this.el.hidden = true;
    this.run = null;
  }
  update(e) {
    this.paint(e);
    if (e.frames && e.frames !== this.lastFrames) {
      this.lastFrames = e.frames;
      this.app.partial(this.run, e.frames);
    }
    if (["done", "failed", "cancelled"].includes(e.status)) {
      this.app.finished(this.run, e);
      if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        const name = this.run.settings?.name || fmtCycle(this.run.settings?.time?.cycle);
        try { new Notification(t(e.status === "done" ? "run.notify_done" : "run.notify_failed", { name }), { body: e.message || "" }); } catch { /* not allowed */ }
      }
      if (e.status === "done") { const id = this.run.id; setTimeout(() => { if (this.run?.id === id) this.close(); }, 4000); }
    }
  }
  paint(e) {
    const el = this.el, status = ["done", "failed", "cancelled", "queued"].includes(e.status) ? e.status : e.status ? "running" : "queued";
    el.replaceChildren();
    const title = status === "queued" ? t("run.queued", { n: e.queue_position || 1 }) : t(`run.${status}`) || t("run.running");
    el.append(h("h4", {}, status === "running" || status === "queued" ? h("span", { class: "spin", "aria-hidden": "true" }, "◌") : null, title,
      h("span", { style: "margin-left:auto;font-weight:500;color:var(--muted);font-size:12px" }, t(`mode.${this.run.settings?.mode}`))));
    // the stage strip
    const cur = e.stage === "geogrid" || e.stage === "ungrib" || e.stage === "metgrid" ? "wps" : e.stage;
    const ci = STAGES.indexOf(cur);
    el.append(h("div", { class: "stages" }, STAGES.map((s, i) =>
      h("span", { class: status === "done" || i < ci ? "done" : i === ci && status === "running" ? "now" : "" }, t(`stage.${s}`)))));
    el.append(h("div", { class: "bar", role: "progressbar", "aria-valuenow": Math.round(e.pct || 0), "aria-valuemin": 0, "aria-valuemax": 100 },
      h("i", { style: `width:${e.pct || 0}%` })));
    const dl = h("dl");
    const row = (k, v) => dl.append(h("dt", {}, k), h("dd", {}, v));
    row(t("run.wall"), fmtDur((Date.now() - this.started) / 1000 + (e.wall_s && cur !== "model" ? 0 : 0)));
    if (e.sim_s != null) {
      row(t("run.sim"), `${fmtDur(e.sim_s)} / ${fmtDur(e.run_s)}`);
      if (e.steps_per_s) row(t("run.rate"), `${t("run.steps_per_s", { n: num(e.steps_per_s, 1) })} · ${t("run.sim_per_wall", { x: num(e.sim_per_wall, 0) })}`);
      if (e.model_remaining_s != null && status === "running") row(t("run.remaining"), fmtDur(e.model_remaining_s));
    }
    el.append(dl);
    if (e.message && status !== "done") el.append(h("p", { class: "msg" }, e.message));
    if (e.log_tail) {
      el.append(h("details", { open: status === "failed" ? true : null }, h("summary", {}, `${t("run.logs")} · ${e.log_stage}`), h("pre", {}, e.log_tail)));
    }
    const acts = h("div", { class: "acts" });
    if (e.frames) acts.append(h("button", { class: "btn", onclick: () => this.app.open(this.run.id) }, t("run.show_partial", { n: e.frames })));
    if (status === "running" || status === "queued") {
      acts.append(h("button", { class: "btn danger", onclick: async () => { await api.send("POST", `/api/v1/runs/${this.run.id}/cancel`); } }, t("run.cancel")));
    } else {
      acts.append(h("button", { class: "btn", onclick: () => this.close() }, t("run.close")));
    }
    el.append(acts);
  }
}
