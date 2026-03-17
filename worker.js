const DEFAULT_PERMISSIONS = {
  guestCanPlay: true,
  guestCanNext: true,
  guestCanReset: true,
  guestCanEdit: true
};

const ROOM_KEY = "room:v1";

function createRoomId() {
  return Math.random().toString(36).slice(2, 10);
}

function clampNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function sanitizeSections(raw = []) {
  return raw
    .filter((section) => section && typeof section === "object")
    .slice(0, 50)
    .map((section) => {
      const value = section.value ?? section.minutes;
      return {
        name: String(section.name || section.title || "Sin nombre").slice(0, 60),
        value: clampNumber(value, 0),
        unit: section.unit === "seg" ? "seg" : "min"
      };
    })
    .filter((section) => section.value >= 0);
}

function toSectionMs(section) {
  return section.unit === "seg" ? section.value * 1000 : section.value * 60000;
}

function sanitizeProfile(raw = {}) {
  return {
    name: String(raw.name || "Invitado").slice(0, 36),
    iconSeed: String(raw.iconSeed || "")
  };
}

function createRoomSnapshot(init = {}) {
  const sections = sanitizeSections(init.sections);
  const fallbackSections = sections.length ? sections : [{ name: "Sección", value: 5, unit: "min" }];
  return {
    name: String(init.name || "Demo").slice(0, 90),
    target: clampNumber(init.target, 30),
    alertThreshold: clampNumber(init.alertThreshold, 30),
    alertThresholdUnit: init.alertThresholdUnit === "min" ? "min" : "seg",
    sections: fallbackSections,
    running: false,
    completed: false,
    currentIndex: 0,
    currentMs: toSectionMs(fallbackSections[0]),
    currentStart: 0,
    version: 0,
    configVersion: 0,
    tickIntervalMs: 220
  };
}

function createRoomState(init = {}) {
  return {
    hostToken: String(init.hostToken || ""),
    permissions: { ...DEFAULT_PERMISSIONS, ...(init.permissions || {}) },
    roomState: createRoomSnapshot(init.config || init)
  };
}

function cloneForClient(roomState) {
  return {
    name: roomState.name,
    target: roomState.target,
    alertThreshold: roomState.alertThreshold,
    alertThresholdUnit: roomState.alertThresholdUnit,
    sections: roomState.sections,
    running: roomState.running,
    completed: roomState.completed,
    currentIndex: roomState.currentIndex,
    currentMs: roomState.currentMs,
    currentStart: roomState.currentStart,
    version: roomState.version,
    configVersion: roomState.configVersion,
    tickIntervalMs: roomState.tickIntervalMs
  };
}

class SyncRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = {
      hostToken: "",
      permissions: { ...DEFAULT_PERMISSIONS },
      roomState: createRoomSnapshot(),
      members: {},
      isReady: false
    };
    this.sockets = new Map();
    this.tickTimer = null;
    this.ready = this.init();
  }

  async init() {
    const persisted = await this.state.storage.get(ROOM_KEY);
    if (persisted) {
      this.rooms = { ...this.rooms, ...persisted };
    }
    if (!Array.isArray(this.rooms.roomState.sections) || this.rooms.roomState.sections.length === 0) {
      this.rooms.roomState = createRoomSnapshot(this.rooms.roomState);
    }
    this.rooms.isReady = true;
    if (this.rooms.roomState.running) this.startTicker();
  }

  firstPlayableIndex(fromIndex = 0) {
    const sections = this.rooms.roomState.sections || [];
    let idx = Number(fromIndex);
    if (!Number.isFinite(idx)) idx = 0;
    if (idx < 0) idx = 0;
    while (idx < sections.length && this.sectionMs(idx) <= 0) idx += 1;
    return idx;
  }

  async persist() {
    await this.ready;
    await this.state.storage.put(ROOM_KEY, this.rooms);
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname.endsWith("/init") && request.method === "POST") {
      await this.seedRoom(await this.safeJson(request));
      return new Response("ok", { status: 200 });
    }

    const isWebSocket = request.headers.get("Upgrade") === "websocket";
    if (isWebSocket && url.pathname.endsWith("/ws")) {
      return this.upgradeSocket(request);
    }

    return new Response("not found", { status: 404 });
  }

  async safeJson(request) {
    try {
      return await request.json();
    } catch (_error) {
      return {};
    }
  }

  async seedRoom(payload = {}) {
    const next = createRoomState(payload);
    this.rooms.hostToken = next.hostToken || this.rooms.hostToken;
    if (next.permissions) this.rooms.permissions = { ...this.rooms.permissions, ...next.permissions };
    this.rooms.roomState = { ...createRoomSnapshot(next.roomState || next), hostToken: this.rooms.hostToken };
    this.rooms.roomState.configVersion = (this.rooms.roomState.configVersion || 0) + 1;
    this.rooms.roomState.version += 1;
    await this.persist();
  }

  async upgradeSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = pair;
    const connectionId = crypto.randomUUID();

    server.accept();
    this.sockets.set(connectionId, { socket: server, profile: { name: "Invitado", iconSeed: "" }, role: "guest" });

    server.addEventListener("message", (event) => this.onMessage(connectionId, event.data));
    server.addEventListener("close", () => this.disconnect(connectionId));
    server.addEventListener("error", () => this.disconnect(connectionId));

    return new Response(null, { status: 101, webSocket: client });
  }

  async onMessage(connectionId, raw) {
    let payload = {};
    try {
      payload = JSON.parse(typeof raw === "string" ? raw : "{}");
    } catch (_error) {
      return this.send(connectionId, { type: "error", code: "bad_payload", message: "Payload inválido." });
    }

    if (payload.type === "join") {
      this.handleJoin(connectionId, payload);
      return;
    }

    if (payload.type === "action") {
      this.applyAction(connectionId, payload);
      return;
    }

    if (payload.type === "profile") {
      this.applyProfile(connectionId, payload);
      return;
    }

    if (payload.type === "permissions") {
      this.applyPermissions(connectionId, payload);
      return;
    }

    this.send(connectionId, { type: "error", code: "bad_message", message: "Mensaje no soportado." });
  }

  handleJoin(connectionId, payload = {}) {
    const socket = this.sockets.get(connectionId);
    if (!socket) return;

    const profile = sanitizeProfile(payload.profile || {});
    const role = payload.hostToken && payload.hostToken === this.rooms.hostToken ? "host" : "guest";
    socket.profile = profile;
    socket.role = role;

    this.rooms.members[connectionId] = {
      id: connectionId,
      name: profile.name,
      iconSeed: profile.iconSeed,
      role,
      connectedAt: Date.now()
    };
    this.sockets.set(connectionId, socket);

    this.send(connectionId, {
      type: "state",
      role,
      permissions: this.rooms.permissions,
      roomState: cloneForClient(this.rooms.roomState),
      members: this.getMembers()
    });

    this.broadcastState();
  }

  applyProfile(connectionId, payload = {}) {
    const socket = this.sockets.get(connectionId);
    if (!socket) return;

    const profile = sanitizeProfile(payload.profile || payload);
    socket.profile = profile;
    const member = this.rooms.members[connectionId];
    if (member) {
      member.name = profile.name;
      member.iconSeed = profile.iconSeed;
      member.connectedAt = Date.now();
      this.rooms.members[connectionId] = member;
    }
    this.broadcastState();
  }

  applyAction(connectionId, payload = {}) {
    const socket = this.sockets.get(connectionId);
    if (!socket) return;

    const action = String(payload.action || "");
    const actor = socket.role;
    const roomState = this.rooms.roomState;
    const canPerform = actor === "host" || this.hasPermission(action);
    if (!canPerform) {
      this.send(connectionId, { type: "error", code: "forbidden", message: "Sin permisos para esta acción." });
      return;
    }

    if (action === "start") this.startTimer(connectionId);
    else if (action === "pause") this.pauseTimer(connectionId);
    else if (action === "next") this.nextSection();
    else if (action === "reset") this.resetSession();
    else if (action === "applyConfig") this.applyConfig(payload.payload || {});
    else this.send(connectionId, { type: "error", code: "bad_action", message: "Acción no válida." });
  }

  hasPermission(action) {
    const perms = this.rooms.permissions || {};
    if (action === "start" || action === "pause") return !!perms.guestCanPlay;
    if (action === "next") return !!perms.guestCanNext;
    if (action === "reset") return !!perms.guestCanReset;
    if (action === "applyConfig") return !!perms.guestCanEdit;
    return false;
  }

  applyPermissions(connectionId, payload = {}) {
    const socket = this.sockets.get(connectionId);
    if (!socket || socket.role !== "host") {
      this.send(connectionId, { type: "error", code: "forbidden", message: "Solo el host puede editar permisos." });
      return;
    }
    const perms = payload.permissions || {};
    this.rooms.permissions = {
      guestCanPlay: !!perms.guestCanPlay,
      guestCanNext: !!perms.guestCanNext,
      guestCanReset: !!perms.guestCanReset,
      guestCanEdit: !!perms.guestCanEdit
    };
    this.rooms.roomState.version += 1;
    this.persist();
    this.broadcastState();
  }

  applyConfig(payload = {}) {
    const sections = sanitizeSections(payload.sections);
    const next = createRoomSnapshot({
      name: String(payload.name || this.rooms.roomState.name || "Demo"),
      target: clampNumber(payload.target, this.rooms.roomState.target || 30),
      alertThreshold: clampNumber(payload.alertThreshold, this.rooms.roomState.alertThreshold || 30),
      alertThresholdUnit: payload.alertThresholdUnit === "min" ? "min" : "seg",
      sections: sections.length ? sections : this.rooms.roomState.sections
    });

    this.rooms.roomState.name = next.name;
    this.rooms.roomState.target = next.target;
    this.rooms.roomState.alertThreshold = next.alertThreshold;
    this.rooms.roomState.alertThresholdUnit = next.alertThresholdUnit;
    this.rooms.roomState.sections = next.sections;

    this.rooms.roomState.running = false;
    this.rooms.roomState.completed = false;
    this.rooms.roomState.currentIndex = 0;
    this.rooms.roomState.currentMs = toSectionMs(next.sections[0]);
    this.rooms.roomState.currentStart = 0;
    this.rooms.roomState.version += 1;
    this.rooms.roomState.configVersion += 1;
    this.rooms.roomState.tickIntervalMs = 220;

    this.stopTicker();
    this.persist();
    this.broadcastState();
  }

  startTimer(_connectionId) {
    const roomState = this.rooms.roomState;
    if (!roomState.sections.length) return;
    if (roomState.completed) this.resetSession();
    if (roomState.running) {
      this.broadcastState();
      return;
    }

    if (roomState.currentIndex < 0 || roomState.currentIndex >= roomState.sections.length) {
      roomState.currentIndex = 0;
    }

    if (!roomState.currentMs || roomState.currentMs <= 0) {
      roomState.currentIndex = this.firstPlayableIndex(roomState.currentIndex);
      roomState.currentMs = this.sectionMs(roomState.currentIndex);
      roomState.currentStart = Date.now();
    }

    if (!roomState.currentMs || roomState.currentMs <= 0) {
      roomState.currentIndex = this.firstPlayableIndex(0);
      roomState.currentMs = this.sectionMs(roomState.currentIndex);
      roomState.currentStart = Date.now();
    }

    if (!roomState.currentMs || roomState.currentMs <= 0) {
      this.finishSession();
      return;
    }

    roomState.currentStart = Date.now();
    roomState.running = true;
    roomState.version += 1;
    this.persist();
    this.startTicker();
    this.broadcastState();
  }

  pauseTimer() {
    const roomState = this.rooms.roomState;
    if (!roomState.running) return;
    roomState.currentMs = Math.max(0, roomState.currentMs - (Date.now() - roomState.currentStart));
    roomState.currentStart = 0;
    roomState.running = false;
    roomState.version += 1;
    this.stopTicker();
    this.persist();
    this.broadcastState();
  }

  nextSection() {
    const roomState = this.rooms.roomState;
    if (roomState.currentIndex >= roomState.sections.length - 1) {
      this.finishSession();
      return;
    }
    roomState.currentIndex += 1;
    roomState.currentMs = this.sectionMs(roomState.currentIndex);
    roomState.currentStart = roomState.running ? Date.now() : 0;
    roomState.version += 1;
    this.persist();
    this.broadcastState();
  }

  resetSession() {
    const roomState = this.rooms.roomState;
    roomState.running = false;
    roomState.completed = false;
    roomState.currentIndex = 0;
    roomState.currentMs = this.sectionMs(0);
    roomState.currentStart = 0;
    roomState.lastSectionIndex = -1;
    roomState.version += 1;
    this.stopTicker();
    this.persist();
    this.broadcastState();
  }

  finishSession() {
    const roomState = this.rooms.roomState;
    roomState.running = false;
    roomState.completed = true;
    roomState.currentIndex = roomState.sections.length;
    roomState.currentMs = 0;
    roomState.currentStart = 0;
    roomState.version += 1;
    this.stopTicker();
    this.persist();
    this.broadcastState();
  }

  sectionMs(index) {
    const sections = this.rooms.roomState.sections || [];
    if (!sections[index]) return 0;
    return toSectionMs(sections[index]);
  }

  startTicker() {
    this.stopTicker();
    this.tickTimer = setInterval(() => this.tick(), this.rooms.roomState.tickIntervalMs || 220);
  }

  stopTicker() {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  tick() {
    const roomState = this.rooms.roomState;
    if (!roomState.running) {
      this.stopTicker();
      return;
    }
    if (!roomState.sections.length) {
      this.finishSession();
      return;
    }

    let nextIndex = roomState.currentIndex;
    let nextRemaining = Math.max(0, Number(roomState.currentMs) || 0);
    let elapsed = Math.max(0, Date.now() - roomState.currentStart);
    let overshoot = elapsed;

    if (nextIndex < 0 || nextIndex >= roomState.sections.length) {
      nextIndex = this.firstPlayableIndex(0);
      nextRemaining = this.sectionMs(nextIndex);
    }

    while (nextIndex < roomState.sections.length) {
      const currentDuration = this.sectionMs(nextIndex);
      if (currentDuration <= 0) {
        if (nextIndex >= roomState.sections.length - 1) {
          this.finishSession();
          return;
        }
        nextIndex += 1;
        nextRemaining = this.sectionMs(nextIndex);
        continue;
      }

      if (nextRemaining <= 0 || nextRemaining > currentDuration) {
        nextRemaining = currentDuration;
      }

      if (overshoot < nextRemaining) {
        break;
      }

      overshoot -= nextRemaining;
      if (nextIndex >= roomState.sections.length - 1) {
        this.finishSession();
        return;
      }

      nextIndex += 1;
      nextRemaining = this.sectionMs(nextIndex);
    }

    if (roomState.running) {
      roomState.currentIndex = nextIndex;
      roomState.currentMs = nextRemaining;
      roomState.currentStart = Date.now() - overshoot;
      roomState.version += 1;
      this.broadcastState();
    }
  }

  getMembers() {
    return Object.values(this.rooms.members || {});
  }

  async send(connectionId, payload) {
    const socket = this.sockets.get(connectionId)?.socket;
    if (!socket) return;
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  async broadcastState() {
    const statePayload = {
      type: "state",
      permissions: this.rooms.permissions,
      roomState: cloneForClient(this.rooms.roomState),
      members: this.getMembers()
    };

    for (const [id] of this.sockets) {
      const socket = this.sockets.get(id)?.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) continue;
      const role = this.rooms.members[id]?.role || "guest";
      socket.send(JSON.stringify({ ...statePayload, role }));
    }
  }

  async disconnect(connectionId) {
    const socket = this.sockets.get(connectionId);
    if (socket) {
      try {
        socket.socket?.close();
      } catch (_error) {}
      this.sockets.delete(connectionId);
      delete this.rooms.members[connectionId];
      if (!this.sockets.size) this.stopTicker();
      this.broadcastState();
    }
  }
}

async function handleCreateRoom(request, env) {
  const payload = await safeJson(request);
  const roomId = createRoomId();
  const hostToken = crypto.randomUUID();
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const initReq = new Request(`https://rooms.internal/api/rooms/${roomId}/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, hostToken })
  });
  const initRes = await stub.fetch(initReq);
  if (!initRes.ok) {
    return new Response("No se pudo inicializar la sala", { status: 500 });
  }
  return Response.json({ roomId, hostToken, wsUrl: `/api/rooms/${roomId}/ws` });
}

function safeJson(request) {
  try {
    return request.json();
  } catch (_error) {
    return Promise.resolve({});
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/rooms")) {
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        return handleCreateRoom(request, env);
      }
      const roomId = (url.pathname.split("/")[3] || "").trim();
      if (!roomId) return new Response("Bad request", { status: 400 });
      const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return room.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};

export { SyncRoom };
