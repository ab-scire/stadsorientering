// Byt före arrangemanget.
const ORGANISER_EMAIL = "orientering@exempel.se";
const MAX_ACCURACY = 30;
const MAX_SPEED = 12;
const SIMULATE = new URLSearchParams(location.search).get("simulate");
const $ = (id) => document.getElementById(id);

let track = null;
let rawFix = null;
let watchId = null;
let simulationId = null;
let wakeLock = null;
let startAnywayTimer = null;
let stopTimer = null;
let holdFrame = null;
let holdStarted = 0;

const db = await openDatabase();

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("stadsorientering-tracker", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("tracks", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readTrack() {
  return new Promise((resolve, reject) => {
    const request = db.transaction("tracks").objectStore("tracks").get("active");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function saveTrack() {
  if (!track) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = db.transaction("tracks", "readwrite").objectStore("tracks").put(track);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

function deleteTrack() {
  return new Promise((resolve, reject) => {
    const request = db.transaction("tracks", "readwrite").objectStore("tracks").delete("active");
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

function normalise(saved) {
  return { id: "active", name: "", startedAt: Date.now(), endedAt: null, points: [], active: false, exported: false, gaps: 0, ...saved, points: saved?.points || [] };
}

function show(view) {
  ["start", "resume", "running", "export"].forEach((name) => $( `${name}-view`).hidden = name !== view);
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${rest}` : `${String(minutes).padStart(2, "0")}:${rest}`;
}

function formatDistance(metres) {
  return (metres / 1000).toFixed(2).replace(".", ",");
}

function formatAge(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function haversine(a, b) {
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(value));
}

function trackDistance() {
  return track?.points.slice(1).reduce((sum, point, index) => sum + haversine(track.points[index], point), 0) || 0;
}

function gpsStatus() {
  if (watchId === null && simulationId === null) return { text: "GPS av", level: "" };
  if (!rawFix || Date.now() - rawFix.time > 15000) return { text: "Ingen GPS", level: "bad" };
  const metres = Math.round(rawFix.accuracy);
  if (metres <= 10) return { text: `GPS ±${metres} m`, level: "good" };
  if (metres <= 30) return { text: `GPS ±${metres} m`, level: "warn" };
  return { text: `GPS svag ±${metres} m`, level: "bad" };
}

function paintChip(id) {
  const chip = $(id);
  const status = gpsStatus();
  chip.textContent = status.text;
  chip.className = `gps-chip ${status.level}`;
}

function render() {
  ["top-gps", "run-gps", "pocket-gps"].forEach(paintChip);
  if (!track) return;
  const elapsed = (track.endedAt || Date.now()) - track.startedAt;
  const distance = trackDistance();
  $("elapsed").textContent = formatTime(elapsed);
  $("pocket-time").textContent = formatTime(elapsed);
  $("distance").textContent = formatDistance(distance);
  $("pocket-distance").textContent = `${formatDistance(distance)} km`;
  $("point-count").textContent = track.points.length;
  const last = track.points.at(-1);
  const age = last ? Date.now() - last.time : null;
  $("last-point").textContent = last ? `Senaste punkt för ${formatAge(age)} sedan` : "Ingen sparad punkt ännu";
  $("last-point").classList.toggle("old", age !== null && age > 15000);
}

function saveName() {
  try { localStorage.setItem("stadsorientering-name", $("name").value.trim()); } catch { /* privat läge */ }
  updateStartButton();
}

function updateStartButton() {
  const goodFix = rawFix && rawFix.accuracy <= MAX_ACCURACY;
  $("start").disabled = !($("name").value.trim() && goodFix);
}

function startError(message) {
  $("start-error").textContent = message;
  $("start-error").hidden = !message;
}

function runError(message) {
  $("run-error").textContent = message;
  $("run-error").hidden = !message;
  $("pocket-error").textContent = message;
  $("pocket-error").hidden = !message;
}

function onPosition(position) {
  const { latitude, longitude, accuracy } = position.coords;
  rawFix = { accuracy, time: position.timestamp || Date.now() };
  render();
  updateStartButton();
  if (!track?.active || accuracy > MAX_ACCURACY) return;
  const point = { latitude, longitude, accuracy, time: rawFix.time };
  const previous = track.points.at(-1);
  if (previous?.time === point.time) return;
  if (previous) {
    const elapsed = (point.time - previous.time) / 1000;
    const metres = haversine(previous, point);
    if (elapsed > 0 && metres / elapsed > MAX_SPEED) return;
    if (elapsed > 20) {
      track.gaps += 1;
      $("gap-text").textContent = `GPS:en var borta i ${formatTime(point.time - previous.time)}. Spåret har ett glapp där.`;
      $("gap-note").hidden = false;
    }
  }
  track.points.push(point);
  saveTrack();
  render();
}

function onError(error) {
  const message = error.code === 1
    ? "Platsåtkomst är avstängd. Tillåt plats för den här sidan i webbläsarens inställningar och försök igen."
    : error.code === 3 ? "GPS:en svarar inte just nu. Fortsätter försöka." : "GPS-fel. Fortsätter försöka.";
  if (track?.active) runError(message); else startError(message);
}

function startWatching() {
  if (watchId !== null || simulationId !== null) return;
  if (SIMULATE) { startSimulation(Number(SIMULATE)); return; }
  if (!navigator.geolocation) { startError("Den här webbläsaren kan inte använda GPS."); return; }
  if (!isSecureContext) { startError("Sidan måste öppnas via https för att GPS ska fungera."); return; }
  watchId = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  $("start-wait").hidden = false;
  startAnywayTimer = setTimeout(() => { if (!rawFix || rawFix.accuracy > MAX_ACCURACY) $("start-anyway").hidden = false; }, 20000);
  render();
}

function startSimulation(mode) {
  let tick = 0;
  const route = [[57.1050,12.2500],[57.1053,12.2508],[57.1058,12.2512],[57.1063,12.2507],[57.1065,12.2517],[57.1060,12.2525],[57.1053,12.2521],[57.1049,12.2513]];
  const emit = () => {
    const runningFor = track?.active ? Date.now() - track.startedAt : 0;
    if (mode === 2 && runningFor > 60000 && runningFor < 85000) return;
    const bad = mode === 2 && tick < 6;
    const index = Math.floor(tick / 4) % route.length;
    const next = route[(index + 1) % route.length];
    const fraction = (tick % 4) / 4;
    const noise = (Math.random() - .5) * .000025;
    onPosition({ coords: { latitude: route[index][0] + (next[0] - route[index][0]) * fraction + noise, longitude: route[index][1] + (next[1] - route[index][1]) * fraction + noise, accuracy: bad ? 45 : 4 + Math.random() * 4 }, timestamp: Date.now() });
    tick += 1;
  };
  emit();
  simulationId = setInterval(emit, 2000);
  $("start-wait").hidden = false;
  startAnywayTimer = setTimeout(() => { if (!rawFix || rawFix.accuracy > MAX_ACCURACY) $("start-anyway").hidden = false; }, 20000);
  render();
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) { $("wake-note").hidden = false; return; }
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { $("wake-note").hidden = false; }
}

async function startRace(force = false) {
  const name = $("name").value.trim();
  if (!name) { startError("Skriv ditt namn först."); return; }
  if (!force && (!rawFix || rawFix.accuracy > MAX_ACCURACY)) return;
  try { localStorage.setItem("stadsorientering-name", name); } catch { /* privat läge */ }
  track = normalise({ name, startedAt: Date.now(), active: true });
  await saveTrack();
  runError(""); show("running"); await requestWakeLock(); render();
  setTimeout(showPocket, 1500);
}

async function continueRace() {
  track.active = true;
  track.endedAt = null;
  await saveTrack();
  show("running"); startWatching(); await requestWakeLock(); render();
}

async function finishRace() {
  if (!track) return;
  track.active = false;
  track.endedAt ||= Date.now();
  await saveTrack();
  stopWatching();
  wakeLock?.release();
  $("pocket").hidden = true;
  showExport();
}

function stopWatching() {
  if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
  if (simulationId !== null) clearInterval(simulationId);
  watchId = null;
  simulationId = null;
}

function confirmAction(button, normal, confirm, action) {
  if (button.dataset.confirming === "yes") { clearTimeout(stopTimer); button.dataset.confirming = ""; button.textContent = normal; action(); return; }
  button.dataset.confirming = "yes"; button.textContent = confirm;
  stopTimer = setTimeout(() => { button.dataset.confirming = ""; button.textContent = normal; }, 3000);
}

function showExport() {
  show("export");
  const elapsed = (track.endedAt || Date.now()) - track.startedAt;
  $("summary").innerHTML = `<div><b>${formatTime(elapsed)}</b><span>LÖPTID</span></div><div><b>${formatDistance(trackDistance())} km</b><span>STRÄCKA</span></div><div><b>${track.points.length}</b><span>PUNKTER</span></div><div><b>${track.gaps || 0}</b><span>GPS-GLAPP</span></div>`;
  $("email").textContent = ORGANISER_EMAIL;
  $("already-sent").hidden = !track.exported;
}

function xmlEscape(value) {
  return value.replace(/[<>&'"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]);
}

function gpxFile() {
  const points = track.points.map((point) => `<trkpt lat="${point.latitude}" lon="${point.longitude}"><time>${new Date(point.time).toISOString()}</time><hdop>${point.accuracy.toFixed(1)}</hdop></trkpt>`).join("");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Stadsorientering GPS-tracker" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${xmlEscape(track.name)}</name><time>${new Date(track.startedAt).toISOString()}</time></metadata><trk><name>${xmlEscape(track.name)}</name><trkseg>${points}</trkseg></trk></gpx>`;
  const stamp = new Date(track.startedAt).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("Z", "").slice(0, 13);
  const safeName = track.name.trim().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
  return new File([gpx], `${safeName}_${stamp}.gpx`, { type: "application/gpx+xml" });
}

async function markExported() { track.exported = true; await saveTrack(); showExport(); }

async function share() {
  const file = gpxFile();
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ title: "GPS-spår", files: [file] }); await markExported(); return; } catch { /* användaren kan ha avbrutit */ } }
  download();
}

function download() {
  const file = gpxFile();
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: file.name });
  link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); markExported();
}

async function copyEmail() {
  try { await navigator.clipboard.writeText(ORGANISER_EMAIL); } catch { const range = document.createRange(); range.selectNodeContents($("email")); getSelection().removeAllRanges(); getSelection().addRange(range); }
  $("copy-email").textContent = "Kopierad"; setTimeout(() => $("copy-email").textContent = "Kopiera adress", 2000);
}

function showPocket() { if (track?.active) $("pocket").hidden = false; }

function stopHolding() { cancelAnimationFrame(holdFrame); $("hold-unlock").classList.remove("holding"); $("hold-progress").style.width = "0"; }

function holdUnlock(event) {
  event.currentTarget.setPointerCapture?.(event.pointerId);
  holdStarted = performance.now(); $("hold-unlock").classList.add("holding");
  const tick = (now) => { const fraction = Math.min(1, (now - holdStarted) / 2000); $("hold-progress").style.width = `${fraction * 100}%`; if (fraction >= 1) { $("pocket").hidden = true; stopHolding(); return; } holdFrame = requestAnimationFrame(tick); };
  holdFrame = requestAnimationFrame(tick);
}

function initialiseEvents() {
  $("name").addEventListener("input", saveName);
  $("gps-on").onclick = startWatching;
  $("start").onclick = () => startRace();
  $("start-anyway").onclick = () => startRace(true);
  $("resume").onclick = continueRace;
  $("resume-stop").onclick = () => confirmAction($("resume-stop"), "Avsluta loppet", "Tryck igen för att avsluta", finishRace);
  $("pocket-on").onclick = showPocket;
  $("stop").onclick = () => confirmAction($("stop"), "Avsluta loppet", "Tryck igen för att avsluta", finishRace);
  $("close-gap").onclick = () => $("gap-note").hidden = true;
  $("share").onclick = share; $("download").onclick = download; $("copy-email").onclick = copyEmail;
  $("new-track").onclick = () => { const action = async () => { await deleteTrack(); track = null; $("name").value = ""; show("start"); }; if (track.exported) action(); else confirmAction($("new-track"), "Nytt lopp", "Spåret är inte skickat. Tryck igen för att radera det.", action); };
  ["pointerup", "pointercancel", "pointerleave"].forEach((event) => $("hold-unlock").addEventListener(event, stopHolding));
  $("hold-unlock").addEventListener("pointerdown", holdUnlock);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveTrack(); if (document.visibilityState === "visible" && track?.active) requestWakeLock(); });
  addEventListener("beforeunload", (event) => { if (track?.active) { event.preventDefault(); event.returnValue = ""; } });
  setInterval(render, 1000);
}

async function initialise() {
  initialiseEvents();
  $("sim-pill").hidden = !SIMULATE;
  try { $("name").value = localStorage.getItem("stadsorientering-name") || ""; } catch { /* privat läge */ }
  const saved = await readTrack();
  if (!saved) { show("start"); render(); return; }
  track = normalise(saved);
  if (track.active) { $("resume-info").textContent = `${track.name} · ${formatTime(Date.now() - track.startedAt)} · ${track.points.length} sparade punkter. Det här spåret visas före startsidan så att inget kan tappas bort.`; show("resume"); }
  else showExport();
  render();
}

initialise();
