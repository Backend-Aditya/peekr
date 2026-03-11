/**
 * server.js — Peekr Signaling Server
 *
 * Matching strategy — "pooled pairing with timeout":
 *   Instead of instant first-come-first-served pairing, each user who calls
 *   find_partner is held in a pending pool for up to MATCH_WINDOW ms (2s).
 *   Every POLL_INTERVAL ms the server runs a batch pass over the pool,
 *   pairing everyone it can. This means two users who arrive within the same
 *   2-second window get matched together even if one arrived slightly later —
 *   much better UX than one person waiting alone while a second joins 100ms later.
 *
 *   If after MATCH_WINDOW ms a user is still unmatched, they're promoted to the
 *   persistent waiting queue and matched instantly on the next arrival.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "https://peekr-production-c72b.up.railway.app/*" },
  transports: ["polling", "websocket"], // polling first → reliable through proxies
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/chat", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "chat.html")),
);

// ─── Tuning ───────────────────────────────────────────────────────────────────
const MATCH_WINDOW = 2000; // ms to hold a user in the pending pool before promoting
const POLL_INTERVAL = 300; // ms between batch-pairing passes

// ─── State ────────────────────────────────────────────────────────────────────
// pendingPool: Map<socketId, { socket, arrivedAt }>
//   Users who just called find_partner and are being held for batch matching.
const pendingPool = new Map();

// waitingQueue: Array<socketId>
//   Users who waited through the full MATCH_WINDOW with no match.
//   Matched instantly when the next user arrives or the next poll runs.
let waitingQueue = [];

// pairs: Map<socketId, partnerId>
const pairs = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isAlive(id) {
  return io.sockets.sockets.has(id);
}

/** Remove a socket from both pending pool and waiting queue */
function removeFromWaiting(socketId) {
  pendingPool.delete(socketId);
  waitingQueue = waitingQueue.filter((id) => id !== socketId);
}

/** Actually pair two sockets and notify them */
function pair(sockA, sockB) {
  pairs.set(sockA.id, sockB.id);
  pairs.set(sockB.id, sockA.id);
  // The one who waited longest becomes initiator (creates the offer)
  sockA.emit("paired", { initiator: false });
  sockB.emit("paired", { initiator: true });
  console.log(`✅  Paired: ${sockA.id.slice(0, 6)} ↔ ${sockB.id.slice(0, 6)}`);
}

/**
 * Unpair a socket, notify its partner, and optionally re-queue the partner.
 */
function unpair(socket, requeuePartner = false) {
  removeFromWaiting(socket.id);
  const partnerId = pairs.get(socket.id);
  pairs.delete(socket.id);

  if (partnerId) {
    pairs.delete(partnerId);
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      partnerSocket.emit("partner_disconnected");
      if (requeuePartner) enqueue(partnerSocket);
    }
  }
}

/**
 * Add a socket to the pending pool.
 * It will be promoted to the waiting queue after MATCH_WINDOW if unmatched.
 */
function enqueue(socket) {
  removeFromWaiting(socket.id); // clean slate
  pendingPool.set(socket.id, { socket, arrivedAt: Date.now() });
  socket.emit("waiting");
  console.log(
    `⏳  Pending: ${socket.id.slice(0, 6)}  pool=${pendingPool.size} queue=${waitingQueue.length}`,
  );
}

// ─── Batch pairing loop ───────────────────────────────────────────────────────
/**
 * Called every POLL_INTERVAL ms.
 * 1. Promote expired pending users → waiting queue
 * 2. Try to pair waiting queue users with each other
 * 3. Try to pair waiting queue users with pending pool users
 */
function runMatchingPass() {
  const now = Date.now();

  // Step 1: Promote expired pending users to the waiting queue
  for (const [id, entry] of pendingPool) {
    if (!isAlive(id)) {
      pendingPool.delete(id);
      continue;
    }
    if (now - entry.arrivedAt >= MATCH_WINDOW) {
      pendingPool.delete(id);
      waitingQueue.push(id);
      console.log(`⬆️  Promoted: ${id.slice(0, 6)} → waiting queue`);
    }
  }

  // Clean stale ids from waiting queue
  waitingQueue = waitingQueue.filter(isAlive);

  // Step 2: Pair within the waiting queue (instant, these users have waited long enough)
  while (waitingQueue.length >= 2) {
    const idA = waitingQueue.shift();
    const idB = waitingQueue.shift();
    const sockA = io.sockets.sockets.get(idA);
    const sockB = io.sockets.sockets.get(idB);
    if (sockA && sockB) {
      pair(sockA, sockB);
    } else {
      // One went stale — put the live one back
      if (sockA) waitingQueue.unshift(idA);
      if (sockB) waitingQueue.unshift(idB);
    }
  }

  // Step 3: If one person is waiting and there are pending users, match them now
  // (don't make the waiting user wait another full poll cycle)
  if (waitingQueue.length === 1) {
    // Find the oldest pending user (most deserving of a match)
    let oldest = null;
    let oldestTime = Infinity;
    for (const [id, entry] of pendingPool) {
      if (isAlive(id) && entry.arrivedAt < oldestTime) {
        oldest = id;
        oldestTime = entry.arrivedAt;
      }
    }
    if (oldest) {
      const idA = waitingQueue.shift();
      pendingPool.delete(oldest);
      const sockA = io.sockets.sockets.get(idA);
      const sockB = io.sockets.sockets.get(oldest);
      if (sockA && sockB) {
        pair(sockA, sockB);
      } else {
        if (sockA) waitingQueue.push(idA);
      }
    }
  }

  // Step 4: Pair within the pending pool if ≥2 users are available
  // (two people arrived at nearly the same time — pair them immediately)
  const poolEntries = [...pendingPool.entries()]
    .filter(([id]) => isAlive(id))
    .sort((a, b) => a[1].arrivedAt - b[1].arrivedAt); // oldest first

  let i = 0;
  while (i + 1 < poolEntries.length) {
    const [idA] = poolEntries[i];
    const [idB] = poolEntries[i + 1];
    pendingPool.delete(idA);
    pendingPool.delete(idB);
    const sockA = io.sockets.sockets.get(idA);
    const sockB = io.sockets.sockets.get(idB);
    if (sockA && sockB) {
      pair(sockA, sockB);
    } else {
      if (sockA) pendingPool.set(idA, poolEntries[i][1]);
      if (sockB) pendingPool.set(idB, poolEntries[i + 1][1]);
    }
    i += 2;
  }
}

// Start the polling loop
setInterval(runMatchingPass, POLL_INTERVAL);

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`🔌  Connected: ${socket.id.slice(0, 6)}`);

  socket.on("find_partner", () => {
    unpair(socket, false);
    enqueue(socket);
  });

  // WebRTC signaling relay — server is just a postman here
  socket.on("offer", ({ sdp }) => {
    const p = pairs.get(socket.id);
    if (p) io.to(p).emit("offer", { sdp });
  });
  socket.on("answer", ({ sdp }) => {
    const p = pairs.get(socket.id);
    if (p) io.to(p).emit("answer", { sdp });
  });
  socket.on("ice_candidate", ({ candidate }) => {
    const p = pairs.get(socket.id);
    if (p) io.to(p).emit("ice_candidate", { candidate });
  });

  socket.on("next", () => {
    unpair(socket, true); // release partner, requeue them
    enqueue(socket); // put self back into pool
  });

  socket.on("disconnect", () => {
    console.log(`❌  Disconnected: ${socket.id.slice(0, 6)}`);
    unpair(socket, true);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  Peekr running → http://localhost:${PORT}\n`);
  console.log(`   Match window:  ${MATCH_WINDOW}ms`);
  console.log(`   Poll interval: ${POLL_INTERVAL}ms\n`);
});
