import { useT } from "../i18n";
import type { Runtime, ServerCfg, Tab } from "../types";
import { MODE_LABEL } from "../types";
import { statusColor } from "./Sidebar";

interface Props {
  tabs: Tab[];
  servers: ServerCfg[];
  runtimes: Record<string, Runtime>;
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPlus: () => void;
}

export function TabBar(p: Props) {
  const t = useT();
  return (
    <div className="tabbar">
      {p.tabs.map((tab) => {
        const srv = p.servers.find((s) => s.id === tab.serverId);
        const dot = srv ? statusColor(p.runtimes[srv.id]?.status ?? "unknown") : "var(--accent)";
        return (
          <div
            key={tab.id}
            className={"tab" + (tab.id === p.activeTabId ? " active" : "")}
            onClick={() => p.onSelect(tab.id)}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flex: "none" }} />
            <span className="tab-label">{srv ? srv.name : t("Сниппеты")}</span>
            <span className="tab-type">{t(MODE_LABEL[tab.mode])}</span>
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                p.onClose(tab.id);
              }}
            >
              ×
            </span>
          </div>
        );
      })}
      <div className="tab-plus" onClick={p.onPlus}>+</div>
    </div>
  );
}
