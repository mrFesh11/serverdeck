import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { fmtBytes, fmtUptime, sparkPoints } from "../metrics";
import type { Runtime, ServerCfg } from "../types";
import type { ToastFn } from "./Toasts";
import { ipc } from "../ipc";

interface Props {
  server: ServerCfg;
  runtime: Runtime;
  onRefresh: () => void;
  toast: ToastFn;
}

const W = 110;
const H = 30;
const P = 3;

function Spark({
  vals,
  ts,
  color,
  fmt,
}: {
  vals: number[];
  ts: number[];
  color: string;
  fmt: (v: number) => string;
}) {
  const [idx, setIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (vals.length < 2)
    return <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="28" preserveAspectRatio="none" style={{ display: "block" }} />;

  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const r = mx - mn || 1;
  const xAt = (i: number) => P + (i * (W - 2 * P)) / (vals.length - 1);
  const yAt = (i: number) => H - P - ((vals[i] - mn) / r) * (H - 2 * P);

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setIdx(Math.max(0, Math.min(vals.length - 1, Math.round(rel * (vals.length - 1)))));
  };

  const timeOf = (i: number) => {
    const d = new Date(ts[i] ?? Date.now());
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  return (
    <div className="spark-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="28"
        preserveAspectRatio="none"
        style={{ display: "block", overflow: "visible", cursor: "crosshair" }}
        onMouseMove={onMove}
        onMouseLeave={() => setIdx(null)}
      >
        <polyline
          points={sparkPoints(vals, W, H, P)}
          fill="none"
          stroke={color}
          strokeWidth="1.4"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {idx !== null && (
          <>
            <line
              x1={xAt(idx)}
              y1={0}
              x2={xAt(idx)}
              y2={H}
              stroke="#3a3f49"
              strokeWidth="0.7"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={xAt(idx)} cy={yAt(idx)} r="2.2" fill={color} stroke="#0e1013" strokeWidth="0.8" />
          </>
        )}
      </svg>
      {idx !== null && (
        <div
          className="spark-tip mono"
          style={{ left: `${Math.max(12, Math.min(88, (xAt(idx) / W) * 100))}%` }}
        >
          <span style={{ color }}>{fmt(vals[idx])}</span>
          <span style={{ color: "var(--dim)", marginLeft: 7 }}>{timeOf(idx)}</span>
        </div>
      )}
    </div>
  );
}

export function Overview({ server, runtime, onRefresh, toast }: Props) {
  const t = useT();
  const m = runtime.metrics;
  const [, tick] = useState(0);
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);

  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const ago = m ? Math.max(0, Math.round((Date.now() - m.ts) / 1000)) : null;

  const showLogs = async (name: string) => {
    setLogs({ name, text: t("загрузка…") });
    try {
      const res = await ipc.exec(server, `docker logs --tail 120 ${name} 2>&1`);
      setLogs({ name, text: res.out || t("(пусто)") });
    } catch (e) {
      setLogs({ name, text: String(e) });
    }
  };

  if (!m) {
    return (
      <div className="ex-state" style={{ flex: 1 }}>
        {runtime.status === "offline" ? (
          <>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{t("Сервер недоступен")}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--red)", maxWidth: 480, textAlign: "center" }}>
              {runtime.error ?? ""}
            </div>
            <div className="btn-ghost" style={{ padding: "8px 16px" }} onClick={onRefresh}>{t("Повторить")}</div>
          </>
        ) : (
          <>
            <span className="spin" style={{ width: 18, height: 18 }} />
            <div style={{ color: "var(--muted)" }}>{t("Подключение к")} {server.name}…</div>
          </>
        )}
      </div>
    );
  }

  const pct = (v: number) => `${Math.round(v)}%`;
  const cards = [
    { label: "CPU", value: `${Math.round(m.cpu)}%`, sub: `${m.cpus} vCPU`, vals: runtime.hist.cpu, fmt: pct, color: m.cpu >= 80 ? "var(--red)" : m.cpu >= 60 ? "var(--yellow)" : "var(--accent)" },
    { label: "RAM", value: `${Math.round(m.ramPct)}%`, sub: `${fmtBytes(m.ramUsed)} / ${fmtBytes(m.ramTotal)}`, vals: runtime.hist.ram, fmt: pct, color: m.ramPct >= 80 ? "var(--red)" : m.ramPct >= 60 ? "var(--yellow)" : "var(--accent)" },
    { label: t("Диск"), value: `${Math.round(m.diskPct)}%`, sub: `${fmtBytes(m.diskUsed)} / ${fmtBytes(m.diskTotal)}`, vals: runtime.hist.disk, fmt: pct, color: "var(--green)" },
    { label: t("Сеть"), value: `${fmtBytes(m.rxRate)}/s`, sub: t("↓ входящий"), vals: runtime.hist.net, fmt: (v: number) => `${fmtBytes(v)}/s`, color: "var(--accent)" },
    { label: "Load avg", value: m.load1.toFixed(2), sub: `${m.load5.toFixed(2)} · ${m.load15.toFixed(2)}`, vals: runtime.hist.load, fmt: (v: number) => v.toFixed(2), color: "var(--accent)" },
    { label: "Uptime", value: fmtUptime(m.uptimeSec), sub: m.os || "—", vals: [] as number[], fmt: pct, color: "var(--dim)" },
  ];

  const running = m.containers.filter((c) => c.state === "running").length;

  return (
    <div className="overview">
      <div className="ov-head">
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{server.name}</h2>
        <span className="mono" style={{ fontSize: 12, color: "var(--dim)" }}>
          {server.host} · {m.os || "Linux"} · {m.cpus} vCPU / {fmtBytes(m.ramTotal)}
        </span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--green)" }}>
          ● online · {t("обновлено")} {ago}{t("с назад")}
        </span>
      </div>

      <div className="cards">
        {cards.map((c) => (
          <div className="card" key={c.label}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="card-label">{c.label}</span>
              <span className="card-sub">{c.sub}</span>
            </div>
            <div className="card-value">{c.value}</div>
            <Spark vals={c.vals} ts={runtime.hist.ts} color={c.color} fmt={c.fmt} />
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Docker</h3>
        <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
          {m.containers.length
            ? `${m.containers.length} ${t("контейнеров")} · ${running} running`
            : t("docker не найден или нет контейнеров")}
        </span>
      </div>

      {m.containers.length > 0 && (
        <div className="tbl">
          <div className="tbl-head">
            <span>{t("Имя")}</span><span>Image</span><span>{t("Статус")}</span><span>Uptime</span><span />
          </div>
          {m.containers.map((c) => {
            const col =
              c.state === "running" ? "var(--green)" : c.state === "restarting" ? "var(--yellow)" : "#7a5b5b";
            return (
              <div className="tbl-row" key={c.name}>
                <span className="mono" style={{ fontSize: 12 }}>{c.name}</span>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.image}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: col }} />
                  <span style={{ fontSize: 12, color: col }}>{c.state}</span>
                </span>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>{c.status}</span>
                <span className="link" style={{ textAlign: "right" }} onClick={() => void showLogs(c.name)}>
                  {t("логи")}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {logs && (
        <div className="overlay" onClick={() => setLogs(null)}>
          <div className="modal" style={{ width: 820, maxHeight: "78vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="mono" style={{ fontSize: 13 }}>docker logs · {logs.name}</span>
              <span className="modal-x" onClick={() => setLogs(null)}>×</span>
            </div>
            <div className="out-body" style={{ maxHeight: "none", flex: 1 }}>
              {logs.text.split("\n").map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
