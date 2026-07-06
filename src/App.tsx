import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "./ipc";
import { LangContext, loadLang, storeLang, useT, type Lang } from "./i18n";
import { metricsCmd, parseMetrics } from "./metrics";
import type { Runtime, ServerCfg, Snippet, Status, Tab, TabMode } from "./types";
import { Sidebar, Rail } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/TerminalPane";
import { Overview } from "./components/Overview";
import { Explorer } from "./components/Explorer";
import { FilesView } from "./components/FilesView";
import { SnippetsView } from "./components/SnippetsView";
import { Palette } from "./components/Palette";
import { ServerModal } from "./components/ServerModal";
import { EmptyState } from "./components/EmptyState";
import { ToastHost, useToasts } from "./components/Toasts";
import { SecretPrompt, HostKeyDialog, type SecretReq, type HostKeyReq } from "./components/AuthDialogs";
import { ImportModal } from "./components/ImportModal";
import { parseAuthError } from "./authFlow";

export const uid = () => Math.random().toString(36).slice(2, 10);

const DEFAULT_SNIPPETS: Snippet[] = [
  { id: "sn1", title: "Docker: очистить неиспользуемое", cmd: "docker system prune -af", tags: ["docker", "cleanup"] },
  { id: "sn2", title: "Дисковое пространство", cmd: "df -h /", tags: ["monitoring"] },
  { id: "sn3", title: "Топ процессов по CPU", cmd: "ps aux --sort=-%cpu | head -6", tags: ["monitoring"] },
  { id: "sn4", title: "Активные docker-контейнеры", cmd: "docker ps --format 'table {{.Names}}\\t{{.Status}}'", tags: ["docker"] },
  { id: "sn5", title: "Обновить пакеты", cmd: "sudo apt update && sudo apt upgrade -y", tags: ["system"] },
  { id: "sn6", title: "Топ процессов по памяти", cmd: "ps aux --sort=-%mem | head -6", tags: ["monitoring"] },
  { id: "sn7", title: "Docker: потребление ресурсов", cmd: "docker stats --no-stream", tags: ["docker", "monitoring"] },
  { id: "sn8", title: "Docker: занятое место", cmd: "docker system df", tags: ["docker", "monitoring"] },
  { id: "sn9", title: "Открытые порты и процессы", cmd: "ss -tulpn", tags: ["network", "security"] },
  { id: "sn10", title: "Публичный IP", cmd: "curl -s --max-time 5 ifconfig.me && echo", tags: ["network"] },
  { id: "sn11", title: "Статистика сетевых интерфейсов", cmd: "ip -s -h link", tags: ["network"] },
  { id: "sn12", title: "UFW: статус файрвола", cmd: "sudo ufw status verbose", tags: ["security", "network"] },
  { id: "sn13", title: "Упавшие systemd-сервисы", cmd: "systemctl --failed --no-pager", tags: ["system", "monitoring"] },
  { id: "sn14", title: "Ошибки в журнале за час", cmd: "journalctl -p err --since '-1h' --no-pager | tail -30", tags: ["logs", "system"] },
  { id: "sn15", title: "Неудачные SSH-попытки за сутки", cmd: "journalctl -u ssh -u sshd --since '-24h' --no-pager 2>/dev/null | grep -iE 'failed|invalid' | tail -20", tags: ["security", "logs"] },
  { id: "sn16", title: "Последние входы в систему", cmd: "last -n 10 -w", tags: ["security"] },
  { id: "sn17", title: "Fail2ban: статус sshd", cmd: "sudo fail2ban-client status sshd 2>/dev/null || echo 'fail2ban не установлен'", tags: ["security"] },
  { id: "sn18", title: "Самые тяжёлые директории в /", cmd: "sudo du -xh --max-depth=1 / 2>/dev/null | sort -hr | head -15", tags: ["monitoring", "cleanup"] },
  { id: "sn19", title: "Файлы больше 100 МБ", cmd: "sudo find / -xdev -type f -size +100M -exec du -h {} + 2>/dev/null | sort -hr | head -10", tags: ["cleanup"] },
  { id: "sn20", title: "Доступные обновления", cmd: "apt list --upgradable 2>/dev/null | tail -n +2", tags: ["system"] },
  { id: "sn21", title: "Нужна ли перезагрузка", cmd: "[ -f /var/run/reboot-required ] && cat /var/run/reboot-required || echo 'перезагрузка не требуется'", tags: ["system"] },
  { id: "sn22", title: "Версия ОС и ядра", cmd: "uname -srmo && grep PRETTY_NAME /etc/os-release", tags: ["system"] },
  { id: "sn23", title: "Certbot: сертификаты и сроки", cmd: "sudo certbot certificates 2>/dev/null | grep -E 'Name|Expiry' || echo 'certbot не установлен'", tags: ["security", "web"] },
  { id: "sn24", title: "Активные соединения (сводка)", cmd: "ss -s", tags: ["network", "monitoring"] },
];

const emptyRuntime = (): Runtime => ({
  status: "unknown",
  hist: { cpu: [], ram: [], disk: [], net: [], load: [], ts: [] },
});

export default function App() {
  const [lang, setLangState] = useState<Lang>(loadLang);
  const setLang = useCallback((l: Lang) => {
    storeLang(l);
    setLangState(l);
  }, []);
  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <AppInner />
    </LangContext.Provider>
  );
}

function AppInner() {
  const t = useT();
  const [servers, setServers] = useState<ServerCfg[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [runtimes, setRuntimes] = useState<Record<string, Runtime>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  const [serverModal, setServerModal] = useState<ServerCfg | "new" | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [secretPrompt, setSecretPrompt] = useState<(SecretReq & { serverId: string }) | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<(HostKeyReq & { serverId: string }) | null>(null);
  const { toasts, toast } = useToasts();

  const secretPromptRef = useRef(secretPrompt);
  secretPromptRef.current = secretPrompt;
  const hostKeyPromptRef = useRef(hostKeyPrompt);
  hostKeyPromptRef.current = hostKeyPrompt;

  const serversRef = useRef(servers);
  serversRef.current = servers;
  const runtimesRef = useRef(runtimes);
  runtimesRef.current = runtimes;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    ipc.loadConfig().then((cfg) => {
      const srv = cfg?.servers ?? [];
      setServers(srv);
      const saved = cfg?.snippets ?? [];
      const ids = new Set(saved.map((s) => s.id));
      setSnippets([...saved, ...DEFAULT_SNIPPETS.filter((s) => !ids.has(s.id))]);
      setRuntimes(Object.fromEntries(srv.map((s) => [s.id, emptyRuntime()])));
      try {
        const st = JSON.parse(localStorage.getItem("sd-tabs") || "null");
        if (st?.tabs?.length) {
          const valid: Tab[] = st.tabs.filter(
            (tb: Tab) => tb.serverId === null || srv.some((s) => s.id === tb.serverId)
          );
          setTabs(valid);
          setActiveTabId(
            valid.some((tb) => tb.id === st.activeTabId) ? st.activeTabId : valid[0]?.id ?? null
          );
        }
      } catch {}
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (loaded) ipc.saveConfig({ servers, snippets }).catch(() => {});
  }, [servers, snippets, loaded]);

  useEffect(() => {
    if (loaded) localStorage.setItem("sd-tabs", JSON.stringify({ tabs, activeTabId }));
  }, [tabs, activeTabId, loaded]);

  const setStatus = useCallback((id: string, status: Status, error?: string) => {
    setRuntimes((r) => ({ ...r, [id]: { ...(r[id] ?? emptyRuntime()), status, error } }));
  }, []);

  const handleAuthError = useCallback((server: ServerCfg, err: unknown): string | null => {
    const ev = parseAuthError(err);
    if (!ev) return null;
    if (ev.kind === "hostkey") {
      if (!hostKeyPromptRef.current)
        setHostKeyPrompt({ serverId: server.id, serverName: server.name, label: ev.label, known: ev.known, got: ev.got });
      return "проверка ключа сервера";
    }
    if (!secretPromptRef.current || secretPromptRef.current.serverId !== server.id)
      setSecretPrompt({
        serverId: server.id,
        serverName: server.name,
        secretKey: ev.secretKey,
        kind: ev.kind,
        wrong: ev.wrong,
      });
    return ev.kind === "password" ? "нужен пароль" : "нужна passphrase";
  }, []);

  const pollServer = useCallback(async (s: ServerCfg, withDocker?: boolean) => {
    const rt = runtimesRef.current[s.id] ?? emptyRuntime();
    const docker =
      withDocker ?? tabsRef.current.some((t) => t.serverId === s.id && t.mode === "overview");
    try {
      if (rt.status !== "online") setStatus(s.id, "connecting");
      const res = await ipc.exec(s, metricsCmd(!rt.metrics?.cpuSample, docker));
      const m = parseMetrics(res.out, rt.metrics);
      setRuntimes((r) => {
        const cur = r[s.id] ?? emptyRuntime();
        const push = (arr: number[], v: number) => [...arr.slice(-59), v];
        return {
          ...r,
          [s.id]: {
            ...cur,
            status: "online",
            metrics: m,
            latency: res.ms,
            error: undefined,
            hist: {
              cpu: push(cur.hist.cpu, m.cpu),
              ram: push(cur.hist.ram, m.ramPct),
              disk: push(cur.hist.disk, m.diskPct),
              net: push(cur.hist.net, m.rxRate),
              load: push(cur.hist.load, m.load1),
              ts: push(cur.hist.ts, m.ts),
            },
          },
        };
      });
    } catch (e) {
      const friendly = handleAuthError(s, e);
      setStatus(s.id, "offline", friendly ?? String(e));
    }
  }, [setStatus, handleAuthError]);

  useEffect(() => {
    if (!loaded) return;
    let stop = false;
    let n = 0;
    const cycle = (force = false) => {
      if (stop || (document.visibilityState === "hidden" && !force)) return;
      n++;
      serversRef.current.forEach((s) => {
        const st = runtimesRef.current[s.id]?.status ?? "unknown";
        if (st === "offline" && n % 4 !== 1) return;
        void pollServer(s);
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") cycle(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    cycle(true);
    const iv = setInterval(() => cycle(), 7000);
    return () => {
      stop = true;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loaded, pollServer]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const openTab = useCallback((serverId: string | null, mode: TabMode) => {
    setTabs((ts) => {
      const existing = ts.find((t) => t.serverId === serverId && t.mode === mode);
      if (existing) {
        setActiveTabId(existing.id);
        return ts;
      }
      const tab: Tab = { id: "t" + uid(), serverId, mode };
      setActiveTabId(tab.id);
      return [...ts, tab];
    });
    if (mode === "overview" && serverId) {
      const s = serversRef.current.find((x) => x.id === serverId);
      if (s) void pollServer(s, true);
    }
    setPalette(false);
  }, [pollServer]);

  const closeTab = useCallback((id: string) => {
    setTabs((ts) => {
      const idx = ts.findIndex((t) => t.id === id);
      const next = ts.filter((t) => t.id !== id);
      setActiveTabId((cur) =>
        cur === id ? (next.length ? next[Math.min(idx, next.length - 1)].id : null) : cur
      );
      return next;
    });
  }, []);

  const saveServer = useCallback((cfg: ServerCfg) => {
    setServers((ss) => {
      const i = ss.findIndex((s) => s.id === cfg.id);
      if (i >= 0) return ss.map((s) => (s.id === cfg.id ? cfg : s));
      return [...ss, cfg];
    });
    setRuntimes((r) => (r[cfg.id] ? r : { ...r, [cfg.id]: emptyRuntime() }));
    setServerModal(null);
    ipc.disconnect(cfg.id).catch(() => {});
    setTimeout(() => void pollServer(cfg), 100);
  }, [pollServer]);

  const deleteServer = useCallback((id: string) => {
    setServers((ss) => ss.filter((s) => s.id !== id));
    setTabs((ts) => ts.filter((t) => t.serverId !== id));
    setServerModal(null);
    ipc.disconnect(id).catch(() => {});
  }, []);

  const submitSecret = useCallback(async (value: string) => {
    const p = secretPromptRef.current;
    if (!p) return;
    await ipc.provideSecret(p.secretKey, value).catch(() => {});
    setSecretPrompt(null);
    const s = serversRef.current.find((x) => x.id === p.serverId);
    if (s) setTimeout(() => void pollServer(s), 50);
  }, [pollServer]);

  const acceptHostKey = useCallback(async () => {
    const p = hostKeyPromptRef.current;
    if (!p) return;
    await ipc.trustHostKey(p.label, p.got).catch(() => {});
    setHostKeyPrompt(null);
    const s = serversRef.current.find((x) => x.id === p.serverId);
    if (s) setTimeout(() => void pollServer(s), 50);
  }, [pollServer]);

  const importServers = useCallback((incoming: ServerCfg[]) => {
    setServers((ss) => {
      const seen = new Set(ss.map((s) => `${s.host}:${s.port}`));
      const fresh = incoming.filter((s) => !seen.has(`${s.host}:${s.port}`));
      setRuntimes((r) => {
        const next = { ...r };
        fresh.forEach((s) => (next[s.id] = emptyRuntime()));
        return next;
      });
      if (fresh.length) toast(`Импортировано серверов: ${fresh.length}`);
      return [...ss, ...fresh];
    });
    setImportOpen(false);
  }, [toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const t = tabs[+e.key - 1];
        if (t) {
          e.preventDefault();
          setActiveTabId(t.id);
        }
      } else if (e.key === "Escape") {
        setPalette(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs]);

  const serverOf = (t: Tab | null) => servers.find((s) => s.id === t?.serverId) ?? null;
  const terminalTabs = tabs.filter((t) => t.mode === "terminal");
  const view = activeTab?.mode;
  const viewServer = serverOf(activeTab);

  const content = useMemo(() => {
    if (!activeTab || (activeTab.mode !== "terminal" && !viewServer && activeTab.mode !== "snippets"))
      return null;
    switch (view) {
      case "overview":
        return (
          <Overview
            key={activeTab.id}
            server={viewServer!}
            runtime={runtimes[viewServer!.id] ?? emptyRuntime()}
            onRefresh={() => void pollServer(viewServer!)}
            toast={toast}
          />
        );
      case "explorer":
        return <Explorer key={activeTab.id} server={viewServer!} toast={toast} />;
      case "files":
        return <FilesView key={activeTab.id} server={viewServer!} toast={toast} />;
      case "snippets":
        return (
          <SnippetsView
            snippets={snippets}
            setSnippets={setSnippets}
            servers={servers}
            runtimes={runtimes}
            toast={toast}
          />
        );
      default:
        return null;
    }
  }, [activeTab?.id, view, viewServer, runtimes, snippets, servers, pollServer, toast]);

  return (
    <div className="app">
      {collapsed ? (
        <Rail
          servers={servers}
          runtimes={runtimes}
          onExpand={() => setCollapsed(false)}
          onServer={(s) => openTab(s.id, "terminal")}
          onAdd={() => setServerModal("new")}
        />
      ) : (
        <Sidebar
          servers={servers}
          runtimes={runtimes}
          snippets={snippets}
          activeServerId={activeTab?.serverId ?? null}
          onCollapse={() => setCollapsed(true)}
          onOpenTab={openTab}
          onAdd={() => setServerModal("new")}
          onImport={() => setImportOpen(true)}
          onEdit={(s) => setServerModal(s)}
          onPalette={() => setPalette(true)}
          onSnippets={() => openTab(null, "snippets")}
        />
      )}

      <div className="main">
        {tabs.length > 0 && (
          <TabBar
            tabs={tabs}
            servers={servers}
            runtimes={runtimes}
            activeTabId={activeTabId}
            onSelect={setActiveTabId}
            onClose={closeTab}
            onPlus={() => setPalette(true)}
          />
        )}

        {terminalTabs.map((t) => {
          const srv = servers.find((s) => s.id === t.serverId);
          if (!srv) return null;
          return (
            <TerminalPane
              key={t.id}
              tab={t}
              server={srv}
              runtime={runtimes[srv.id] ?? emptyRuntime()}
              visible={t.id === activeTabId}
              onAuthError={handleAuthError}
            />
          );
        })}

        {view !== "terminal" && content}

        {servers.length === 0 && tabs.length === 0 && loaded && (
          <EmptyState onAdd={() => setServerModal("new")} />
        )}
        {servers.length > 0 && tabs.length === 0 && (
          <div className="ex-state" style={{ flex: 1 }}>
            <div style={{ fontSize: 14, color: "var(--muted)" }}>
              {t("Выберите сервер слева или нажмите")} <span className="kbd">Ctrl K</span>
            </div>
          </div>
        )}
      </div>

      {palette && (
        <Palette
          servers={servers}
          runtimes={runtimes}
          onClose={() => setPalette(false)}
          onServer={(s, mode) => openTab(s.id, mode)}
          onAdd={() => {
            setPalette(false);
            setServerModal("new");
          }}
          onSnippets={() => openTab(null, "snippets")}
        />
      )}

      {serverModal && (
        <ServerModal
          initial={serverModal === "new" ? null : serverModal}
          onClose={() => setServerModal(null)}
          onSave={saveServer}
          onDelete={deleteServer}
        />
      )}

      {importOpen && (
        <ImportModal existing={servers} onClose={() => setImportOpen(false)} onImport={importServers} />
      )}

      {secretPrompt && (
        <SecretPrompt req={secretPrompt} onSubmit={submitSecret} onCancel={() => setSecretPrompt(null)} />
      )}
      {hostKeyPrompt && (
        <HostKeyDialog req={hostKeyPrompt} onAccept={acceptHostKey} onReject={() => setHostKeyPrompt(null)} />
      )}

      <ToastHost toasts={toasts} />
    </div>
  );
}
