import { useT } from "../i18n";
import { fmtBytes, fmtUptime } from "../metrics";
import type { Runtime, ServerCfg } from "../types";
import { statusColor, barColor } from "./Sidebar";

export function Dashboard({
  servers,
  runtimes,
  onOpen,
}: {
  servers: ServerCfg[];
  runtimes: Record<string, Runtime>;
  onOpen: (serverId: string) => void;
}) {
  const t = useT();
  const online = servers.filter((s) => runtimes[s.id]?.status === "online").length;

  return (
    <div className="overview">
      <div className="ov-head">
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{t("Дашборд")}</h2>
        <span className="mono" style={{ fontSize: 12, color: "var(--dim)" }}>
          {online} / {servers.length} online
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
        {servers.map((s) => {
          const rt = runtimes[s.id];
          const st = rt?.status ?? "unknown";
          const m = rt?.metrics;
          return (
            <div key={s.id} className="card" style={{ cursor: "pointer", gap: 11 }} onClick={() => onOpen(s.id)}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {st === "connecting" ? <span className="spin" /> : <span className="dot" style={{ background: statusColor(st) }} />}
                <span style={{ fontSize: 14, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.name}
                </span>
                {rt?.latency !== undefined && st === "online" && (
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--dim)" }}>{rt.latency}ms</span>
                )}
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--dim)" }}>{s.user}@{s.host}</div>
              {st === "online" && m ? (
                <>
                  {([["CPU", m.cpu], ["RAM", m.ramPct], [t("Диск"), m.diskPct]] as [string, number][]).map(([lbl, v]) => (
                    <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span className="mono" style={{ fontSize: 9.5, color: "var(--dim)", width: 26 }}>{lbl}</span>
                      <span className="meter" style={{ flex: 1 }}>
                        <span style={{ width: `${Math.round(v)}%`, background: barColor(v) }} />
                      </span>
                      <span className="mono" style={{ fontSize: 9.5, color: "var(--muted)", width: 30, textAlign: "right" }}>{Math.round(v)}%</span>
                    </div>
                  ))}
                  <div className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>
                    up {fmtUptime(m.uptimeSec)} · {fmtBytes(m.ramTotal)} · {m.cpus} vCPU
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 11.5, color: st === "offline" ? "var(--red)" : "var(--dim)", padding: "8px 0" }}>
                  {st === "offline" ? (rt?.error ?? t("недоступен")) : st === "connecting" ? t("подключение…") : "—"}
                </div>
              )}
            </div>
          );
        })}
        {servers.length === 0 && (
          <div style={{ color: "var(--dim)", fontSize: 13 }}>{t("Нет серверов. Добавьте первый.")}</div>
        )}
      </div>
    </div>
  );
}
