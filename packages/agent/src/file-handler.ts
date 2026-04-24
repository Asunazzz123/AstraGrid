import { readFileSync } from "fs";
import { basename } from "path";
import { FilePayload } from "@bot/shared";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export function readFile(filePath: string): FilePayload {
  const buf = readFileSync(filePath);
  const ext = basename(filePath).match(/\.[a-z0-9]+$/i)?.[0] ?? "";
  return {
    name: basename(filePath),
    mime: MIME_MAP[ext.toLowerCase()] ?? "application/octet-stream",
    data: buf.toString("base64"),
    size: buf.length,
  };
}
