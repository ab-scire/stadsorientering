// Stadsorientering – GPS-tracker. Statisk sida, ingen server: spåret sparas i telefonen (IndexedDB)
// och lämnar den bara när deltagaren själv delar GPX-filen.

// Byt före arrangemanget.
const ORGANISER_EMAIL = "orientering@exempel.se";

const MAX_ACCURACY = 30;    // m. Sämre punkter sparas inte, men visas i GPS-statusen.
const MAX_SPEED = 12;       // m/s. Snabbare hopp mellan två punkter räknas som GPS-fel.
const STALE_AFTER = 15000;  // ms utan läsning innan statusen blir "Ingen GPS".
const GAP_AFTER = 20000;    // ms mellan två punkter som räknas som glapp i spåret.
const START_ANYWAY_AFTER = 20000;
const HOLD_TIME = 2000;     // ms att hålla in för att låsa upp fickläget.
const SIMULATE = Number(new URLSearchParams(location.search).get("simulate")) || 0;

const $ = (id) => document.getElementById(id);

let db = null;
let track = null;
const gps = { state: "off", fix: null, startedAt: 0, permission: "unknown" }; // state: off | on | denied | unsupported
let watchId = null;
let simulationId = null;
let wakeLock = null;
let pocketTimer = null;
let ignoreTapsUntil = 0;

// ---------------------------------------------------------------- lagring

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB saknas")); return; }
    const request = indexedDB.open("stadsorientering-tracker", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("tracks", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB blockerad"));
  });
}

function storeRequest(mode, run) {
  if (!db) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = run(db.transaction("tracks", mode).objectStore("tracks"));
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

const readTrack = () => storeRequest("readonly", (store) => store.get("active"));
const deleteTrack = () => storeRequest("readwrite", (store) => store.delete("active"));

function saveTrack() {
  if (!track) return Promise.resolve();
  return storeRequest("readwrite", (store) => store.put(track)).catch((error) => {
    console.warn("Kunde inte spara spåret", error);
    $("storage-warning").hidden = false;
  });
}

// Äldre sparade poster saknar några fält. De får standardvärden.
function normalise(saved) {
  return {
    id: "active", name: "", activity: "Till fots", startedAt: Date.now(), endedAt: null, active: false, exported: false, gaps: 0,
    ...saved,
    points: Array.isArray(saved?.points) ? saved.points : [],
  };
}

function rememberName(name) {
  try { localStorage.setItem("stadsorientering-name", name); } catch { /* privat läge */ }
}

function selectedActivity() {
  return document.querySelector('input[name="activity"]:checked')?.value || "Till fots";
}

// ---------------------------------------------------------------- format

const pad = (value) => String(value).padStart(2, "0");

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

const formatDistance = (metres) => (metres / 1000).toFixed(2).replace(".", ",");

function formatAge(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${pad(seconds % 60)} min`;
}

function haversine(a, b) {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

function trackDistance() {
  if (!track) return 0;
  let sum = 0;
  for (let i = 1; i < track.points.length; i++) sum += haversine(track.points[i - 1], track.points[i]);
  return sum;
}

// ---------------------------------------------------------------- GPS-status

const hasGoodFix = () => !!gps.fix && gps.fix.accuracy <= MAX_ACCURACY && Date.now() - gps.fix.receivedAt <= STALE_AFTER;

function gpsStatus() {
  if (gps.state === "off") return { text: "GPS av", level: "" };
  if (gps.state === "unsupported") return { text: "GPS saknas", level: "bad" };
  if (gps.state === "denied") return { text: "GPS nekad", level: "bad" };
  if (!gps.fix) return { text: "Söker GPS…", level: "searching" };
  if (Date.now() - gps.fix.receivedAt > STALE_AFTER) return { text: "Ingen GPS", level: "bad" };
  const metres = Math.round(gps.fix.accuracy);
  if (metres <= 10) return { text: `GPS ±${metres} m`, level: "good" };
  if (metres <= MAX_ACCURACY) return { text: `GPS ±${metres} m`, level: "warn" };
  return { text: `GPS svag ±${metres} m`, level: "bad" };
}

function gpsHint(status) {
  if (status.level === "searching") return "Första positionen kan ta upp till en minut.";
  if (status.level === "good") return "Bra GPS.";
  if (status.level === "warn") return "Godkänd. Brukar bli bättre efter en stund.";
  if (gps.fix && status.text === "Ingen GPS") return "Ingen position på en stund. Är platstjänster på?";
  return "För svag. Gå ut i det fria, en bit från höga hus.";
}

// Vad deltagaren ska göra härnäst på startsidan. Stegen motsvarar listan "Så går det till".
function nextStep() {
  if (gps.state === "unsupported") return { step: 2, text: "GPS:en går inte att använda här. Se hjälpen nedan.", problem: true };
  if (gps.state === "denied") return { step: 3, text: "Platsåtkomst är nekad. Följ hjälpen nedan och försök igen.", problem: true };
  if (!$("name").value.trim()) return { step: 1, text: "Skriv ditt namn." };
  if (gps.state === "off") return { step: 2, text: "Tryck på Slå på GPS." };
  if (!gps.fix) {
    const askedLongAgo = Date.now() - gps.startedAt > 8000;
    return gps.permission === "granted" || askedLongAgo || SIMULATE
      ? { step: 4, text: "Söker GPS-position. Stå utomhus, gärna en bit från höga hus." }
      : { step: 3, text: "Tryck på Tillåt när telefonen frågar om platsåtkomst." };
  }
  if (!hasGoodFix()) return { step: 4, text: `Väntar på bättre GPS. Behöver ±${MAX_ACCURACY} m eller bättre.` };
  return { step: 5, text: "Klart! Tryck på Starta rundan.", ready: true };
}

// ---------------------------------------------------------------- rendering

function show(view) {
  for (const name of ["start", "resume", "running", "export"]) $(`${name}-view`).hidden = name !== view;
  window.scrollTo(0, 0);
}

function paintChip(id, status) {
  const chip = $(id);
  chip.textContent = status.text;
  chip.className = `gps-chip ${status.level}${id === "start-gps" ? " gps-chip--large" : ""}`;
}

function renderStart(status) {
  const next = nextStep();
  $("next-step-number").textContent = next.ready ? "✓" : next.step;
  $("next-step-text").textContent = next.text;
  $("next-step").classList.toggle("is-ready", !!next.ready);
  $("next-step").classList.toggle("is-problem", !!next.problem);
  [...$("guide-steps").children].forEach((item, index) => {
    const step = index + 1;
    item.classList.toggle("is-done", step < next.step);
    item.classList.toggle("is-current", step === next.step);
    if (step === next.step) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
  });

  const on = gps.state === "on";
  $("gps-on").disabled = on;
  $("gps-on").textContent = on ? "GPS är på" : "Slå på GPS";
  $("gps-live").hidden = !on;
  $("gps-hint").textContent = on ? gpsHint(status) : "";

  $("start").classList.toggle("is-waiting", !next.ready);
  $("start").setAttribute("aria-disabled", String(!next.ready));
  $("start-anyway").hidden = !(on && !hasGoodFix() && $("name").value.trim() && Date.now() - gps.startedAt > START_ANYWAY_AFTER);
}

function renderRace() {
  const elapsed = (track.endedAt || Date.now()) - track.startedAt;
  const distance = formatDistance(trackDistance());
  $("elapsed").textContent = formatTime(elapsed);
  $("pocket-time").textContent = formatTime(elapsed);
  $("distance").textContent = distance;
  $("pocket-distance").textContent = `${distance} km`;
  $("point-count").textContent = track.points.length;
  const last = track.points.at(-1);
  const age = last ? Date.now() - last.time : null;
  $("last-point").textContent = last ? `Senaste punkt för ${formatAge(age)} sedan` : "Ingen sparad punkt ännu";
  $("last-point").classList.toggle("is-old", age !== null && age > STALE_AFTER);
}

function render() {
  const status = gpsStatus();
  for (const id of ["top-gps", "start-gps", "run-gps", "pocket-gps"]) paintChip(id, status);
  if (!$("start-view").hidden) renderStart(status);
  if (track) renderRace();
}

// ---------------------------------------------------------------- fel och hjälp

function showGpsHelp(message, { settings = false, retry = true } = {}) {
  $("gps-help-text").textContent = message;
  $("gps-help-settings").hidden = !settings;
  $("gps-retry").hidden = !retry;
  $("gps-help").hidden = !message;
}

function runError(message) {
  for (const id of ["run-error", "pocket-error"]) {
    $(id).textContent = message;
    $(id).hidden = !message;
  }
}

function onGpsError(error) {
  let message;
  if (error.code === 1) {
    stopGps();
    gps.state = "denied";
    message = "Platsåtkomst är nekad för den här sidan. Tillåt plats och tryck på Försök igen.";
    showGpsHelp(message, { settings: true });
  } else if (error.code === 2) {
    message = "Telefonen hittar ingen position. Kontrollera att Platstjänster (iPhone) eller Plats (Android) är påslaget. Sidan fortsätter leta.";
    if (!track?.active) showGpsHelp(message, { settings: true });
  } else {
    // Timeout: watchPosition fortsätter leta av sig själv.
    message = "GPS:en har inte hittat någon position på 20 sekunder. Gå utomhus och vänta, sidan fortsätter leta.";
    if (!track?.active) showGpsHelp(message, { retry: false });
  }
  if (track?.active) runError(message);
  render();
}

// ---------------------------------------------------------------- GPS-livscykel

function onPosition(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const time = position.timestamp || Date.now();
  gps.fix = { accuracy, receivedAt: Date.now() };
  if (gps.state !== "denied") showGpsHelp("");
  runError("");

  if (track?.active && accuracy <= MAX_ACCURACY) addPoint({ latitude, longitude, accuracy, time });
  render();
}

function addPoint(point) {
  const previous = track.points.at(-1);
  if (previous) {
    if (point.time <= previous.time) return;
    const seconds = (point.time - previous.time) / 1000;
    if (haversine(previous, point) / seconds > MAX_SPEED) return;
    if (point.time - previous.time > GAP_AFTER) {
      track.gaps += 1;
      $("gap-text").textContent = `GPS:en var borta i ${formatTime(point.time - previous.time)}. Spåret har ett glapp där.`;
      $("gap-note").hidden = false;
    }
  }
  track.points.push(point);
  saveTrack();
}

function startGps() {
  if (watchId !== null || simulationId !== null) return;
  showGpsHelp("");
  gps.fix = null;
  gps.startedAt = Date.now();

  if (SIMULATE) {
    gps.state = "on";
    startSimulation(SIMULATE);
  } else if (!window.isSecureContext) {
    gps.state = "unsupported";
    showGpsHelp("GPS fungerar bara när sidan öppnas via en https-adress. Använd länken från arrangören.", { retry: false });
  } else if (!("geolocation" in navigator)) {
    gps.state = "unsupported";
    showGpsHelp("Den här webbläsaren kan inte använda GPS. Prova Safari eller Chrome.", { retry: false });
  } else {
    gps.state = "on";
    try {
      watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    } catch (error) {
      gps.state = "unsupported";
      showGpsHelp(`GPS:en kunde inte startas (${error.message}).`);
    }
  }
  render();
}

function stopGps() {
  if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
  if (simulationId !== null) clearInterval(simulationId);
  watchId = null;
  simulationId = null;
  gps.state = "off";
}

// Webbläsaren kan tappa GPS:en när skärmen varit släckt. Starta om bevakningen om den tystnat.
function restartGpsIfSilent() {
  if (!track?.active || gps.state !== "on") return;
  if (gps.fix && Date.now() - gps.fix.receivedAt < STALE_AFTER) return;
  stopGps();
  startGps();
}

async function watchPermission() {
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    gps.permission = status.state;
    status.onchange = () => { gps.permission = status.state; render(); };
  } catch { /* Permissions API saknas – vi får veta via watchPosition */ }
}

// Simulering går genom samma onPosition/onGpsError som riktig GPS.
// ?simulate=1: bra GPS. ?simulate=2: svag GPS först och ett avbrott under aktiviteten. ?simulate=3: nekad platsåtkomst.
function startSimulation(mode) {
  if (mode === 3) { setTimeout(() => onGpsError({ code: 1 }), 800); simulationId = -1; return; }
  const route = [[57.1050, 12.2500], [57.1053, 12.2508], [57.1058, 12.2512], [57.1063, 12.2507], [57.1065, 12.2517], [57.1060, 12.2525], [57.1053, 12.2521], [57.1049, 12.2513]];
  let tick = 0;
  const emit = () => {
    const sinceGps = Date.now() - gps.startedAt;
    const racing = track?.active ? Date.now() - track.startedAt : 0;
    if (mode === 2 && racing > 60000 && racing < 85000) return;
    const weak = mode === 2 && sinceGps < 12000;
    const leg = Math.floor(tick / 4) % route.length;
    const [a, b] = [route[leg], route[(leg + 1) % route.length]];
    const f = (tick % 4) / 4;
    const noise = () => (Math.random() - .5) * .00002;
    tick += 1;
    onPosition({
      coords: { latitude: a[0] + (b[0] - a[0]) * f + noise(), longitude: a[1] + (b[1] - a[1]) * f + noise(), accuracy: weak ? 45 : 4 + Math.random() * 4 },
      timestamp: Date.now(),
    });
  };
  setTimeout(emit, 1200);
  simulationId = setInterval(emit, 2000);
}

// ---------------------------------------------------------------- skärmlås

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) { $("wake-note").hidden = false; return; }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
    $("wake-note").hidden = true;
  } catch (error) {
    console.warn("Wake Lock nekades", error);
    $("wake-note").hidden = false;
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------------------------------------------------------------- aktiviteten

function startRace(force = false) {
  const name = $("name").value.trim();
  if (!force && !nextStep().ready) {
    // Knappen ser inaktiv ut men svarar ändå, så att deltagaren ser vad som saknas.
    const box = $("next-step");
    box.classList.remove("is-nudged");
    void box.offsetWidth;
    box.classList.add("is-nudged");
    if (!name) $("name").focus();
    return;
  }
  if (!name) { $("name").focus(); return; }
  requestWakeLock(); // direkt i klicket, innan något annat väntar
  rememberName(name);
  track = normalise({ name, activity: selectedActivity(), startedAt: Date.now(), active: true });
  saveTrack();
  runError("");
  $("gap-note").hidden = true;
  show("running");
  render();
  clearTimeout(pocketTimer);
  pocketTimer = setTimeout(showPocket, 1500);
}

function continueRace() {
  requestWakeLock();
  track.active = true;
  track.endedAt = null;
  saveTrack();
  show("running");
  startGps();
  render();
}

async function finishRace() {
  if (!track) return;
  clearTimeout(pocketTimer);
  stopGps();
  releaseWakeLock();
  $("pocket").hidden = true;
  track.active = false;
  track.endedAt ||= Date.now();
  await saveTrack();
  showExport();
}

// Kräver två tryck inom 3 s. Används för allt som avslutar eller raderar.
function confirmTap(button, question, action) {
  if (Date.now() < ignoreTapsUntil) return;
  if (button.dataset.confirming) {
    clearTimeout(Number(button.dataset.confirming));
    delete button.dataset.confirming;
    button.textContent = button.dataset.label;
    button.classList.remove("is-confirming");
    action();
    return;
  }
  button.dataset.label ||= button.textContent;
  button.textContent = question;
  button.classList.add("is-confirming");
  button.dataset.confirming = String(setTimeout(() => {
    delete button.dataset.confirming;
    button.textContent = button.dataset.label;
    button.classList.remove("is-confirming");
  }, 3000));
}

// ---------------------------------------------------------------- export

function showExport() {
  show("export");
  const elapsed = (track.endedAt || Date.now()) - track.startedAt;
  const cells = [[formatTime(elapsed), "Tid"], [`${formatDistance(trackDistance())} km`, "Sträcka"], [track.points.length, "Punkter"], [track.gaps || 0, "GPS-glapp"], [track.activity, "Sätt"]];
  $("summary").replaceChildren(...cells.map(([value, label]) => {
    const cell = document.createElement("div");
    cell.append(Object.assign(document.createElement("b"), { textContent: value }), Object.assign(document.createElement("span"), { textContent: label }));
    return cell;
  }));
  $("email").textContent = ORGANISER_EMAIL;
  $("already-sent").hidden = !track.exported;
}

const xmlEscape = (value) => value.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

function gpxFile() {
  const name = xmlEscape(track.name);
  const points = track.points.map((p) => `<trkpt lat="${p.latitude}" lon="${p.longitude}"><time>${new Date(p.time).toISOString()}</time><hdop>${p.accuracy.toFixed(1)}</hdop></trkpt>`).join("");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Stadsorientering GPS-tracker" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${name}</name><time>${new Date(track.startedAt).toISOString()}</time></metadata><trk><name>${name}</name><trkseg>${points}</trkseg></trk></gpx>`;
  const start = new Date(track.startedAt);
  const stamp = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}T${pad(start.getHours())}${pad(start.getMinutes())}`;
  const safeName = track.name.trim().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "") || "lopare";
  return new File([gpx], `${safeName}_${stamp}.gpx`, { type: "application/gpx+xml" });
}

async function markExported() {
  track.exported = true;
  await saveTrack();
  showExport();
}

async function shareFile() {
  const file = gpxFile();
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      await markExported();
    } catch (error) {
      if (error.name !== "AbortError") downloadFile(); // Avbryt i delningsmenyn ska inte ladda ned
    }
    return;
  }
  downloadFile();
}

function downloadFile() {
  const file = gpxFile();
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: file.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  markExported();
}

async function copyEmail() {
  try {
    await navigator.clipboard.writeText(ORGANISER_EMAIL);
    $("copy-email").textContent = "Kopierad";
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("email"));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    $("copy-email").textContent = "Markerad – kopiera";
  }
  setTimeout(() => { $("copy-email").textContent = "Kopiera adress"; }, 2500);
}

async function newTrack() {
  await deleteTrack();
  track = null;
  $("name").value = "";
  document.querySelector('input[name="activity"][value="Till fots"]').checked = true;
  rememberName("");
  show("start");
  render();
}

// ---------------------------------------------------------------- fickläge

const hold = { id: null, startedAt: 0, frame: 0 };

function showPocket() {
  if (track?.active) $("pocket").hidden = false;
}

function beginHold(event) {
  if (hold.id !== null) return;
  event.preventDefault();
  const button = $("hold-unlock");
  hold.id = event.pointerId ?? "tangent";
  hold.startedAt = performance.now();
  if (event.pointerId !== undefined) { try { button.setPointerCapture(event.pointerId); } catch { /* finns inte överallt */ } }
  button.classList.add("is-holding");
  $("hold-label").textContent = "Håll kvar…";
  const step = (now) => {
    const fraction = Math.min(1, (now - hold.startedAt) / HOLD_TIME);
    $("hold-progress").style.transform = `scaleX(${fraction})`;
    if (fraction >= 1) { endHold(); unlockPocket(); return; }
    hold.frame = requestAnimationFrame(step);
  };
  hold.frame = requestAnimationFrame(step);
}

function cancelHold(event) {
  if (hold.id === null) return;
  if (event?.pointerId !== undefined && event.pointerId !== hold.id) return;
  endHold();
}

function endHold() {
  cancelAnimationFrame(hold.frame);
  hold.id = null;
  $("hold-unlock").classList.remove("is-holding");
  $("hold-progress").style.transform = "scaleX(0)";
  $("hold-label").textContent = "Håll in 2 sekunder för att låsa upp";
}

function unlockPocket() {
  $("pocket").hidden = true;
  ignoreTapsUntil = Date.now() + 800; // fingret som släpps får inte trycka på något under lagret
}

function initialisePocket() {
  const pocket = $("pocket");
  const button = $("hold-unlock");
  // Stoppa markering, förstoringsglas, kontextmeny och spökklick i hela lagret.
  pocket.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
  pocket.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
  for (const type of ["contextmenu", "selectstart", "dragstart", "dblclick"]) pocket.addEventListener(type, (event) => event.preventDefault());

  button.addEventListener("pointerdown", beginHold);
  for (const type of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"]) button.addEventListener(type, cancelHold);
  button.addEventListener("keydown", (event) => { if ((event.key === " " || event.key === "Enter") && !event.repeat) beginHold(event); });
  button.addEventListener("keyup", () => cancelHold());
  addEventListener("blur", () => cancelHold());
}

// ---------------------------------------------------------------- start

function initialiseEvents() {
  $("name").addEventListener("input", render);
  $("name").addEventListener("change", () => rememberName($("name").value.trim()));
  $("name").addEventListener("keydown", (event) => { if (event.key === "Enter") $("name").blur(); });
  $("gps-on").addEventListener("click", startGps);
  $("gps-retry").addEventListener("click", () => { stopGps(); startGps(); });
  $("start").addEventListener("click", () => startRace());
  $("start-anyway").addEventListener("click", () => startRace(true));
  $("resume").addEventListener("click", continueRace);
  $("resume-stop").addEventListener("click", (event) => confirmTap(event.currentTarget, "Tryck igen för att avsluta", finishRace));
  $("pocket-on").addEventListener("click", () => { if (Date.now() >= ignoreTapsUntil) showPocket(); });
  $("stop").addEventListener("click", (event) => confirmTap(event.currentTarget, "Tryck igen för att avsluta", finishRace));
  $("close-gap").addEventListener("click", () => { $("gap-note").hidden = true; });
  $("share").addEventListener("click", shareFile);
  $("download").addEventListener("click", downloadFile);
  $("copy-email").addEventListener("click", copyEmail);
  $("new-track").addEventListener("click", (event) => {
    if (track?.exported) newTrack();
    else confirmTap(event.currentTarget, "Spåret är inte skickat. Tryck igen för att radera det.", newTrack);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { cancelHold(); saveTrack(); return; }
    if (track?.active) { requestWakeLock(); restartGpsIfSilent(); }
    render();
  });
  addEventListener("pagehide", () => saveTrack());
  addEventListener("beforeunload", (event) => { if (track?.active) { event.preventDefault(); event.returnValue = ""; } });
  setInterval(render, 1000);
}

async function initialise() {
  // Knapparna kopplas in först, så att sidan fungerar även om lagringen strular.
  initialiseEvents();
  initialisePocket();
  $("sim-pill").hidden = !SIMULATE;
  $("email").textContent = ORGANISER_EMAIL;
  try { $("name").value = localStorage.getItem("stadsorientering-name") || ""; } catch { /* privat läge */ }
  watchPermission();
  render();

  let saved = null;
  try {
    db = await openDatabase();
    saved = await readTrack();
  } catch (error) {
    console.warn("Lagringen fungerar inte", error);
    $("storage-warning").hidden = false;
  }
  if (!saved) { show("start"); render(); return; }

  track = normalise(saved);
  if (track.active) {
    $("resume-info").textContent = `${track.name} · ${track.activity} · ${formatTime(Date.now() - track.startedAt)} sedan start · ${track.points.length} sparade punkter.`;
    show("resume");
  } else {
    showExport(); // Ett avslutat spår visas alltid före startsidan, så att det inte tappas bort.
  }
  render();
}

initialise();
