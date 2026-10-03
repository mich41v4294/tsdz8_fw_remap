import { HexError, IntelHex } from "./intelHex";
import {
  AUDIENCE_LABELS,
  GROUP_LABELS,
  GROUP_ORDER,
  parameterMap,
  parametersByAudience,
  type ParameterAudience,
  type ParameterGroup,
  type ParameterSpec,
} from "./parameterMap";
import {
  applyPatches,
  buildDiff,
  checkOriginalBytes,
  defaultValues,
  type ByteDiff,
} from "./patcher";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app missing");

let loaded: { name: string; image: IntelHex } | null = null;
const values = defaultValues();

app.innerHTML = `
  <main>
    <h1>TSDZ8 stock parameter patcher</h1>
    <p class="lede">
      Load the Tongsheng stock HEX, raise firmware ceilings, download a checksum-correct HEX.
      The VD04 still chooses the live on-road / off-road speed. Flashing is up to you (J-Link at
      <code>${parameterMap.firmware.flashBase}</code>).
    </p>
    <div class="banner">
      <strong>Off-road / private property only.</strong>
      Raising the motor speed cap can make the bike illegal on public roads and is your responsibility.
      The handlebar hold-to-toggle path is not rewritten.
    </div>
    <section class="drop">
      <div>Drop or choose <code>original firmware thonghsheng.hex</code></div>
      <input id="file" type="file" accept=".hex,application/octet-stream,text/plain" />
    </section>
    <div id="status" class="status">No file loaded.</div>
    <div id="fields"></div>
    <h2>Byte diff</h2>
    <div id="diff"></div>
    <p>
      <button id="download" type="button" disabled>Download patched HEX</button>
    </p>
    <footer>
      ${parameterMap.notes.map((n) => `<p>${n}</p>`).join("")}
      Mapped firmware: ${parameterMap.firmware.label}. Rider settings first; advanced FOC/protect immediates are collapsed below. UART 0x59 framing is locked.
    </footer>
  </main>
`;

const fileInput = app.querySelector<HTMLInputElement>("#file")!;
const statusEl = app.querySelector<HTMLDivElement>("#status")!;
const fieldsEl = app.querySelector<HTMLDivElement>("#fields")!;
const diffEl = app.querySelector<HTMLDivElement>("#diff")!;
const downloadBtn = app.querySelector<HTMLButtonElement>("#download")!;

function fmtBytes(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function hexAddr(addr: number): string {
  return `0x${addr.toString(16).toUpperCase()}`;
}

function setStatus(kind: "ok" | "bad" | "", text: string) {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text;
}

function renderCard(spec: ParameterSpec): string {
  const extra =
    spec.audience === "advanced" ? ` <span class="badge advanced">Advanced</span>` : "";
  const ceilingLocked = spec.id === "speed_ceiling_kmh" && values.unlimit_speed_display_60 === 1;
  const control =
    spec.control === "checkbox"
      ? `<input data-id="${spec.id}" type="checkbox" ${values[spec.id] ? "checked" : ""} />`
      : `<input data-id="${spec.id}" type="number" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${values[spec.id]}" ${ceilingLocked ? "disabled" : ""} />`;
  const lockNote = ceilingLocked
    ? " Ignored while Unlimit speed when display sends 60 is on (ceiling compare is forced allow)."
    : "";
  return `
        <article class="card ${spec.audience} ${spec.control === "checkbox" ? "toggle" : ""}">
          <label>
            <span>${spec.label}${extra}</span>
            <span>
              ${control}
              ${spec.unit}
            </span>
          </label>
          <p class="summary">${spec.summary}</p>
          <p class="notes">${spec.notes}${lockNote}</p>
        </article>`;
}

function renderAudienceGroups(audience: ParameterAudience): string {
  return GROUP_ORDER.map((group: ParameterGroup) => {
    const specs = parametersByAudience(audience).filter((p) => p.group === group);
    if (specs.length === 0) return "";
    return `<h3>${GROUP_LABELS[group]}</h3><div class="grid">${specs.map(renderCard).join("")}</div>`;
  }).join("");
}

function renderFields() {
  fieldsEl.innerHTML = `
    <section class="audience rider">
      <h2>${AUDIENCE_LABELS.rider}</h2>
      <p class="hint">Everyday speed, PAS, walk, and silent-display defaults. Checkboxes rewrite branch opcodes; number fields patch immediates.</p>
      ${renderAudienceGroups("rider")}
    </section>
    <details class="audience advanced">
      <summary>
        <h2>${AUDIENCE_LABELS.advanced}</h2>
      </summary>
      <p class="hint warn">FOC, stall, hall, PAS pulse timing, and protection constants. Wrong values can stall the motor, cut assist, or rotate commutation.</p>
      ${renderAudienceGroups("advanced")}
    </details>
  `;

  for (const input of fieldsEl.querySelectorAll<HTMLInputElement>("input[data-id]")) {
    const sync = () => {
      const id = input.dataset.id;
      if (!id) return;
      values[id] = input.type === "checkbox" ? (input.checked ? 1 : 0) : Number(input.value);
      if (id === "unlimit_speed_display_60") {
        renderFields();
        renderDiff();
        return;
      }
      renderDiff();
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  }
}

function renderDiff() {
  const diffs: ByteDiff[] = buildDiff(values);
  if (!loaded) {
    diffEl.innerHTML = "<p class='hint'>Load a HEX to preview patches.</p>";
    downloadBtn.disabled = true;
    return;
  }
  if (diffs.length === 0) {
    diffEl.innerHTML = "<p class='hint'>No changes from the stock immediates.</p>";
    downloadBtn.disabled = true;
    return;
  }
  diffEl.innerHTML = `
    <table>
      <thead><tr><th>Audience</th><th>Parameter</th><th>Address</th><th>Old</th><th>New</th></tr></thead>
      <tbody>
        ${diffs
          .map(
            (d) =>
              `<tr class="${d.audience}"><td>${d.audience === "advanced" ? "Advanced" : "Rider"}</td><td>${d.label}</td><td><code>${hexAddr(d.address)}</code></td><td><code>${fmtBytes(d.oldBytes)}</code></td><td><code>${fmtBytes(d.newBytes)}</code></td></tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;
  downloadBtn.disabled = false;
}

function loadText(name: string, text: string) {
  try {
    const image = IntelHex.parse(text);
    const failures = checkOriginalBytes(image);
    if (failures.length > 0) {
      loaded = null;
      const first = failures[0];
      setStatus(
        "bad",
        `${name} does not match this stock map at ${hexAddr(first.address)} (${first.id}). Expected ${fmtBytes(first.expected)}, found ${fmtBytes(first.actual)}.`,
      );
      renderDiff();
      return;
    }
    loaded = { name, image };
    setStatus("ok", `${name} matches ${parameterMap.firmware.id}. Ready to patch ceilings.`);
    renderDiff();
  } catch (err) {
    loaded = null;
    const message = err instanceof HexError || err instanceof Error ? err.message : String(err);
    setStatus("bad", message);
    renderDiff();
  }
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  loadText(file.name, await file.text());
});

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
    const message = err instanceof Error ? err.message : String(err);
    setStatus("bad", message);
  }
});

renderFields();
renderDiff();
