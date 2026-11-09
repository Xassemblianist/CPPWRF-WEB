// SPDX-License-Identifier: GPL-3.0-or-later
// "Çalışmalar": every run (or the published samples), estimate against actual, star, delete, run again, compare.
import { $, h, t, api, num, fmtDur, fmtBytes, fmtCycle, fmtTime } from "./util.js";

export class Library {
  constructor(app) {
    this.app = app;
    this.pane = $("pane-runs");
    this.runs = [];
  }
  async refresh() {
    if (api.online) {
      try { this.runs = await api.get("/api/v1/runs"); } catch { this.runs = []; }
    } else {
      this.runs = (api.samples || []).map((r) => ({ ...r, sample: true }));
    }
    this.runs.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    this.render();
    return this.runs;
  }
  find(id) { return this.runs.find((r) => r.id === id); }
  render() {
    const p = this.pane;
    p.replaceChildren();
    if (!api.online) p.append(h("p", { class: "hint" }, t("sys.offline")));
    if (!this.runs.length) { p.append(h("p", { class: "hint" }, t("lib.empty"))); return; }
    for (const r of this.runs) p.append(this.item(r));
  }
  item(r) {
    const s = r.settings || {}, d = s.domain || {}, tm = s.time || {};
    const cur = this.app.run?.id === r.id;
    const el = h("article", { class: `run${cur ? " cur" : ""}` });
    const title = s.name || `${fmtCycle(tm.cycle)} · +${tm.hours} ${this.app.lang === "tr" ? "sa" : "h"}`;
    el.append(h("div", { class: "t" },
      api.online ? h("button", { class: "star", "aria-pressed": String(!!r.starred), title: t("lib.star"), "aria-label": t("lib.star"),
        onclick: async () => { await api.send("POST", `/api/v1/runs/${r.id}/star`, { starred: !r.starred }); this.refresh(); } }, "★") : null,
      h("span", {}, title),
      h("span", { class: `st ${r.status}` }, r.sample ? t("lib.sample") : t(`lib.status.${r.status}`))));
    el.append(h("div", { class: "m" }, `${t(`mode.${s.mode}`)} · ${num(d.dx_km, d.dx_km % 1 ? 1 : 0)} km · ${d.nx}×${d.ny}×${d.nz}${s.nest ? ` + 1:${s.nest.ratio}` : ""} · ${s.physics?.preset || ""}`));
    if (r.created) el.append(h("div", { class: "m" }, `${fmtTime(r.created, { date: true })} · CPPWRF ${r.cppwrf_commit || "?"}`));
    const est = r.estimate?.total_s, act = r.actual?.total_s;
    if (est && act) {
      const dpc = Math.round(100 * (act - est) / est);
      el.append(h("div", { class: "m" }, t("lib.est_vs_act", { e: fmtDur(est), a: fmtDur(act), d: `${dpc > 0 ? "+" : ""}${dpc}%` })));
    }
    if (r.disk_bytes) el.append(h("div", { class: "m" }, t("lib.size", { s: fmtBytes(r.disk_bytes) })));
    if (r.message && r.status !== "done") el.append(h("div", { class: "m", style: "color:var(--red)" }, r.message));
    const acts = h("div", { class: "acts" });
    if (r.status === "done" || r.sample || (r.status === "running" && r.frames)) acts.append(h("button", { class: "btn", onclick: () => this.app.open(r.id) }, t("lib.open")));
    if ((r.status === "done" || r.sample) && this.app.run && this.app.run.id !== r.id) acts.append(h("button", { class: "btn", onclick: () => this.app.compare(r.id) }, t("lib.compare")));
    if (api.online && s.domain) {
      acts.append(h("button", { class: "btn", title: t("lib.rerun"), onclick: () => this.app.rerun(r, false) }, "↻"));
      acts.append(h("button", { class: "btn", title: t("lib.edit"), onclick: () => this.app.rerun(r, true) }, "✎"));
    }
    if (r.status === "running" || r.status === "queued") acts.append(h("button", { class: "btn", onclick: () => this.app.track(r) }, t("run.logs")));
    if (api.online && r.status !== "running") acts.append(h("button", { class: "btn danger", onclick: async () => {
      if (!(await this.app.confirm(t("lib.delete_confirm")))) return;
      await api.send("DELETE", `/api/v1/runs/${r.id}`);
      if (this.app.run?.id === r.id) this.app.unload();
      this.refresh();
    } }, t("lib.delete")));
    el.append(acts);
    return el;
  }
}
