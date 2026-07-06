import { memo, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { listen } from "@tauri-apps/api/event";
import { b64decode, b64encode, ipc } from "../ipc";
import { useT } from "../i18n";
import type { Runtime, ServerCfg, Tab } from "../types";

const FONT_KEY = "sd-term-font";
const loadFont = () => {
  const n = parseInt(localStorage.getItem(FONT_KEY) ?? "13");
  return isNaN(n) ? 13 : Math.min(24, Math.max(9, n));
};

interface Props {
  tab: Tab;
  server: ServerCfg;
  runtime: Runtime;
  visible: boolean;
  onAuthError: (server: ServerCfg, err: unknown) => string | null;
}

export const TerminalPane = memo(
  TerminalPaneInner,
  (a, b) =>
    a.tab.id === b.tab.id &&
    a.visible === b.visible &&
    a.server === b.server &&
    a.runtime.latency === b.runtime.latency
);

function TerminalPaneInner({ tab, server, runtime, visible, onAuthError }: Props) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState("00:00:00");
  const [closed, setClosed] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(loadFont);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const setFont = (n: number) => {
    const v = Math.min(24, Math.max(9, n));
    localStorage.setItem(FONT_KEY, String(v));
    setFontSize(v);
    if (termRef.current) {
      termRef.current.options.fontSize = v;
      requestAnimationFrame(() => fitRef.current?.fit());
    }
  };

  const reconnect = () => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    setClosed(null);
    setStartedAt(Date.now());
    ipc.termOpen(server, tab.id, term.cols, term.rows).catch((e) => {
      term.writeln(`\x1b[31m${t("Ошибка подключения")}: ${e}\x1b[0m`);
    });
  };

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: loadFont(),
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 8000,
      theme: {
        background: "#0b0d10",
        foreground: "#c2c6cd",
        cursor: "#c2c6cd",
        selectionBackground: "rgba(70,168,110,0.35)",
        black: "#1c1f25",
        red: "#c85c58",
        green: "#6ea36b",
        yellow: "#d1a24d",
        blue: "#5b93cc",
        magenta: "#a97bc4",
        cyan: "#6ea3a0",
        white: "#c2c6cd",
        brightBlack: "#5b616b",
        brightRed: "#d97a76",
        brightGreen: "#8bc188",
        brightYellow: "#e0b96a",
        brightBlue: "#7fadd9",
        brightMagenta: "#c29ad6",
        brightCyan: "#8fc1be",
        brightWhite: "#e8eaee",
      },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(hostRef.current!);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
        setFont(loadFont() + 1);
        return false;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        setFont(loadFont() - 1);
        return false;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        setFont(13);
        return false;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return false;
      }
      return true;
    });

    const unsubs: Array<() => void> = [];
    let disposed = false;

    ipc.termOpen(server, tab.id, term.cols, term.rows).catch((e) => {
      term.writeln(`\x1b[31m${t("Ошибка подключения")}: ${e}\x1b[0m`);
    });

    listen<string>(`term-out-${tab.id}`, (ev) => {
      term.write(b64decode(ev.payload));
    }).then((u) => {
      if (disposed) u();
      else unsubs.push(u);
    });
    listen<string | null>(`term-closed-${tab.id}`, (ev) => {
      if (ev.payload) {
        const friendly = onAuthError(server, ev.payload);
        term.writeln(`\r\n\x1b[31m${friendly ?? ev.payload}\x1b[0m`);
        setClosed(friendly ?? ev.payload);
      } else {
        term.writeln(`\r\n\x1b[90m${t("Сессия завершена")}\x1b[0m`);
        setClosed("closed");
      }
    }).then((u) => {
      if (disposed) u();
      else unsubs.push(u);
    });

    const dataSub = term.onData((d) => {
      ipc.termWrite(tab.id, b64encode(d)).catch(() => {});
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      ipc.termResize(tab.id, cols, rows).catch(() => {});
    });

    const ro = new ResizeObserver(() => {
      if (hostRef.current?.offsetParent !== null) fitRef.current?.fit();
    });
    ro.observe(hostRef.current!);

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
      dataSub.dispose();
      resizeSub.dispose();
      ro.disconnect();
      ipc.termClose(tab.id).catch(() => {});
      term.dispose();
    };
  }, [tab.id]);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [visible]);

  useEffect(() => {
    const iv = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      setElapsed(`${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`);
    }, 1000);
    return () => clearInterval(iv);
  }, [startedAt]);

  const runSearch = (dir: 1 | -1) => {
    if (!searchQ) return;
    const opts = { caseSensitive: false };
    if (dir === 1) searchRef.current?.findNext(searchQ, opts);
    else searchRef.current?.findPrevious(searchQ, opts);
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: visible ? "flex" : "none",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {searchOpen && (
        <div className="term-search">
          <span style={{ color: "var(--dim)", fontSize: 12 }}>⌕</span>
          <input
            ref={searchInputRef}
            placeholder={t("Поиск в выводе…")}
            value={searchQ}
            onChange={(e) => {
              setSearchQ(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") {
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
          />
          <span className="term-search-btn" onClick={() => runSearch(-1)}>↑</span>
          <span className="term-search-btn" onClick={() => runSearch(1)}>↓</span>
          <span
            className="term-search-btn"
            onClick={() => {
              setSearchOpen(false);
              termRef.current?.focus();
            }}
          >
            ×
          </span>
        </div>
      )}
      <div className="term-wrap" ref={hostRef} />
      {closed && (
        <div className="term-reconnect">
          <span style={{ color: "var(--muted)", fontSize: 12 }}>{t("Сессия закрыта")}</span>
          <span className="btn-ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={reconnect}>
            ↻ {t("Переподключиться")}
          </span>
        </div>
      )}
      <div className="statusbar">
        <span style={{ color: closed ? "var(--red)" : "var(--green)" }}>●</span>
        <span style={{ marginLeft: 6, color: "#b6bac2" }}>{server.name}</span>
        <span className="sep">·</span>
        <span>
          {server.host}:{server.port} · SSH
        </span>
        {runtime.latency !== undefined && (
          <>
            <span className="sep">·</span>
            <span>latency {runtime.latency}ms</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span className="term-font-ctl" title={t("Размер шрифта (Ctrl +/−)")}>
          <span onClick={() => setFont(fontSize - 1)}>A−</span>
          <span style={{ color: "var(--dim)" }}>{fontSize}</span>
          <span onClick={() => setFont(fontSize + 1)}>A+</span>
        </span>
        <span className="sep">·</span>
        <span>{t("сессия")} {elapsed}</span>
        <span className="sep">·</span>
        <span>UTF-8</span>
      </div>
    </div>
  );
}
