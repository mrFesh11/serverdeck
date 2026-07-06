import { useMemo, useState } from "react";
import { ipc } from "../ipc";
import { useT } from "../i18n";
import type { Runtime, ServerCfg, Snippet, SnippetResult } from "../types";
import type { ToastFn } from "./Toasts";
import { uid } from "../App";

interface Props {
  snippets: Snippet[];
  setSnippets: (fn: (s: Snippet[]) => Snippet[]) => void;
  servers: ServerCfg[];
  runtimes: Record<string, Runtime>;
  toast: ToastFn;
}

export function SnippetsView({ snippets, setSnippets, servers, runtimes, toast }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(snippets[0]?.id ?? null);
  const [targets, setTargets] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<SnippetResult[]>([]);
  const [running, setRunning] = useState(false);
  const [editor, setEditor] = useState<{ title: string; cmd: string; tags: string } | null>(null);
  const [sudoPw, setSudoPw] = useState("");

  const active = snippets.find((s) => s.id === activeId) ?? null;
  const needsSudo = !!active && /\bsudo\b/.test(active.cmd);
  const online = servers.filter((s) => runtimes[s.id]?.status === "online");
  const selectedIds = online.filter((s) => targets[s.id]).map((s) => s.id);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.cmd.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [snippets, query]);

  const run = async () => {
    if (!active || !selectedIds.length || running) return;
    setRunning(true);
    const targetsList = servers.filter((s) => selectedIds.includes(s.id));
    if (needsSudo && sudoPw)
      await Promise.all(targetsList.map((s) => ipc.provideSecret(`sudo:${s.id}`, sudoPw).catch(() => {})));
    setResults(targetsList.map((s) => ({ serverId: s.id, name: s.name, running: true })));
    await Promise.all(
      targetsList.map(async (s) => {
        try {
          const r = /\bsudo\b/.test(active.cmd)
            ? await ipc.execPty(s, active.cmd)
            : await ipc.exec(s, active.cmd);
          setResults((rs) =>
            rs.map((x) =>
              x.serverId === s.id
                ? { ...x, running: false, code: r.code, ms: r.ms, lines: r.out.split("\n") }
                : x
            )
          );
        } catch (e) {
          setResults((rs) =>
            rs.map((x) => (x.serverId === s.id ? { ...x, running: false, error: String(e) } : x))
          );
        }
      })
    );
    setRunning(false);
  };

  const saveEditor = () => {
    if (!editor || !editor.title.trim() || !editor.cmd.trim()) return;
    const sn: Snippet = {
      id: "sn" + uid(),
      title: editor.title.trim(),
      cmd: editor.cmd.trim(),
      tags: editor.tags.split(",").map((t) => t.trim()).filter(Boolean),
    };
    setSnippets((ss) => [...ss, sn]);
    setActiveId(sn.id);
    setEditor(null);
  };

  return (
    <div className="snippets">
      <div className="sn-lib">
        <div style={{ flex: "none", padding: "12px 14px 10px", display: "flex", gap: 8 }}>
          <div className="sn-search" style={{ flex: 1 }}>
            <span style={{ color: "var(--dim)", fontSize: 12 }}>⌕</span>
            <input
              placeholder={t("Поиск сниппетов…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div
            className="btn-ghost"
            style={{ padding: "0 12px" }}
            onClick={() => setEditor({ title: "", cmd: "", tags: "" })}
          >
            +
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 7 }}>
          {filtered.map((sn) => (
            <div
              key={sn.id}
              className={"sn-card" + (sn.id === activeId ? " active" : "")}
              onClick={() => setActiveId(sn.id)}
            >
              <span
                className="sn-del"
                onClick={(e) => {
                  e.stopPropagation();
                  setSnippets((ss) => ss.filter((x) => x.id !== sn.id));
                  if (activeId === sn.id) setActiveId(null);
                }}
              >
                ✕
              </span>
              <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6, paddingRight: 16 }}>{sn.title}</div>
              <div className="sn-cmd" style={{ marginBottom: 7 }}>$ {sn.cmd}</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {sn.tags.map((t) => (
                  <span className="sn-tag" key={t}>{t}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        {active ? (
          <>
            <div style={{ flex: "none", padding: "16px 20px 14px", borderBottom: "1px solid var(--border2)" }}>
              <div className="sec-label" style={{ marginBottom: 6 }}>{t("Выбранный сниппет")}</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{active.title}</div>
              <div className="mono" style={{ fontSize: 13, color: "var(--body)", background: "var(--term)", border: "1px solid var(--border)", borderRadius: 7, padding: "10px 13px", userSelect: "text" }}>
                <span style={{ color: "var(--green)" }}>$</span> {active.cmd}
              </div>
            </div>
            <div style={{ flex: "none", padding: "13px 20px", borderBottom: "1px solid var(--border2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 9 }}>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>{t("Выполнить на")}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>{t("выбрано")} {selectedIds.length}</span>
                <span style={{ flex: 1 }} />
                <div className={"run-btn" + (!selectedIds.length || running ? " disabled" : "")} onClick={() => void run()}>
                  {running ? t("Выполняется…") : t("▸ Выполнить")}
                </div>
              </div>
              {needsSudo && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
                  <span style={{ fontSize: 11, color: "var(--yellow)", whiteSpace: "nowrap" }}>sudo</span>
                  <input
                    type="password"
                    style={{ maxWidth: 260, padding: "5px 9px", fontSize: 12 }}
                    placeholder={t("sudo-пароль (в памяти)")}
                    value={sudoPw}
                    onChange={(e) => setSudoPw(e.target.value)}
                  />
                  <span style={{ fontSize: 10.5, color: "var(--dim)" }}>
                    {t("подставится при запросе пароля")}
                  </span>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {online.map((s) => (
                  <div
                    key={s.id}
                    className={"chip" + (targets[s.id] ? " on" : "")}
                    onClick={() => setTargets((t) => ({ ...t, [s.id]: !t[s.id] }))}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--green)" }} />
                    <span>{s.name}</span>
                    <span style={{ fontSize: 11, color: targets[s.id] ? "var(--accent)" : "var(--dim)" }}>
                      {targets[s.id] ? "✓" : "+"}
                    </span>
                  </div>
                ))}
                {!online.length && (
                  <span style={{ fontSize: 12, color: "var(--dim)" }}>{t("Нет доступных серверов онлайн")}</span>
                )}
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
              {results.map((r) => (
                <div className="out-block" key={r.serverId}>
                  <div className="out-head">
                    {r.running ? (
                      <span className="spin" style={{ width: 8, height: 8 }} />
                    ) : (
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: r.error || r.code !== 0 ? "var(--red)" : "var(--green)" }} />
                    )}
                    <span className="mono" style={{ fontSize: 12 }}>{r.name}</span>
                    <span style={{ flex: 1 }} />
                    {!r.running && !r.error && (
                      <span className="mono" style={{ fontSize: 10.5, color: r.code === 0 ? "var(--green)" : "var(--red)" }}>
                        exit {r.code} · {r.ms}ms
                      </span>
                    )}
                  </div>
                  <div className="out-body">
                    {r.running && <div>{t("выполняется…")}</div>}
                    {r.error && <div style={{ color: "var(--red)" }}>{r.error}</div>}
                    {r.lines?.map((l, i) => <div key={i}>{l || " "}</div>)}
                  </div>
                </div>
              ))}
              {!results.length && (
                <div style={{ fontSize: 12, color: "var(--dim)", textAlign: "center", paddingTop: 30 }}>
                  {t("Выберите серверы и нажмите «Выполнить» — вывод появится здесь по каждому серверу.")}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="ex-state">
            <div style={{ fontSize: 13, color: "var(--dim)" }}>{t("Выберите сниппет слева")}</div>
          </div>
        )}
      </div>

      {editor && (
        <div className="overlay" onClick={() => setEditor(null)}>
          <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {t("Новый сниппет")}
              <span className="modal-x" onClick={() => setEditor(null)}>×</span>
            </div>
            <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
              <div>
                <div className="field-label">{t("Название")}</div>
                <input autoFocus value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} />
              </div>
              <div>
                <div className="field-label">{t("Команда")}</div>
                <textarea
                  className="mono"
                  rows={3}
                  style={{ resize: "vertical", fontSize: 12 }}
                  value={editor.cmd}
                  onChange={(e) => setEditor({ ...editor, cmd: e.target.value })}
                />
              </div>
              <div>
                <div className="field-label">{t("Теги (через запятую)")}</div>
                <input className="mono" value={editor.tags} onChange={(e) => setEditor({ ...editor, tags: e.target.value })} />
              </div>
            </div>
            <div className="modal-foot">
              <span style={{ flex: 1 }} />
              <div className="btn-text" onClick={() => setEditor(null)}>{t("Отмена")}</div>
              <div className={"btn-accent" + (!editor.title.trim() || !editor.cmd.trim() ? " disabled" : "")} onClick={saveEditor}>
                {t("Сохранить")}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
