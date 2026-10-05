import en from "./locales/en.json?v=29" with { type: "json" };
import sk from "./locales/sk.json?v=29" with { type: "json" };

const catalogs = { en, sk };
const STORAGE_KEY = "tsdz8-lang";

function lookup(catalog, key) {
  if (!catalog) return undefined;
  if (Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
  return undefined;
}

export function detectLang() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "sk") return stored;
  } catch {
    /* ignore */
  }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en") || "en";
  return nav.toLowerCase().startsWith("sk") ? "sk" : "en";
}

let current = detectLang();

export function getLang() {
  return current;
}

export function setLang(lang) {
  current = lang === "sk" ? "sk" : "en";
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch {
    /* ignore */
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = current;
  }
}

export function t(key, vars = {}) {
  const raw = lookup(catalogs[current], key) ?? lookup(catalogs.en, key) ?? key;
  if (typeof raw !== "string") return key;
  return raw.replace(/\{(\w+)\}/g, (_, name) =>
    vars[name] === undefined || vars[name] === null ? `{${name}}` : String(vars[name]),
  );
}

export function paramText(id, field) {
  const langParams = catalogs[current]?.parameters?.[id];
  const enParams = catalogs.en?.parameters?.[id];
  return langParams?.[field] ?? enParams?.[field] ?? "";
}

export function mapNotes() {
  const notes = catalogs[current]?.mapNotes ?? catalogs.en.mapNotes ?? [];
  return notes;
}

export function applyDocumentLang() {
  if (typeof document !== "undefined") {
    document.documentElement.lang = current;
    document.title = t("title");
  }
}

setLang(current);
