"""Capture a verified, visible application viewport, never the whole desktop.

Read-only inventory: python capture.py --list
Record: python capture.py --hwnd 68310 --expect-title 'МОДУС' \
  --crop 0,130,1280,720 --seconds 45 --output clip01.mp4
Add --background to start a hidden process and return immediately.
Clean stop: python capture.py --stop --output clip01.mp4
Crop coordinates are physical pixels relative to the window CLIENT area.
Caller must inspect a screenshot first, exclude tabs/address bar/private content,
and keep this app visible throughout capture. No clicks/window changes are made.
Loss of foreground, window motion or title mismatch aborts recording. The output
is then renamed .rejected.mp4 and must not be used without manual inspection.
"""
import argparse
import ctypes
from ctypes import wintypes as W
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')
U = ctypes.windll.user32
U.SetProcessDPIAware()
U.GetForegroundWindow.restype = W.HWND
U.GetWindowTextLengthW.argtypes = [W.HWND]
U.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
U.GetClientRect.argtypes = [W.HWND, ctypes.POINTER(W.RECT)]
U.ClientToScreen.argtypes = [W.HWND, ctypes.POINTER(W.POINT)]
U.IsWindowVisible.argtypes = [W.HWND]
U.IsIconic.argtypes = [W.HWND]


def info(hwnd):
    buf = ctypes.create_unicode_buffer(U.GetWindowTextLengthW(hwnd) + 1)
    U.GetWindowTextW(hwnd, buf, len(buf))
    r, p = W.RECT(), W.POINT()
    if not U.GetClientRect(hwnd, ctypes.byref(r)):
        raise ValueError('Invalid window handle')
    U.ClientToScreen(hwnd, ctypes.byref(p))
    return dict(hwnd=hwnd, title=buf.value, x=p.x, y=p.y,
                width=r.right, height=r.bottom, foreground=U.GetForegroundWindow() == hwnd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--hwnd', type=int)
    parser.add_argument('--expect-title')
    parser.add_argument('--crop', help='client x,y,width,height')
    parser.add_argument('--seconds', type=float, default=60)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--background', action='store_true', help='start hidden recorder and return its PID')
    parser.add_argument('--stop', action='store_true', help='request clean stop for --output')
    a = parser.parse_args()
    if a.stop:
        if not a.output:
            parser.error('--stop requires --output')
        a.output.resolve().with_suffix('.stop').touch()
        return
    if a.list:
        callback_type = ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
        def visit(hwnd, _):
            if U.IsWindowVisible(hwnd) and not U.IsIconic(hwnd) and U.GetWindowTextLengthW(hwnd):
                print(json.dumps(info(hwnd), ensure_ascii=False))
            return True
        U.EnumWindows(callback_type(visit), 0)
        return
    if not all((a.hwnd, a.expect_title, a.crop, a.output)):
        parser.error('record requires --hwnd --expect-title --crop --output')
    if not 0 < a.seconds <= 900:
        parser.error('--seconds must be between 0 and 900')
    initial = info(a.hwnd)
    def verified():
        current = info(a.hwnd)
        if a.expect_title.casefold() not in current['title'].casefold():
            raise RuntimeError('Window title no longer matches intended app')
        if not current['foreground'] or U.IsIconic(a.hwnd):
            raise RuntimeError('Intended app is not the visible foreground window')
        if any(current[k] != initial[k] for k in ('x', 'y', 'width', 'height')):
            raise RuntimeError('Window moved or resized; capture crop is no longer valid')
    verified()
    x, y, width, height = map(int, a.crop.split(','))
    if min(x, y) < 0 or min(width, height) <= 0 or width % 2 or height % 2:
        raise ValueError('Crop must be positive, even-sized and inside client area')
    if x + width > initial['width'] or y + height > initial['height']:
        raise ValueError('Crop exceeds the verified client area')
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg is not installed')
    a.output = a.output.resolve()
    if a.output.exists():
        raise FileExistsError(a.output)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    stop_marker = a.output.with_suffix('.stop')
    stop_marker.unlink(missing_ok=True)
    if a.background:
        child_args = [item for item in sys.argv[1:] if item != '--background']
        with a.output.with_suffix('.recorder.log').open('wb') as runner_log:
            proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), *child_args],
                                    stdout=runner_log, stderr=runner_log,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
        a.output.with_suffix('.recorder.pid').write_text(str(proc.pid), encoding='ascii')
        print(json.dumps(dict(pid=proc.pid, output=str(a.output))))
        return
    args = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-n', '-f', 'gdigrab',
            '-framerate', '25', '-draw_mouse', '1', '-offset_x', str(initial['x']+x),
            '-offset_y', str(initial['y']+y), '-video_size', f'{width}x{height}',
            '-i', 'desktop', '-t', str(a.seconds), '-an', '-c:v', 'libx264',
            '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart', str(a.output)]
    with a.output.with_suffix('.capture.log').open('wb') as log:
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=log, stderr=log)
        try:
            while proc.poll() is None:
                if stop_marker.exists():
                    proc.communicate(b'q', timeout=10)
                    break
                verified()
                time.sleep(0.1)
            if proc.returncode:
                raise RuntimeError(f'ffmpeg failed with {proc.returncode}; inspect capture log')
        except BaseException:
            if proc.poll() is None:
                try:
                    proc.communicate(b'q', timeout=8)
                except (subprocess.TimeoutExpired, OSError):
                    proc.kill()
                    proc.wait()
            if a.output.exists():
                a.output.rename(a.output.with_name(a.output.stem + '.rejected.mp4'))
            raise
    a.output.with_suffix('.capture.json').write_text(json.dumps(
        dict(window=initial, crop=[x,y,width,height], seconds=a.seconds),
        ensure_ascii=False, indent=2), encoding='utf-8')
    print(a.output)


if __name__ == '__main__':
    main()
