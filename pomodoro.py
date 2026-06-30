#!/usr/bin/env python3
"""
番茄钟 - Pomodoro Timer
================================
Enhanced desktop Pomodoro timer built with Python + tkinter.

Features:
  - 25min focus / 5min short break / 15min long break
  - Start, pause, reset controls
  - Auto-switch between work and break modes
  - Customizable durations via settings dialog
  - Task labels for each session
  - Daily statistics with history view
  - Sound notifications (Windows)
  - System tray minimization (requires pystray + Pillow, optional)
  - Always-on-top option
  - Color-coded modes (red = work, green = short break, blue = long break)

Dependencies:
  - Built-in:  tkinter, json, winsound, datetime, pathlib, threading
  - Optional:  pystray, Pillow  (pip install pystray pillow)
"""

import tkinter as tk
from tkinter import ttk, messagebox
import json
import threading
import time
import winsound
from datetime import datetime
from pathlib import Path

# ─── Optional system tray support ───
try:
    from PIL import Image, ImageDraw
    import pystray
    PYSTRAY_AVAILABLE = True
except ImportError:
    PYSTRAY_AVAILABLE = False

# ─── Constants ───
APP_NAME = "番茄钟"
BASE_DIR = Path(__file__).resolve().parent
SETTINGS_FILE = BASE_DIR / "pomodoro_settings.json"
STATS_FILE = BASE_DIR / "pomodoro_stats.json"

# Color scheme
WORK_COLOR = "#E74C3C"          # tomato red
SHORT_BREAK_COLOR = "#27AE60"   # green
LONG_BREAK_COLOR = "#2980B9"    # blue
BG_COLOR = "#FDF6F0"            # warm cream background
CARD_BG = "#FFFFFF"             # card background
TEXT_COLOR = "#2C3E50"          # dark blue-gray text
STATS_BG = "#F5EDE3"            # stats strip background
BTN_SECONDARY = "#D5C4B1"       # secondary button color
BORDER_COLOR = "#E0D5C7"        # subtle border

# Fonts
FONT_TITLE = ("Microsoft YaHei", 18, "bold")
FONT_TIMER = ("Consolas", 48, "bold")
FONT_LABEL = ("Microsoft YaHei", 11)
FONT_BODY = ("Microsoft YaHei", 10)
FONT_SMALL = ("Microsoft YaHei", 9)
FONT_BTN = ("Microsoft YaHei", 11, "bold")

# Mode configuration: (label, color)
MODE_CONFIG = {
    "work":        ("🔴 专注时间", WORK_COLOR),
    "short_break": ("🟢 短休息",   SHORT_BREAK_COLOR),
    "long_break":  ("🔵 长休息",   LONG_BREAK_COLOR),
}

# Default settings
DEFAULT_SETTINGS = {
    "work_duration": 25,
    "short_break": 5,
    "long_break": 15,
    "pomodoros_until_long": 4,
    "always_on_top": False,
    "sound_enabled": True,
}


# ─── Module-level helpers ────────────────────────────────────

def _beep_loop():
    """Play notification chime (4-beep pattern). Runs in daemon thread."""
    for _ in range(4):
        try:
            winsound.Beep(880, 180)
            time.sleep(0.08)
            winsound.Beep(1100, 280)
            time.sleep(0.12)
        except Exception:
            try:
                winsound.MessageBeep(-1)
            except Exception:
                pass
            break


def _format_duration(minutes):
    """Return a human-readable duration string, e.g. '1h 15m' or '25 分钟'."""
    h, m = divmod(minutes, 60)
    if h > 0:
        return f"{h}h {m}m"
    return f"{m} 分钟"


# ═══════════════════════════════════════════════════════════════
#  Settings Manager
# ═══════════════════════════════════════════════════════════════

class SettingsManager:
    """Load and persist application settings to a JSON file."""

    def __init__(self):
        self.settings = dict(DEFAULT_SETTINGS)
        self.load()

    def load(self):
        try:
            if SETTINGS_FILE.exists():
                with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.settings.update(data)
        except Exception:
            pass  # keep defaults on any error

    def save(self):
        try:
            with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
                json.dump(self.settings, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Failed to save settings: {e}")

    def get(self, key):
        return self.settings.get(key, DEFAULT_SETTINGS.get(key))


# ═══════════════════════════════════════════════════════════════
#  Statistics Tracker
# ═══════════════════════════════════════════════════════════════

class StatsTracker:
    """Track daily pomodoro counts, minutes, and tasks in a JSON file."""

    def __init__(self):
        self.stats = {}
        self.load()

    def load(self):
        try:
            if STATS_FILE.exists():
                with open(STATS_FILE, "r", encoding="utf-8") as f:
                    self.stats = json.load(f)
        except Exception:
            self.stats = {}

    def save(self):
        try:
            with open(STATS_FILE, "w", encoding="utf-8") as f:
                json.dump(self.stats, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Failed to save stats: {e}")

    def record(self, minutes, task=""):
        """Record a completed pomodoro for today."""
        today = datetime.now().strftime("%Y-%m-%d")
        if today not in self.stats:
            self.stats[today] = {"count": 0, "minutes": 0, "tasks": []}
        entry = self.stats[today]
        entry["count"] += 1
        entry["minutes"] += minutes
        if task and task not in entry["tasks"]:
            entry["tasks"].append(task)
        self.save()

    def get_today(self):
        """Return today's stats dict."""
        today = datetime.now().strftime("%Y-%m-%d")
        return self.stats.get(today, {"count": 0, "minutes": 0, "tasks": []})

    def get_all_time(self):
        """Return (total_pomodoros, total_minutes) across all dates."""
        total_count = sum(d["count"] for d in self.stats.values())
        total_minutes = sum(d["minutes"] for d in self.stats.values())
        return total_count, total_minutes

    def get_history(self):
        """Return stats dict sorted newest-first."""
        return dict(sorted(self.stats.items(), reverse=True))


# ═══════════════════════════════════════════════════════════════
#  Main Application
# ═══════════════════════════════════════════════════════════════

class PomodoroApp:
    """Main Pomodoro Timer application window and logic."""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.geometry("420x530")
        self.root.resizable(False, False)
        self.root.configure(bg=BG_COLOR)

        # Managers
        self.settings = SettingsManager()
        self.stats = StatsTracker()

        # Timer state
        self.mode = "work"          # "work" | "short_break" | "long_break"
        self.running = False
        self.paused = False
        self.remaining = self.settings.get("work_duration") * 60
        self.total_seconds = self.remaining
        self.pomodoro_cycle = 0     # work sessions since last long break
        self.current_task = tk.StringVar()
        self.after_id = None        # id from root.after() for cancelling
        self.tray_icon = None       # set before UI updates (they may reference it)

        # Build UI
        self._setup_styles()
        self._setup_ui()
        self._refresh_ui()
        self._update_stats_display()

        # System tray (optional)
        if PYSTRAY_AVAILABLE:
            self._setup_tray()

        # Window close → minimize to tray (or quit if no tray)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        # Apply always-on-top setting
        if self.settings.get("always_on_top"):
            self.root.attributes("-topmost", True)

    # ─── TTK Styles ───────────────────────────────────────────

    def _setup_styles(self):
        """Configure ttk styles once at startup."""
        self._style = ttk.Style()
        self._style.theme_use("default")
        self._style.configure(
            "TProgressbar",
            troughcolor="#ECF0F1",
            background=WORK_COLOR,
            thickness=10,
        )

    # ─── Internal helpers ─────────────────────────────────────

    def _cancel_timer(self):
        """Cancel the pending after() callback if one is scheduled."""
        if self.after_id:
            self.root.after_cancel(self.after_id)
            self.after_id = None

    def _create_dialog(self, title, geometry, *, resizable=True):
        """Create a centred, transient Toplevel dialog bound to the main window."""
        dlg = tk.Toplevel(self.root)
        dlg.title(title)
        dlg.geometry(geometry)
        dlg.configure(bg=BG_COLOR)
        dlg.transient(self.root)
        dlg.grab_set()
        if not resizable:
            dlg.resizable(False, False)
        self._center_dialog(dlg)
        return dlg

    def _primary_btn(self, parent, text, bg, command, **kw):
        """Create a styled primary (colored) button."""
        return tk.Button(
            parent, text=text, font=FONT_BTN, bg=bg, fg="white",
            activeforeground="white", relief="flat", cursor="hand2",
            command=command, **kw,
        )

    def _secondary_btn(self, parent, text, command, **kw):
        """Create a styled secondary (muted) button."""
        return tk.Button(
            parent, text=text, font=FONT_BODY, bg=BTN_SECONDARY,
            fg=TEXT_COLOR, relief="flat", cursor="hand2",
            command=command, **kw,
        )

    def _refresh_ui(self):
        """Update display and button states (called on state transitions)."""
        self._update_display()
        self._update_button_states()

    def _run_daemon(self, target):
        """Run *target* in a daemon thread."""
        t = threading.Thread(target=target, daemon=True)
        t.start()

    # ─── UI Construction ──────────────────────────────────────

    def _setup_ui(self):
        # ---- Title ----
        title_frame = tk.Frame(self.root, bg=BG_COLOR)
        title_frame.pack(pady=(18, 8))
        tk.Label(
            title_frame, text=f"🍅 {APP_NAME}", font=FONT_TITLE,
            fg=WORK_COLOR, bg=BG_COLOR,
        ).pack()

        # ---- Timer Card ----
        card = tk.Frame(
            self.root, bg=CARD_BG,
            highlightbackground=BORDER_COLOR, highlightthickness=1,
            padx=20, pady=15,
        )
        card.pack(padx=30, pady=(0, 12), fill="x")

        # Timer digits (large monospace)
        self.timer_label = tk.Label(
            card, text="25:00", font=FONT_TIMER,
            fg=TEXT_COLOR, bg=CARD_BG,
        )
        self.timer_label.pack()

        # Mode indicator
        self.mode_label = tk.Label(
            card, text="🔴 专注时间", font=FONT_LABEL,
            fg=WORK_COLOR, bg=CARD_BG,
        )
        self.mode_label.pack(pady=(2, 8))

        # Progress bar
        self.progress = ttk.Progressbar(
            card, mode="determinate", length=300,
            style="TProgressbar",
        )
        self.progress["value"] = 100
        self.progress.pack(pady=(0, 4))

        # ---- Control Buttons ----
        btn_frame = tk.Frame(self.root, bg=BG_COLOR)
        btn_frame.pack(pady=(0, 12))

        self.start_btn = tk.Button(
            btn_frame, text="▶ 开始", font=FONT_BTN,
            bg=WORK_COLOR, fg="white",
            activebackground="#C0392B", activeforeground="white",
            relief="flat", padx=18, pady=6, cursor="hand2",
            command=self._start,
        )
        self.start_btn.pack(side="left", padx=4)

        self.pause_btn = tk.Button(
            btn_frame, text="⏸ 暂停", font=FONT_BTN,
            bg="#F39C12", fg="white",
            activebackground="#E67E22", activeforeground="white",
            relief="flat", padx=18, pady=6, cursor="hand2",
            command=self._pause,
        )
        self.pause_btn.pack(side="left", padx=4)

        self.reset_btn = tk.Button(
            btn_frame, text="↺ 重置", font=FONT_BTN,
            bg="#95A5A6", fg="white",
            activebackground="#7F8C8D", activeforeground="white",
            relief="flat", padx=18, pady=6, cursor="hand2",
            command=self._reset,
        )
        self.reset_btn.pack(side="left", padx=4)

        # ---- Task Input ----
        task_frame = tk.Frame(self.root, bg=BG_COLOR)
        task_frame.pack(pady=(0, 12), padx=30, fill="x")
        tk.Label(
            task_frame, text="当前任务:", font=FONT_BODY,
            fg=TEXT_COLOR, bg=BG_COLOR,
        ).pack(side="left")
        self.task_entry = tk.Entry(
            task_frame, textvariable=self.current_task, font=FONT_BODY,
            width=25, relief="solid", borderwidth=1,
        )
        self.task_entry.pack(side="left", padx=(8, 0), fill="x", expand=True)
        self.task_entry.bind("<Return>", lambda e: self._focus_root())

        # ---- Today Stats ----
        stats_frame = tk.Frame(
            self.root, bg=STATS_BG,
            highlightbackground=BORDER_COLOR, highlightthickness=1,
            padx=15, pady=10,
        )
        stats_frame.pack(padx=30, pady=(0, 12), fill="x")

        self.today_stats_label = tk.Label(
            stats_frame, text="", font=FONT_BODY,
            fg=TEXT_COLOR, bg=STATS_BG, justify="left",
        )
        self.today_stats_label.pack()

        # ---- Bottom Action Buttons ----
        bottom_frame = tk.Frame(self.root, bg=BG_COLOR)
        bottom_frame.pack(padx=30, fill="x")

        tk.Button(
            bottom_frame, text="⚙ 设置", font=FONT_BODY,
            bg=BTN_SECONDARY, fg=TEXT_COLOR,
            relief="flat", padx=14, pady=5, cursor="hand2",
            command=self._show_settings,
        ).pack(side="left")

        tk.Button(
            bottom_frame, text="📊 统计", font=FONT_BODY,
            bg=BTN_SECONDARY, fg=TEXT_COLOR,
            relief="flat", padx=14, pady=5, cursor="hand2",
            command=self._show_stats,
        ).pack(side="right")

    # ─── Timer Engine ─────────────────────────────────────────

    def _timer_tick(self):
        """Called every second while the timer is running."""
        if self.remaining > 0:
            self.remaining -= 1
            self._update_display()
            self.after_id = self.root.after(1000, self._timer_tick)
        else:
            self._timer_finished()

    def _timer_finished(self):
        """Handle the timer reaching 00:00."""
        self.running = False
        self.after_id = None

        if self.mode == "work":
            self._on_work_complete()
        else:
            self._on_break_complete()

        self._refresh_ui()

    def _on_work_complete(self):
        """A work session just finished — record, notify, start break."""
        work_minutes = self.settings.get("work_duration")
        task = self.current_task.get().strip()
        self.stats.record(work_minutes, task)
        self.pomodoro_cycle += 1
        self._update_stats_display()

        # Play notification sound
        self._play_notification()

        # Determine break type
        if self.pomodoro_cycle >= self.settings.get("pomodoros_until_long"):
            self.mode = "long_break"
            self.remaining = self.settings.get("long_break") * 60
            self.pomodoro_cycle = 0
        else:
            self.mode = "short_break"
            self.remaining = self.settings.get("short_break") * 60

        self.total_seconds = self.remaining

        # Auto-start the break
        self.running = True
        self.after_id = self.root.after(1000, self._timer_tick)

        # Show a brief popup
        mode_name = "长休息" if self.mode == "long_break" else "短休息"
        self._flash_window()
        messagebox.showinfo(
            "🍅 番茄完成！",
            f"太棒了！开始{mode_name} ({self.total_seconds // 60} 分钟)",
        )

    def _on_break_complete(self):
        """A break just finished — notify and return to idle work mode."""
        self._play_notification()
        self.mode = "work"
        self.remaining = self.settings.get("work_duration") * 60
        self.total_seconds = self.remaining

        self._flash_window()
        messagebox.showinfo(
            "⏰ 休息结束",
            "休息时间结束，准备开始新的番茄吧！",
        )

    # ─── Control Actions ──────────────────────────────────────

    def _start(self):
        """Start or resume the timer."""
        if self.paused:
            self.paused = False
        else:
            self.mode = "work"
            self.remaining = self.settings.get("work_duration") * 60
            self.total_seconds = self.remaining

        self.running = True
        self._refresh_ui()
        self._cancel_timer()
        self.after_id = self.root.after(1000, self._timer_tick)

    def _pause(self):
        """Pause the running timer."""
        if self.running:
            self.running = False
            self.paused = True
            self._cancel_timer()
            self._refresh_ui()

    def _reset(self):
        """Reset timer to initial work state."""
        self._cancel_timer()
        self.running = False
        self.paused = False
        self.mode = "work"
        self.remaining = self.settings.get("work_duration") * 60
        self.total_seconds = self.remaining
        self.pomodoro_cycle = 0
        self._refresh_ui()

    # ─── Display Updates ──────────────────────────────────────

    def _update_display(self):
        """Refresh timer digits, progress bar, and mode label colors."""
        mins, secs = divmod(self.remaining, 60)
        self.timer_label.config(text=f"{mins:02d}:{secs:02d}")

        # Progress bar
        if self.total_seconds > 0:
            pct = self.remaining / self.total_seconds * 100
        else:
            pct = 0
        self.progress["value"] = pct

        # Mode-specific colors (from module-level constant)
        text, color = MODE_CONFIG[self.mode]
        self.mode_label.config(text=text, fg=color)

        # Update progress bar color (reuse cached style, only when mode changes)
        if getattr(self, "_last_mode", None) != self.mode:
            self._style.configure("TProgressbar", background=color)
            self._last_mode = self.mode

        # Update tray tooltip
        self._update_tray_tooltip(mins, secs, text)

    def _update_button_states(self):
        """Enable/disable buttons based on run state."""
        if self.running:
            self.start_btn.config(state="disabled")
            self.pause_btn.config(state="normal")
        else:
            self.start_btn.config(state="normal")
            self.pause_btn.config(state="disabled")

    def _update_stats_display(self):
        """Refresh the today-stats label."""
        today = self.stats.get_today()
        count = today["count"]
        minutes = today["minutes"]

        parts = [f"🍅 今日完成: {count} 个番茄"]
        parts.append(f"⏱ 总专注: {_format_duration(minutes)}")

        if today.get("tasks"):
            recent = today["tasks"][-3:]
            parts.append(f"📋 任务: {'、'.join(recent)}")

        self.today_stats_label.config(text="  |  ".join(parts))

    # ─── Sound ─────────────────────────────────────────────────

    def _play_notification(self):
        """Play a completion chime in a background thread."""
        if not self.settings.get("sound_enabled"):
            return
        self._run_daemon(_beep_loop)

    # ─── Window Flash ─────────────────────────────────────────

    def _flash_window(self):
        """Briefly bring window to front to get user attention."""
        try:
            self._restore_from_tray()
            self.root.attributes("-topmost", True)
            self.root.after(500, lambda: self.root.attributes(
                "-topmost", self.settings.get("always_on_top")))
        except Exception:
            pass

    # ─── Settings Dialog ──────────────────────────────────────

    def _show_settings(self):
        dialog = self._create_dialog("设置", "360x340", resizable=False)

        vars_dict = {}

        rows = [
            ("专注时长 (分钟):", "work_duration", 1, 120),
            ("短休息 (分钟):",  "short_break", 1, 60),
            ("长休息 (分钟):",  "long_break", 1, 60),
            ("长休息间隔 (个番茄):", "pomodoros_until_long", 1, 10),
        ]

        for label_text, key, lo, hi in rows:
            frm = tk.Frame(dialog, bg=BG_COLOR)
            frm.pack(pady=7, padx=25, fill="x")
            tk.Label(
                frm, text=label_text, font=FONT_BODY,
                fg=TEXT_COLOR, bg=BG_COLOR,
            ).pack(side="left")
            var = tk.IntVar(value=self.settings.get(key))
            vars_dict[key] = var
            sp = tk.Spinbox(
                frm, from_=lo, to=hi, textvariable=var,
                width=5, font=FONT_BODY, justify="center",
                relief="solid", borderwidth=1,
            )
            sp.pack(side="right")

        # Checkboxes
        cb_frame = tk.Frame(dialog, bg=BG_COLOR)
        cb_frame.pack(pady=8, padx=25, fill="x")

        atop_var = tk.BooleanVar(value=self.settings.get("always_on_top"))
        tk.Checkbutton(
            cb_frame, text="窗口置顶", variable=atop_var,
            font=FONT_BODY, bg=BG_COLOR, activebackground=BG_COLOR,
            cursor="hand2",
        ).pack(anchor="w", pady=2)

        sound_var = tk.BooleanVar(value=self.settings.get("sound_enabled"))
        tk.Checkbutton(
            cb_frame, text="启用声音提醒", variable=sound_var,
            font=FONT_BODY, bg=BG_COLOR, activebackground=BG_COLOR,
            cursor="hand2",
        ).pack(anchor="w", pady=2)

        # Tray status indicator
        tray_status = "✓ 已启用" if PYSTRAY_AVAILABLE else "✗ 未安装 (pip install pystray pillow)"
        tk.Label(
            cb_frame, text=f"系统托盘: {tray_status}",
            font=FONT_SMALL, fg="#999", bg=BG_COLOR,
        ).pack(anchor="w", pady=(6, 0))

        def save_and_close():
            for key, var in vars_dict.items():
                self.settings.settings[key] = var.get()
            self.settings.settings["always_on_top"] = atop_var.get()
            self.settings.settings["sound_enabled"] = sound_var.get()
            self.settings.save()

            self.root.attributes("-topmost", atop_var.get())

            # Reset timer if idle (not running, not paused)
            if not self.running and not self.paused:
                self.remaining = self.settings.get("work_duration") * 60
                self.total_seconds = self.remaining
                self._update_display()

            dialog.destroy()

        tk.Button(
            dialog, text="保存", font=FONT_BTN,
            bg=WORK_COLOR, fg="white",
            activebackground="#C0392B", activeforeground="white",
            relief="flat", padx=24, pady=6, cursor="hand2",
            command=save_and_close,
        ).pack(pady=15)

    # ─── Stats Dialog ─────────────────────────────────────────

    def _show_stats(self):
        dialog = self._create_dialog("统计", "420x420")

        # Summary header
        total_count, total_minutes = self.stats.get_all_time()
        summary = (
            f"📊 总计: {total_count} 个番茄  |  "
            f"⏱ 总专注: {_format_duration(total_minutes)}"
        )
        tk.Label(
            dialog, text=summary, font=("Microsoft YaHei", 11, "bold"),
            fg=TEXT_COLOR, bg=BG_COLOR,
        ).pack(pady=(15, 8))

        # History list in a scrollable text widget
        text_frame = tk.Frame(
            dialog, bg=CARD_BG,
            highlightbackground=BORDER_COLOR, highlightthickness=1,
        )
        text_frame.pack(padx=20, pady=(0, 12), fill="both", expand=True)

        text_widget = tk.Text(
            text_frame, font=FONT_BODY, bg=CARD_BG, fg=TEXT_COLOR,
            relief="flat", padx=12, pady=10, wrap="word",
            state="disabled",
        )
        text_widget.pack(side="left", fill="both", expand=True)

        scrollbar = tk.Scrollbar(text_frame, command=text_widget.yview)
        scrollbar.pack(side="right", fill="y")
        text_widget.config(yscrollcommand=scrollbar.set)

        history = self.stats.get_history()
        text_widget.config(state="normal")
        if history:
            for date, data in history.items():
                time_str = _format_duration(data["minutes"])
                text_widget.insert("end", f"📅 {date}\n")
                text_widget.insert(
                    "end", f"   🍅 {data['count']} 个番茄  ⏱ {time_str}\n",
                )
                if data.get("tasks"):
                    text_widget.insert(
                        "end", f"   📋 {', '.join(data['tasks'])}\n",
                    )
                text_widget.insert("end", "\n")
        else:
            text_widget.insert("end", "暂无记录\n\n开始你的第一个番茄吧！🍅")
        text_widget.config(state="disabled")

        self._secondary_btn(dialog, "关闭", dialog.destroy).pack(pady=(0, 15))

    # ─── Tray Icon ────────────────────────────────────────────

    def _create_tray_image(self):
        """Draw a simple tomato icon (64x64) for the system tray."""
        size = 64
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        # Tomato body (red circle)
        draw.ellipse([6, 14, 58, 60], fill="#E74C3C", outline="#C0392B", width=2)
        # Highlight / shine
        draw.ellipse([18, 21, 30, 32], fill=(255, 255, 255, 80))
        # Stem (green rectangle)
        draw.rectangle([28, 2, 34, 16], fill="#27AE60")
        # Leaf
        draw.ellipse([32, 4, 52, 18], fill="#2ECC71", outline="#27AE60", width=1)

        return img

    def _setup_tray(self):
        """Create and start the system tray icon."""
        icon_img = self._create_tray_image()

        menu = pystray.Menu(
            pystray.MenuItem("显示窗口", self._restore_from_tray, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", self._quit_app),
        )

        self.tray_icon = pystray.Icon(APP_NAME, icon_img, APP_NAME, menu)

        tray_thread = threading.Thread(target=self.tray_icon.run, daemon=True)
        tray_thread.start()

    def _update_tray_tooltip(self, mins, secs, mode_text):
        """Update the system tray tooltip with current state."""
        if not self.tray_icon:
            return
        if self.running:
            status = "运行中"
        elif self.paused:
            status = "已暂停"
        else:
            status = "就绪"
        self.tray_icon.title = (
            f"🍅 {APP_NAME} - {mode_text} {mins:02d}:{secs:02d} ({status})"
        )

    def _restore_from_tray(self):
        """Restore the window from the system tray."""
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    # ─── Window Lifecycle ─────────────────────────────────────

    def _on_close(self):
        """Handle the window close (X) button."""
        if PYSTRAY_AVAILABLE and self.tray_icon:
            self.root.withdraw()
            if self.running:
                messagebox.showinfo(
                    APP_NAME,
                    "番茄钟已最小化到系统托盘，计时仍在继续。\n"
                    "双击托盘图标或右键选择「显示窗口」恢复。",
                )
        else:
            self._quit_app()

    def _quit_app(self):
        """Fully terminate the application."""
        self._cancel_timer()
        if self.tray_icon:
            self.tray_icon.stop()
            self.tray_icon = None
        self.root.destroy()

    def _focus_root(self):
        """Move focus away from the task entry to the root window."""
        self.root.focus_set()

    def _center_dialog(self, dialog):
        """Position a dialog near its parent window."""
        dialog.update_idletasks()
        pw = self.root.winfo_width()
        ph = self.root.winfo_height()
        px = self.root.winfo_rootx()
        py = self.root.winfo_rooty()
        dw = dialog.winfo_width()
        dh = dialog.winfo_height()
        x = px + (pw - dw) // 2
        y = py + (ph - dh) // 2
        dialog.geometry(f"+{x}+{y}")

    # ─── Entry Point ──────────────────────────────────────────

    def run(self):
        self.root.mainloop()


# ═══════════════════════════════════════════════════════════════
#  Main guard
# ═══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    app = PomodoroApp()
    app.run()
