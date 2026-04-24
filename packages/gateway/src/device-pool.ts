import { WebSocketServer, WebSocket } from "ws";
import { GateToDev, DevToGate, AgentType } from "@bot/shared";

export type DeviceInfo = {
  device: string;
  agents: AgentType[];
  projects: string[];
  online: boolean;
  lastHeartbeat: number;
};

type InternalDevice = DeviceInfo & { ws: WebSocket };

export class DevicePool {
  private devices = new Map<string, InternalDevice>();
  private wss: WebSocketServer;
  private tokens: Record<string, string>;
  private listeners: Array<(device: string, msg: DevToGate) => void> = [];

  constructor(port: number, tokens: Record<string, string>) {
    this.tokens = tokens;
    this.wss = new WebSocketServer({ port });

    this.wss.on("connection", (ws) => {
      let deviceName: string | null = null;

      ws.on("message", (raw) => {
        let msg: DevToGate;
        try { msg = JSON.parse(raw.toString()) as DevToGate; } catch { return; }

        if (msg.type === "register") {
          if (this.tokens[msg.device] !== msg.token) {
            ws.close(4001, "unauthorized");
            return;
          }
          deviceName = msg.device;
          this.devices.set(msg.device, {
            ws,
            device: msg.device,
            agents: msg.agents,
            projects: msg.projects,
            online: true,
            lastHeartbeat: Date.now(),
          });
          console.log(`[device-pool] ${msg.device} registered`);
          return;
        }

        if (msg.type === "pong" && deviceName) {
          const dev = this.devices.get(deviceName);
          if (dev) {
            dev.lastHeartbeat = Date.now();
            dev.online = true;
          }
          return;
        }

        if (deviceName) {
          for (const fn of this.listeners) fn(deviceName, msg);
        }
      });

      ws.on("close", () => {
        if (deviceName) {
          const dev = this.devices.get(deviceName);
          if (dev && dev.ws === ws) {
            dev.online = false;
            console.log(`[device-pool] ${deviceName} disconnected`);
          }
        }
      });
    });

    // Heartbeat: ping every 30s, offline after 90s
    setInterval(() => {
      const now = Date.now();
      for (const [name, dev] of this.devices) {
        if (now - dev.lastHeartbeat > 90000) {
          dev.online = false;
          this.devices.delete(name);
          console.log(`[device-pool] ${name} timed out`);
        } else if (dev.online) {
          dev.ws.send(JSON.stringify({ type: "ping" } satisfies GateToDev));
        }
      }
    }, 30000);

    console.log(`[device-pool] WebSocket server listening on :${port}`);
  }

  getDevice(name: string): DeviceInfo | undefined {
    return this.devices.get(name);
  }

  listDevices(): DeviceInfo[] {
    return [...this.devices.values()].map(({ ws: _, ...info }) => info);
  }

  send(device: string, msg: GateToDev): boolean {
    const dev = this.devices.get(device);
    if (!dev?.online) return false;
    dev.ws.send(JSON.stringify(msg));
    return true;
  }

  onMessage(fn: (device: string, msg: DevToGate) => void): void {
    this.listeners.push(fn);
  }

  close(): void {
    this.wss.close();
  }
}
