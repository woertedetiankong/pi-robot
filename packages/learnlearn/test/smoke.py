"""Offline real-pi PTY smoke test; uses isolated config and never contacts a model service."""
import codecs
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))')
with tempfile.TemporaryDirectory(prefix="companion-smoke-") as folder:
    Path(folder, "companion.json").write_text(json.dumps({"format": "quiz", "mode": "task", "layout": "summary", "saveDirectory": str(Path(folder, "favorites"))}))
    Path(folder, ".pi").mkdir()
    Path(folder, ".pi/settings.json").write_text(json.dumps({"packages": [str(ROOT)]}))
    Path(folder, "settings.json").write_text(json.dumps({"hideThinkingBlock": True}))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 150, 0, 0))
    env = dict(os.environ, PI_CODING_AGENT_DIR=folder, TERM="xterm-256color")
    process = subprocess.Popen([shutil.which("pi"), "--approve", "--no-skills", "--no-prompt-templates", "--no-session", "-e", str(ROOT / "test/fixtures/provider.ts"), "--provider", "companion-test", "--model", "demo", "--thinking", "off"], cwd=folder, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    transcript = ""
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    def read_until(fragment, timeout=15):
        global transcript
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    data = decoder.decode(os.read(master, 65536))
                except OSError:
                    break
                transcript += data
                if "\x1b[c" in data: os.write(master, b"\x1b[?1;2c")
                if fragment in ANSI.sub("", transcript): return
            if process.poll() is not None: break
        raise AssertionError(f"Missing {fragment!r}; output tail:\n{ANSI.sub('', transcript)[-5000:]}")
    def send(value): os.write(master, value.encode("utf-8"))
    def down(count):
        for _ in range(count):
            send("\x1b[B")
            time.sleep(.08)
        send("\r")
    try:
        read_until("好奇心陪伴")
        send("请检查缓存逻辑\r")
        read_until("缓存失效：先判断，再动手")
        # Native Kitty key form for Ctrl+Alt+J, supported by pi's key matcher.
        send("\x1b[106;7u")
        read_until("1–4 快答")
        send("b\r")
        read_until("当前场景建议（不设唯一正确答案）")
        read_until("需满足额外条件：B · 合并重建请求")
        send("t")
        read_until("独立追问 · 返回后继续回答")
        send("为什么选择 B？\r")
        read_until("回答中，可返回主任务")
        send("\x1b[27u")
        time.sleep(.15)
        send("\x1b[27u")
        read_until("新回复")
        send("保留主任务草稿")
        send("\x1b[106;7u")
        read_until("h 历史")
        send("t")
        read_until("选择 B 能减少同一个缓存键的重复重建")
        send("\x13")
        read_until("收藏内容")
        send("\r")
        read_until("已收藏")
        saved = list(Path(folder, "favorites").glob("*.md"))
        assert len(saved) == 1 and "为什么选择 B" in saved[0].read_text()
        time.sleep(.3)
        send("\x1b[27u")
        time.sleep(.15)
        send("\x1b[27u")
        read_until("主任务完成：这是离线模型验证", timeout=15)
        send("\x15")
        send("/companion off\r")
        time.sleep(.3)
        send("/companion on\r")
        time.sleep(.3)
        if process.poll() is not None: raise AssertionError("pi exited during power toggling")
        transcript = ""
        send("/companion settings\r")
        read_until("修改应用到当前会话")
        send("\r")
        read_until("之后的修改保存到哪里")
        down(2)
        read_until("修改应用到所有项目的默认值")
        down(3)
        read_until("摘要（最多 4 行） ✓ 当前")
        down(2)
        read_until("已应用到所有项目的默认值")
        assert json.loads(Path(folder, "companion.json").read_text())["layout"] == "overlay"
        time.sleep(.3)
        send("\x1b[27u")
        time.sleep(.2)
        transcript = ""
        send("/companion settings\r")
        read_until("修改应用到所有项目的默认值")
        time.sleep(.2)
        down(3)
        read_until("完整卡片 · 右侧浮层（可能遮挡输出） ✓ 当前")
        send("\x1b[27u")
        time.sleep(.15)
        send("\x1b[27u")
        time.sleep(.15)
        send("/companion next\r")
        time.sleep(.8)
        transcript = ""
        send("/companion history\r")
        read_until("最近 20 张")
        read_until("第 2 张")
        send("\x1b[B\r")
        read_until("你选了 B")
        read_until("d 展开详解")
        send("t")
        read_until("选择 B 能减少同一个缓存键的重复重建")
        send("\x1b[27u")
        time.sleep(.2)
        transcript = ""
        send("f")
        read_until("这张卡片怎么样")
        down(3)
        read_until("哪里没懂")
        down(1)
        read_until("输入没看懂的词或一句话")
        send("重建\r")
        read_until("重建就是重新取数据并把它存回缓存")
        print("PASS: real pi summary, quiz, background reply after dismissal, preserved history/chat, favorite, main completion, power toggles, scoped layout persistence, current-option readback and targeted clarification.")
    finally:
        (ROOT / "artifacts").mkdir(exist_ok=True)
        (ROOT / "artifacts/smoke-transcript.txt").write_text(ANSI.sub("", transcript))
        process.terminate()
        try: process.wait(timeout=3)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        os.close(master)
