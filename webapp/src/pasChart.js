import { parameterMap } from "./parameterMap.js";
import { t } from "./i18n.js";

export const PAS_PERCENT_IDS = [
  "pas1_percent",
  "pas2_percent",
  "pas3_percent",
  "pas4_percent",
  "pas5_percent",
];

export const VIEW = { width: 640, height: 248, padL: 52, padR: 18, padT: 22, padB: 36 };

function percentSpec(id) {
  return parameterMap.parameters.find((p) => p.id === id);
}

export function percentMax() {
  return Math.max(...PAS_PERCENT_IDS.map((id) => percentSpec(id)?.max ?? 255));
}

export function isPasPercentId(id) {
  return PAS_PERCENT_IDS.includes(id);
}

export function plotRect() {
  return {
    x: VIEW.padL,
    y: VIEW.padT,
    w: VIEW.width - VIEW.padL - VIEW.padR,
    h: VIEW.height - VIEW.padT - VIEW.padB,
  };
}

export function pointFor(index, percent) {
  const plot = plotRect();
  const max = percentMax();
  const x = plot.x + (index / (PAS_PERCENT_IDS.length - 1)) * plot.w;
  const y = plot.y + (1 - percent / max) * plot.h;
  return { x, y };
}

export function clampPercent(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(percentMax(), n));
}

export function valueFromPointer(svg, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return 0;
  const pt = svg.createSVGPoint();
  pt.x = 0;
  pt.y = clientY;
  const local = pt.matrixTransform(ctm.inverse());
  const plot = plotRect();
  const t = (local.y - plot.y) / plot.h;
  return clampPercent((1 - t) * percentMax());
}

function percentsFrom(values) {
  return PAS_PERCENT_IDS.map((id) => clampPercent(values[id] ?? 0));
}

function stockPercents() {
  return PAS_PERCENT_IDS.map((id) => {
    const spec = parameterMap.parameters.find((p) => p.id === id);
    return clampPercent(spec?.defaultValue ?? 0);
  });
}

function pathD(percents) {
  return percents
    .map((percent, index) => {
      const { x, y } = pointFor(index, percent);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function labelOffset(percent) {
  return percent > percentMax() * 0.92 ? 20 : -14;
}

export function applyPasChart(svg, values) {
  const live = percentsFrom(values);
  const livePath = svg.querySelector(".pas-chart-live");
  if (livePath) livePath.setAttribute("d", pathD(live));
  for (const [index, id] of PAS_PERCENT_IDS.entries()) {
    const percent = live[index];
    const { x, y } = pointFor(index, percent);
    const handle = svg.querySelector(`[data-pas-id="${id}"]`);
    if (!handle) continue;
    handle.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    const label = handle.querySelector(".pas-value");
    if (label) {
      label.setAttribute("y", String(labelOffset(percent)));
      label.textContent = `${percent}%`;
    }
  }
}

export function pasChartSvg(values) {
  const live = percentsFrom(values);
  const stock = stockPercents();
  const plot = plotRect();
  const max = percentMax();
  const yTicks = [0, 50, 100, 150, 200].filter((tick) => tick < max);
  if (yTicks[yTicks.length - 1] !== max) yTicks.push(max);
  const grid = yTicks
    .map((tick) => {
      const y = pointFor(0, tick).y;
      return `<line class="pas-grid" x1="${plot.x}" y1="${y.toFixed(1)}" x2="${(plot.x + plot.w).toFixed(1)}" y2="${y.toFixed(1)}" /><text class="pas-axis" x="${plot.x - 8}" y="${y.toFixed(1)}" dy="0.35em" text-anchor="end">${tick}</text>`;
    })
    .join("");
  const xLabels = PAS_PERCENT_IDS.map((id, index) => {
    const x = pointFor(index, 0).x;
    return `<text class="pas-axis" x="${x.toFixed(1)}" y="${VIEW.height - 10}" text-anchor="middle">PAS ${index + 1}</text>`;
  }).join("");
  const handles = live
    .map((percent, index) => {
      const { x, y } = pointFor(index, percent);
      const id = PAS_PERCENT_IDS[index];
      return `<g class="pas-handle" data-pas-id="${id}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle class="pas-hit" r="16" /><circle class="pas-dot" r="7" /><text class="pas-value" x="0" y="${labelOffset(percent)}" text-anchor="middle">${percent}%</text></g>`;
    })
    .join("");
  return `<svg class="pas-chart-svg" viewBox="0 0 ${VIEW.width} ${VIEW.height}" role="img" aria-label="${t("pasChart.title")}">
      ${grid}
      <path class="pas-chart-stock" d="${pathD(stock)}" fill="none" />
      <path class="pas-chart-live" d="${pathD(live)}" fill="none" />
      ${xLabels}
      ${handles}
    </svg>`;
}
