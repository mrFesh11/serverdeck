import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ipc } from "../ipc";
import { useT } from "../i18n";
import type { ServerCfg } from "../types";
import { uid } from "../App";

interface Props {
  initial: ServerCfg | null;
  onClose: () => void;
  onSave: (cfg: ServerCfg) => void;
  onDelete: (id: string) => void;
}

export function ServerModal({ initial, onClose, onSave, onDelete }: Props) {
  const t = useT();
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [user, setUser] = useState(initial?.user ?? "root");
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? "~/.ssh/id_ed25519");
  const [jumpOn, setJumpOn] = useState(!!initial?.jump);
  const [jHost, setJHost] = useState(initial?.jump?.host ?? "");
  const [jPort, setJPort] = useState(String(initial?.jump?.port ?? 22));
  const [jUser, setJUser] = useState(initial?.jump?.user ?? "root");
  const [jKey, setJKey] = useState(initial?.jump?.keyPath ?? "~/.ssh/id_ed25519");
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "fail"; msg?: string }>({ state: "idle" });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const cfg = (): ServerCfg => ({
    id: initial?.id ?? "s" + uid(),
    name: name.trim() || host.trim(),
    host: host.trim(),
    port: parseInt(port) || 22,
    user: user.trim() || "root",
    keyPath: keyPath.trim(),
    jump:
      jumpOn && jHost.trim()
        ? {
            host: jHost.trim(),
            port: parseInt(jPort) || 22,
            user: jUser.trim() || "root",
            keyPath: jKey.trim(),
          }
        : null,
  });

  const valid = host.trim().length > 0;

  const runTest = async () => {
    if (!valid || test.state === "testing") return;
    setTest({ state: "testing" });
    try {
      const ms = await ipc.testConnection(cfg());
      setTest({ state: "ok", msg: `${ms}ms` });
    } catch (e) {
      setTest({ state: "fail", msg: String(e) });
    }
  };

  const pickKey = async () => {
    const f = await openDialog({ multiple: false });
    if (typeof f === "string") setKeyPath(f);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {initial ? t("Настройки сервера") : t("Добавить сервер")}
          <span className="modal-x" onClick={onClose}>×</span>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 13 }}>
          <div>
            <div className="field-label">{t("Имя")}</div>
            <input autoFocus placeholder="prod-web-01" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 10 }}>
            <div>
              <div className="field-label">Host</div>
              <input className="mono" placeholder="10.0.1.14" value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div>
              <div className="field-label">{t("Порт")}</div>
              <input className="mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
            </div>
          </div>
          <div>
            <div className="field-label">{t("Пользователь")}</div>
            <input className="mono" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div>
            <div className="field-label">{t("SSH-ключ (пусто — ssh-agent)")}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="mono" style={{ flex: 1, fontSize: 12 }} value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />
              <div className="btn-ghost" style={{ padding: "9px 13px", flex: "none" }} onClick={() => void pickKey()}>
                {t("Выбрать…")}
              </div>
            </div>
          </div>
          <div
            className={"tool-toggle" + (jumpOn ? " on" : "")}
            style={{ alignSelf: "flex-start" }}
            onClick={() => setJumpOn(!jumpOn)}
          >
            <span className="tool-dot" />
            <span>{t("Через jump-хост (ProxyJump)")}</span>
          </div>
          {jumpOn && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 10 }}>
                <div>
                  <div className="field-label">Jump host</div>
                  <input className="mono" placeholder="10.0.0.1" value={jHost} onChange={(e) => setJHost(e.target.value)} />
                </div>
                <div>
                  <div className="field-label">{t("Порт")}</div>
                  <input className="mono" value={jPort} onChange={(e) => setJPort(e.target.value.replace(/\D/g, ""))} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 10 }}>
                <div>
                  <div className="field-label">{t("Пользователь")}</div>
                  <input className="mono" value={jUser} onChange={(e) => setJUser(e.target.value)} />
                </div>
                <div>
                  <div className="field-label">{t("SSH-ключ jump-хоста")}</div>
                  <input className="mono" style={{ fontSize: 12 }} value={jKey} onChange={(e) => setJKey(e.target.value)} />
                </div>
              </div>
            </div>
          )}
          {test.state === "fail" && (
            <div className="mono" style={{ fontSize: 11, color: "var(--red)", lineHeight: 1.5, wordBreak: "break-all" }}>
              {test.msg}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <div
            style={{
              display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5,
              padding: "9px 15px", borderRadius: 7, cursor: "pointer",
              background: test.state === "ok" ? "rgba(110,163,107,0.14)" : "var(--border2)",
              border: `1px solid ${test.state === "ok" ? "rgba(110,163,107,0.5)" : "#2a2e36"}`,
              color: test.state === "ok" ? "var(--green)" : "#b6bac2",
            }}
            onClick={() => void runTest()}
          >
            {test.state === "idle" && t("Тест соединения")}
            {test.state === "testing" && t("Проверка…")}
            {test.state === "ok" && `${t("✓ Соединение установлено")} · ${test.msg}`}
            {test.state === "fail" && t("Повторить тест")}
          </div>
          <span style={{ flex: 1 }} />
          {initial && (
            <div
              className="btn-text"
              style={{ color: confirmDelete ? "var(--red)" : "var(--dim)" }}
              onClick={() => (confirmDelete ? onDelete(initial.id) : setConfirmDelete(true))}
            >
              {confirmDelete ? t("Точно удалить?") : t("Удалить")}
            </div>
          )}
          <div className="btn-text" onClick={onClose}>{t("Отмена")}</div>
          <div className={"btn-accent" + (valid ? "" : " disabled")} onClick={() => valid && onSave(cfg())}>
            {t("Сохранить")}
          </div>
        </div>
      </div>
    </div>
  );
}
