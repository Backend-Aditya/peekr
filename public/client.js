'use strict';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
  ]
};

// ─── DOM ──────────────────────────────────────────────────────────────────────
const remoteVideo       = document.getElementById('remoteVideo');
const localVideo        = document.getElementById('localVideo');
const remotePlaceholder = document.getElementById('remotePlaceholder');
const selfPlaceholder   = document.getElementById('selfPlaceholder');
const placeholderLabel  = document.getElementById('placeholderLabel');
const statusDot         = document.getElementById('statusDot');
const statusText        = document.getElementById('statusText');
const clockEl           = document.getElementById('clock');
const btnCam            = document.getElementById('btnCam');
const iconCamOn         = document.getElementById('iconCamOn');
const iconCamOff        = document.getElementById('iconCamOff');
const btnNext           = document.getElementById('btnNext');
const btnLeave          = document.getElementById('btnLeave');   // ← renamed
const chatPanel         = document.getElementById('chatPanel');
const btnChatToggle     = document.getElementById('btnChatToggle');
const btnChatClose      = document.getElementById('btnChatClose');
const chatMessages      = document.getElementById('chatMessages');
const chatInput         = document.getElementById('chatInput');
const btnSend           = document.getElementById('btnSend');
const typingIndicator   = document.getElementById('typingIndicator');

// ─── State ────────────────────────────────────────────────────────────────────
let socket      = null;
let localStream = null;
let peerConn    = null;
let dataChannel = null;
let camOn       = true;
let clockTimer  = null;
let sessionSecs = 0;
let chatOpen    = false;
let isTyping    = false;
let typingTimer = null;

const TYPING_DEBOUNCE = 1500;
const TYPING_START    = '__t1__';
const TYPING_STOP     = '__t0__';

// ─── Clock ────────────────────────────────────────────────────────────────────
function startClock() {
  sessionSecs = 0;
  clockEl.textContent = '00:00';
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    sessionSecs++;
    const m = String(Math.floor(sessionSecs / 60)).padStart(2, '0');
    const s = String(sessionSecs % 60).padStart(2, '0');
    clockEl.textContent = `${m}:${s}`;
  }, 1000);
}
function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
  clockEl.textContent = '00:00';
}

// ─── Status ───────────────────────────────────────────────────────────────────
function setStatus(key) {
  const map = {
    offline:   ['offline',    ''],
    online:    ['online',     'online'],
    waiting:   ['searching…', 'waiting'],
    connected: ['connected',  'connected'],
  };
  const [label, cls] = map[key] || map.offline;
  statusText.textContent = label;
  statusDot.className = 'header__dot' + (cls ? ' ' + cls : '');
}

// ─── Messages ─────────────────────────────────────────────────────────────────
function addMsg(text, type) {
  const el = document.createElement('div');
  el.className = 'msg ' + type;
  el.textContent = text;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function clearLog() { chatMessages.innerHTML = ''; }

// ─── Placeholder ──────────────────────────────────────────────────────────────
function showPlaceholder(label) {
  remotePlaceholder?.classList.remove('hidden');
  if (label && placeholderLabel) placeholderLabel.textContent = label;
}
function hidePlaceholder() {
  remotePlaceholder?.classList.add('hidden');
}

// ─── Typing ───────────────────────────────────────────────────────────────────
function showTyping() {
  typingIndicator?.classList.add('visible');
  if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
}
function hideTyping() {
  typingIndicator?.classList.remove('visible');
}

// ─── Chat panel ───────────────────────────────────────────────────────────────
function toggleChat(force) {
  chatOpen = force !== undefined ? force : !chatOpen;
  chatPanel?.classList.remove('closed');
  chatPanel?.classList.toggle('open', chatOpen);
  btnChatToggle?.classList.toggle('chat-open', chatOpen);
  if (chatOpen) clearBadge(); // clear on open
}
btnChatToggle?.addEventListener('click', () => toggleChat());
btnChatClose?.addEventListener('click',  () => toggleChat(false));

// ─── Enable chat ──────────────────────────────────────────────────────────────
function enableChat(on) {
  if (chatInput) chatInput.disabled = !on;
  if (btnSend)   btnSend.disabled   = !on;
}

// ─── Safe channel helpers ─────────────────────────────────────────────────────
function safeSend(data) {
  if (dataChannel && dataChannel.readyState === 'open') {
    try { dataChannel.send(data); } catch (_) {}
  }
}
function safeCloseChannel(ch) {
  if (!ch) return;
  ch.onopen = ch.onclose = ch.onerror = ch.onmessage = null;
  if (ch.readyState !== 'closed') try { ch.close(); } catch (_) {}
}

// ─── Media ────────────────────────────────────────────────────────────────────
async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    if (selfPlaceholder) selfPlaceholder.style.display = 'none';
  } catch (e) {
    console.warn('getUserMedia:', e);
    if (selfPlaceholder) selfPlaceholder.style.display = 'flex';
  }
}

// ─── Camera toggle ────────────────────────────────────────────────────────────
function toggleCam() {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getTracks().forEach(t => { if (t.kind === 'video') t.enabled = camOn; });
  if (iconCamOn)  iconCamOn.style.display  = camOn ? '' : 'none';
  if (iconCamOff) iconCamOff.style.display = camOn ? 'none' : '';
  btnCam?.classList.toggle('cam-off', !camOn);
  if (selfPlaceholder) selfPlaceholder.style.display = camOn ? 'none' : 'flex';
}
btnCam?.addEventListener('click', toggleCam);

// ─── Socket ───────────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect',    () => { setStatus('online'); findPartner(); });
  socket.on('disconnect', () => { setStatus('offline'); teardown(false); stopClock(); });
  socket.on('waiting',    () => { setStatus('waiting'); showPlaceholder('Finding someone…'); });

  socket.on('paired', ({ initiator }) => {
    clearLog();
    setStatus('connected');
    startClock();
    hidePlaceholder();
    enableChat(true);
    createPeerConnection();
    if (initiator) { setupDataChannelOfferer(); createOffer(); }
  });

  socket.on('partner_disconnected', () => {
    teardown(false);
    stopClock();
    setStatus('online');
    showPlaceholder('Stranger left — hit Next 👋');
    enableChat(false);
  });

  socket.on('offer', async ({ sdp }) => {
    if (!peerConn) return;
    try {
      await peerConn.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await peerConn.createAnswer();
      await peerConn.setLocalDescription(answer);
      socket.emit('answer', { sdp: peerConn.localDescription });
    } catch (e) { console.error('offer:', e); }
  });

  socket.on('answer', async ({ sdp }) => {
    if (!peerConn) return;
    try { await peerConn.setRemoteDescription(new RTCSessionDescription(sdp)); }
    catch (e) { console.error('answer:', e); }
  });

  socket.on('ice_candidate', async ({ candidate }) => {
    if (!peerConn) return;
    try { await peerConn.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  });
}

function findPartner() {
  setStatus('waiting');
  showPlaceholder('Finding someone…');
  socket?.emit('find_partner');
}

// ─── PeerConnection ───────────────────────────────────────────────────────────
function createPeerConnection() {
  if (peerConn) teardown(false);
  peerConn = new RTCPeerConnection(ICE_CONFIG);

  localStream?.getTracks().forEach(t => peerConn.addTrack(t, localStream));

  peerConn.onicecandidate = ({ candidate }) => {
    if (candidate) socket?.emit('ice_candidate', { candidate });
  };

  peerConn.oniceconnectionstatechange = () => {
    const s = peerConn?.iceConnectionState;
    if (s === 'failed') peerConn.restartIce();
    if (s === 'disconnected') {
      setTimeout(() => {
        if (peerConn?.iceConnectionState === 'disconnected') {
          teardown(false); stopClock(); enableChat(false);
          setStatus('online'); showPlaceholder('Connection lost — hit Next 👋');
        }
      }, 3000);
    }
  };

  peerConn.ontrack = ({ streams }) => {
    if (streams?.[0]) { remoteVideo.srcObject = streams[0]; hidePlaceholder(); }
  };

  peerConn.ondatachannel = ({ channel }) => { dataChannel = channel; wireChannel(dataChannel); };
}

async function createOffer() {
  try {
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    socket.emit('offer', { sdp: peerConn.localDescription });
  } catch (e) { console.error('createOffer:', e); }
}

// ─── DataChannel ──────────────────────────────────────────────────────────────
function setupDataChannelOfferer() {
  dataChannel = peerConn.createDataChannel('chat', { ordered: true });
  wireChannel(dataChannel);
}

function wireChannel(ch) {
  ch.onopen  = () => enableChat(true);
  ch.onclose = () => { enableChat(false); hideTyping(); };
  ch.onerror = (e) => {
    const msg = e?.error?.message || '';
    if (msg.includes('User-Initiated Abort') || msg.includes('Close called')) return;
    console.error('DataChannel error:', e);
  };
  ch.onmessage = ({ data }) => {
    if (data === TYPING_START) { showTyping(); return; }
    if (data === TYPING_STOP)  { hideTyping(); return; }
    addMsg(data, 'stranger');
    if (!chatOpen) toggleChat(true); // auto-open chat on first message
  };
}

// ─── Send message ─────────────────────────────────────────────────────────────
function sendMessage() {
  const text = chatInput?.value.trim();
  if (!text) return;
  safeSend(TYPING_STOP);
  isTyping = false;
  clearTimeout(typingTimer);
  safeSend(text);
  addMsg(text, 'you');
  chatInput.value = '';
}

function onTypingInput() {
  if (!isTyping) { isTyping = true; safeSend(TYPING_START); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { isTyping = false; safeSend(TYPING_STOP); }, TYPING_DEBOUNCE);
}

btnSend?.addEventListener('click', sendMessage);
chatInput?.addEventListener('input', onTypingInput);
chatInput?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ─── Teardown ─────────────────────────────────────────────────────────────────
function teardown(clearMessages) {
  isTyping = false;
  clearTimeout(typingTimer);
  hideTyping();
  safeCloseChannel(dataChannel); dataChannel = null;
  if (peerConn) {
    peerConn.onicecandidate = peerConn.oniceconnectionstatechange =
    peerConn.ontrack = peerConn.ondatachannel = null;
    peerConn.close(); peerConn = null;
  }
  remoteVideo.srcObject = null;
  if (clearMessages) clearLog();
  enableChat(false);
}

// ─── Controls ─────────────────────────────────────────────────────────────────
btnNext?.addEventListener('click', () => {
  teardown(true);
  stopClock();
  socket?.emit('next');
  findPartner();
});

// LEAVE — hard navigate to home. Cleanest possible redirect.
btnLeave?.addEventListener('click', () => {
  teardown(true);
  stopClock();
  socket?.emit('next');       // release partner back to queue
  socket?.disconnect();       // close socket cleanly
  window.location.href = '/'; // navigate home
});

// ─── Init — runs immediately when page loads ──────────────────────────────────
(async () => {
  await initMedia();
  connectSocket();
})();