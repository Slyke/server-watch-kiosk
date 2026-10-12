#!/usr/bin/env python3
"""Lock after human inactivity, then cycle the panel without unlocking it."""
import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path


def run(*args):
    return subprocess.run(args, check=True, timeout=10, text=True,
                          capture_output=True).stdout.strip()


def lock_status():
    status = json.loads(run('omarchy-shell', 'lock', 'status'))
    if 'kioskIdle' not in status or not status.get('passwordPam'):
        raise RuntimeError('Kiosk lock plugin / password PAM is not ready')
    return status


class DisplayCycle:
    """Pure timing policy: only a confirmed secure lock may start a rest."""

    def __init__(self, on_seconds, off_seconds):
        self.on_seconds = on_seconds
        self.off_seconds = off_seconds
        self.phase = 'unlocked'
        self.deadline = 0
        self.wake_at = 0

    def step(self, status, now):
        if not status['locked']:
            old_phase = self.phase
            self.phase = 'unlocked'
            if old_phase != 'unlocked':
                return 'on'
            return 'lock' if status['kioskIdle'] else None
        if not status['secure']:
            return None
        if self.phase == 'unlocked':
            self.phase = 'resting'
            self.deadline = now + self.off_seconds
            self.wake_at = status.get('lastWakeAt', 0)
            return 'off'
        if self.phase == 'resting':
            if now >= self.deadline or status.get('lastWakeAt', 0) > self.wake_at:
                self.phase = 'on'
                self.deadline = now + self.on_seconds
                return 'on'
        elif now >= self.deadline and not status.get('authenticating', False):
            self.phase = 'resting'
            self.deadline = now + self.off_seconds
            self.wake_at = status.get('lastWakeAt', 0)
            return 'off'
        return None


def main():
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    on_seconds = int(os.environ.get('KIOSK_ON_SECONDS', '1800'))
    off_seconds = int(os.environ.get('KIOSK_OFF_SECONDS', '300'))
    if not (1 <= on_seconds <= 86400 and 1 <= off_seconds <= 86400):
        raise ValueError('Display intervals must be between 1 and 86400 seconds')
    state = Path.home() / '.local/state/service-board/display.json'
    state.parent.mkdir(parents=True, exist_ok=True)
    cycle = DisplayCycle(on_seconds, off_seconds)

    def panel(enabled):
        action = 'enable' if enabled else 'disable'
        run('hyprctl', 'dispatch', 'hl.dsp.dpms({ action = "' + action + '" })')
        state.write_text(json.dumps({
            'display': 'on' if enabled else 'resting', 'since': time.time(),
            'onSeconds': on_seconds, 'offSeconds': off_seconds,
            'lockAfterIdleSeconds': on_seconds, 'phase': cycle.phase,
        }))
        print('Panel ' + ('on' if enabled else 'resting'), flush=True)

    try:
        run('omarchy-toggle-idle', 'stay-awake')
        run('brightnessctl', '-d', 'intel_backlight', 'set', '20%')
        if run('omarchy-shell', 'lock', 'setKioskIdleSeconds', str(on_seconds)) != 'ok':
            raise RuntimeError('Could not configure the native inactivity monitor')
        panel(True)
        print(f'Locking after {on_seconds}s of human inactivity; '
              f'locked panel cycle {on_seconds}s on / {off_seconds}s off', flush=True)
        while not stop.is_set():
            status = lock_status()
            action = cycle.step(status, time.monotonic())
            if action == 'lock':
                if run('omarchy-shell', 'lock', 'lockKiosk') != 'ok':
                    raise RuntimeError('Native session lock request failed')
                # Preserve Omarchy housekeeping, including locking 1Password.
                run('omarchy-system-lock')
                print('Session lock requested; waiting for compositor security', flush=True)
            elif action == 'off':
                panel(False)
            elif action == 'on':
                panel(True)
            # No keys, pointer positions or passwords are collected here.
            stop.wait(2)
    finally:
        panel(True)  # Stopping the service never unlocks the desktop.


if __name__ == '__main__':
    main()
