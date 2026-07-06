import { useEffect, useMemo, useState } from "react";
import { ipc } from "../ipc";
import { useT } from "../i18n";
import type { JumpCfg, ParsedHost, ServerCfg } from "../types";
import { uid } from "../App";

function resolveJump(raw: string, all: ParsedHost[]): JumpCfg | null {
  if (!raw || raw.toLowerCase() === "none") return null;
  const first = raw.split(",")[0].trim();
  const ref = all.find((h) => h.name === first);
  if (ref)
    return {
      host: ref.host,
      port: ref.port,
      user: ref.user || "root",
      keyPath: ref.keyPath,
      auth: "key",
    };
  const m = first.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
  if (!m) return null;
  return { host: m[2], port: m[3] ? parseInt(m[3]) : 22, user: m[1] || "root", keyPath: "", auth: "key" };
}

export function ImportModal({
  existing,
  onClose,
  onImport,
}: {
  existing: ServerCfg[];
  onClose: () => void;
  onImport: (servers: ServerCfg[]) => void;
}) {
  const t = useT();
  const [hosts, setHosts] = useState<ParsedHost[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const knownHosts = useMemo(
    () => new Set(existing.map((s) => `${s.host}:${s.port}`)),
    [existing]
  );

  useEffect(() => {
    ipc.importSshConfig()
      .then((list) => {
        setHosts(list);
        setPicked(Object.fromEntries(list.filter((h) => !knownHosts.has(`${h.host}:${h.port}`)).map((h) => [h.name, true])));
      })
      .catch(() => setHosts([]));
  }, []);

  const add = () => {
    if (!hosts) return;
    const servers = hosts
      .filter((h) => picked[h.name])
      .map<ServerCfg>((h) => ({
        id: "s" + uid(),
        name: h.name,
        host: h.host,
        port: h.port,
        user: h.user || "root",
        keyPath: h.keyPath,
        auth: h.keyPath ? "key" : "agent",
        jump: resolveJump(h.proxyJump, hosts),
      }));
    onImport(servers);
  };

  const count = Object.values(picked).filter(Boolean).length;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 560, maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {t("Импорт из ~/.ssh/config")}
          <span className="modal-x" onClick={onClose}>×</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px" }}>
          {hosts === null && <div style={{ padding: 20, color: "var(--dim)", fontSize: 12 }}>{t("загрузка…")}</div>}
          {hosts?.length === 0 && (
            <div style={{ padding: 20, color: "var(--dim)", fontSize: 12.5, textAlign: "center" }}>
              {t("В ~/.ssh/config не найдено хостов с HostName.")}
            </div>
          )}
          {hosts?.map((h) => {
            const dup = knownHosts.has(`${h.host}:${h.port}`);
            return (
              <div
                key={h.name}
                className="frow"
                style={{ gridTemplateColumns: "20px 1fr", padding: "7px 8px", alignItems: "start" }}
                onClick={() => setPicked((p) => ({ ...p, [h.name]: !p[h.name] }))}
              >
                <span style={{ display: "flex", justifyContent: "center", paddingTop: 2 }}>
                  <span className={"check" + (picked[h.name] ? " on" : "")}>{picked[h.name] ? "✓" : ""}</span>
                </span>
                <span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{h.name}</span>
                  {dup && <span style={{ fontSize: 10.5, color: "var(--yellow)", marginLeft: 8 }}>{t("уже добавлен")}</span>}
                  <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginTop: 2 }}>
                    {(h.user || "root")}@{h.host}:{h.port}
                    {h.keyPath ? `  ·  ${h.keyPath}` : ""}
                    {h.proxyJump ? `  ·  jump: ${h.proxyJump}` : ""}
                  </div>
                </span>
              </div>
            );
          })}
        </div>
        <div className="modal-foot">
          <span style={{ flex: 1 }} />
          <div className="btn-text" onClick={onClose}>{t("Отмена")}</div>
          <div className={"btn-accent" + (count ? "" : " disabled")} onClick={add}>
            {t("Добавить выбранные")} {count ? `(${count})` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
