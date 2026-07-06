import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ipc } from "../ipc";
import { useT } from "../i18n";
import { fmtBytes, fmtMtime } from "../metrics";
import type { FileEntry, ServerCfg } from "../types";
import type { ToastFn } from "./Toasts";

const join = (base: string, name: string) => (base.replace(/\/+$/, "") || "") + "/" + name;
const parentOf = (p: string) => {
  const a = p.replace(/\/+$/, "").split("/");
  a.pop();
  return a.join("/") || "/";
};

function sortEntries(list: FileEntry[]): FileEntry[] {
  return [...list].sort((a, b) => {
    if (a.ftype === "dir" && b.ftype !== "dir") return -1;
    if (b.ftype === "dir" && a.ftype !== "dir") return 1;
    return a.name.localeCompare(b.name);
  });
}

interface Props {
  server: ServerCfg;
  toast: ToastFn;
}

export function FilesView({ server, toast }: Props) {
  const t = useT();
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("/");
  const [localFiles, setLocalFiles] = useState<FileEntry[]>([]);
  const [remoteFiles, setRemoteFiles] = useState<FileEntry[]>([]);
  const [localSel, setLocalSel] = useState<string | null>(null);
  const [remoteSel, setRemoteSel] = useState<string | null>(null);
  const [localQ, setLocalQ] = useState("");
  const [remoteQ, setRemoteQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [transfers, setTransfers] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const remoteRef = useRef(remotePath);
  remoteRef.current = remotePath;

  const loadLocal = useCallback(async (p: string) => {
    try {
      setLocalFiles(sortEntries(await ipc.localList(p)));
      setLocalSel(null);
    } catch (e) {
      toast(`${t("Локально")}: ${e}`, true);
    }
  }, [toast]);

  const loadRemote = useCallback(async (p: string) => {
    try {
      setRemoteFiles(sortEntries(await ipc.sftpList(server, p)));
      setRemoteSel(null);
    } catch (e) {
      toast(`SFTP: ${e}`, true);
    }
  }, [server, toast]);

  useEffect(() => {
    ipc.homeDir().then((h) => {
      setLocalPath(h);
      void loadLocal(h);
    });
    void loadRemote("/");
  }, []);

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type === "over") setDragOver(true);
      else if (ev.payload.type === "drop") {
        setDragOver(false);
        const paths = ev.payload.paths;
        void (async () => {
          for (const local of paths) {
            const name = local.split(/[/\\]/).pop()!;
            try {
              setBusy(name);
              await ipc.sftpUpload(server, local, join(remoteRef.current, name));
              setTransfers((n) => n + 1);
              toast(`${t("Загружено:")} ${name}`);
            } catch (e) {
              toast(`${t("Ошибка:")} ${e}`, true);
            } finally {
              setBusy(null);
            }
          }
          void loadRemote(remoteRef.current);
        })();
      } else setDragOver(false);
    });
    return () => {
      void unlisten.then((u) => u());
    };
  }, []);

  const upload = async () => {
    if (!localSel) return;
    const f = localFiles.find((x) => x.name === localSel);
    if (!f || f.ftype === "dir") return;
    try {
      setBusy(f.name);
      await ipc.sftpUpload(server, join(localPath, f.name), join(remotePath, f.name));
      setTransfers((n) => n + 1);
      toast(`${t("Загружено:")} ${f.name}`);
      void loadRemote(remotePath);
    } catch (e) {
      toast(`Ошибка: ${e}`, true);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!remoteSel) return;
    const f = remoteFiles.find((x) => x.name === remoteSel);
    if (!f || f.ftype === "dir") return;
    try {
      setBusy(f.name);
      await ipc.sftpDownload(server, join(remotePath, f.name), join(localPath, f.name));
      setTransfers((n) => n + 1);
      toast(`${t("Скачано:")} ${f.name} → ${localPath}`);
      void loadLocal(localPath);
    } catch (e) {
      toast(`Ошибка: ${e}`, true);
    } finally {
      setBusy(null);
    }
  };

  const up = { name: "..", ftype: "dir", size: 0, perms: "", owner: "", mtime: 0, hidden: false } as FileEntry;
  const localRows = useMemo(() => {
    const q = localQ.trim().toLowerCase();
    return [up, ...(q ? localFiles.filter((f) => f.name.toLowerCase().includes(q)) : localFiles)];
  }, [localFiles, localQ]);
  const remoteRows = useMemo(() => {
    const q = remoteQ.trim().toLowerCase();
    return [up, ...(q ? remoteFiles.filter((f) => f.name.toLowerCase().includes(q)) : remoteFiles)];
  }, [remoteFiles, remoteQ]);

  const openLocal = (f: FileEntry) => {
    if (f.ftype !== "dir") return;
    const p = f.name === ".." ? parentOf(localPath) : join(localPath, f.name);
    setLocalPath(p);
    setLocalQ("");
    void loadLocal(p);
  };
  const openRemote = (f: FileEntry) => {
    if (f.ftype !== "dir") return;
    const p = f.name === ".." ? parentOf(remotePath) : join(remotePath, f.name);
    setRemotePath(p);
    setRemoteQ("");
    void loadRemote(p);
  };

  return (
    <div className="files">
      <div className="files-toolbar">
        <span style={{ color: "var(--dim)" }}>SFTP</span>
        <span className="sep">·</span>
        <span style={{ color: "var(--dim)" }}>{server.user}@{server.name}</span>
        <span style={{ flex: 1 }} />
        <div className="btn-ghost" style={{ padding: "5px 12px", fontSize: 11.5 }} onClick={() => void upload()}>
          {t("Загрузить →")}
        </div>
        <div className="btn-ghost" style={{ padding: "5px 12px", fontSize: 11.5 }} onClick={() => void download()}>
          {t("← Скачать")}
        </div>
        <span style={{ fontSize: 11, color: "var(--dim)", marginLeft: 8 }}>
          {busy ? `${t("передача:")} ${busy}…` : transfers ? `${transfers} ${t("передач завершено")}` : ""}
        </span>
      </div>

      <div className="files-panes">
        <div className="pane">
          <div className="pane-head">
            <div className="sec-label" style={{ marginBottom: 5 }}>{t("Локально")}</div>
            <div className="pane-path">{localPath}</div>
            <div className="pane-filter">
              <span style={{ color: "var(--dim)", fontSize: 11 }}>⌕</span>
              <input
                placeholder={t("Фильтр…")}
                value={localQ}
                onChange={(e) => setLocalQ(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setLocalQ("")}
              />
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
            {localRows.map((f) => (
              <div
                key={f.name}
                className={"frow" + (localSel === f.name ? " selected" : "")}
                style={{ gridTemplateColumns: "1fr 70px" }}
                onClick={() => setLocalSel(f.name === ".." ? null : f.name)}
                onDoubleClick={() => openLocal(f)}
              >
                <span className="fname" style={{ color: f.ftype === "dir" ? "#a9c2dc" : "var(--body)" }}>
                  <span style={f.ftype === "dir" ? { width: 11, height: 9, borderRadius: 2, background: "var(--accent)", opacity: 0.85, flex: "none" } : { width: 10, height: 12, borderRadius: 2, border: "1px solid #4a4f58", flex: "none" }} />
                  <span>{f.ftype === "dir" && f.name !== ".." ? f.name + "/" : f.name}</span>
                </span>
                <span className="fmeta" style={{ textAlign: "right" }}>{f.ftype === "dir" ? "—" : fmtBytes(f.size)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="pane">
          <div className="pane-head">
            <div className="sec-label" style={{ marginBottom: 5 }}>{t("Удалённо")} · {server.name}</div>
            <div className="pane-path">{remotePath}</div>
            <div className="pane-filter">
              <span style={{ color: "var(--dim)", fontSize: 11 }}>⌕</span>
              <input
                placeholder={t("Фильтр…")}
                value={remoteQ}
                onChange={(e) => setRemoteQ(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setRemoteQ("")}
              />
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 100px 110px", gap: 8, padding: "3px 8px 5px", fontSize: 9.5, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--dimmer)" }}>
              <span>{t("Имя")}</span>
              <span style={{ textAlign: "right" }}>{t("Размер")}</span>
              <span>{t("Права")}</span>
              <span style={{ textAlign: "right" }}>{t("Изменён")}</span>
            </div>
            {remoteRows.map((f) => (
              <div
                key={f.name}
                className={"frow" + (remoteSel === f.name ? " selected" : "")}
                style={{ gridTemplateColumns: "1fr 70px 100px 110px" }}
                onClick={() => setRemoteSel(f.name === ".." ? null : f.name)}
                onDoubleClick={() => openRemote(f)}
              >
                <span className="fname" style={{ color: f.ftype === "dir" ? "#a9c2dc" : "var(--body)" }}>
                  <span style={f.ftype === "dir" ? { width: 11, height: 9, borderRadius: 2, background: "var(--accent)", opacity: 0.85, flex: "none" } : { width: 10, height: 12, borderRadius: 2, border: "1px solid #4a4f58", flex: "none" }} />
                  <span>{f.ftype === "dir" && f.name !== ".." ? f.name + "/" : f.name}</span>
                </span>
                <span className="fmeta" style={{ textAlign: "right" }}>{f.ftype === "dir" ? "—" : fmtBytes(f.size)}</span>
                <span className="fmeta">{f.perms}</span>
                <span className="fmeta" style={{ textAlign: "right" }}>{fmtMtime(f.mtime)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={"dropzone" + (dragOver ? " over" : "")}>
        <span style={{ fontSize: 15 }}>↥</span>
        <span>
          {t("Перетащите файлы сюда для загрузки в")}{" "}
          <span className="mono" style={{ color: "var(--muted)" }}>{remotePath}</span>
        </span>
      </div>
    </div>
  );
}
