import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useT } from "../i18n";

export function UpdateBanner() {
  const t = useT();
  const [upd, setUpd] = useState<Update | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    check()
      .then((u) => {
        if (u?.available) setUpd(u);
      })
      .catch(() => {});
  }, []);

  if (!upd || dismissed) return null;

  const install = async () => {
    setBusy(true);
    setError("");
    try {
      let total = 0;
      let got = 0;
      await upd.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total) setProgress(Math.round((got / total) * 100));
        }
      });
      await relaunch();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="update-banner">
      <span style={{ color: "var(--accent)" }}>↑</span>
      <span style={{ fontSize: 12.5 }}>
        {t("Доступно обновление")} <b className="mono">{upd.version}</b>
      </span>
      {error && <span style={{ fontSize: 11, color: "var(--red)" }}>{error}</span>}
      <span style={{ flex: 1 }} />
      <div className={"btn-accent" + (busy ? " disabled" : "")} style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => void install()}>
        {busy ? `${progress}%` : t("Обновить и перезапустить")}
      </div>
      {!busy && (
        <span className="btn-text" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setDismissed(true)}>
          {t("Позже")}
        </span>
      )}
    </div>
  );
}
