import { randomUUID } from "crypto";
import { ParsedCommand } from "./parser";
import { DevicePool } from "./device-pool";
import { GateToDev } from "@bot/shared";

export type RouteResult =
  | { ok: true; taskId: string; device: string }
  | { ok: false; error: string };

export function route(cmd: ParsedCommand, pool: DevicePool): RouteResult {
  const dev = pool.getDevice(cmd.device);

  if (!dev) {
    const online = pool.listDevices().map(d => d.device).join(", ") || "none";
    return { ok: false, error: `Device "${cmd.device}" not found. Online: ${online}` };
  }

  if (!dev.online) {
    return { ok: false, error: `Device "${cmd.device}" is offline` };
  }

  if (!dev.agents.includes(cmd.agent)) {
    return { ok: false, error: `Device "${cmd.device}" has no "${cmd.agent}" agent. Available: ${dev.agents.join(", ")}` };
  }

  const taskId = randomUUID();
  const cwd = cmd.project
    ? dev.projects.find(p => p === cmd.project || p.endsWith("/" + cmd.project)) ?? dev.projects[0] ?? process.cwd()
    : dev.projects[0] ?? process.cwd();

  const exec: GateToDev = {
    type: "exec",
    id: taskId,
    agent: cmd.agent,
    cwd,
    task: cmd.task,
  };

  pool.send(cmd.device, exec);

  return { ok: true, taskId, device: cmd.device };
}
