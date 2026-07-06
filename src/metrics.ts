import type { Container, Metrics } from "./types";

export function metricsCmd(baseline: boolean, docker: boolean): string {
  return `export LANG=C
echo @CPU@; head -1 /proc/stat${baseline ? "; sleep 0.4; head -1 /proc/stat" : ""}
echo @MEM@; free -b 2>/dev/null | grep -i 'mem:'
echo @DISK@; df -B1 -P / 2>/dev/null | tail -1
echo @LOAD@; cat /proc/loadavg 2>/dev/null
echo @UP@; cat /proc/uptime 2>/dev/null
echo @OS@; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; nproc 2>/dev/null
echo @NET@; IF=$(ip route show default 2>/dev/null | awk '{print $5; exit}'); cat /sys/class/net/$IF/statistics/rx_bytes 2>/dev/null || echo 0${
    docker
      ? "\necho @DOCKER@; docker ps -a --format '{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}' 2>/dev/null || true"
      : ""
  }`;
}

function section(out: string, marker: string): string {
  const re = new RegExp(`@${marker}@\\n([\\s\\S]*?)(?=\\n@[A-Z]+@|$)`);
  const m = out.match(re);
  return m ? m[1].trim() : "";
}

function cpuSample(line: string): { total: number; idle: number } | null {
  const p = line.trim().split(/\s+/);
  if (p[0] !== "cpu") return null;
  const v = p.slice(1, 9).map((x) => parseInt(x) || 0);
  const total = v.reduce((a, b) => a + b, 0);
  return { total, idle: v[3] + (v[4] || 0) };
}

export function parseMetrics(out: string, prev?: Metrics): Metrics {
  const cpuLines = section(out, "CPU").split("\n").map(cpuSample).filter(Boolean) as {
    total: number;
    idle: number;
  }[];
  const cur = cpuLines[cpuLines.length - 1];
  const base = cpuLines.length > 1 ? cpuLines[0] : prev?.cpuSample;
  let cpu = prev?.cpu ?? 0;
  if (cur && base && cur.total > base.total) {
    const dt = cur.total - base.total;
    cpu = Math.max(0, Math.min(100, (1 - (cur.idle - base.idle) / dt) * 100));
  }

  const mem = section(out, "MEM").split(/\s+/);
  const ramTotal = parseInt(mem[1] || "0") || 0;
  const ramUsed = parseInt(mem[2] || "0") || 0;

  const disk = section(out, "DISK").split(/\s+/);
  const diskTotal = parseInt(disk[1] || "0") || 0;
  const diskUsed = parseInt(disk[2] || "0") || 0;

  const load = section(out, "LOAD").split(/\s+/);
  const up = section(out, "UP").split(/\s+/);
  const osLines = section(out, "OS").split("\n");
  const net = parseInt(section(out, "NET")) || 0;

  const ts = Date.now();
  let rxRate = 0;
  if (prev && prev.rxBytes > 0 && net >= prev.rxBytes && ts > prev.ts)
    rxRate = ((net - prev.rxBytes) / (ts - prev.ts)) * 1000;

  const containers: Container[] = out.includes("@DOCKER@")
    ? section(out, "DOCKER")
        .split("\n")
        .filter((l) => l.includes("\t"))
        .map((l) => {
          const [name, image, state, status] = l.split("\t");
          return { name, image, state, status };
        })
    : prev?.containers ?? [];

  return {
    cpu,
    cpuSample: cur ?? prev?.cpuSample,
    ramPct: ramTotal ? (ramUsed / ramTotal) * 100 : 0,
    ramUsed,
    ramTotal,
    diskPct: diskTotal ? (diskUsed / diskTotal) * 100 : 0,
    diskUsed,
    diskTotal,
    load1: parseFloat(load[0]) || 0,
    load5: parseFloat(load[1]) || 0,
    load15: parseFloat(load[2]) || 0,
    uptimeSec: parseFloat(up[0]) || 0,
    os: osLines[0] || "",
    cpus: parseInt(osLines[1]) || 0,
    rxBytes: net,
    rxRate,
    containers,
    ts,
  };
}

export function fmtBytes(n: number, digits = 1): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : digits)} ${u[i]}`;
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export function fmtMtime(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function sparkPoints(vals: number[], w = 110, h = 30, p = 3): string {
  if (vals.length < 2) return "";
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const r = mx - mn || 1;
  return vals
    .map((v, i) => {
      const x = p + (i * (w - 2 * p)) / (vals.length - 1);
      const y = h - p - ((v - mn) / r) * (h - 2 * p);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
