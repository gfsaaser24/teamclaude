// src/events.js
/**
 * EventHub — in-memory event ring buffer with SSE fan-out.
 *
 * The server command emits request-lifecycle and oauth-flow events here; the
 * desktop UI subscribes via GET /teamclaude/events and backfills from the
 * ring buffer (sent as the initial `hello` frame, also exposed as
 * GET /teamclaude/log).
 */
export class EventHub {
  constructor({ bufferSize = 200, bootId = null } = {}) {
    this.bufferSize = bufferSize;
    // Random per-process id (item 4). Sent in the SSE hello (and mirrored on
    // /status and /log) so a client reconnecting across a restart detects that
    // the numeric event ids reset and re-seeds instead of mis-associating.
    this.bootId = bootId;
    this.recentEvents = [];
    this.clients = new Set();
    this.nextEventId = 1;
  }

  emit(type, data = {}) {
    const event = { id: this.nextEventId++, type, ts: Date.now(), ...data };
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.bufferSize) this.recentEvents.shift();
    const frame = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try { res.write(frame); } catch { this.clients.delete(res); }
    }
    return event;
  }

  recent() {
    return [...this.recentEvents];
  }

  clientCount() {
    return this.clients.size;
  }

  handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ bootId: this.bootId, recent: this.recent() })}\n\n`);
    this.clients.add(res);
    // Keep intermediaries from timing out an idle stream; unref so the timer
    // never holds the process open.
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* removed on close */ }
    }, 30_000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    });
  }
}
