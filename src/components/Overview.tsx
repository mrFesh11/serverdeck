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
  const [cMenu, setCMenu] = useState<{ name: string; state: string; x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<{ action: string; label: string; name: string; danger: boolean; kind: "docker" | "systemd" } | null>(null);
  const [acting, setActing] = useState(false);
  const [services, setServices] = useState<import("../ipc").ServiceUnit[] | "loading" | null>(null);
  const [svcQuery, setSvcQuery] = useState("");
  const [svcMenu, setSvcMenu] = useState<{ name: string; active: string; x: number; y: number } | null>(null);

  const loadServices = async () => {
    setServices("loading");
    try {
      setServices(await ipc.listServices(server));
    } catch (e) {
      setServices([]);
      toast(`${t("Ошибка:")} ${e}`, true);
    }
  };

  const runSystemd = async (action: string, name: string) => {
    setActing(true);
    try {
      const res = await ipc.systemdAction(server, action, name);
      if (action === "status") setLogs({ name: `${name}.service`, text: res.out || "(пусто)" });
      else if (res.code === 0) toast(`systemctl ${action}: ${name}`);
      else toast(`systemctl ${action} · ${name}: ${res.out.trim() || "код " + res.code}`, true);
      if (action !== "status") void loadServices();
    } catch (e) {
      toast(`${t("Ошибка:")} ${e}`, true);
    } finally {
      setActing(false);
      setConfirm(null);
    }
  };

  const runDocker = async (action: string, name: string) => {
    setActing(true);
    try {
      const res = await ipc.dockerAction(server, action, name);
      if (res.code === 0) toast(`docker ${action}: ${name}`);
      else toast(`docker ${action} · ${name}: ${res.out.trim() || "код " + res.code}`, true);
      onRefresh();
    } catch (e) {
      toast(`${t("Ошибка:")} ${e}`, true);
    } finally {
      setActing(false);
      setConfirm(null);
    }
  };

  const dockerItems: [string, string, boolean][] = [
    ["Логи", "logs", false],
    ["Старт", "start", false],
    ["Стоп", "stop", true],
    ["Рестарт", "restart", true],
    ["Удалить", "rm", true],
  ];

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
                <span
                  className="link"
                  style={{ textAlign: "right", fontSize: 15, letterSpacing: 1 }}
                  title={t("Действия")}
                  onClick={(e) => setCMenu({ name: c.name, state: c.state, x: e.clientX, y: e.clientY })}
                >
                  ⋯
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "22px 0 10px" }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{t("Сервисы")}</h3>
        <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>systemd</span>
        <span style={{ flex: 1 }} />
        {Array.isArray(services) && (
          <input
            style={{ width: 200, padding: "5px 9px", fontSize: 12 }}
            placeholder={t("Фильтр…")}
            value={svcQuery}
            onChange={(e) => setSvcQuery(e.target.value)}
          />
        )}
        <div className="btn-ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => void loadServices()}>
          {services === "loading" ? "…" : Array.isArray(services) ? t("Обновить") : t("Показать сервисы")}
        </div>
      </div>
      {Array.isArray(services) && (
        <div className="tbl">
          <div className="tbl-head" style={{ gridTemplateColumns: "1.4fr 0.8fr 0.8fr 2fr 40px" }}>
            <span>{t("Имя")}</span><span>Active</span><span>Sub</span><span>{t("Описание")}</span><span />
          </div>
          {services
            .filter((s) => !svcQuery || s.name.toLowerCase().includes(svcQuery.toLowerCase()) || s.desc.toLowerCase().includes(svcQuery.toLowerCase()))
            .slice(0, 300)
            .map((s) => {
              const col = s.active === "active" ? "var(--green)" : s.active === "failed" ? "var(--red)" : "#7a5b5b";
              return (
                <div className="tbl-row" key={s.name} style={{ gridTemplateColumns: "1.4fr 0.8fr 0.8fr 2fr 40px" }}>
                  <span className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: col }} />
                    <span style={{ fontSize: 12, color: col }}>{s.active}</span>
                  </span>
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>{s.sub}</span>
                  <span style={{ fontSize: 12, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.desc}</span>
                  <span className="link" style={{ textAlign: "right", fontSize: 15, letterSpacing: 1 }} onClick={(e) => setSvcMenu({ name: s.name, active: s.active, x: e.clientX, y: e.clientY })}>⋯</span>
                </div>
              );
            })}
        </div>
      )}

      {svcMenu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 65 }} onClick={() => setSvcMenu(null)} />
          <div className="ctx-menu" style={{ left: Math.min(svcMenu.x, window.innerWidth - 200), top: Math.min(svcMenu.y, window.innerHeight - 220), width: 180 }}>
            <div className="mono" style={{ padding: "5px 10px 7px", fontSize: 10.5, color: "var(--dim)", borderBottom: "1px solid var(--border)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {svcMenu.name}
            </div>
            {([["Статус", "status", false], ["Старт", "start", false], ["Стоп", "stop", true], ["Рестарт", "restart", true]] as [string, string, boolean][])
              .filter(([, action]) => action === "status" ? true : action === "start" ? svcMenu.active !== "active" : svcMenu.active === "active")
              .map(([label, action, danger]) => (
                <div
                  key={action}
                  className={"ctx-item" + (danger ? " danger" : "")}
                  onClick={() => {
                    const name = svcMenu.name;
                    setSvcMenu(null);
                    if (danger) setConfirm({ action, label: t(label), name, danger, kind: "systemd" });
                    else void runSystemd(action, name);
                  }}
                >
                  <span style={{ width: 16, textAlign: "center", color: danger ? "var(--red)" : "var(--muted)" }}>
                    {action === "status" ? "≡" : action === "start" ? "▸" : action === "stop" ? "■" : "↻"}
                  </span>
                  <span>{t(label)}</span>
                </div>
              ))}
          </div>
        </>
      )}

      {cMenu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 65 }} onClick={() => setCMenu(null)} />
          <div className="ctx-menu" style={{ left: Math.min(cMenu.x, window.innerWidth - 200), top: Math.min(cMenu.y, window.innerHeight - 220), width: 180 }}>
            <div className="mono" style={{ padding: "5px 10px 7px", fontSize: 10.5, color: "var(--dim)", borderBottom: "1px solid var(--border)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {cMenu.name}
            </div>
            {dockerItems
              .filter(([, action]) =>
                action === "logs" || action === "rm"
                  ? true
                  : action === "start"
                  ? cMenu.state !== "running"
                  : cMenu.state === "running"
              )
              .map(([label, action, danger]) => (
                <div
                  key={action}
                  className={"ctx-item" + (danger ? " danger" : "")}
                  onClick={() => {
                    const name = cMenu.name;
                    setCMenu(null);
                    if (action === "logs") void showLogs(name);
                    else if (danger) setConfirm({ action, label: t(label), name, danger, kind: "docker" });
                    else void runDocker(action, name);
                  }}
                >
                  <span style={{ width: 16, textAlign: "center", color: danger ? "var(--red)" : "var(--muted)" }}>
                    {action === "logs" ? "≡" : action === "start" ? "▸" : action === "stop" ? "■" : action === "restart" ? "↻" : "✕"}
                  </span>
                  <span>{t(label)}</span>
                </div>
              ))}
          </div>
        </>
      )}

      {confirm && (
        <div className="overlay" onClick={() => !acting && setConfirm(null)}>
          <div className="modal" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {confirm.label} · docker
              <span className="modal-x" onClick={() => !acting && setConfirm(null)}>×</span>
            </div>
            <div style={{ padding: 18, fontSize: 13, color: "var(--body)", lineHeight: 1.5 }}>
              {confirm.kind === "systemd"
                ? confirm.action === "stop"
                  ? t("Остановить сервис")
                  : t("Перезапустить сервис")
                : confirm.action === "rm"
                ? t("Удалить контейнер")
                : confirm.action === "stop"
                ? t("Остановить контейнер")
                : t("Перезапустить контейнер")}{" "}
              <b className="mono">{confirm.name}</b>{t(" на")} <span className="mono">{server.name}</span>?
              <div style={{ fontSize: 11.5, color: "var(--yellow)", marginTop: 8 }}>
                {t("Это продакшен — действие затронет живой сервис.")}
              </div>
            </div>
            <div className="modal-foot">
              <span style={{ flex: 1 }} />
              <div className="btn-text" onClick={() => !acting && setConfirm(null)}>{t("Отмена")}</div>
              <div className={"btn-danger" + (acting ? " disabled" : "")} style={{ padding: "9px 16px" }} onClick={() => void (confirm.kind === "systemd" ? runSystemd : runDocker)(confirm.action, confirm.name)}>
                {acting ? "…" : confirm.label}
              </div>
            </div>
          </div>
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
