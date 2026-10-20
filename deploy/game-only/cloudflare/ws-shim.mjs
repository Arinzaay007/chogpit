// Wrangler aliases the Node-only 'ws' package to this minimal interface.
// LiveRooms still owns all authoritative room/game rules. Actual WebSocket
// upgrading and message delivery are handled by Cloudflare Durable Objects.
export const WebSocket = { OPEN: 1 };
export class WebSocketServer {
  constructor() { this.clients = new Set(); }
  close() { this.clients.clear(); }
}
