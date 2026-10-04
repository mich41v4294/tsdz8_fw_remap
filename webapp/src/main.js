import { HexError, IntelHex } from "./intelHex.js";
import { GROUP_ORDER, parameterMap, parametersByAudience } from "./parameterMap.js";
import { applyPatches, applyPreset, buildDiff, checkOriginalBytes, defaultValues, presetMatches } from "./patcher.js";
import { compareFirmware, loadFirmwareBytes } from "./firmwareDiff.js";
import {
  HEX_ROW_HEIGHT,
  OVERLAY_NONE,
  asciiChar,
  buildOverlay,
  bytesPerRow,
  dumpRowCount,
  formatDumpByte,
  inspectAddress,
  parseGotoAddress,
  rowIndexForAddress,
  statusName,
} from "./firmwareHexView.js";
import { FlashSession } from "./flash/session.js";
import { FLASH_BASE, IMAGE_SIZE } from "./flash/constants.js";
import { webUsbFlasherEnabled } from "./flash/flags.js";
import { webUsbAvailable } from "./flash/jlinkUsb.js";
import { applyDocumentLang, getLang, mapNotes, paramText, setLang, t } from "./i18n.js";
import { applyPasChart, isPasPercentId, pasChartSvg, valueFromPointer } from "./pasChart.js";

const app = document.querySelector("#app");
if (!app) throw new Error("#app missing");

let view = "patcher";
let loaded = null;
const values = defaultValues();
const webUsbOn = webUsbFlasherEnabled();
let session = null;
let advancedOpen = false;
let pasFineOpen = false;
let advancedFilter = "";
let advancedGroup = "";
let compareLeft = null;
let compareRight = null;
let hexFile = null;
let hexMode = "hex";
let hexSelected = null;
let hexScrollTop = 0;
let hexGotoDraft = "";
let patcherStatus = { kind: "", key: "status.noFile", vars: {} };
let probeStatus = { kind: "", key: webUsbOn ? "probe.none" : "probe.useCli", vars: {}, text: "" };
let compareStatus = { kind: "", key: "compare.needTwo", vars: {} };
let hexStatus = { kind: "", key: "hexviz.needFile", vars: {} };

function fmtBytes(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function hexAddr(addr) {
  return `0x${addr.toString(16).toUpperCase()}`;
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function checkboxLabel(state) {
  if (state === "on") return t("compare.checkboxOn");
  if (state === "off") return t("compare.checkboxOff");
  return t("compare.checkboxUnknown");
}

function isStockDerivedSlider(spec) {
  return spec.control === "slider" && spec.sliderMin != null && spec.min === 0 && spec.defaultValue === 0;
}

function downloadInfo() {
  if (!loaded) return { disabled: true, key: "download.needFile", vars: {} };
  const count = buildDiff(values).length;
  if (count === 0) return { disabled: true, key: "download.noChanges", vars: {} };
  return { disabled: false, key: "download.changes", vars: { count: String(count) } };
}

function syncDownload() {
  const info = downloadInfo();
  const label = t(info.key, info.vars);
  for (const btn of app.querySelectorAll("#download")) {
    btn.disabled = info.disabled;
    btn.title = label;
  }
  const reason = app.querySelector("#sticky-reason");
  if (reason) reason.textContent = label;
}

function setPatcherStatus(kind, key, vars = {}) {
  patcherStatus = { kind, key, vars };
  const el = app.querySelector("#status");
  if (!el) return;
  el.className = `status ${kind}`;
  el.textContent = t(key, vars);
}

function setProbeStatus(kind, text) {
  probeStatus = { kind, key: "", vars: {}, text };
  const el = app.querySelector("#probe-status");
  if (!el) return;
  el.className = `status ${kind}`;
  el.textContent = text;
}

function setCompareStatus(kind, key, vars = {}) {
  compareStatus = { kind, key, vars };
  const el = app.querySelector("#compare-status");
  if (!el) return;
  el.className = `status ${kind}`;
  el.hidden = key === "compare.needTwo";
  el.textContent = t(key, vars);
}

function setHexStatus(kind, key, vars = {}) {
  hexStatus = { kind, key, vars };
  const el = app.querySelector("#hex-status");
  if (!el) return;
  el.className = `status ${kind}`;
  el.hidden = key === "hexviz.needFile";
  el.textContent = t(key, vars);
}

function hexJumpLabel(range) {
  if (range.kind === "preserve") return range.label || range.id;
  const label = paramText(range.id, "label") || range.id;
  return range.siteIndex > 0 ? `${label} (${range.siteIndex + 1})` : label;
}

function setHexFile(name, image) {
  hexFile = { name, image, overlay: buildOverlay(image) };
  hexStatus = {
    kind: "ok",
    key: "hexviz.loaded",
    vars: {
      name,
      sites: String(hexFile.overlay.siteCount),
      changed: String(hexFile.overlay.changedByteCount),
    },
  };
}

function patchedImage() {
  if (!loaded) return null;
  return applyPatches(loaded.image, values).toFlatImage();
}

function refreshCompareStatus() {
  if (compareStatus.kind === "bad") return;
  if (compareLeft && compareRight) {
    setCompareStatus("ok", "compare.pair", { a: compareLeft.name, b: compareRight.name });
    return;
  }
  if (compareLeft || compareRight) {
    const packed = compareLeft || compareRight;
    setCompareStatus("ok", "compare.needOther", { name: packed.name });
    return;
  }
  setCompareStatus("", "compare.needTwo");
}

function syncProbeButtons() {
  const connectBtn = app.querySelector("#connect");
  const flashBtn = app.querySelector("#flash");
  const verifyBtn = app.querySelector("#verify");
  const dumpBtn = app.querySelector("#dump");
  if (!webUsbOn || !connectBtn || !flashBtn || !verifyBtn || !dumpBtn) return;
  const hasUsb = webUsbAvailable();
  connectBtn.disabled = !hasUsb;
  const ready = Boolean(session) && Boolean(loaded);
  flashBtn.disabled = !ready;
  verifyBtn.disabled = !ready;
  dumpBtn.disabled = !session;
  if (!hasUsb) {
    setProbeStatus("", t("probe.noWebusb"));
  }
}

function snapValue(spec, raw) {
  if (spec.control === "checkbox") return raw ? 1 : 0;
  let value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (isStockDerivedSlider(spec) && value === 0) return 0;
  if (value < spec.min) value = spec.min;
  if (value > spec.max) value = spec.max;
  if (spec.sliderMin != null && value > 0 && value < spec.sliderMin) value = spec.sliderMin;
  const step = spec.step || 1;
  if (step > 1) value = Math.round(value / step) * step;
  return value;
}

function renderDropZone({ id, accept, copyHtml, fileName, extra = "", compact = false }) {
  const file = fileName ? `<span class="drop-file">${esc(fileName)}</span>` : "";
  return `
    <label class="drop ${compact ? "drop-compact" : ""}" data-drop="${id}">
      <input id="${id}" class="drop-input" type="file" accept="${accept}" />
      <span class="drop-copy">${copyHtml}</span>
      ${file}
      ${extra}
    </label>
  `;
}

function renderCard(spec, { showAdvancedBadge = false } = {}) {
  const extra = showAdvancedBadge ? ` <span class="badge advanced">${t("badge.advanced")}</span>` : "";
  const current = values[spec.id];
  const sliderMin = spec.sliderMin ?? spec.min;
  const derived = isStockDerivedSlider(spec) && current === 0;
  const rangeValue = derived ? sliderMin : current;
  const atStock = current === spec.defaultValue;
  const control =
    spec.control === "checkbox"
      ? `<input data-id="${spec.id}" type="checkbox" ${current ? "checked" : ""} />`
      : `<input data-id="${spec.id}" id="num-${spec.id}" type="number" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${current}" />`;
  const slider =
    spec.control === "slider"
      ? `<div class="range-row">
            <button type="button" data-stock-id="${spec.id}" class="${atStock ? "active" : ""}">${t("fields.stock")}</button>
            <div class="range-wrap">
              <input data-id="${spec.id}" type="range" min="${sliderMin}" max="${spec.max}" step="${spec.step}" value="${rangeValue}" ${derived ? "disabled" : ""} aria-label="${esc(paramText(spec.id, "label"))}" />
              <div class="range-ends"><span title="${t("fields.min")}">${sliderMin}</span><span title="${t("fields.max")}">${spec.max}</span></div>
            </div>
          </div>
          ${derived ? `<p class="derived-flag">${t("fields.stockDerived")}</p>` : ""}`
      : "";
  const unit = paramText(spec.id, "unit");
  const numId = spec.control === "checkbox" ? "" : `num-${spec.id}`;
  const cardClass = [
    "card",
    spec.audience,
    spec.control === "checkbox" ? "toggle" : "",
    spec.control === "slider" ? "slider" : "",
    derived ? "derived" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `
        <article class="${cardClass}" data-param="${spec.id}">
          <label${numId ? ` for="${numId}"` : ""}>
            <span>${paramText(spec.id, "label")}${extra}</span>
            <span>
              ${control}
              ${unit}
            </span>
          </label>
          ${slider}
          <p class="summary">${paramText(spec.id, "summary")}</p>
          <details class="notes">
            <summary>${t("fields.notes")}</summary>
            <p>${paramText(spec.id, "notes")}</p>
          </details>
        </article>`;
}

function renderPasChartHtml() {
  return `
    <section class="pas-chart">
      <h3>${t("pasChart.title")}</h3>
      <p class="hint">${t("pasChart.hint")}</p>
      ${pasChartSvg(values)}
    </section>`;
}

function renderAudienceGroups(audience) {
  return GROUP_ORDER.map((group) => {
    const specs = parametersByAudience(audience).filter((p) => p.group === group);
    if (specs.length === 0) return "";
    const body =
      audience === "rider" && group === "assist"
        ? (() => {
            const percents = specs.filter((p) => isPasPercentId(p.id));
            const rest = specs.filter((p) => !isPasPercentId(p.id));
            return `
        <h3>${t(`group.${group}`)}</h3>
        ${renderPasChartHtml()}
        <details class="pas-fine" ${pasFineOpen ? "open" : ""}>
          <summary>${t("pasChart.fineTune")}</summary>
          <div class="grid">${percents.map((spec) => renderCard(spec)).join("")}</div>
        </details>
        <div class="grid">${rest.map((spec) => renderCard(spec)).join("")}</div>`;
          })()
        : `<h3>${t(`group.${group}`)}</h3><div class="grid">${specs.map((spec) => renderCard(spec)).join("")}</div>`;
    if (audience === "advanced") {
      const hidden = advancedGroup && advancedGroup !== group ? "hidden" : "";
      return `<div class="adv-group" data-adv-group="${group}" ${hidden}>${body}</div>`;
    }
    return body;
  }).join("");
}

function renderPresetsHtml() {
  const presets = parameterMap.presets ?? [];
  if (presets.length === 0) return "";
  const choices = presets
    .map((preset) => {
      const matched = presetMatches(preset, values);
      const active = matched ? "active" : "";
      const kind = preset.kind ? `preset-${preset.kind}` : "";
      const summary = t(`presets.${preset.id}.summary`);
      const state = matched ? `<span class="preset-choice-state">${t("presets.applied")}</span>` : "";
      return `<button type="button" data-preset="${preset.id}" class="preset-choice ${kind} ${active}" title="${esc(summary)}"><span class="preset-choice-label">${t(`presets.${preset.id}.label`)}</span><span class="preset-choice-summary">${summary}</span>${state}</button>`;
    })
    .join("");
  return `
    <section class="presets">
      <h2>${t("presets.title")}</h2>
      <p class="hint warn">${t("presets.hint")}</p>
      <div class="preset-choices">${choices}</div>
    </section>
  `;
}

function renderAdvancedToolbar() {
  const chips = [
    `<button type="button" data-adv-filter="" class="${advancedGroup === "" ? "active" : ""}">${t("advanced.allGroups")}</button>`,
    ...GROUP_ORDER.map(
      (group) =>
        `<button type="button" data-adv-filter="${group}" class="${advancedGroup === group ? "active" : ""}">${t(`group.${group}`)}</button>`,
    ),
  ];
  return `
    <div class="advanced-toolbar">
      <input id="advanced-filter" type="search" value="${esc(advancedFilter)}" placeholder="${t("advanced.filter")}" autocomplete="off" />
      <div class="group-chips" role="group" aria-label="${t("advanced.filter")}">${chips.join("")}</div>
    </div>
  `;
}

function renderFieldsHtml() {
  return `
    <section class="audience rider">
      <h2>${t("audience.rider")}</h2>
      <p class="hint">${t("fields.riderHint")}</p>
      ${renderAudienceGroups("rider")}
    </section>
    <details class="audience advanced" ${advancedOpen ? "open" : ""}>
      <summary>
        <h2>${t("audience.advanced")}</h2>
      </summary>
      <p class="hint warn">${t("fields.advancedHint")}</p>
      ${renderAdvancedToolbar()}
      ${renderAudienceGroups("advanced")}
    </details>
  `;
}

function applyAdvancedFilter() {
  const q = advancedFilter.trim().toLowerCase();
  const section = app.querySelector("details.audience.advanced");
  if (!section) return;
  for (const groupEl of section.querySelectorAll(".adv-group")) {
    const group = groupEl.dataset.advGroup;
    if (advancedGroup && group !== advancedGroup) {
      groupEl.hidden = true;
      continue;
    }
    let any = false;
    for (const card of groupEl.querySelectorAll(".card")) {
      const id = card.dataset.param;
      const hay = `${paramText(id, "label")} ${paramText(id, "summary")} ${id}`.toLowerCase();
      const show = !q || hay.includes(q);
      card.hidden = !show;
      if (show) any = true;
    }
    groupEl.hidden = !any;
  }
}

function renderDiffHtml() {
  const diffs = buildDiff(values);
  if (!loaded) {
    return `<p class="hint">${t("diff.loadHint")}</p>`;
  }
  if (diffs.length === 0) {
    return `<p class="hint">${t("diff.noChanges")}</p>`;
  }
  return `
    <div class="table-scroll">
    <table>
      <thead><tr><th>${t("diff.audience")}</th><th>${t("diff.parameter")}</th><th>${t("diff.address")}</th><th>${t("diff.old")}</th><th>${t("diff.new")}</th></tr></thead>
      <tbody>
        ${diffs
          .map((d) => {
            const audience = d.audience === "advanced" ? t("audience.advancedShort") : t("audience.riderShort");
            return `<tr class="${d.audience}"><td>${audience}</td><td>${paramText(d.id, "label")}</td><td><code>${hexAddr(d.address)}</code></td><td><code>${fmtBytes(d.oldBytes)}</code></td><td><code>${fmtBytes(d.newBytes)}</code></td></tr>`;
          })
          .join("")}
      </tbody>
    </table>
    </div>
  `;
}

function renderCompareResult() {
  if (!compareLeft || !compareRight) {
    if (compareLeft || compareRight) {
      return `<div class="empty-state">${t("compare.needOther")}</div>`;
    }
    return `<div class="empty-state">${t("compare.needTwo")}</div>`;
  }
  const result = compareFirmware(compareLeft.image, compareRight.image);
  if (result.parameterCount === 0 && result.unmappedByteCount === 0) {
    return `<div class="compare-identical"><strong>${t("compare.identicalTitle")}</strong><p>${t("compare.identical")}</p></div>`;
  }
  const paramRows = result.parameters
    .map((p) => {
      const audience = p.audience === "advanced" ? t("audience.advancedShort") : t("audience.riderShort");
      const label = paramText(p.id, "label");
      if (p.kind === "checkbox") {
        return p.sites
          .map((site) => {
            const decoded = t("compare.checkbox", {
              old: checkboxLabel(site.oldState),
              new: checkboxLabel(site.newState),
            });
            return `<tr class="${p.audience}"><td>${audience}</td><td>${label}</td><td><code>${hexAddr(site.address)}</code></td><td><code>${fmtBytes(site.oldBytes)}</code></td><td><code>${fmtBytes(site.newBytes)}</code></td><td>${decoded}</td></tr>`;
          })
          .join("");
      }
      const unit = paramText(p.id, "unit");
      const decoded = t("compare.value", { old: p.oldValue, new: p.newValue, unit });
      return `<tr class="${p.audience}"><td>${audience}</td><td>${label}</td><td><code>${hexAddr(p.address)}</code></td><td><code>${fmtBytes(p.oldBytes)}</code></td><td><code>${fmtBytes(p.newBytes)}</code></td><td>${decoded}</td></tr>`;
    })
    .join("");

  const unmappedRows = result.unmapped
    .map((range) => {
      const shown = 32;
      const oldShown = range.oldBytes.slice(0, shown);
      const newShown = range.newBytes.slice(0, shown);
      const extra =
        range.oldBytes.length > shown
          ? ` … (${t("compare.rangeBytes", { count: String(range.oldBytes.length) })})`
          : "";
      return `<tr><td><code>${hexAddr(range.address)}</code></td><td>${t("compare.rangeBytes", { count: String(range.oldBytes.length) })}</td><td><code>${fmtBytes(oldShown)}${extra}</code></td><td><code>${fmtBytes(newShown)}${extra}</code></td></tr>`;
    })
    .join("");

  return `
    <p class="hint">${t("compare.summary", { params: String(result.parameterCount), bytes: String(result.unmappedByteCount) })}</p>
    ${
      result.parameterCount
        ? `<h3>${t("compare.paramsTitle")}</h3>
      <div class="table-scroll"><table>
        <thead><tr><th>${t("diff.audience")}</th><th>${t("diff.parameter")}</th><th>${t("diff.address")}</th><th>${t("diff.old")}</th><th>${t("diff.new")}</th><th>${t("compare.valueCol")}</th></tr></thead>
        <tbody>${paramRows}</tbody>
      </table></div>`
        : ""
    }
    ${
      result.unmappedByteCount
        ? `<h3>${t("compare.unmappedTitle")}</h3>
      <div class="table-scroll"><table>
        <thead><tr><th>${t("diff.address")}</th><th>${t("diff.bytesCol")}</th><th>${t("diff.old")}</th><th>${t("diff.new")}</th></tr></thead>
        <tbody>${unmappedRows}</tbody>
      </table></div>`
        : ""
    }
  `;
}

function renderHexLegend() {
  const chips = [
    ...GROUP_ORDER.map((group) => `<span class="hex-chip group-${group}">${t(`group.${group}`)}</span>`),
    `<span class="hex-chip kind-preserve">${t("hexviz.legend.preserve")}</span>`,
    `<span class="hex-chip status-stock">${t("hexviz.legend.stock")}</span>`,
    `<span class="hex-chip status-patched">${t("hexviz.legend.patched")}</span>`,
    `<span class="hex-chip status-other">${t("hexviz.legend.other")}</span>`,
  ];
  return `<div class="hex-legend" aria-label="${t("hexviz.legend")}">${chips.join("")}</div>`;
}

function renderHexJumpHtml() {
  const overlay = hexFile?.overlay;
  const ranges = overlay?.ranges ?? [];
  const rider = ranges.filter((r) => r.kind === "parameter" && r.audience === "rider");
  const advanced = ranges.filter((r) => r.kind === "parameter" && r.audience === "advanced");
  const preserve = ranges.filter((r) => r.kind === "preserve");
  const section = (title, items) => {
    if (items.length === 0) return "";
    const buttons = items
      .map((range) => {
        const active = hexSelected != null && hexSelected >= range.address && hexSelected < range.address + range.size;
        return `<button type="button" data-hex-jump="${range.address}" class="${active ? "active" : ""}">${hexJumpLabel(range)}<span class="addr">${hexAddr(range.address)}</span></button>`;
      })
      .join("");
    return `<h3>${title}</h3>${buttons}`;
  };
  if (!overlay) return "";
  return `
    ${section(t("audience.rider"), rider)}
    ${section(t("audience.advanced"), advanced)}
    ${section(t("hexviz.jumpPreserve"), preserve)}
  `;
}

function renderHexInspectHtml() {
  if (!hexFile) return "";
  if (hexSelected == null) {
    return `<p class="hint">${t("hexviz.pickByte")}</p>`;
  }
  const info = inspectAddress(hexFile.overlay, hexFile.image, hexSelected);
  if (!info) {
    return `<p class="hint">${t("hexviz.addressBad")}</p>`;
  }
  if (!info.mapped) {
    return `
      <h3>${t("hexviz.detail.unmapped")}</h3>
      <dl>
        <dt>${t("hexviz.detail.address")}</dt>
        <dd><code>${hexAddr(info.address)}</code></dd>
        <dt>${t("hexviz.detail.bytes")}</dt>
        <dd><code>${fmtBytes(info.siteBytes)}</code></dd>
      </dl>
    `;
  }
  const range = info.range;
  const title = hexJumpLabel(range);
  const kind = range.kind === "preserve" ? t("hexviz.detail.kind.preserve") : t("hexviz.detail.kind.parameter");
  const status = t(`hexviz.detail.status.${info.status}`);
  const unit = range.kind === "parameter" ? paramText(range.id, "unit") : "";
  let valueRow = "";
  if (info.checkbox) {
    valueRow = `<dt>${t("hexviz.detail.value")}</dt><dd>${checkboxLabel(info.checkbox)}</dd>`;
  } else if (info.decoded != null) {
    valueRow = `<dt>${t("hexviz.detail.value")}</dt><dd>${info.decoded}${unit ? ` ${unit}` : ""}</dd>`;
  }
  const encoding = range.encoding
    ? `<dt>${t("hexviz.detail.encoding")}</dt><dd>${range.encoding}</dd>`
    : "";
  return `
    <h3>${title}</h3>
    <p class="hint">${kind} · ${status}</p>
    <dl>
      <dt>${t("hexviz.detail.address")}</dt>
      <dd><code>${hexAddr(range.address)}</code></dd>
      <dt>${t("hexviz.detail.bytes")}</dt>
      <dd><code>${fmtBytes(info.siteBytes)}</code></dd>
      <dt>${t("hexviz.detail.original")}</dt>
      <dd><code>${fmtBytes(range.originalBytes)}</code></dd>
      ${valueRow}
      ${encoding}
    </dl>
  `;
}

function hexByteClass(overlay, offset) {
  const idx = overlay.rangeIndex[offset];
  if (idx === OVERLAY_NONE) return "";
  const range = overlay.ranges[idx];
  const parts = ["mapped"];
  if (range.kind === "preserve") parts.push("kind-preserve");
  else if (range.group) parts.push(`group-${range.group}`);
  parts.push(`status-${statusName(overlay.status[offset])}`);
  if (hexSelected === FLASH_BASE + offset) parts.push("selected");
  return parts.join(" ");
}

function renderHexRowsHtml(startRow, endRow) {
  if (!hexFile) return "";
  const overlay = hexFile.overlay;
  const image = hexFile.image;
  const mode = hexMode;
  const bpr = bytesPerRow(mode);
  const rows = [];
  for (let row = startRow; row < endRow; row++) {
    const off = row * bpr;
    const addr = FLASH_BASE + off;
    const cells = [];
    let ascii = "";
    for (let i = 0; i < bpr; i++) {
      const pos = off + i;
      const value = image[pos];
      const cls = hexByteClass(overlay, pos);
      cells.push(
        `<span class="hex-byte ${cls}" data-hex-addr="${addr + i}">${formatDumpByte(value, mode)}</span>`,
      );
      if (mode === "hex") {
        const ch = asciiChar(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
        ascii += cls ? `<span class="mapped">${ch}</span>` : ch;
      }
    }
    const asciiCol =
      mode === "hex" ? `<span class="hex-ascii" title="${t("hexviz.ascii")}">${ascii}</span>` : "";
    rows.push(
      `<div class="hex-row"><span class="hex-addr">${hexAddr(addr)}</span><span class="hex-bytes">${cells.join("")}</span>${asciiCol}</div>`,
    );
  }
  return rows.join("");
}

function paintHexDump() {
  const viewport = app.querySelector("#hex-viewport");
  const spacer = app.querySelector("#hex-spacer");
  const rowsEl = app.querySelector("#hex-rows");
  if (!viewport || !spacer || !rowsEl || !hexFile) return;
  const totalRows = dumpRowCount(hexMode);
  spacer.style.height = `${totalRows * HEX_ROW_HEIGHT}px`;
  const viewH = viewport.clientHeight || 640;
  const start = Math.max(0, Math.floor(viewport.scrollTop / HEX_ROW_HEIGHT) - 6);
  const visible = Math.ceil(viewH / HEX_ROW_HEIGHT) + 12;
  const end = Math.min(totalRows, start + visible);
  rowsEl.style.transform = `translateY(${start * HEX_ROW_HEIGHT}px)`;
  rowsEl.innerHTML = renderHexRowsHtml(start, end);
}

function paintHexSidePanels() {
  const jump = app.querySelector("#hex-jump");
  const inspect = app.querySelector("#hex-inspect");
  if (jump) jump.innerHTML = renderHexJumpHtml();
  if (inspect) inspect.innerHTML = renderHexInspectHtml();
}

function scrollHexToAddress(address) {
  hexSelected = address;
  const viewport = app.querySelector("#hex-viewport");
  if (viewport) {
    const row = rowIndexForAddress(address, hexMode);
    const target = Math.max(0, row * HEX_ROW_HEIGHT - viewport.clientHeight / 3);
    hexScrollTop = target;
    viewport.scrollTop = target;
  }
  paintHexDump();
  paintHexSidePanels();
}

function renderHexDumpPane() {
  if (!hexFile) return "";
  return `
    <div id="hex-viewport" class="hex-viewport">
      <div id="hex-spacer" class="hex-spacer">
        <div id="hex-rows" class="hex-rows"></div>
      </div>
    </div>
  `;
}

function renderHexWorkspace() {
  if (!hexFile) {
    return `<div class="empty-state">${t("hexviz.needFile")}</div>`;
  }
  return `
        ${renderHexLegend()}
        <div class="hex-toolbar">
          <div class="mode" role="group" aria-label="${t("hexviz.modeGroup")}">
            <button type="button" data-hex-mode="hex" class="${hexMode === "hex" ? "active" : ""}" aria-pressed="${hexMode === "hex"}">${t("hexviz.modeHex")}</button>
            <button type="button" data-hex-mode="bin" class="${hexMode === "bin" ? "active" : ""}" aria-pressed="${hexMode === "bin"}">${t("hexviz.modeBin")}</button>
          </div>
          <form class="goto" id="hex-goto">
            <label>${t("hexviz.address")}
              <input id="hex-goto-input" type="text" value="${esc(hexGotoDraft)}" placeholder="0x1000881A" autocomplete="off" />
            </label>
            <button type="submit">${t("hexviz.addressGo")}</button>
          </form>
        </div>
        <div class="hex-layout">
          <aside id="hex-jump" class="hex-jump">${renderHexJumpHtml()}</aside>
          <div id="hex-dump">${renderHexDumpPane()}</div>
          <aside id="hex-inspect" class="hex-inspect">${renderHexInspectHtml()}</aside>
        </div>
  `;
}

function render() {
  applyDocumentLang();
  const lang = getLang();
  const info = downloadInfo();
  const probeText = probeStatus.text || t(probeStatus.key || (webUsbOn ? "probe.none" : "probe.useCli"));
  const wide = view === "hex";
  const gated = !loaded;
  const hideCompareStatus = compareStatus.key === "compare.needTwo";
  const hideHexStatus = hexStatus.key === "hexviz.needFile";

  app.innerHTML = `
    <div class="chrome">
      <div class="chrome-inner ${wide ? "wide" : ""}">
        <header class="topbar">
          <div>
            <h1>${t("title")}</h1>
          </div>
          <div class="lang" role="group" aria-label="${t("lang.label")}">
            <button type="button" data-lang="en" class="${lang === "en" ? "active" : ""}" aria-pressed="${lang === "en"}">${t("lang.en")}</button>
            <button type="button" data-lang="sk" class="${lang === "sk" ? "active" : ""}" aria-pressed="${lang === "sk"}">${t("lang.sk")}</button>
          </div>
        </header>
        <nav class="tabs" role="tablist">
          <button type="button" role="tab" data-view="patcher" aria-selected="${view === "patcher"}" aria-controls="view-patcher" class="${view === "patcher" ? "active" : ""}">${t("nav.patcher")}</button>
          <button type="button" role="tab" data-view="compare" aria-selected="${view === "compare"}" aria-controls="view-compare" class="${view === "compare" ? "active" : ""}">${t("nav.compare")}</button>
          <button type="button" role="tab" data-view="hex" aria-selected="${view === "hex"}" aria-controls="view-hex" class="${view === "hex" ? "active" : ""}">${t("nav.hex")}</button>
        </nav>
      </div>
    </div>
    <main class="${wide ? "wide" : ""}">
      <section id="view-patcher" role="tabpanel" ${view === "patcher" ? "" : "hidden"}>
        <p class="lede">${t("lede")}</p>
        <div class="banner">
          <strong>${t("banner.strong")}</strong>
          ${t("banner.body")}
        </div>
        ${renderDropZone({
          id: "file",
          accept: ".hex,application/octet-stream,text/plain",
          copyHtml: t("drop.hex"),
          fileName: loaded?.name || "",
          compact: Boolean(loaded),
        })}
        <div id="status" class="status ${patcherStatus.kind}" role="status" aria-live="polite">${t(patcherStatus.key, patcherStatus.vars)}</div>
        ${gated ? `<p class="editor-gate">${t("editor.needFile")}</p>` : ""}
        <div class="editor ${gated ? "gated" : ""}">
          ${renderPresetsHtml()}
          <div id="fields">${renderFieldsHtml()}</div>
        </div>
        <h2>${t("diff.title")}</h2>
        <div id="diff">${renderDiffHtml()}</div>
        <details class="how-flash">
          <summary>${t("flash.how")}</summary>
          <p class="hint">${t("probe.cliHint")}</p>
        </details>
        <section class="probe" id="probe-panel">
          <h2>${t("probe.title")}</h2>
          <p class="hint">${t("probe.cliHint")}</p>
          <p class="actions webusb-only" ${webUsbOn ? "" : "hidden"}>
            <button id="connect" type="button">${t("probe.connect")}</button>
            <button id="flash" type="button" disabled>${t("probe.flash")}</button>
            <button id="verify" type="button" disabled>${t("probe.verify")}</button>
            <button id="dump" type="button" disabled>${t("probe.dump")}</button>
          </p>
          <label class="power webusb-only" ${webUsbOn ? "" : "hidden"}>
            <input id="power" type="checkbox" />
            ${t("probe.power")}
          </label>
          <p class="hint webusb-only" ${webUsbOn ? "" : "hidden"}>
            ${t("probe.webusbHint")}
          </p>
          <div id="probe-status" class="status ${probeStatus.kind}" role="status" aria-live="polite">${probeText}</div>
        </section>
        <footer>
          <details class="tech-notes">
            <summary>${t("footer.techNotes")}</summary>
            ${mapNotes()
              .map((n) => `<p>${n}</p>`)
              .join("")}
          </details>
          ${t("footer.mapped", { label: t("firmwareLabel") })}
        </footer>
      </section>

      <section id="view-compare" role="tabpanel" ${view === "compare" ? "" : "hidden"}>
        <h2>${t("compare.title")}</h2>
        <p class="lede">${t("compare.lede")}</p>
        <div class="compare-drops">
          ${renderDropZone({
            id: "file-a",
            accept: ".hex,.bin,application/octet-stream,text/plain",
            copyHtml: t("compare.dropA"),
            fileName: compareLeft ? compareLeft.name : "",
            compact: Boolean(compareLeft),
          })}
          ${renderDropZone({
            id: "file-b",
            accept: ".hex,.bin,application/octet-stream,text/plain",
            copyHtml: t("compare.dropB"),
            fileName: compareRight ? compareRight.name : "",
            compact: Boolean(compareRight),
          })}
        </div>
        <div id="compare-status" class="status ${compareStatus.kind}" role="status" aria-live="polite" ${hideCompareStatus ? "hidden" : ""}>${t(compareStatus.key, compareStatus.vars)}</div>
        <div id="compare-result">${renderCompareResult()}</div>
      </section>

      <section id="view-hex" role="tabpanel" ${view === "hex" ? "" : "hidden"}>
        <h2>${t("hexviz.title")}</h2>
        <p class="lede">${t("hexviz.lede")}</p>
        ${
          hexFile
            ? `<div class="hex-filebar">
            <span class="file-chip">${esc(hexFile.name)}</span>
            ${renderDropZone({
              id: "file-hex",
              accept: ".hex,.bin,application/octet-stream,text/plain",
              copyHtml: t("hexviz.replace"),
              fileName: "",
              compact: true,
            })}
            <button id="hex-use-patcher" type="button" ${loaded ? "" : "disabled"}>${t("hexviz.usePatcher")}</button>
          </div>`
            : `${renderDropZone({
                id: "file-hex",
                accept: ".hex,.bin,application/octet-stream,text/plain",
                copyHtml: t("hexviz.drop"),
                fileName: "",
              })}
            <p><button id="hex-use-patcher" type="button" ${loaded ? "" : "disabled"}>${t("hexviz.usePatcher")}</button></p>`
        }
        <div id="hex-status" class="status ${hexStatus.kind}" role="status" aria-live="polite" ${hideHexStatus ? "hidden" : ""}>${t(hexStatus.key, hexStatus.vars)}</div>
        ${renderHexWorkspace()}
      </section>
    </main>
    <div class="sticky-bar" ${view === "patcher" ? "" : "hidden"}>
      <div class="sticky-inner">
        <p id="sticky-reason" class="sticky-reason">${t(info.key, info.vars)}</p>
        <button id="download" type="button" ${info.disabled ? "disabled" : ""} title="${esc(t(info.key, info.vars))}">${t("download")}</button>
      </div>
    </div>
  `;

  bind();
  applyAdvancedFilter();
  syncProbeButtons();
}

function setParamValue(id, next) {
  const spec = parameterMap.parameters.find((p) => p.id === id);
  if (!spec) return;
  if (spec.control === "checkbox") {
    values[id] = next ? 1 : 0;
  } else {
    const value = snapValue(spec, next);
    if (value == null) return;
    values[id] = value;
  }
  const sliderMin = spec.sliderMin ?? spec.min;
  const derived = isStockDerivedSlider(spec) && values[id] === 0;
  const card = app.querySelector(`[data-param="${id}"]`);
  if (card) {
    card.classList.toggle("derived", derived);
    const flag = card.querySelector(".derived-flag");
    if (derived && !flag) {
      const row = card.querySelector(".range-row");
      row?.insertAdjacentHTML("afterend", `<p class="derived-flag">${t("fields.stockDerived")}</p>`);
    } else if (!derived && flag) {
      flag.remove();
    }
  }
  for (const other of app.querySelectorAll(`#fields input[data-id="${id}"]`)) {
    if (other.type === "checkbox") {
      other.checked = Boolean(values[id]);
      continue;
    }
    if (other.type === "range") {
      other.disabled = derived;
      other.value = String(derived ? sliderMin : values[id]);
      other.setAttribute("aria-invalid", "false");
      continue;
    }
    other.value = String(values[id]);
    other.setAttribute("aria-invalid", "false");
  }
  const stockBtn = app.querySelector(`[data-stock-id="${id}"]`);
  if (stockBtn) stockBtn.classList.toggle("active", values[id] === spec.defaultValue);
  if (isPasPercentId(id)) {
    const svg = app.querySelector(".pas-chart-svg");
    if (svg) applyPasChart(svg, values);
  }
  const diff = app.querySelector("#diff");
  if (diff) diff.innerHTML = renderDiffHtml();
  syncDownload();
  syncProbeButtons();
}

function bindPasChart() {
  const svg = app.querySelector(".pas-chart-svg");
  if (!svg) return;
  let dragId = null;
  const applyFromEvent = (event) => {
    if (!dragId) return;
    setParamValue(dragId, valueFromPointer(svg, event.clientY));
  };
  svg.addEventListener("pointerdown", (event) => {
    const handle = event.target instanceof Element ? event.target.closest("[data-pas-id]") : null;
    if (!handle) return;
    dragId = handle.dataset.pasId;
    svg.setPointerCapture(event.pointerId);
    event.preventDefault();
    applyFromEvent(event);
  });
  svg.addEventListener("pointermove", applyFromEvent);
  const stopDrag = () => {
    dragId = null;
  };
  svg.addEventListener("pointerup", stopDrag);
  svg.addEventListener("pointercancel", stopDrag);
}

function bindDropZone(input, onFile) {
  if (!input) return;
  const zone = input.closest("[data-drop]");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) onFile(file);
  });
  if (!zone) return;
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
}

function bind() {
  for (const btn of app.querySelectorAll("[data-lang]")) {
    btn.addEventListener("click", () => {
      const y = window.scrollY;
      setLang(btn.dataset.lang);
      render();
      window.scrollTo(0, y);
    });
  }
  for (const btn of app.querySelectorAll("[data-view]")) {
    btn.addEventListener("click", () => {
      view = btn.dataset.view;
      render();
    });
  }
  for (const btn of app.querySelectorAll("[data-preset]")) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.preset;
      if (!id) return;
      applyPreset(id, values);
      render();
    });
  }

  const advanced = app.querySelector("details.audience.advanced");
  if (advanced) {
    advanced.addEventListener("toggle", () => {
      advancedOpen = advanced.open;
    });
  }

  const pasFine = app.querySelector("details.pas-fine");
  if (pasFine) {
    pasFine.addEventListener("toggle", () => {
      pasFineOpen = pasFine.open;
    });
  }

  const filterInput = app.querySelector("#advanced-filter");
  if (filterInput) {
    filterInput.addEventListener("input", () => {
      advancedFilter = filterInput.value;
      applyAdvancedFilter();
    });
  }
  for (const btn of app.querySelectorAll("[data-adv-filter]")) {
    btn.addEventListener("click", () => {
      advancedGroup = btn.dataset.advFilter || "";
      for (const other of app.querySelectorAll("[data-adv-filter]")) {
        other.classList.toggle("active", (other.dataset.advFilter || "") === advancedGroup);
      }
      applyAdvancedFilter();
    });
  }

  for (const input of app.querySelectorAll("#fields input[data-id]")) {
    const sync = (event) => {
      const id = input.dataset.id;
      if (!id) return;
      if (input.type === "checkbox") {
        setParamValue(id, input.checked ? 1 : 0);
        return;
      }
      if (event.type === "input" && input.type === "number" && !Number.isFinite(Number(input.value))) {
        input.setAttribute("aria-invalid", "true");
        return;
      }
      setParamValue(id, input.value);
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  }

  bindPasChart();

  for (const btn of app.querySelectorAll("[data-stock-id]")) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.stockId;
      const spec = parameterMap.parameters.find((p) => p.id === id);
      if (!id || !spec) return;
      setParamValue(id, spec.defaultValue);
    });
  }

  for (const wrap of app.querySelectorAll(".card.derived .range-wrap")) {
    wrap.addEventListener("pointerdown", () => {
      const input = wrap.querySelector("input[type=range]");
      const id = input?.dataset.id;
      const spec = parameterMap.parameters.find((p) => p.id === id);
      if (!id || !spec || values[id] !== 0) return;
      setParamValue(id, spec.sliderMin ?? spec.min);
    });
  }

  bindDropZone(app.querySelector("#file"), async (file) => {
    loadText(file.name, await file.text());
  });

  const downloadBtn = app.querySelector("#download");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      if (!loaded) return;
      try {
        const patched = applyPatches(loaded.image, values);
        const blob = new Blob([patched.serialize()], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = loaded.name.replace(/\.hex$/i, "") + "-patched.hex";
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) {
        setPatcherStatus("bad", "status.patchError", { message: errText(err) });
      }
    });
  }

  bindCompareFiles();
  bindHexView();
  bindProbe();
}

function bindCompareFiles() {
  const loadSide = async (file, side) => {
    try {
      const text = await file.text();
      const buffer = await file.arrayBuffer();
      const image = loadFirmwareBytes(file.name, text, buffer);
      const packed = { name: file.name, image };
      if (side === "a") compareLeft = packed;
      else compareRight = packed;
      compareStatus = { kind: "ok", key: "compare.loaded", vars: { name: file.name, size: String(image.length) } };
      refreshCompareStatus();
      render();
    } catch (err) {
      if (side === "a") compareLeft = null;
      else compareRight = null;
      compareStatus = { kind: "bad", key: "compare.parseError", vars: { name: file.name, message: errText(err) } };
      render();
    }
  };
  bindDropZone(app.querySelector("#file-a"), (file) => loadSide(file, "a"));
  bindDropZone(app.querySelector("#file-b"), (file) => loadSide(file, "b"));
}

function bindHexView() {
  const gotoForm = app.querySelector("#hex-goto");
  const gotoInput = app.querySelector("#hex-goto-input");
  const jump = app.querySelector("#hex-jump");
  const dump = app.querySelector("#hex-dump");

  const loadHexFile = async (file) => {
    try {
      const text = await file.text();
      const buffer = await file.arrayBuffer();
      const image = loadFirmwareBytes(file.name, text, buffer);
      setHexFile(file.name, image);
      render();
    } catch (err) {
      hexFile = null;
      hexStatus = { kind: "bad", key: "hexviz.parseError", vars: { name: file.name, message: errText(err) } };
      render();
    }
  };

  bindDropZone(app.querySelector("#file-hex"), loadHexFile);

  app.querySelector("#hex-use-patcher")?.addEventListener("click", () => {
    if (!loaded) return;
    try {
      setHexFile(loaded.name, patchedImage());
      render();
    } catch (err) {
      hexStatus = { kind: "bad", key: "status.patchError", vars: { message: errText(err) } };
      render();
    }
  });

  for (const btn of app.querySelectorAll("[data-hex-mode]")) {
    btn.addEventListener("click", () => {
      hexMode = btn.dataset.hexMode === "bin" ? "bin" : "hex";
      for (const other of app.querySelectorAll("[data-hex-mode]")) {
        const on = other.dataset.hexMode === hexMode;
        other.classList.toggle("active", on);
        other.setAttribute("aria-pressed", String(on));
      }
      if (hexSelected != null) {
        scrollHexToAddress(hexSelected);
      } else {
        paintHexDump();
      }
    });
  }

  gotoInput?.addEventListener("input", () => {
    hexGotoDraft = gotoInput.value;
  });

  gotoForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const addr = parseGotoAddress(gotoInput?.value || "");
    if (addr == null) {
      setHexStatus("bad", "hexviz.addressBad");
      return;
    }
    if (hexFile) {
      setHexStatus("ok", "hexviz.loaded", {
        name: hexFile.name,
        sites: String(hexFile.overlay.siteCount),
        changed: String(hexFile.overlay.changedByteCount),
      });
    }
    scrollHexToAddress(addr);
  });

  jump?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-hex-jump]");
    if (!btn) return;
    const addr = Number(btn.dataset.hexJump);
    if (!Number.isFinite(addr)) return;
    scrollHexToAddress(addr);
  });

  dump?.addEventListener("click", (event) => {
    const cell = event.target.closest("[data-hex-addr]");
    if (!cell) return;
    const addr = Number(cell.dataset.hexAddr);
    if (!Number.isFinite(addr)) return;
    hexSelected = addr;
    paintHexDump();
    paintHexSidePanels();
  });

  function bindHexViewport() {
    const vp = app.querySelector("#hex-viewport");
    if (!vp) return;
    vp.scrollTop = hexScrollTop;
    vp.addEventListener("scroll", () => {
      hexScrollTop = vp.scrollTop;
      paintHexDump();
    });
  }

  bindHexViewport();
  if (view === "hex") paintHexDump();
}

function bindProbe() {
  const connectBtn = app.querySelector("#connect");
  const flashBtn = app.querySelector("#flash");
  const verifyBtn = app.querySelector("#verify");
  const dumpBtn = app.querySelector("#dump");
  const powerBox = app.querySelector("#power");
  if (!webUsbOn || !connectBtn || !flashBtn || !verifyBtn || !dumpBtn || !powerBox) return;

  connectBtn.addEventListener("click", async () => {
    connectBtn.disabled = true;
    try {
      if (session) {
        await session.close();
        session = null;
      }
      session = await FlashSession.connect({
        power: powerBox.checked,
        status: (msg) => setProbeStatus("", msg),
      });
      setProbeStatus("ok", session.infoLine());
    } catch (err) {
      session = null;
      setProbeStatus("bad", errText(err));
    }
    syncProbeButtons();
  });

  flashBtn.addEventListener("click", async () => {
    if (!session) return;
    const image = patchedImage();
    if (!image) return;
    const ok = window.confirm(t("probe.confirmFlash"));
    if (!ok) return;
    flashBtn.disabled = true;
    try {
      await session.flash(image, (msg) => setProbeStatus("", msg));
      setProbeStatus("ok", t("probe.flashed", { size: String(IMAGE_SIZE), addr: hexAddr(FLASH_BASE) }));
    } catch (err) {
      setProbeStatus("bad", errText(err));
    }
    syncProbeButtons();
  });

  verifyBtn.addEventListener("click", async () => {
    if (!session) return;
    const image = patchedImage();
    if (!image) return;
    verifyBtn.disabled = true;
    try {
      await session.verify(image);
      setProbeStatus("ok", t("probe.verifyOk"));
    } catch (err) {
      setProbeStatus("bad", errText(err));
    }
    syncProbeButtons();
  });

  dumpBtn.addEventListener("click", async () => {
    if (!session) return;
    dumpBtn.disabled = true;
    try {
      const data = await session.dumpFlash((msg) => setProbeStatus("", msg));
      const hex = IntelHex.fromFlatImage(data).serialize();
      const blob = new Blob([hex], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "tsdz8-dump.hex";
      a.click();
      URL.revokeObjectURL(a.href);
      setProbeStatus("ok", t("probe.dumped", { size: String(IMAGE_SIZE) }));
    } catch (err) {
      setProbeStatus("bad", errText(err));
    }
    syncProbeButtons();
  });
}

function loadText(name, text) {
  try {
    const image = IntelHex.parse(text);
    const failures = checkOriginalBytes(image);
    if (failures.length > 0) {
      loaded = null;
      const first = failures[0];
      patcherStatus = {
        kind: "bad",
        key: "status.mismatch",
        vars: {
          name,
          addr: hexAddr(first.address),
          id: first.id,
          expected: fmtBytes(first.expected),
          actual: fmtBytes(first.actual),
        },
      };
      render();
      app.querySelector("#status")?.scrollIntoView({ block: "nearest" });
      return;
    }
    loaded = { name, image };
    patcherStatus = { kind: "ok", key: "status.ready", vars: { name, id: parameterMap.firmware.id } };
    render();
    app.querySelector("#status")?.scrollIntoView({ block: "nearest" });
  } catch (err) {
    loaded = null;
    const message = err instanceof HexError || err instanceof Error ? err.message : String(err);
    patcherStatus = { kind: "bad", key: "status.patchError", vars: { message } };
    render();
  }
}

render();
