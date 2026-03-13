'use strict';

/**
 * Room manager for WebSocket connections.
 * - rooms: Map<sessionId, Set<WebSocket>>
 */
const WebSocket = require('ws');

function safeSend(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}

class Rooms {
  constructor() {
    this._rooms = new Map();
  }

  join(sessionId, ws) {
    const sid = String(sessionId);
    if (!this._rooms.has(sid)) this._rooms.set(sid, new Set());
    this._rooms.get(sid).add(ws);
  }

  leave(sessionId, ws) {
    const sid = String(sessionId);
    const set = this._rooms.get(sid);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this._rooms.delete(sid);
  }

  broadcast(sessionId, msg, exceptWs) {
    const sid = String(sessionId);
    const set = this._rooms.get(sid);
    if (!set) return 0;
    let n = 0;
    for (const ws of set) {
      if (exceptWs && ws === exceptWs) continue;
      if (safeSend(ws, msg)) n++;
    }
    return n;
  }
}

module.exports = { Rooms };
