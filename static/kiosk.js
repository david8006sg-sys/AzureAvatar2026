(() => {
  // ----------------------
  // Dependencies (must be loaded before this file)
  // ----------------------
  const SpeechSDK = window.SpeechSDK;

  // ----------------------
  // Kiosk tuning params
  // ----------------------
  const IDLE_TIMEOUT_MS = 90_000;          // idle 回首页
  const HEARTBEAT_MS = 15_000;            // 心跳
  const MAX_HEARTBEAT_FAIL = 3;           // 连续失败次数
  const RECONNECT_BASE_DELAY_MS = 1000;   // 重连退避
  const RECONNECT_MAX_DELAY_MS = 15_000;  // 最大退避
  const SESSION_REFRESH_MS = 7 * 60_000;  // 定期刷新会话（避免 token 临界过期）

  // ----------------------
  // State
  // ----------------------
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

  // ----------------------
  // DOM refs (set in init)
  // ----------------------
  let videoEl, audioEl, statusEl, textEl, btnConnect, btnSpeak, btnStop;

  // ----------------------
  // UI helpers
  // ----------------------
  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function disableButtons(disabled) {
    if (btnConnect) btnConnect.disabled = disabled;
    if (btnSpeak) btnSpeak.disabled = disabled;
    if (btnStop) btnStop.disabled = disabled;
  }

  function setDefaultTextByLang(lang) {
    if (!textEl) return;
    if (lang === "en-SG") textEl.value = "Welcome. Please select a service.";
    if (lang === "zh-CN") textEl.value = "欢迎使用。请选择服务。";
    if (lang === "ms-MY") textEl.value = "Selamat datang. Sila pilih perkhidmatan.";
  }

  // ----------------------
  // Idle timeout
  // ----------------------
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      goHome("Idle timeout. Returning to home...");
    }, IDLE_TIMEOUT_MS);
  }

  function bindIdleEvents() {
    ["click", "touchstart", "mousemove", "keydown"].forEach((evt) => {
      window.addEventListener(evt, resetIdleTimer, { passive: true });
    });
    resetIdleTimer();
  }

  // ----------------------
  // Heartbeat
  // ----------------------
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
    } catch (e) {
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

  // ----------------------
  // API
  // ----------------------
  async function apiSession(language) {
    const r = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        language,
        avatarCharacter: "Meg",
        avatarStyle: "business"
      }),
    });

    if (!r.ok) throw new Error(await r.text());
    return await r.json();
  }

  // ----------------------
  // WebRTC
  // ----------------------
  function createPeerConnection(iceServers) {
    const peer = new RTCPeerConnection({ iceServers });

    peer.ontrack = (e) => {
      const stream = e.streams[0];
      if (e.track.kind === "video" && videoEl) videoEl.srcObject = stream;
      if (e.track.kind === "audio" && audioEl) audioEl.srcObject = stream;
    };

    peer.oniceconnectionstatechange = () => {
      const s = peer.iceConnectionState;
      if (s === "failed" || s === "disconnected") {
        scheduleReconnect(`ICE state: ${s}`);
      }
    };

    peer.onconnectionstatechange = () => {
      const s = peer.connectionState;
      if (s === "failed" || s === "disconnected") {
        scheduleReconnect(`Peer state: ${s}`);
      }
    };

    // recvonly
    peer.addTransceiver("video", { direction: "recvonly" });
    peer.addTransceiver("audio", { direction: "recvonly" });

    return peer;
  }

  function safeDisconnect() {
    isConnected = false;

    try { if (synth) synth.close(); } catch (_) {}
    synth = null;

    try { if (pc) pc.close(); } catch (_) {}
    pc = null;

    try { if (videoEl) videoEl.srcObject = null; } catch (_) {}
    try { if (audioEl) audioEl.srcObject = null; } catch (_) {}

    stopSessionRefreshTimer();
  }

  // ----------------------
  // Reconnect (backoff)
  // ----------------------
  function cancelReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(reason) {
    if (isOffline || isConnecting) return;
    if (reconnectTimer) return; // avoid stacking

    reconnectAttempt += 1;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS
    );

    setStatus(`Reconnecting in ${Math.round(delay / 1000)}s... (${reason})`);

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      await connectInternal(`Reconnect attempt ${reconnectAttempt}: ${reason}`);
    }, delay);
  }

  // ----------------------
  // Session refresh
  // ----------------------
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

  // ----------------------
  // Core connect
  // ----------------------
  async function connectInternal(reason = "") {
    if (isOffline) {
      setStatus("Offline. Cannot connect.");
      return;
    }
    if (isConnecting) return;

    // Ensure SDK loaded
    if (!SpeechSDK || !SpeechSDK.SpeechConfig || !SpeechSDK.AvatarSynthesizer) {
      setStatus("Speech SDK not loaded. Check script order / bundling.");
      return;
    }

    isConnecting = true;
    disableButtons(true);
    setStatus(`Connecting (${currentLang})... ${reason}`.trim());

    try {
      session = await apiSession(currentLang);

      // cleanup old session
      safeDisconnect();

      // build speech config
      const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(
        session.speechToken,
        session.speechRegion
      );
      speechConfig.speechSynthesisVoiceName = session.voice;

      // avatar config Meg/business
      const avatarConfig = new SpeechSDK.AvatarConfig(
        session.avatarCharacter,
        session.avatarStyle
      );

      // create webrtc peer
      pc = createPeerConnection(session.iceServers);
      console.log("[AVATAR] RTCPeerConnection created");

      // create synthesizer
      synth = new SpeechSDK.AvatarSynthesizer(speechConfig, avatarConfig);
      console.log("[AVATAR] Synthesizer created");

      // start avatar session (this is where WebRTC begins)
      await synth.startAvatarAsync(pc);
      console.log("[AVATAR] Avatar started");

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

  // ----------------------
  // Speak / stop
  // ----------------------
  async function speak() {
    resetIdleTimer();

    if (isOffline) {
      setStatus("Offline. Please wait...");
      return;
    }

    if (!synth || !pc || !isConnected) {
      await connectInternal("Auto-connect before speak");
    }
    if (!synth) return;

    const t = (textEl?.value || "").trim();
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

  // ----------------------
  // Home
  // ----------------------
  function goHome(msg) {
    cancelReconnectTimer();
    safeDisconnect();
    setDefaultTextByLang(currentLang);
    setStatus(msg || "Home");
  }

  // ----------------------
  // Bind events
  // ----------------------
  function bindUI() {
    document.querySelectorAll("button.lang").forEach((btn) => {
      btn.addEventListener("click", () => {
        resetIdleTimer();
        currentLang = btn.dataset.lang;
        setDefaultTextByLang(currentLang);
        setStatus(`Language set: ${currentLang}`);

        // Optional: immediately reconnect in new language (more deterministic than schedule)
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
  }

  // ----------------------
  // Init (DOM ready)
  // ----------------------
  function init() {
    videoEl = document.getElementById("avatarVideo");
    audioEl = document.getElementById("avatarAudio");
    statusEl = document.getElementById("status");
    textEl = document.getElementById("text");
    btnConnect = document.getElementById("btnConnect");
    btnSpeak = document.getElementById("btnSpeak");
    btnStop = document.getElementById("btnStop");

    console.log("SpeechSDK loaded:", !!SpeechSDK);

    setDefaultTextByLang(currentLang);
    bindIdleEvents();
    startHeartbeat();
    bindUI();

    setStatus("Tap a language, then Connect.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
``