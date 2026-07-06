import { invoke } from "@tauri-apps/api/core";
import type { ExecOut, FileEntry, ParsedHost, ServerCfg, Snippet } from "./types";

export interface AppConfig {
  servers: ServerCfg[];
  snippets: Snippet[];
}

export const ipc = {
  loadConfig: () => invoke<AppConfig | null>("load_config"),
  saveConfig: (cfg: AppConfig) => invoke<void>("save_config", { cfg }),
  exec: (cfg: ServerCfg, cmd: string) => invoke<ExecOut>("ssh_exec", { cfg, cmd }),
  execPty: (cfg: ServerCfg, cmd: string) => invoke<ExecOut>("ssh_exec_pty", { cfg, cmd }),
  provideSecret: (key: string, value: string) => invoke<void>("provide_secret", { key, value }),
  trustHostKey: (label: string, fingerprint: string) =>
    invoke<void>("trust_host_key", { label, fingerprint }),
  importSshConfig: () => invoke<ParsedHost[]>("import_ssh_config"),
  testConnection: (cfg: ServerCfg) => invoke<number>("test_connection", { cfg }),
  sftpList: (cfg: ServerCfg, path: string) => invoke<FileEntry[]>("sftp_list", { cfg, path }),
  sftpPreview: (cfg: ServerCfg, path: string) =>
    invoke<{ text: string | null; size: number }>("sftp_preview", { cfg, path }),
  sftpDownload: (cfg: ServerCfg, remote: string, local: string) =>
    invoke<void>("sftp_download", { cfg, remote, local }),
  sftpUpload: (cfg: ServerCfg, local: string, remote: string) =>
    invoke<void>("sftp_upload", { cfg, local, remote }),
  sftpRename: (cfg: ServerCfg, from: string, to: string) =>
    invoke<void>("sftp_rename", { cfg, from, to }),
  sftpDelete: (cfg: ServerCfg, path: string, isDir: boolean) =>
    invoke<void>("sftp_delete", { cfg, path, isDir }),
  sftpChmod: (cfg: ServerCfg, path: string, mode: number) =>
    invoke<void>("sftp_chmod", { cfg, path, mode }),
  sftpMkdir: (cfg: ServerCfg, path: string) => invoke<void>("sftp_mkdir", { cfg, path }),
  localList: (path: string) => invoke<FileEntry[]>("local_list", { path }),
  homeDir: () => invoke<string>("home_dir"),
  termOpen: (cfg: ServerCfg, termId: string, cols: number, rows: number) =>
    invoke<void>("term_open", { cfg, termId, cols, rows }),
  termWrite: (termId: string, data: string) => invoke<void>("term_write", { termId, data }),
  termResize: (termId: string, cols: number, rows: number) =>
    invoke<void>("term_resize", { termId, cols, rows }),
  termClose: (termId: string) => invoke<void>("term_close", { termId }),
  disconnect: (serverId: string) => invoke<void>("disconnect_server", { serverId }),
};

export function b64encode(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
