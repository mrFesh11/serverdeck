export type Status = "unknown" | "connecting" | "online" | "offline";

export type AuthMethod = "key" | "password" | "agent";

export interface JumpCfg {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  auth: AuthMethod;
}

export interface ServerCfg {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  auth: AuthMethod;
  jump?: JumpCfg | null;
}

export interface Settings {
  pollIntervalSec: number;
  notifyOffline: boolean;
  notifyThresholds: boolean;
  cpuThreshold: number;
  ramThreshold: number;
  diskThreshold: number;
  accent: string;
}

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalSec: 7,
  notifyOffline: true,
  notifyThresholds: true,
  cpuThreshold: 90,
  ramThreshold: 90,
  diskThreshold: 90,
  accent: "#46a86e",
};

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function applyAccent(accent: string) {
  const root = document.documentElement;
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-soft", hexToRgba(accent, 0.16));
}

export interface ParsedHost {
  name: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  proxyJump: string;
}

export interface Container {
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface Metrics {
  cpu: number;
  cpuSample?: { total: number; idle: number };
  ramPct: number;
  ramUsed: number;
  ramTotal: number;
  diskPct: number;
  diskUsed: number;
  diskTotal: number;
  load1: number;
  load5: number;
  load15: number;
  uptimeSec: number;
  os: string;
  cpus: number;
  rxBytes: number;
  rxRate: number;
  containers: Container[];
  ts: number;
}

export interface Runtime {
  status: Status;
  metrics?: Metrics;
  hist: { cpu: number[]; ram: number[]; disk: number[]; net: number[]; load: number[]; ts: number[] };
  latency?: number;
  error?: string;
}

export interface Snippet {
  id: string;
  title: string;
  cmd: string;
  tags: string[];
}

export type TabMode = "terminal" | "overview" | "explorer" | "files" | "snippets" | "dashboard";

export interface Tab {
  id: string;
  serverId: string | null;
  mode: TabMode;
}

export interface FileEntry {
  name: string;
  ftype: "dir" | "file" | "link";
  size: number;
  perms: string;
  owner: string;
  mtime: number;
  hidden: boolean;
}

export interface ExecOut {
  code: number;
  ms: number;
  out: string;
}

export interface SnippetResult {
  serverId: string;
  name: string;
  running: boolean;
  code?: number;
  ms?: number;
  lines?: string[];
  error?: string;
}

export const MODE_LABEL: Record<TabMode, string> = {
  terminal: "Терминал",
  overview: "Обзор",
  explorer: "Проводник",
  files: "Файлы",
  snippets: "Библиотека",
  dashboard: "Дашборд",
};

export const C = {
  bg: "#0e1013",
  term: "#0b0d10",
  panel: "#15171c",
  panel2: "#131519",
  border: "#22252c",
  border2: "#1c1f25",
  text: "#d6d9df",
  body: "#c2c6cd",
  muted: "#868c96",
  dim: "#5b616b",
  dimmer: "#4a4f58",
  accent: "#46a86e",
  accentSoft: "rgba(70, 168, 110,0.16)",
  green: "#6ea36b",
  yellow: "#d1a24d",
  red: "#c85c58",
};
