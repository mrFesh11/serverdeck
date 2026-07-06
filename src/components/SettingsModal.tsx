import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ipc } from "../ipc";
import { useT, useLang } from "../i18n";
import type { Settings } from "../types";
import type { ToastFn } from "./Toasts";

const ACCENTS = ["#46a86e", "#5b93cc", "#a97bc4", "#c08a4a", "#4a9d9a", "#c85c58"];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--border2)" }}>
      <span style={{ flex: 1, fontSize: 13 }}>{label}</span>
      {children}
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <span
      onClick={onClick}
      style={{
        width: 38, height: 21, borderRadius: 11, cursor: "pointer", flex: "none",
        background: on ? "var(--accent)" : "#2a2e36", position: "relative", transition: "background .15s",
      }}
    >
      <span style={{ position: "absolute", top: 2, left: on ? 19 : 2, width: 17, height: 17, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
    </span>
  );
}

export function SettingsModal({
  settings,
  setSettings,
  onClose,
  toast,
}: {
  settings: Settings;
  setSettings: (fn: (s: Settings) => Settings) => void;
  onClose: () => void;
  toast: ToastFn;
}) {
  const t = useT();
  const { lang, setLang } = useLang();
  const [vault, setVault] = useState<{ exists: boolean; unlocked: boolean } | null>(null);
  const [vaultPw, setVaultPw] = useState<string | null>(null);
  const [version, setVersion] = useState("");

  const refreshVault = () => ipc.vaultStatus().then(setVault).catch(() => {});
  useEffect(() => {
    refreshVault();
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const num = (v: string, min: number, max: number, def: number) => {
    const n = parseInt(v);
    return isNaN(n) ? def : Math.min(max, Math.max(min, n));
  };

  const createVault = async () => {
    if (!vaultPw) return;
    try {
      await ipc.vaultCreate(vaultPw);
      toast(t("Хранилище создано"));
      setVaultPw(null);
      refreshVault();
    } catch (e) {
      toast(`${t("Ошибка:")} ${e}`, true);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 480, maxHeight: "86vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {t("Настройки")}
          <span className="modal-x" onClick={onClose}>×</span>
        </div>
        <div style={{ padding: "6px 18px 12px", overflowY: "auto" }}>
          <div className="sec-label" style={{ margin: "12px 0 2px" }}>{t("Опрос и уведомления")}</div>
          <Row label={t("Интервал опроса, сек")}>
            <input
              type="number"
              style={{ width: 70 }}
              value={settings.pollIntervalSec}
              onChange={(e) => setSettings((s) => ({ ...s, pollIntervalSec: num(e.target.value, 2, 300, 7) }))}
            />
          </Row>
          <Row label={t("Уведомлять об offline/online")}>
            <Toggle on={settings.notifyOffline} onClick={() => setSettings((s) => ({ ...s, notifyOffline: !s.notifyOffline }))} />
          </Row>
          <Row label={t("Уведомлять о превышении порогов")}>
            <Toggle on={settings.notifyThresholds} onClick={() => setSettings((s) => ({ ...s, notifyThresholds: !s.notifyThresholds }))} />
          </Row>

          <div className="sec-label" style={{ margin: "16px 0 2px" }}>{t("Пороги алертов, %")}</div>
          {(["cpuThreshold", "ramThreshold", "diskThreshold"] as const).map((k, i) => (
            <Row key={k} label={["CPU", "RAM", t("Диск")][i]}>
              <input
                type="number"
                style={{ width: 70 }}
                value={settings[k]}
                onChange={(e) => setSettings((s) => ({ ...s, [k]: num(e.target.value, 1, 100, 90) }))}
              />
            </Row>
          ))}

          <div className="sec-label" style={{ margin: "16px 0 6px" }}>{t("Внешний вид")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "4px 0" }}>
            <span style={{ flex: 1, fontSize: 13 }}>{t("Акцент")}</span>
            <div style={{ display: "flex", gap: 8 }}>
              {ACCENTS.map((c) => (
                <span
                  key={c}
                  onClick={() => setSettings((s) => ({ ...s, accent: c }))}
                  style={{
                    width: 22, height: 22, borderRadius: 6, background: c, cursor: "pointer",
                    border: settings.accent === c ? "2px solid var(--text)" : "2px solid transparent",
                  }}
                />
              ))}
            </div>
          </div>
          <Row label={t("Язык")}>
            <div className="seg">
              {(["ru", "en"] as const).map((l) => (
                <div key={l} className={"seg-btn" + (lang === l ? " active" : "")} style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setLang(l)}>
                  {l.toUpperCase()}
                </div>
              ))}
            </div>
          </Row>

          <div className="sec-label" style={{ margin: "16px 0 6px" }}>{t("Хранилище паролей (vault)")}</div>
          {vault?.exists ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
              <span style={{ color: vault.unlocked ? "var(--green)" : "var(--yellow)" }}>
                ● {vault.unlocked ? t("разблокировано") : t("заблокировано")}
              </span>
              <span style={{ flex: 1 }} />
              {vault.unlocked && (
                <div className="btn-ghost" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => ipc.vaultLock().then(refreshVault)}>
                  {t("Заблокировать")}
                </div>
              )}
            </div>
          ) : vaultPw === null ? (
            <div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8 }}>
                {t("Зашифрует пароли и passphrase на диске. Открывается мастер-паролем при запуске.")}
              </div>
              <div className="btn-ghost" style={{ padding: "7px 14px", fontSize: 12, display: "inline-block" }} onClick={() => setVaultPw("")}>
                {t("Создать хранилище")}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="password"
                autoFocus
                placeholder={t("Мастер-пароль")}
                value={vaultPw}
                onChange={(e) => setVaultPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && vaultPw && void createVault()}
              />
              <div className={"btn-accent" + (vaultPw ? "" : " disabled")} style={{ flex: "none" }} onClick={() => void createVault()}>
                {t("Создать")}
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="mono" style={{ fontSize: 11, color: "var(--dim)" }}>
            Nimbus{version ? ` v${version}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          <div className="btn-accent" onClick={onClose}>{t("Готово")}</div>
        </div>
      </div>
    </div>
  );
}
