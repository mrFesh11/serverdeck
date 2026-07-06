import { useEffect, useMemo, useRef, useState } from "react";
import type { Runtime, ServerCfg, TabMode } from "../types";
import { statusColor } from "./Sidebar";
import { useT } from "../i18n";

interface Item {
  kind: "server" | "action";
  label: string;
  sub?: string;
  dot?: string;
  icon?: string;
  run: () => void;
}

interface Props {
  servers: ServerCfg[];
  runtimes: Record<string, Runtime>;
  onClose: () => void;
  onServer: (s: ServerCfg, mode: TabMode) => void;
  onAdd: () => void;
  onSnippets: () => void;
}

export function Palette(p: Props) {
  const t = useT();
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const servers: Item[] = p.servers.flatMap((s) => {
      const st = p.runtimes[s.id]?.status ?? "unknown";
      const base = { dot: statusColor(st), sub: `${s.user}@${s.host}` };
      const modes: [TabMode, string][] = [
        ["terminal", t("терминал")],
        ["overview", t("обзор")],
        ["explorer", t("проводник")],
      ];
      return modes.map(([mode, label], i) => ({
        kind: "server" as const,
        label: s.name,
        ...base,
        sub: i === 0 ? base.sub : label,
        icon: label,
        run: () => p.onServer(s, mode),
      }));
    });
    const actions: Item[] = [
      { kind: "action", label: t("Добавить сервер"), icon: "+", run: p.onAdd },
      { kind: "action", label: t("Открыть библиотеку сниппетов"), icon: "⌗", run: p.onSnippets },
    ];
    let all = [...servers, ...actions];
    if (query)
      all = all.filter(
        (i) => i.label.toLowerCase().includes(query) || (i.sub ?? "").toLowerCase().includes(query) || (i.icon ?? "").includes(query)
      );
    return all.slice(0, 14);
  }, [q, p.servers, p.runtimes, t]);

  useEffect(() => setHl(0), [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHl((h) => Math.min(h + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHl((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && items[hl]) {
      items[hl].run();
    }
  };

  const serverItems = items.filter((i) => i.kind === "server");
  const actionItems = items.filter((i) => i.kind === "action");

  return (
    <div className="overlay top" onClick={p.onClose}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "6px 16px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--dim)", fontSize: 15 }}>⌕</span>
          <input
            ref={inputRef}
            style={{ border: "none", background: "transparent", fontSize: 15, padding: "10px 0" }}
            placeholder={t("Перейти к серверу или команде…")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <span className="kbd">esc</span>
        </div>
        <div style={{ maxHeight: 340, overflowY: "auto", padding: 6 }}>
          {serverItems.length > 0 && <div className="pal-sec">{t("Серверы")}</div>}
          {serverItems.map((i) => {
            const idx = items.indexOf(i);
            return (
              <div key={idx} className={"pal-item" + (idx === hl ? " hl" : "")} onClick={i.run} onMouseEnter={() => setHl(idx)}>
                <span className="dot" style={{ background: i.dot }} />
                <span style={{ fontSize: 13 }}>{i.label}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>{i.sub}</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 10, color: "var(--dim)" }}>{i.icon}</span>
              </div>
            );
          })}
          {actionItems.length > 0 && <div className="pal-sec">{t("Действия")}</div>}
          {actionItems.map((i) => {
            const idx = items.indexOf(i);
            return (
              <div key={idx} className={"pal-item" + (idx === hl ? " hl" : "")} onClick={i.run} onMouseEnter={() => setHl(idx)}>
                <span style={{ width: 20, textAlign: "center", color: "var(--muted)", fontSize: 14 }}>{i.icon}</span>
                <span style={{ fontSize: 13 }}>{i.label}</span>
              </div>
            );
          })}
          {!items.length && (
            <div style={{ padding: 18, fontSize: 12.5, color: "var(--dim)", textAlign: "center" }}>{t("Ничего не найдено")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
