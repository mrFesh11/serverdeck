import { useState } from "react";
import { useT } from "../i18n";

export interface SecretReq {
  serverName: string;
  secretKey: string;
  kind: "password" | "passphrase";
  wrong: boolean;
}

export function SecretPrompt({
  req,
  onSubmit,
  onCancel,
}: {
  req: SecretReq;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const label =
    req.kind === "password"
      ? t("Пароль для входа")
      : t("Пароль от SSH-ключа (passphrase)");

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {req.kind === "password" ? t("Требуется пароль") : t("Требуется passphrase")}
          <span className="modal-x" onClick={onCancel}>×</span>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
            <span className="mono" style={{ color: "var(--text)" }}>{req.serverName}</span>
            {"  ·  "}
            {req.kind === "password" ? t("сервер запросил пароль") : t("ключ зашифрован")}
          </div>
          {req.wrong && (
            <div style={{ fontSize: 12, color: "var(--red)" }}>{t("Неверно, попробуйте снова")}</div>
          )}
          <div>
            <div className="field-label">{label}</div>
            <input
              type="password"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && value && onSubmit(value)}
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--dim)" }}>
            {t("Хранится только в памяти до закрытия приложения, на диск не пишется.")}
          </div>
        </div>
        <div className="modal-foot">
          <span style={{ flex: 1 }} />
          <div className="btn-text" onClick={onCancel}>{t("Отмена")}</div>
          <div className={"btn-accent" + (value ? "" : " disabled")} onClick={() => value && onSubmit(value)}>
            {t("Подключиться")}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface HostKeyReq {
  serverName: string;
  label: string;
  known: string;
  got: string;
}

export function HostKeyDialog({
  req,
  onAccept,
  onReject,
}: {
  req: HostKeyReq;
  onAccept: () => void;
  onReject: () => void;
}) {
  const t = useT();
  return (
    <div className="overlay" onClick={onReject}>
      <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head" style={{ color: "var(--red)" }}>
          ⚠ {t("Ключ сервера изменился")}
          <span className="modal-x" onClick={onReject}>×</span>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, color: "var(--body)", lineHeight: 1.5 }}>
            {t("Отпечаток ключа")} <span className="mono" style={{ color: "var(--text)" }}>{req.serverName}</span>{" "}
            ({req.label}) {t("не совпадает с сохранённым. Это может означать переустановку сервера — или атаку (MITM).")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 12px", fontSize: 12 }}>
            <span style={{ color: "var(--dim)" }}>{t("Известный")}</span>
            <span className="mono" style={{ color: "var(--muted)", wordBreak: "break-all" }}>{req.known}</span>
            <span style={{ color: "var(--dim)" }}>{t("Новый")}</span>
            <span className="mono" style={{ color: "var(--yellow)", wordBreak: "break-all" }}>{req.got}</span>
          </div>
        </div>
        <div className="modal-foot">
          <span style={{ flex: 1 }} />
          <div className="btn-text" onClick={onReject}>{t("Отклонить")}</div>
          <div className="btn-danger" style={{ padding: "9px 16px" }} onClick={onAccept}>
            {t("Принять новый ключ")}
          </div>
        </div>
      </div>
    </div>
  );
}
