import { useT } from "../i18n";

export function EmptyState({ onAdd }: { onAdd: () => void }) {
  const t = useT();
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, padding: 40 }}>
      <div style={{ width: 56, height: 56, borderRadius: 14, background: "var(--panel)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 600, color: "var(--accent)" }}>
        N
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 19, fontWeight: 600, marginBottom: 8 }}>{t("Ещё нет серверов")}</div>
        <div style={{ fontSize: 13, color: "var(--muted)", maxWidth: 360, lineHeight: 1.5 }}>
          {t("Добавьте первый сервер, чтобы открыть терминал по SSH, следить за метриками и управлять файлами.")}
        </div>
      </div>
      <div className="btn-accent" onClick={onAdd}>{t("+ Добавить сервер")}</div>
    </div>
  );
}
