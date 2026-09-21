import { useProjectBridge } from "./features/projects/projectBridge";
import { useEffect, useRef, useState } from "react";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type TerminalEvent =
  | { type: "output"; data: number[] }
  | { type: "exit" }
  | { type: "error"; message: string };

type OpenCodeTerminalProps = {
  active: boolean;
};

export function OpenCodeTerminal({ active }: OpenCodeTerminalProps) {
  const { invoke } = useProjectBridge();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const startedRef = useRef(false);
  const startingRef = useRef(false);
  const previewMessageShownRef = useRef(false);
  const channelRef = useRef<Channel<TerminalEvent> | null>(null);
  const [status, setStatus] = useState("等待启动");

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.18,
      scrollback: 5000,
      theme: {
        background: "#061a2b",
        foreground: "#c8dbe4",
        cursor: "#78dcff",
        cursorAccent: "#061a2b",
        selectionBackground: "#1b607d",
        black: "#06111b",
        red: "#e87474",
        green: "#7adf9b",
        yellow: "#d4b06d",
        blue: "#5caee6",
        magenta: "#bd91e8",
        cyan: "#49c9ec",
        white: "#d8e7ef",
        brightBlack: "#607987",
        brightRed: "#ff9892",
        brightGreen: "#9bf1b6",
        brightYellow: "#f2d18b",
        brightBlue: "#86caff",
        brightMagenta: "#d8b1ff",
        brightCyan: "#8be6ff",
        brightWhite: "#f3fbff",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    const channel = isTauri() ? new Channel<TerminalEvent>() : null;
    if (channel) {
      channel.onmessage = (event) => {
        if (event.type === "output") {
          terminal.write(new Uint8Array(event.data));
          return;
        }

        if (event.type === "error") {
          terminal.writeln(`\r\n\x1b[31m[terminal] ${event.message}\x1b[0m`);
          setStatus("连接异常");
          return;
        }

        terminal.writeln("\r\n\x1b[90m[OpenCode 已退出]\x1b[0m");
        startedRef.current = false;
        setStatus("已退出");
      };
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    channelRef.current = channel;

    const inputSubscription = terminal.onData((data) => {
      if (!startedRef.current) return;
      void invoke("terminal_write", { data }).catch((error: unknown) => {
        terminal.writeln(`\r\n\x1b[31m[terminal] ${String(error)}\x1b[0m`);
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!activeRef.current) return;

      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          if (startedRef.current) {
            void invoke("terminal_resize", {
              rows: terminal.rows,
              cols: terminal.cols,
            });
          }
        } catch {
          // The terminal can briefly have no size while the view is switching.
        }
      });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      inputSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      channelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const channel = channelRef.current;
    if (!active || !terminal || !fitAddon) return;

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        return;
      }

      terminal.focus();
      if (!channel) {
        if (!previewMessageShownRef.current) {
          terminal.writeln(
            "\x1b[36mOpenCode 终端可在 CoopAgent 桌面版中使用。\x1b[0m",
          );
          previewMessageShownRef.current = true;
        }
        setStatus("桌面版功能");
        return;
      }

      if (startedRef.current || startingRef.current) {
        if (startedRef.current) {
          void invoke("terminal_resize", {
            rows: terminal.rows,
            cols: terminal.cols,
          });
        }
        return;
      }

      startingRef.current = true;
      setStatus("正在启动");
      void invoke("terminal_start", {
        rows: terminal.rows,
        cols: terminal.cols,
        onEvent: channel,
      })
        .then(() => {
          startedRef.current = true;
          setStatus("OpenCode 已连接");
          terminal.focus();
        })
        .catch((error: unknown) => {
          terminal.writeln(
            `\x1b[31m无法启动 OpenCode：${String(error)}\x1b[0m`,
          );
          setStatus("启动失败");
        })
        .finally(() => {
          startingRef.current = false;
        });
    });
  }, [active]);

  return (
    <div
      className={`terminal-pane${active ? " is-active" : ""}`}
      aria-hidden={!active}
    >
      <div className="terminal-meta">
        <span className="terminal-live-dot" />
        <span>{status}</span>
      </div>
      <div
        className="terminal-surface"
        aria-label="OpenCode 终端"
        ref={containerRef}
      />
    </div>
  );
}
