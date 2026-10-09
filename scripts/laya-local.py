#!/usr/bin/env python3
"""Install and manage the official Laya server in an isolated local environment."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'runs' / 'laya'
PYTHON = DATA / 'venv' / 'bin' / 'python'
PID = DATA / 'server.pid'
LOG = DATA / 'server.log'
VERSION = '0.4.1'


def running():
    if not PID.exists():
        return None
    try:
        pid = int(PID.read_text().strip())
        command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True).strip()
        return pid if str(PYTHON) in command and 'laya.serve' in command else None
    except (ValueError, subprocess.CalledProcessError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['setup', 'start', 'stop', 'status'])
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    if args.action == 'setup':
        if not PYTHON.exists():
            subprocess.run([sys.executable, '-m', 'venv', str(DATA / 'venv')], check=True)
        subprocess.run([str(PYTHON), '-m', 'pip', 'install', f'laya[serve]=={VERSION}'], check=True)
        return
    pid = running()
    if args.action == 'stop':
        if pid:
            os.kill(pid, signal.SIGTERM)
            print(f'Stopping Laya PID {pid}')
            deadline = time.monotonic() + 10
            while running() and time.monotonic() < deadline:
                time.sleep(0.1)
            if running():
                print('Laya is still stopping; retry status before restarting')
                sys.exit(1)
        else:
            print('Laya is not running')
        PID.unlink(missing_ok=True)
        return
    if args.action == 'start':
        if pid:
            print(f'Laya is already running (PID {pid})')
            return
        if not PYTHON.exists():
            parser.error('Run python3 scripts/laya-local.py setup first')
        env = os.environ.copy()
        env.update(LAYA_HOST='127.0.0.1', LAYA_PORT='8000', LAYA_MODELS='multilingual',
                   LAYA_MAX_LOADED='1', LAYA_PRELOAD='1', LAYA_JEV_STRICT='1', LAYA_REVISION='reviewed',
                   HF_HUB_CACHE=str(DATA / 'cache'), LAYA_THREADS=env.get('LAYA_THREADS', '4'))
        # Never inherit a credential into the unauthenticated loopback service.
        env.pop('LAYA_API_KEY', None)
        with LOG.open('ab') as output:
            process = subprocess.Popen([str(PYTHON), '-m', 'laya.serve'], cwd=ROOT,
                                       env=env, stdin=subprocess.DEVNULL,
                                       stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        PID.write_text(str(process.pid) + '\n')
        print(f'Starting Laya PID {process.pid}; log: {LOG}')
        print('Endpoint: http://127.0.0.1:8000/v1/systemone (first start downloads the checkpoint)')
        return
    print(f'Laya PID {pid}' if pid else 'Laya is not running')
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3) as response:
            print(json.dumps(json.load(response), indent=2))
    except (OSError, ValueError) as error:
        print(f'Health probe unavailable: {error}')
        sys.exit(1)


if __name__ == '__main__':
    main()
