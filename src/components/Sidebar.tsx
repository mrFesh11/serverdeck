import { useState } from "react";
import { useLang, useT } from "../i18n";
import type { Runtime, ServerCfg, Snippet, Status, TabMode } from "../types";

export const statusColor = (s: Status) =>
  s === "online" ? "var(--green)" : s === "offline" ? "var(--red)" : "var(--yellow)";

export const barColor = (v: number) =>
  v >= 80 ? "var(--red)" : v >= 60 ? "var(--yellow)" : "var(--accent)";

interface SidebarProps {
  servers: ServerCfg[];
  runtimes: Record<string, Runtime>;
  snippets: Snippet[];
  activeServerId: string | null;
  onCollapse: () => void;
  onOpenTab: (serverId: string | null, mode: TabMode) => void;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (s: ServerCfg) => void;
  onPalette: () => void;
  onSnippets: () => void;
  onDashboard: () => void;
  onSettings: () => void;
}

export function Sidebar(p: SidebarProps) {
  const t = useT();
  const { lang, setLang } = useLang();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const online = p.servers.filter((s) => p.runtimes[s.id]?.status === "online").length;

  return (
    <div className="sidebar">
      <div className="sb-brand">
        <div className="sb-logo">N</div>
        <div className="sb-title">Nimbus</div>
        <div style={{ flex: 1 }} />
        <div className="kbd" title="RU / EN" onClick={() => setLang(lang === "ru" ? "en" : "ru")}>
          {lang.toUpperCase()}
        </div>
        <div className="kbd" title={t("Команды (Ctrl+K)")} onClick={p.onPalette}>⌘K</div>
        <div className="sb-collapse" title={t("Настройки")} onClick={p.onSettings} style={{ fontSize: 14 }}>⚙</div>
        <div className="sb-collapse" title={t("Свернуть")} onClick={p.onCollapse}>‹</div>
      </div>

      <div style={{ padding: "10px 12px 4px" }}>
        <div className="sb-add" onClick={p.onAdd}>{t("+ Добавить сервер")}</div>
      </div>
      <div style={{ display: "flex", gap: 8, padding: "0 12px 8px", justifyContent: "center" }}>
        <span style={{ fontSize: 11, color: "var(--accent)", cursor: "pointer" }} onClick={p.onDashboard}>
          {t("Дашборд")}
        </span>
        <span style={{ color: "var(--dimmer)" }}>·</span>
        <span style={{ fontSize: 11, color: "var(--dim)", cursor: "pointer" }} onClick={p.onImport}>
          {t("Импорт ssh-config")}
        </span>
      </div>

      <div className="sb-sec">
        <span className="sec-label">{t("Серверы")}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--dimmer)" }}>
          {online}/{p.servers.length}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
        {p.servers.map((s) => {
          const rt = p.runtimes[s.id];
          const st = rt?.status ?? "unknown";
          const m = rt?.metrics;
          return (
            <div
              key={s.id}
              className={
                "srv-row" +
                (p.activeServerId === s.id ? " active" : "") +
                (st === "offline" ? " offline" : "")
              }
              onClick={() => p.onOpenTab(s.id, "terminal")}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: s.id, x: e.clientX, y: e.clientY });
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {st === "connecting" ? (
                  <span className="spin" />
                ) : (
                  <span className="dot" style={{ background: statusColor(st) }} />
                )}
                <span className="srv-name" style={{ color: st === "offline" ? "#6a7079" : "var(--text)" }}>
                  {s.name}
                </span>
                {st === "offline" && (
                  <span className="mono" style={{ fontSize: 10, color: "var(--red)" }}>offline</span>
                )}
                <span
                  className="srv-edit"
                  title={t("Настройки")}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onEdit(s);
                  }}
                >
                  ✎
                </span>
              </div>
              <div className="srv-host">{s.user}@{s.host}</div>
              {st === "online" && m && (
                <div style={{ display: "flex", gap: 12, paddingLeft: 16, paddingTop: 1 }}>
                  {(["CPU", "RAM"] as const).map((lbl) => {
                    const v = lbl === "CPU" ? m.cpu : m.ramPct;
                    return (
                      <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 5, flex: 1 }}>
                        <span className="mono" style={{ fontSize: 9, color: "var(--dim)", width: 22 }}>{lbl}</span>
                        <span className="meter">
                          <span style={{ width: `${Math.round(v)}%`, background: barColor(v) }} />
                        </span>
                        <span className="mono" style={{ fontSize: 9, color: "var(--muted)", width: 24, textAlign: "right" }}>
                          {Math.round(v)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {p.servers.length === 0 && (
          <div style={{ padding: "14px 8px", fontSize: 12, color: "var(--dim)" }}>
            {t("Нет серверов. Добавьте первый.")}
          </div>
        )}
      </div>

      <div className="sb-foot">
        <div
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 7px 7px", cursor: "pointer" }}
          onClick={p.onSnippets}
        >
          <span className="sec-label">{t("Сниппеты")}</span>
          <span style={{ fontSize: 11, color: "var(--accent)" }}>{t("Открыть →")}</span>
        </div>
        {p.snippets.slice(0, 3).map((sn) => (
          <div key={sn.id} className="snip-mini" onClick={p.onSnippets}>
            <span style={{ width: 5, height: 5, borderRadius: 1, background: "var(--dimmer)", flex: "none" }} />
            <span style={{ flex: 1, fontSize: 12, color: "#b6bac2", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {sn.title}
            </span>
            <span className="mono" style={{ fontSize: 9, color: "var(--dim)" }}>{sn.tags[0] ?? ""}</span>
          </div>
        ))}
      </div>

      {menu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 65 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            {(
              [
                [t("Терминал"), "terminal"],
                [t("Обзор"), "overview"],
                [t("Проводник"), "explorer"],
                [t("Файлы (SFTP)"), "files"],
              ] as [string, TabMode][]
            ).map(([label, mode]) => (
              <div
                key={mode}
                className="ctx-item"
                onClick={() => {
                  p.onOpenTab(menu.id, mode);
                  setMenu(null);
                }}
              >
                <span style={{ width: 16, textAlign: "center", color: "var(--muted)" }}>
                  {mode === "terminal" ? ">_" : mode === "overview" ? "▤" : mode === "explorer" ? "▦" : "⇅"}
                </span>
                <span>{label}</span>
              </div>
            ))}
            <div
              className="ctx-item"
              style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 9 }}
              onClick={() => {
                const s = p.servers.find((x) => x.id === menu.id);
                if (s) p.onEdit(s);
                setMenu(null);
              }}
            >
              <span style={{ width: 16, textAlign: "center", color: "var(--muted)" }}>✎</span>
              <span>{t("Настройки сервера")}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface RailProps {
  servers: ServerCfg[];
  runtimes: Record<string, Runtime>;
  onExpand: () => void;
  onServer: (s: ServerCfg) => void;
  onAdd: () => void;
}

export function Rail(p: RailProps) {
  return (
    <div className="rail">
      <div className="rail-logo" onClick={p.onExpand}>N</div>
      <div style={{ width: 20, height: 1, background: "var(--border)" }} />
      {p.servers.map((s) => (
        <div key={s.id} className="rail-item" title={s.name} onClick={() => p.onServer(s)}>
          <span>{s.name.slice(0, 2)}</span>
          <span className="rail-dot" style={{ background: statusColor(p.runtimes[s.id]?.status ?? "unknown") }} />
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <div className="rail-item" style={{ fontSize: 18 }} onClick={p.onAdd}>+</div>
    </div>
  );
}
