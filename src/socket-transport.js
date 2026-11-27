export class SocketServerTransport {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.onmessage = undefined;
    this.onclose = undefined;
    this.onerror = undefined;
  }

  async start() {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) {
          try {
            this.onmessage?.(JSON.parse(line));
          } catch (err) {
            this.onerror?.(err instanceof Error ? err : new Error(String(err)));
          }
        }
        index = this.buffer.indexOf('\n');
      }
    });
    this.socket.on('error', (err) => {
      this.onerror?.(err);
    });
    this.socket.on('close', () => {
      this.onclose?.();
    });
  }

  async send(message) {
    if (this.socket.destroyed) return;
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    if (!this.socket.destroyed) {
      this.socket.end();
    }
  }
}
