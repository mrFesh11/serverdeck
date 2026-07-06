export type Status = "unknown" | "connecting" | "online" | "offline";

export interface JumpCfg {
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

export interface ServerCfg {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  jump?: JumpCfg | null;
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

export type TabMode = "terminal" | "overview" | "explorer" | "files" | "snippets";

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
  accent: "#5b93cc",
  accentSoft: "rgba(91,147,204,0.16)",
  green: "#6ea36b",
  yellow: "#d1a24d",
  red: "#c85c58",
};
