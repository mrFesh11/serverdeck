import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ipc } from "../ipc";
import { useT } from "../i18n";
import { fmtBytes, fmtMtime } from "../metrics";
import type { FileEntry, ServerCfg } from "../types";
import type { ToastFn } from "./Toasts";

const PINS = ["/home", "/etc", "/var/log", "/var/www", "/opt", "/root"];

const joinPath = (base: string, name: string) => (base === "/" ? "" : base) + "/" + name;
const parentOf = (p: string) => {
  if (p === "/") return "/";
  const a = p.split("/");
  a.pop();
  return a.join("/") || "/";
};

function iconMeta(f: FileEntry): { bg?: string; border?: boolean; label: string } {
  if (f.ftype === "dir") return { bg: "var(--accent)", label: "" };
  if (f.ftype === "link") return { bg: "#6ea3a0", label: "LN" };
  const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "";
  const map: Record<string, { bg: string; label: string }> = {
    js: { bg: "#d1a24d", label: "JS" }, ts: { bg: "#5b93cc", label: "TS" },
    json: { bg: "#6ea36b", label: "{}" }, sh: { bg: "#5b93cc", label: "SH" },
    md: { bg: "#868c96", label: "MD" }, py: { bg: "#6ea36b", label: "PY" },
    rs: { bg: "#c08a4a", label: "RS" }, go: { bg: "#6ea3a0", label: "GO" },
    yml: { bg: "#a97bc4", label: "YM" }, yaml: { bg: "#a97bc4", label: "YM" },
    toml: { bg: "#a97bc4", label: "TM" }, conf: { bg: "#868c96", label: "CF" },
    log: { bg: "#7a7f5b", label: "LG" }, env: { bg: "#7a5b5b", label: "EN" },
    pem: { bg: "#7a5b5b", label: "KY" }, key: { bg: "#7a5b5b", label: "KY" },
  };
  if (f.name.startsWith(".env")) return { bg: "#7a5b5b", label: "EN" };
  return map[ext] ?? { border: true, label: "" };
}

function FIcon({ f, size = 18 }: { f: FileEntry; size?: number }) {
  const m = iconMeta(f);
  return (
    <span
      className="ficon"
      style={{
        width: size, height: size,
        borderRadius: size > 20 ? 8 : 4,
        fontSize: size > 20 ? 12 : 8,
        background: m.border ? "transparent" : m.bg,
        border: m.border ? "1px solid #4a4f58" : "none",
        color: m.border ? "var(--muted)" : "var(--term)",
      }}
    >
      {m.label}
    </span>
  );
}

type SortKey = "name" | "size" | "perms" | "owner" | "mtime";
type ExState = "loading" | "ready" | "denied" | "error";

interface Modal {
  kind: "rename" | "chmod" | "delete" | "move" | "mkdir";
  files: FileEntry[];
  value: string;
}

interface Props {
  server: ServerCfg;
  toast: ToastFn;
}

export function Explorer({ server, toast }: Props) {
  const t = useT();
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [state, setState] = useState<ExState>("loading");
  const [error, setError] = useState("");
  const [dirCache, setDirCache] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "/": true });
  const [hist, setHist] = useState<string[]>(["/"]);
  const [histIdx, setHistIdx] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [showHidden, setShowHidden] = useState(true);
  const [view, setView] = useState<"table" | "grid">("table");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [menu, setMenu] = useState<{ f: FileEntry; x: number; y: number } | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [deepResults, setDeepResults] = useState<{ type: string; size: number; path: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(
    async (p: string) => {
      setState("loading");
      setMenu(null);
      try {
        const list = await ipc.sftpList(server, p);
        if (pathRef.current !== p) return;
        setEntries(list);
        setState("ready");
        setDirCache((c) => ({
          ...c,
          [p]: list.filter((f) => f.ftype === "dir").map((f) => f.name).sort(),
        }));
      } catch (e) {
        if (pathRef.current !== p) return;
        const msg = String(e);
        setError(msg);
        setState(/permission denied|failure/i.test(msg) ? "denied" : "error");
        setEntries([]);
      }
    },
    [server]
  );

  const go = useCallback(
    (p: string, pushHist = true) => {
      setPath(p);
      setSelected({});
      setPreview(null);
      setPreviewText(null);
      setQuery("");
      setDeepResults(null);
      if (pushHist)
        setHist((h) => {
          const cut = h.slice(0, histIdx + 1);
          setHistIdx(cut.length);
          return [...cut, p];
        });
      setExpanded((ex) => {
        const next = { ...ex };
        let cur = p;
        while (cur !== "/") {
          next[cur] = true;
          cur = parentOf(cur);
        }
        next["/"] = true;
        return next;
      });
    },
    [histIdx]
  );

  useEffect(() => {
    void load(path);
  }, [path, load]);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === "over") setDragOver(true);
      else if (ev.payload.type === "drop") {
        setDragOver(false);
        void uploadFiles(ev.payload.paths);
      } else setDragOver(false);
    });
    return () => {
      void unlisten.then((u) => u());
    };
  }, []);

  const uploadFiles = async (paths: string[]) => {
    for (const local of paths) {
      const name = local.split(/[/\\]/).pop()!;
      try {
        await ipc.sftpUpload(server, local, joinPath(pathRef.current, name));
        toast(`${t("Загружено:")} ${name}`);
      } catch (e) {
        toast(`${t("Ошибка загрузки")} ${name}: ${e}`, true);
      }
    }
    void load(pathRef.current);
  };

  const deepSearch = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setDeepResults(null);
    try {
      const dir = `'${path.replace(/'/g, `'\\''`)}'`;
      const pat = `'*${q.replace(/'/g, `'\\''`)}*'`;
      const res = await ipc.exec(
        server,
        `find ${dir} -maxdepth 6 -iname ${pat} -printf '%y\\t%s\\t%p\\n' 2>/dev/null | head -150`
      );
      const rows = res.out
        .split("\n")
        .filter((l) => l.includes("\t"))
        .map((l) => {
          const [type, size, ...rest] = l.split("\t");
          return { type, size: parseInt(size) || 0, path: rest.join("\t") };
        });
      setDeepResults(rows);
    } catch (e) {
      toast(`${t("Ошибка:")} ${e}`, true);
    } finally {
      setSearching(false);
    }
  };

  const openResult = (r: { type: string; path: string }) => {
    if (r.type === "d") {
      go(r.path);
    } else {
      const parent = r.path.split("/").slice(0, -1).join("/") || "/";
      const name = r.path.split("/").pop()!;
      go(parent);
      setSelected({ [name]: true });
    }
  };

  const visible = useMemo(() => {
    let list = entries.slice();
    if (!showHidden) list = list.filter((f) => !f.hidden);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));
    const { key, dir } = sort;
    list.sort((a, b) => {
      if (a.ftype === "dir" && b.ftype !== "dir") return -1;
      if (b.ftype === "dir" && a.ftype !== "dir") return 1;
      let av: string | number, bv: string | number;
      if (key === "size") { av = a.size; bv = b.size; }
      else if (key === "mtime") { av = a.mtime; bv = b.mtime; }
      else { av = a[key].toLowerCase(); bv = b[key].toLowerCase(); }
      return av < bv ? -dir : av > bv ? dir : 0;
    });
    return list;
  }, [entries, showHidden, sort, query]);

  const selNames = Object.keys(selected).filter((k) => selected[k]);
  const selFiles = visible.filter((f) => selected[f.name]);

  const openEntry = (f: FileEntry) => {
    if (f.ftype === "dir") go(joinPath(path, f.name));
    else selectFile(f);
  };

  const selectFile = (f: FileEntry) => {
    setSelected({ [f.name]: true });
    setPreview(f);
    setPreviewText(null);
    if (f.ftype === "file" && f.size < 3 * 1024 * 1024) {
      ipc.sftpPreview(server, joinPath(path, f.name))
        .then((r) => setPreviewText(r.text))
        .catch(() => setPreviewText(null));
    }
  };

  const toggleCheck = (f: FileEntry) => {
    setSelected((s) => {
      const n = { ...s };
      if (n[f.name]) delete n[f.name];
      else n[f.name] = true;
      return n;
    });
    setPreview(f);
  };

  const download = async (files: FileEntry[]) => {
    setMenu(null);
    try {
      if (files.length === 1 && files[0].ftype !== "dir") {
        const dest = await saveDialog({ defaultPath: files[0].name });
        if (!dest) return;
        setBusy(true);
        await ipc.sftpDownload(server, joinPath(path, files[0].name), dest);
        toast(`${t("Скачано:")} ${files[0].name}`);
      } else {
        const dir = await openDialog({ directory: true });
        if (!dir || Array.isArray(dir)) return;
        setBusy(true);
        for (const f of files.filter((x) => x.ftype !== "dir")) {
          await ipc.sftpDownload(server, joinPath(path, f.name), `${dir}/${f.name}`);
        }
        const skipped = files.filter((x) => x.ftype === "dir").length;
        toast(`${t("Скачано файлов:")} ${files.length - skipped}${skipped ? `, ${t("директории пропущены")} (${skipped})` : ""}`);
      }
    } catch (e) {
      toast(`${t("Ошибка скачивания:")} ${e}`, true);
    } finally {
      setBusy(false);
    }
  };

  const applyModal = async () => {
    if (!modal) return;
    setBusy(true);
    try {
      if (modal.kind === "rename") {
        const f = modal.files[0];
        await ipc.sftpRename(server, joinPath(path, f.name), joinPath(path, modal.value.trim()));
        toast(t("Переименовано"));
      } else if (modal.kind === "chmod") {
        const mode = parseInt(modal.value.trim(), 8);
        if (isNaN(mode)) throw new Error(t("некорректный режим"));
        for (const f of modal.files) await ipc.sftpChmod(server, joinPath(path, f.name), mode);
        toast(`chmod ${modal.value} ${t("применён")}`);
      } else if (modal.kind === "delete") {
        for (const f of modal.files)
          await ipc.sftpDelete(server, joinPath(path, f.name), f.ftype === "dir");
        toast(`${t("Удалено:")} ${modal.files.length}`);
      } else if (modal.kind === "move") {
        const dest = modal.value.trim().replace(/\/+$/, "") || "/";
        for (const f of modal.files)
          await ipc.sftpRename(server, joinPath(path, f.name), joinPath(dest, f.name));
        toast(`${t("Перемещено в")} ${dest}`);
      } else if (modal.kind === "mkdir") {
        await ipc.sftpMkdir(server, joinPath(path, modal.value.trim()));
        toast(t("Директория создана"));
      }
      setModal(null);
      setSelected({});
      void load(path);
    } catch (e) {
      toast(`${t("Ошибка:")} ${e}`, true);
    } finally {
      setBusy(false);
    }
  };

  const crumbs = path === "/" ? [""] : path.split("/");
  const arw = (k: SortKey) => (sort.key === k ? (sort.dir === 1 ? " ↑" : " ↓") : "");
  const clickSort = (k: SortKey) =>
    setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : 1 }));

  const treeRows = useMemo(() => {
    const rows: { path: string; name: string; depth: number; hasChildren: boolean }[] = [];
    const walk = (p: string, depth: number) => {
      const kids = dirCache[p];
      if (!kids || !expanded[p]) return;
      for (const name of kids) {
        const full = joinPath(p, name);
        rows.push({ path: full, name, depth, hasChildren: true });
        walk(full, depth + 1);
      }
    };
    walk("/", 1);
    return rows;
  }, [dirCache, expanded]);

  const toggleNode = (p: string) => {
    setExpanded((ex) => ({ ...ex, [p]: !ex[p] }));
    if (!dirCache[p])
      ipc.sftpList(server, p)
        .then((list) =>
          setDirCache((c) => ({
            ...c,
            [p]: list.filter((f) => f.ftype === "dir").map((f) => f.name).sort(),
          }))
        )
        .catch(() => {});
  };

  const canBack = histIdx > 0;
  const canFwd = histIdx < hist.length - 1;

  return (
    <div className="explorer">
      <div className="ex-body">
        <div className="ex-tree">
          <div style={{ padding: "11px 12px 8px" }}>
            <div className="sec-label" style={{ marginBottom: 6 }}>{t("Быстрый доступ")}</div>
            {PINS.map((p) => (
              <div key={p} className={"pin" + (path === p ? " active" : "")} onClick={() => go(p)}>
                <span className="pin-dot" />
                <span>{p}</span>
              </div>
            ))}
          </div>
          <div style={{ height: 1, background: "var(--border2)", margin: "2px 12px" }} />
          <div style={{ padding: "8px 8px 10px", overflowY: "auto", flex: 1 }}>
            <div className="sec-label" style={{ margin: "0 4px 6px" }}>{t("Файловая система")}</div>
            <div className={"tree-row" + (path === "/" ? " active" : "")} onClick={() => go("/")}>
              <span
                className={"tree-chev" + (expanded["/"] ? " open" : "")}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleNode("/");
                }}
              >
                ›
              </span>
              <span className="tree-folder" />
              <span className="tree-name">/</span>
            </div>
            {treeRows.map((n) => (
              <div
                key={n.path}
                className={"tree-row" + (path === n.path ? " active" : "")}
                onClick={() => go(n.path)}
              >
                <span className="tree-pad" style={{ width: n.depth * 14 }} />
                <span
                  className={"tree-chev" + (expanded[n.path] ? " open" : "")}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleNode(n.path);
                  }}
                >
                  ›
                </span>
                <span className="tree-folder" />
                <span className="tree-name">{n.name}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="ex-center">
          <div className="ex-toolbar">
            <div style={{ display: "flex", gap: 2 }}>
              <div className={"nav-btn" + (canBack ? "" : " disabled")} onClick={() => { if (canBack) { setHistIdx(histIdx - 1); go(hist[histIdx - 1], false); } }}>‹</div>
              <div className={"nav-btn" + (canFwd ? "" : " disabled")} onClick={() => { if (canFwd) { setHistIdx(histIdx + 1); go(hist[histIdx + 1], false); } }}>›</div>
              <div className="nav-btn" onClick={() => go(parentOf(path))}>↑</div>
              <div className="nav-btn" onClick={() => void load(path)}>⟳</div>
            </div>
            <div className="crumbs">
              {crumbs.map((seg, i) => (
                <span key={i} style={{ display: "inline-flex", gap: 3 }}>
                  {i > 1 && <span className="crumb-sep">/</span>}
                  <span
                    className={"crumb" + (i === crumbs.length - 1 ? " last" : "")}
                    onClick={() => go(i === 0 ? "/" : crumbs.slice(0, i + 1).join("/"))}
                  >
                    {i === 0 ? "/" : seg}
                  </span>
                </span>
              ))}
            </div>
            <div className="ex-search" title={t("Enter — глубокий поиск по поддиректориям")}>
              <span style={{ color: "var(--dim)", fontSize: 12 }}>⌕</span>
              <input
                placeholder={t("Поиск…")}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (deepResults) setDeepResults(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void deepSearch();
                  if (e.key === "Escape") {
                    setQuery("");
                    setDeepResults(null);
                  }
                }}
              />
              {query && (
                <span
                  style={{ color: "var(--dim)", cursor: "pointer", fontSize: 12 }}
                  onClick={() => {
                    setQuery("");
                    setDeepResults(null);
                  }}
                >
                  ×
                </span>
              )}
            </div>
            <div className="seg">
              <div className={"seg-btn" + (view === "table" ? " active" : "")} onClick={() => setView("table")}>≣</div>
              <div className={"seg-btn" + (view === "grid" ? " active" : "")} onClick={() => setView("grid")}>▦</div>
            </div>
            <div className={"tool-toggle" + (showHidden ? " on" : "")} onClick={() => setShowHidden(!showHidden)}>
              <span className="tool-dot" />
              <span>{t("Скрытые")}</span>
            </div>
            <div className="tool-toggle" title={t("Новая папка")} onClick={() => setModal({ kind: "mkdir", files: [], value: "" })}>+ 🗀</div>
            <div
              className={"tool-toggle" + (previewOpen ? " on" : "")}
              style={{ padding: "6px 9px" }}
              title={t("Панель предпросмотра")}
              onClick={() => setPreviewOpen(!previewOpen)}
            >
              ◨
            </div>
          </div>

          {(searching || deepResults) && (
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderBottom: "1px solid var(--border2)", fontSize: 11.5, color: "var(--muted)" }}>
                {searching ? (
                  <>
                    <span className="spin" />
                    <span>{t("Идёт поиск…")}</span>
                  </>
                ) : (
                  <>
                    <span>
                      {t("Найдено:")} <b style={{ color: "var(--text)" }}>{deepResults!.length}</b>
                      <span className="mono" style={{ color: "var(--dim)", marginLeft: 8 }}>{query} · {path}</span>
                    </span>
                    <span style={{ flex: 1 }} />
                    <span className="link" onClick={() => setDeepResults(null)}>{t("Закрыть результаты")}</span>
                  </>
                )}
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "3px 0" }}>
                {deepResults?.map((r) => (
                  <div
                    key={r.path}
                    className="frow"
                    style={{ gridTemplateColumns: "1fr 80px", padding: "6px 14px" }}
                    onDoubleClick={() => openResult(r)}
                    onClick={() => openResult(r)}
                  >
                    <span className="fname" style={{ color: r.type === "d" ? "#a9c2dc" : "var(--body)" }}>
                      <span style={r.type === "d" ? { width: 11, height: 9, borderRadius: 2, background: "var(--accent)", opacity: 0.85, flex: "none" } : { width: 10, height: 12, borderRadius: 2, border: "1px solid #4a4f58", flex: "none" }} />
                      <span>{r.path}</span>
                    </span>
                    <span className="fmeta" style={{ textAlign: "right" }}>
                      {r.type === "d" ? "—" : fmtBytes(r.size)}
                    </span>
                  </div>
                ))}
                {deepResults && deepResults.length === 0 && (
                  <div className="ex-state" style={{ padding: 40 }}>
                    <div style={{ fontSize: 13, color: "var(--dim)" }}>{t("Ничего не найдено")}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {!searching && !deepResults && state === "ready" && view === "table" && (
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <div className="ex-thead">
                <span />
                <span className="ex-th" onClick={() => clickSort("name")}>{t("Имя")}{arw("name")}</span>
                <span className="ex-th" style={{ textAlign: "right" }} onClick={() => clickSort("size")}>{t("Размер")}{arw("size")}</span>
                <span className="ex-th" onClick={() => clickSort("perms")}>{t("Права")}{arw("perms")}</span>
                <span className="ex-th" onClick={() => clickSort("owner")}>{t("Владелец")}{arw("owner")}</span>
                <span className="ex-th" style={{ textAlign: "right" }} onClick={() => clickSort("mtime")}>{t("Изменён")}{arw("mtime")}</span>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "3px 0" }}>
                {visible.map((f) => (
                  <div
                    key={f.name}
                    className={"ex-trow" + (selected[f.name] ? " selected" : "") + (f.hidden ? " hidden-f" : "")}
                    onClick={() => selectFile(f)}
                    onDoubleClick={() => openEntry(f)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!selected[f.name]) setSelected({ [f.name]: true });
                      setPreview(f);
                      setMenu({ f, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span
                      style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCheck(f);
                      }}
                    >
                      <span className={"check" + (selected[f.name] ? " on" : "")}>{selected[f.name] ? "✓" : ""}</span>
                    </span>
                    <span className="fname" style={{ color: f.hidden ? "#6a7079" : f.ftype === "dir" ? "#a9c2dc" : "var(--body)" }}>
                      <FIcon f={f} />
                      <span>{f.name}</span>
                    </span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--muted)", textAlign: "right" }}>
                      {f.ftype === "dir" ? "—" : fmtBytes(f.size)}
                    </span>
                    <span className="mono" style={{ fontSize: 11, color: "#6a7079" }}>{f.perms}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{f.owner}</span>
                    <span className="mono" style={{ fontSize: 11, color: "#6a7079", textAlign: "right" }}>{fmtMtime(f.mtime)}</span>
                  </div>
                ))}
                {visible.length === 0 && (
                  <div className="ex-state" style={{ padding: 40 }}>
                    <div style={{ width: 46, height: 38, borderRadius: 8, border: "1.5px dashed #2a2e36" }} />
                    <div style={{ fontSize: 14, color: "var(--muted)" }}>{t("Директория пуста")}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {!searching && !deepResults && state === "ready" && view === "grid" && (
            <div className="ex-grid">
              {visible.map((f) => (
                <div
                  key={f.name}
                  className={"ex-tile" + (selected[f.name] ? " selected" : "") + (f.hidden ? " hidden-f" : "")}
                  onClick={() => selectFile(f)}
                  onDoubleClick={() => openEntry(f)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!selected[f.name]) setSelected({ [f.name]: true });
                    setMenu({ f, x: e.clientX, y: e.clientY });
                  }}
                >
                  <FIcon f={f} size={36} />
                  <span style={{ color: f.hidden ? "#6a7079" : f.ftype === "dir" ? "#a9c2dc" : "var(--body)" }}>{f.name}</span>
                </div>
              ))}
            </div>
          )}

          {state === "loading" && (
            <div style={{ flex: 1, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 11 }}>
              {[38, 52, 30, 46, 60, 34, 50, 42].map((w, i) => (
                <div key={i} className="skel-row">
                  <span className="skel" style={{ width: 18, height: 18 }} />
                  <span className="skel" style={{ height: 9, width: `${w}%` }} />
                  <span style={{ flex: 1 }} />
                  <span className="skel" style={{ height: 9, width: 64 }} />
                </div>
              ))}
            </div>
          )}

          {state === "denied" && (
            <div className="ex-state">
              <div style={{ width: 48, height: 48, borderRadius: 12, background: "var(--border2)", border: "1px solid #2a2e36", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🔒</div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{t("Нет доступа")}</div>
              <div className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>permission denied · {path}</div>
              <div style={{ fontSize: 12, color: "var(--dim)" }}>{t("Для просмотра этой директории нужны другие права.")}</div>
            </div>
          )}

          {state === "error" && (
            <div className="ex-state">
              <div style={{ fontSize: 15, fontWeight: 600 }}>{t("Ошибка")}</div>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--red)", maxWidth: 480, textAlign: "center" }}>{error}</div>
              <div className="btn-ghost" style={{ padding: "8px 16px" }} onClick={() => void load(path)}>{t("Повторить")}</div>
            </div>
          )}

          {selNames.length > 1 && state === "ready" && (
            <div className="bulkbar">
              <span style={{ fontSize: 12 }}><b>{selNames.length}</b> {t("выбрано")}</span>
              <span className="vline" />
              <div className="bulk-btn" onClick={() => void download(selFiles)}>{t("↓ Скачать")}</div>
              <div className="bulk-btn" onClick={() => setModal({ kind: "move", files: selFiles, value: path })}>{t("→ Переместить")}</div>
              <div className="bulk-btn danger" onClick={() => setModal({ kind: "delete", files: selFiles, value: "" })}>{t("✕ Удалить")}</div>
              <span className="vline" />
              <div className="bulk-btn" style={{ color: "var(--muted)" }} onClick={() => setSelected({})}>{t("Снять")}</div>
            </div>
          )}
        </div>

        {previewOpen && state === "ready" && (
          <div className="ex-preview">
            {preview ? (
              <>
                <div style={{ padding: "14px 15px", borderBottom: "1px solid var(--border2)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <FIcon f={preview} size={22} />
                    <span className="mono" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview.name}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 10.5, color: "var(--dim)", wordBreak: "break-all", marginBottom: 13 }}>
                    {joinPath(path, preview.name)}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "7px 12px", fontSize: 11.5 }}>
                    <span style={{ color: "var(--dim)" }}>{t("Размер")}</span>
                    <span className="mono" style={{ color: "var(--body)" }}>{preview.ftype === "dir" ? "—" : fmtBytes(preview.size)}</span>
                    <span style={{ color: "var(--dim)" }}>{t("Права")}</span>
                    <span className="mono" style={{ color: "var(--body)" }}>{preview.perms}</span>
                    <span style={{ color: "var(--dim)" }}>{t("Владелец")}</span>
                    <span className="mono" style={{ color: "var(--body)" }}>{preview.owner}</span>
                    <span style={{ color: "var(--dim)" }}>{t("Изменён")}</span>
                    <span className="mono" style={{ color: "var(--body)" }}>{fmtMtime(preview.mtime)}</span>
                  </div>
                </div>
                <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 15px" }}>
                  <div className="sec-label" style={{ marginBottom: 8 }}>{t("Предпросмотр")}</div>
                  {previewText ? (
                    <div className="pv-code">
                      {previewText.split("\n").slice(0, 60).map((l, i) => (
                        <div key={i}>{l || " "}</div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11.5, color: "var(--dim)", padding: "22px 0", textAlign: "center" }}>
                      {preview.ftype === "dir" ? t("Директория") : t("Предпросмотр недоступен для этого типа файла")}
                    </div>
                  )}
                </div>
                <div style={{ flex: "none", padding: "12px 14px", borderTop: "1px solid var(--border2)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div className="btn-primary" onClick={() => void download([preview])}>{t("↓ Скачать")}</div>
                  <div className="btn-ghost" onClick={() => setModal({ kind: "chmod", files: [preview], value: preview.perms.slice(1).replace(/[^rwx-]/g, "") ? octalOf(preview.perms) : "644" })}>chmod</div>
                  <div className="btn-ghost" onClick={() => setModal({ kind: "rename", files: [preview], value: preview.name })}>{t("Переименовать")}</div>
                  <div className="btn-danger" onClick={() => setModal({ kind: "delete", files: [preview], value: "" })}>{t("Удалить")}</div>
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", fontSize: 12, color: "var(--dim)" }}>
                {t("Выберите файл, чтобы увидеть детали")}
              </div>
            )}
          </div>
        )}
      </div>

      {dragOver && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(91,147,204,0.08)", border: "2px dashed var(--accent)", borderRadius: 8, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{ fontSize: 14, color: "var(--text)", background: "var(--panel)", padding: "10px 18px", borderRadius: 8, border: "1px solid var(--border)" }}>
            ↥ {t("Отпустите для загрузки в")} <span className="mono" style={{ color: "var(--accent)" }}>{path}</span>
          </div>
        </div>
      )}

      <div className="statusbar" style={{ padding: "0 14px" }}>
        <span>{state === "ready" ? `${visible.length} ${t("объектов")}` : "…"}</span>
        {selNames.length > 0 && (
          <>
            <span className="sep">·</span>
            <span>{selNames.length} {t("выбрано")}</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--green)" }}>●</span>
        <span style={{ marginLeft: 6 }}>{server.user}@{server.name}</span>
        <span className="sep">·</span>
        <span>SFTP</span>
      </div>

      {menu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 65 }}
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 260) }}>
            <div className="mono" style={{ padding: "5px 10px 7px", fontSize: 10.5, color: "var(--dim)", borderBottom: "1px solid var(--border)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {menu.f.name}
            </div>
            <div className="ctx-item" onClick={() => { openEntry(menu.f); setMenu(null); }}>
              <span style={{ width: 16, textAlign: "center", color: "var(--muted)" }}>↗</span>
              <span>{t("Открыть")}</span>
              <span className="ctx-hint">Enter</span>
            </div>
            <div className="ctx-item" onClick={() => void download(selFiles.length > 1 ? selFiles : [menu.f])}>
              <span style={{ width: 16, textAlign: "center", color: "var(--muted)" }}>↓</span>
              <span>{t("Скачать")}</span>
            </div>
            <div className="ctx-item" onClick={() => { setModal({ kind: "rename", files: [menu.f], value: menu.f.name }); setMenu(null); }}>
              <span style={{ width: 16, textAlign: "center", color: "var(--muted)" }}>✎</span>
              <span>{t("Переименовать")}</span>
              <span className="ctx-hint">F2</span>
            </div>
            <div className="ctx-item" onClick={() => { setModal({ kind: "chmod", files: selFiles.length > 1 ? selFiles : [menu.f], value: octalOf(menu.f.perms) }); setMenu(null); }}>
              <span style={{ width: 16, textAlign: "center", color: "var(--muted)" }}>⚙</span>
              <span>{t("Права (chmod)…")}</span>
            </div>
            <div
              className="ctx-item"
              onClick={() => {
                navigator.clipboard.writeText(joinPath(path, menu.f.name)).catch(() => {});
                toast(t("Путь скопирован"));
                setMenu(null);
              }}
            >
              <span style={{ width: 16, textAlign: "center", color: "var(--muted)" }}>⧉</span>
              <span>{t("Копировать путь")}</span>
            </div>
            <div
              className="ctx-item danger"
              style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 9 }}
              onClick={() => { setModal({ kind: "delete", files: selFiles.length > 1 ? selFiles : [menu.f], value: "" }); setMenu(null); }}
            >
              <span style={{ width: 16, textAlign: "center" }}>✕</span>
              <span>{t("Удалить")}</span>
              <span className="ctx-hint">Del</span>
            </div>
          </div>
        </>
      )}

      {modal && (
        <div className="overlay" onClick={() => !busy && setModal(null)}>
          <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {modal.kind === "rename" && t("Переименовать")}
              {modal.kind === "chmod" && t("Права (chmod)")}
              {modal.kind === "delete" && t("Удалить")}
              {modal.kind === "move" && t("Переместить")}
              {modal.kind === "mkdir" && t("Новая директория")}
              <span className="modal-x" onClick={() => setModal(null)}>×</span>
            </div>
            <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
              {modal.kind === "delete" ? (
                <div style={{ fontSize: 13, color: "var(--body)", lineHeight: 1.5 }}>
                  Удалить <b>{modal.files.length === 1 ? modal.files[0].name : `${modal.files.length} объектов`}</b>
                  {modal.files.some((f) => f.ftype === "dir") && " (включая содержимое директорий)"}? Это действие необратимо.
                </div>
              ) : (
                <div>
                  <div className="field-label">
                    {modal.kind === "rename" && t("Новое имя")}
                    {modal.kind === "chmod" && `Режим (октально) для ${modal.files.length} объект(ов)`}
                    {modal.kind === "move" && t("Целевая директория")}
                    {modal.kind === "mkdir" && t("Имя директории")}
                  </div>
                  <input
                    className="mono"
                    autoFocus
                    value={modal.value}
                    onChange={(e) => setModal({ ...modal, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void applyModal();
                    }}
                  />
                </div>
              )}
            </div>
            <div className="modal-foot">
              <span style={{ flex: 1 }} />
              <div className="btn-text" onClick={() => setModal(null)}>{t("Отмена")}</div>
              <div
                className={(modal.kind === "delete" ? "btn-danger" : "btn-accent") + (busy ? " disabled" : "")}
                style={modal.kind === "delete" ? { padding: "9px 18px" } : undefined}
                onClick={() => void applyModal()}
              >
                {busy ? "…" : modal.kind === "delete" ? t("Удалить") : t("Применить")}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function octalOf(perms: string): string {
  const p = perms.slice(1);
  let out = "";
  for (let i = 0; i < 9; i += 3) {
    let v = 0;
    if (p[i] === "r") v += 4;
    if (p[i + 1] === "w") v += 2;
    if (p[i + 2] && p[i + 2] !== "-") v += 1;
    out += v;
  }
  return out || "644";
}
