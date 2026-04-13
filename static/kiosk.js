const SpeechSDK = window.SpeechSDK;

const videoEl = document.getElementById("avatarVideo");
const audioEl = document.getElementById("avatarAudio");
const statusEl = document.getElementById("status");
const textEl = document.getElementById("text");
const btnConnect = document.getElementById("btnConnect");
const btnSpeak = document.getElementById("btnSpeak");
const btnStop = document.getElementById("btnStop");

const IDLE_TIMEOUT_MS = 90_000;
const HEARTBEAT_MS = 15_000;
const MAX_HEARTBEAT_FAIL = 3;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const SESSION_REFRESH_MS = 7 * 60_000;

let currentLang = "en-SG";
let session = null;
let pc = null;
let synth = null;
let idleTimer = null;
let heartbeatTimer = null;
let sessionRefreshTimer = null;
let heartbeatFailCount = 0;
let isOffline = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let isConnecting = false;
let isConnected = false;

console.log("SpeechSDK:", SpeechSDK);
console.log("START AVATAR");
await synth.startAvatarAsync(pc);

function setStatus(msg) { statusEl.textContent = msg; }

function setDefaultTextByLang(lang) {
  if (lang === "en-SG") textEl.value = "Welcome. Please select a service.";
  if (lang === "zh-CN") textEl.value = "欢迎使用。请选择服务。";
  if (lang === "ms-MY") textEl.value = "Selamat datang. Sila pilih perkhidmatan.";
}

function disableButtons(disabled) {
  btnConnect.disabled = disabled;
  btnSpeak.disabled = disabled;
  btnStop.disabled = disabled;
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => goHome("Idle timeout. Returning to home..."), IDLE_TIMEOUT_MS);
}

function bindIdleEvents() {
  ["click", "touchstart", "mousemove", "keydown"].forEach((evt) => window.addEventListener(evt, resetIdleTimer, { passive: true }));
  resetIdleTimer();
}

async function heartbeatOnce() {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    if (!r.ok) throw new Error("health not ok");
    heartbeatFailCount = 0;
    if (isOffline) {
      isOffline = false;
      setStatus("Online restored. You can connect/speak.");
      if (!isConnected && !isConnecting) scheduleReconnect("Online restored");
    }
  } catch {
    heartbeatFailCount += 1;
    if (heartbeatFailCount >= MAX_HEARTBEAT_FAIL && !isOffline) {
      isOffline = true;
      setStatus("Offline (backend unreachable). Waiting to recover...");
      cancelReconnectTimer();
      safeDisconnect();
    }
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(heartbeatOnce, HEARTBEAT_MS);
  heartbeatOnce();
}

async function apiSession(language) {
  const r = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ language, avatarCharacter: "Meg", avatarStyle: "business" }),
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

function createPeerConnection(iceServers) {
  const peer = new RTCPeerConnection({ iceServers });
  peer.ontrack = (e) => {
    const stream = e.streams[0];
    if (e.track.kind === "video") videoEl.srcObject = stream;
    if (e.track.kind === "audio") audioEl.srcObject = stream;
  };
  peer.oniceconnectionstatechange = () => {
    const s = peer.iceConnectionState;
    if (s === "failed" || s === "disconnected") scheduleReconnect(`ICE state: ${s}`);
  };
  peer.onconnectionstatechange = () => {
    const s = peer.connectionState;
    if (s === "failed" || s === "disconnected") scheduleReconnect(`Peer connection state: ${s}`);
  };
  peer.addTransceiver("video", { direction: "recvonly" });
  peer.addTransceiver("audio", { direction: "recvonly" });
  return peer;
}

function safeDisconnect() {
  isConnected = false;
  try { if (synth) synth.close(); } catch {}
  synth = null;
  try { if (pc) pc.close(); } catch {}
  pc = null;
  try { videoEl.srcObject = null; } catch {}
  try { audioEl.srcObject = null; } catch {}
  stopSessionRefreshTimer();
}

function cancelReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

async function connectInternal(reason = "") {
  if (isOffline || isConnecting) return;
  isConnecting = true;
  disableButtons(true);
  setStatus(`Connecting (${currentLang})... ${reason}`.trim());
  try {
    session = await apiSession(currentLang);
    safeDisconnect();
    const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(session.speechToken, session.speechRegion);
    speechConfig.speechSynthesisVoiceName = session.voice;
    const avatarConfig = new SpeechSDK.AvatarConfig(session.avatarCharacter, session.avatarStyle);
    pc = createPeerConnection(session.iceServers);
    synth = new SpeechSDK.AvatarSynthesizer(speechConfig, avatarConfig);
    await synth.startAvatarAsync(pc);
    isConnected = true;
    reconnectAttempt = 0;
    setStatus(`Connected: ${session.language} | ${session.voice} | ${session.avatarCharacter}/${session.avatarStyle}`);
    startSessionRefreshTimer();
  } catch (e) {
    isConnected = false;
    setStatus(`Connect error: ${e.message || e}`);
    scheduleReconnect("Connect failed");
  } finally {
    isConnecting = false;
    disableButtons(false);
  }
}

async function speak() {
  resetIdleTimer();
  if (isOffline) {
    setStatus("Offline. Please wait...");
    return;
  }
  if (!synth || !pc || !isConnected) await connectInternal("Auto-connect before speak");
  if (!synth) return;
  const t = textEl.value?.trim();
  if (!t) return;
  try {
    setStatus("Speaking...");
    await synth.speakTextAsync(t);
    setStatus("Done.");
  } catch (e) {
    setStatus(`Speak failed: ${e.message || e}`);
    scheduleReconnect("Speak failed");
  }
}

async function stopSpeaking() {
  resetIdleTimer();
  if (!synth) return;
  try {
    setStatus("Stopping...");
    await synth.stopSpeakingAsync();
    setStatus("Idle.");
  } catch (e) {
    setStatus(`Stop failed: ${e.message || e}`);
  }
}

function scheduleReconnect(reason) {
  if (isOffline || isConnecting || reconnectTimer) return;
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempt - 1), RECONNECT_MAX_DELAY_MS);
  setStatus(`Reconnecting in ${Math.round(delay / 1000)}s... (${reason})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await connectInternal(`Reconnect attempt ${reconnectAttempt}: ${reason}`);
  }, delay);
}

function startSessionRefreshTimer() {
  stopSessionRefreshTimer();
  sessionRefreshTimer = setInterval(async () => {
    if (!isConnected || isConnecting || isOffline) return;
    setStatus("Refreshing session...");
    await connectInternal("Periodic refresh");
  }, SESSION_REFRESH_MS);
}

function stopSessionRefreshTimer() {
  if (sessionRefreshTimer) clearInterval(sessionRefreshTimer);
  sessionRefreshTimer = null;
}

function goHome(msg) {
  cancelReconnectTimer();
  safeDisconnect();
  setDefaultTextByLang(currentLang);
  setStatus(msg || "Home");
}

document.querySelectorAll("button.lang").forEach((btn) => {
  btn.addEventListener("click", () => {
    resetIdleTimer();
    currentLang = btn.dataset.lang;
    setDefaultTextByLang(currentLang);
    setStatus(`Language set: ${currentLang}`);
    scheduleReconnect("Language changed");
  });
});

btnConnect.addEventListener("click", () => {
  resetIdleTimer();
  connectInternal("Manual connect").catch((e) => setStatus(`Connect error: ${e.message || e}`));
});
btnSpeak.addEventListener("click", () => speak());
btnStop.addEventListener("click", () => stopSpeaking());

window.addEventListener("online", () => {
  isOffline = false;
  heartbeatFailCount = 0;
  setStatus("Network online. Checking backend...");
  heartbeatOnce();
});
window.addEventListener("offline", () => {
  isOffline = true;
  setStatus("Network offline.");
  cancelReconnectTimer();
  safeDisconnect();
});

setDefaultTextByLang(currentLang);
bindIdleEvents();
startHeartbeat();
setStatus("Tap a language, then Connect.");
