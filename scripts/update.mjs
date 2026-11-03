// Pobiera plan z Apollo2Calendar (UEK), zapisuje site/data.json i wykrywa zmiany.
// Uruchamiane przez GitHub Actions co 5 minut. Bez zależności – wystarczy Node 20+.
import { readFile, writeFile, appendFile } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url);
const config = JSON.parse(await readFile(new URL("config.json", ROOT), "utf8"));
const DATA_PATH = new URL("site/data.json", ROOT);

const KEEP_REMOVED_DAYS = 14;   // ile dni pokazywać w aplikacji zajęcia usunięte z planu
const KEEP_CHANGES = 40;        // ile ostatnich zmian trzymać w historii
const KEEPALIVE_DAYS = 25;      // GitHub wyłącza harmonogram po 60 dniach bez commitów

// ---------- pobranie ----------
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

// Serwer UEK bywa wolny i zrywa połączenia z zagranicy – dlatego curl z długim czasem połączenia i ponowieniami.
async function getIcs() {
  if (process.env.ICS_FILE) return readFile(process.env.ICS_FILE, "utf8");
  let lastErr;
  for (let i = 1; i <= 6; i++) {
    try {
      const { stdout } = await run("curl", ["-4", "-sS", "--fail", "--connect-timeout", "45", "-m", "90",
        "-H", "Cache-Control: no-cache", "-A", "plan-zajec-github-action", config.icsUrl],
        { maxBuffer: 20 * 1024 * 1024, encoding: "utf8" });
      if (!stdout.includes("BEGIN:VCALENDAR")) throw new Error("Odpowiedź nie jest kalendarzem: " + stdout.slice(0, 80));
      if (i > 1) console.log(`Pobrano za ${i}. razem.`);
      return stdout;
    } catch (e) {
      lastErr = e;
      console.log(`Próba ${i} nieudana: ${(e.stderr || e.message || "").toString().trim().slice(0, 200)}`);
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
  throw lastErr;
}

// ---------- parsowanie ICS ----------
function unescape(v) {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
const warsawFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function toLocal(prop) {
  // zwraca "YYYY-MM-DDTHH:MM" w czasie warszawskim
  const m = prop.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (z) {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
    return warsawFmt.format(dt).replace(" ", "T");
  }
  return `${y}-${mo}-${d}T${h}:${mi}`;
}
function parseIcs(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(";");
    cur[name] = { value: line.slice(i + 1), params };
  }
  return out;
}

const DOW = ["nd", "pn", "wt", "śr", "cz", "pt", "sb"];
function normalize(raw) {
  const summary = unescape(raw.SUMMARY?.value || "").trim();
  const m = summary.match(/^(.*?)\s*\(([^()\s]+)\s+(\d+\/\d+)\)\s*$/);
  const subject = (m ? m[1] : summary).trim();
  const kind = m ? m[2] : "";
  const no = m ? m[3] : "";
  const desc = unescape(raw.DESCRIPTION?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
  const notes = [];
  let teacher = "";
  for (const l of desc) {
    const u = l.match(/^Uwagi:\s*(.*)$/i);
    if (u) notes.push(u[1].trim()); else if (!teacher) teacher = l; else notes.push(l);
  }
  let room = unescape(raw.LOCATION?.value || "").replace(/\s{2,}/g, " ").trim();
  if (room === ".") room = "";
  const start = toLocal(raw.DTSTART);
  const end = toLocal(raw.DTEND);
  return { start, end, subject, kind, no, room, teacher, note: notes.join(" ") };
}

function selectMine(ev) {
  if (ev.subject !== "Język obcy I") return ev;
  const d = new Date(ev.start + ":00");
  const time = ev.start.slice(11, 16);
  const slot = config.lektoraty.find(s => s.day === DOW[d.getDay()] && s.time === time);
  if (!slot) return null;
  return { ...ev, subject: `Język obcy I · ${slot.label}`, room: ev.room.startsWith("http") ? "" : ev.room };
}

// ---------- porównanie ----------
const keyOf = e => `${e.start}|${e.subject}`;
const fmtDay = s => {
  const d = new Date(s + ":00");
  return `${DOW[d.getDay()]} ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const KIND = { wyk: "wykład", "ćw": "ćwiczenia", lek: "lektorat", kon: "konwersatorium", egz: "egzamin", przen: "przeniesione" };
const label = e => `${e.subject}${e.kind && e.kind !== "przen" ? ` (${KIND[e.kind] || e.kind})` : ""}, ${fmtDay(e.start)} ${e.start.slice(11)}`;

function diff(oldEvents, newEvents, nowLocal) {
  const changes = [];
  const oldMap = new Map(oldEvents.filter(e => !e.removed).map(e => [keyOf(e), e]));
  const newMap = new Map(newEvents.map(e => [keyOf(e), e]));
  const future = e => e.end > nowLocal;
  for (const [k, n] of newMap) {
    const o = oldMap.get(k);
    if (!o) { if (future(n)) changes.push(`Nowe: ${label(n)}${n.room ? ` – ${n.room}` : ""}`); continue; }
    if (!future(n)) continue;
    if (n.kind === "przen" && o.kind !== "przen") { changes.push(`Przeniesione: ${label(o)}${n.note ? ` → ${n.note}` : ""}`); continue; }
    const parts = [];
    if (o.end !== n.end) parts.push(`koniec ${o.end.slice(11)} → ${n.end.slice(11)}`);
    if (o.room !== n.room) parts.push(`sala ${o.room || "–"} → ${n.room || "–"}`);
    if (o.kind !== n.kind) parts.push(`typ ${KIND[o.kind] || o.kind} → ${KIND[n.kind] || n.kind}`);
    if (o.teacher !== n.teacher) parts.push(`prowadzący ${n.teacher || "–"}`);
    if (o.note !== n.note && n.note) parts.push(`uwaga: ${n.note}`);
    if (parts.length) changes.push(`Zmiana: ${label(n)} – ${parts.join(", ")}`);
  }
  for (const [k, o] of oldMap) if (!newMap.has(k) && future(o)) changes.push(`Usunięte z planu: ${label(o)}`);
  return changes;
}

// ---------- główny przebieg ----------
const now = new Date();
const nowLocal = warsawFmt.format(now).replace(" ", "T");
const nowIso = now.toISOString();

let prev = null;
try { prev = JSON.parse(await readFile(DATA_PATH, "utf8")); } catch {}
if (prev && prev.reset) prev = null; // nowy punkt odniesienia, bez zgłaszania zmian

let icsText;
try { icsText = await getIcs(); }
catch (e) {
  // nie oznaczamy uruchomienia jako błąd (GitHub wysyłałby maila co 5 minut) – spróbujemy za 5 minut
  console.log("::warning::Serwer UEK nie odpowiedział, plan zostaje bez zmian. Kolejna próba za kilka minut.");
  process.exit(0);
}
const parsed = parseIcs(icsText).map(normalize).filter(e => e.start && e.end);
if (parsed.length < 20) throw new Error(`Podejrzanie mało zajęć (${parsed.length}) – nie nadpisuję planu.`);
const events = parsed.map(selectMine).filter(Boolean).sort((a, b) => a.start.localeCompare(b.start) || a.subject.localeCompare(b.subject));

const changes = prev ? diff(prev.events, events, nowLocal) : [];
const removedCount = changes.filter(c => c.startsWith("Usunięte")).length;
const futureCount = (prev?.events || []).filter(e => !e.removed && e.end > nowLocal).length;
if (removedCount > 10 && removedCount > futureCount * 0.2) {
  // prawie na pewno chwilowy błąd serwera UEK (np. obcięty kalendarz) – nie nadpisujemy planu
  console.log(`::warning::Podejrzanie dużo usuniętych zajęć (${removedCount}) – pomijam tę aktualizację.`);
  process.exit(0);
}

// zajęcia, które zniknęły z planu – zostają widoczne jako przekreślone przez KEEP_REMOVED_DAYS
const newKeys = new Set(events.map(keyOf));
const cutoff = new Date(now.getTime() - KEEP_REMOVED_DAYS * 864e5).toISOString();
const removed = [];
if (prev) {
  for (const o of prev.events) {
    if (newKeys.has(keyOf(o)) || o.end <= nowLocal) continue;
    if (o.removed) { if (o.removedAt > cutoff) removed.push(o); }
    else removed.push({ ...o, removed: true, removedAt: nowIso });
  }
}

const stripMeta = list => JSON.stringify(list.map(({ changedAt, ...e }) => e));
// znacznik „zmienione niedawno” dla aplikacji
const prevMap = new Map((prev?.events || []).filter(e => !e.removed).map(e => [keyOf(e), e]));
const finalEvents = [...events.map(e => {
  const o = prevMap.get(keyOf(e));
  if (!prev) return e;
  if (!o) return { ...e, changedAt: nowIso };
  const same = o.end === e.end && o.room === e.room && o.kind === e.kind && o.teacher === e.teacher && o.note === e.note;
  if (!same) return { ...e, changedAt: nowIso };
  return o.changedAt && o.changedAt > cutoff ? { ...e, changedAt: o.changedAt } : e;
}), ...removed].sort((a, b) => a.start.localeCompare(b.start) || a.subject.localeCompare(b.subject));

const dataChanged = !prev || stripMeta(prev.events) !== stripMeta(finalEvents) || changes.length > 0;
const lastCommitAge = prev ? (now - new Date(prev.savedAt)) / 864e5 : Infinity;
const keepalive = !dataChanged && lastCommitAge > KEEPALIVE_DAYS;

const out = {
  group: config.group,
  savedAt: dataChanged || keepalive ? nowIso : prev.savedAt,
  lastChangeAt: changes.length ? nowIso : (prev?.lastChangeAt || null),
  changes: [...changes.map(text => ({ at: nowIso, text })), ...(prev?.changes || [])].slice(0, KEEP_CHANGES),
  events: finalEvents,
};

if (dataChanged || keepalive || !prev) {
  await writeFile(DATA_PATH, JSON.stringify(out, null, 1) + "\n");
}

console.log(`Zajęć w planie: ${events.length}. Zmian: ${changes.length}.`);
changes.forEach(c => console.log(" • " + c));

// powiadomienie ntfy
if (changes.length && config.ntfyTopic) {
  const body = changes.slice(0, 8).join("\n") + (changes.length > 8 ? `\n…i ${changes.length - 8} więcej` : "");
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(config.ntfyTopic)}`, {
      method: "POST",
      body,
      headers: {
        Title: `Zmiana w planie ${config.group}`.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l"),
        Tags: "calendar",
        ...(config.appUrl ? { Click: config.appUrl } : {}),
      },
    });
  } catch (e) { console.log("Nie udało się wysłać powiadomienia:", e.message); }
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `changed=${dataChanged || keepalive || !prev}\n`);
}
