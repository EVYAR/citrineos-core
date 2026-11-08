#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
# SPDX-License-Identifier: Apache-2.0
"""Ephemeral hosted-job resource guard. No application, Docker or subprocess starts on import."""
import argparse
from enum import Enum
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

MIB = 1048576
RESERVE = 1536
LABEL = 'io.citrineos.hosted-ci-job'
PROFILES = {
    'install': (1536, 2304, 0, 900),
    'build': (1536, 2304, 0, 1200),
    'runtime': (1536, 3072, 1024, 1800),
    'typecheck': (1536, 2304, 0, 900),
    'lint': (1536, 2304, 0, 1200),
    'stdlib': (128, 640, 0, 300),
    'operator': (4096, 4608, 0, 1500),
    'e2e': (1536, 2304, 7168, 3600),
}


class InvariantCode(str, Enum):
    DOCKER_RESPONSE = 'docker-response-invalid'
    MEMORY_STATS = 'container-memory-statistics-unavailable'
    OWNERSHIP = 'unexpected-container-ownership'
    LIVE_LIMITS = 'live-container-budget-mismatch'


class GuardInvariantError(RuntimeError):
    def __init__(self, code: InvariantCode, http_status: int | None = None):
        super().__init__(code.value)
        self.code = code
        self.http_status = http_status


def hosted(environment):
    if not (environment.get('GITHUB_ACTIONS') == 'true' and environment.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and environment.get('RUNNER_OS') == 'Linux'):
        raise RuntimeError('This workload requires a GitHub-hosted Linux runner; self-hosted execution refused')


def available_mib(meminfo=Path('/proc/meminfo'), cgroup=Path('/sys/fs/cgroup')):
    fields = dict(line.split(':', 1) for line in meminfo.read_text().splitlines())
    available = int(fields['MemAvailable'].split()[0]) // 1024
    maximum = cgroup / 'memory.max'
    if maximum.exists() and maximum.read_text().strip() != 'max':
        available = min(available, (int(maximum.read_text()) - int((cgroup / 'memory.current').read_text())) // MIB)
    return available


def group_rss(pid, proc=Path('/proc')):
    rss = 0
    for path in proc.glob('[0-9]*/stat'):
        try:
            text = path.read_text()
            fields = text[text.rfind(') ') + 2:].split()
            if int(fields[2]) == pid or int(fields[3]) == pid:
                rss += int(fields[21]) * os.sysconf('SC_PAGE_SIZE')
        except (OSError, ValueError, IndexError):
            continue
    return rss


def container_memory(stats):
    memory = stats.get('memory_stats', {})
    detail = memory.get('stats', {})
    if 'anon' in detail:
        return int(detail['anon'])
    if 'rss' in detail:
        return int(detail['rss'])
    if 'usage' in memory:
        return int(memory['usage'])
    raise GuardInvariantError(InvariantCode.MEMORY_STATS)


def bounded_create(options, nonce, cap):
    if cap <= 0:
        raise RuntimeError('Container creation is not allowed in this stage')
    options = dict(options)
    options['Labels'] = {**options.get('Labels', {}), LABEL: nonce}
    host = dict(options.get('HostConfig') or {})
    requested = host.get('Memory', 0)
    if not isinstance(requested, int) or requested < 0:
        raise RuntimeError('Invalid container memory request')
    host['Memory'] = min(requested or cap, cap)
    host['MemorySwap'] = host['Memory']
    host['NanoCpus'] = min(host.get('NanoCpus') or 1000000000, 1000000000)
    host['PidsLimit'] = min(max(host.get('PidsLimit') or 256, 1), 256)
    options['HostConfig'] = host
    return options


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=3)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class Docker:
    def __init__(self, path='/var/run/docker.sock'):
        self.path = path

    def request(self, method, path):
        client = UnixHTTP(self.path)
        try:
            client.request(method, path)
            response = client.getresponse()
            body = response.read(2097153)
            if response.status not in (200, 204, 404) or len(body) > 2097152:
                raise GuardInvariantError(InvariantCode.DOCKER_RESPONSE, response.status)
            return json.loads(body) if body and response.status != 404 else None
        finally:
            client.close()

    def containers(self):
        return self.request('GET', '/containers/json?all=1')


def owned_container(container, state):
    return (container['Id'] not in state['baselineContainers'] and
            container.get('Labels', {}).get(LABEL) == state['nonce'])


class BudgetProxy(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, path, docker, nonce, cap):
        self.docker, self.nonce, self.cap = docker, nonce, cap
        self.sockets = set()
        self.failure = None
        super().__init__(str(path), ProxyHandler)
        os.chmod(path, 0o600)

    def close_owned(self):
        for sock in list(self.sockets):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        self.shutdown()
        self.server_close()


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        upstream = None
        reader = None
        self.server.sockets.add(client)
        try:
            client.settimeout(10)
            reader = client.makefile('rb')
            request = reader.readline(8193)
            if len(request) > 8192:
                raise RuntimeError('Docker request line too long')
            method, target, version = request.decode('ascii').strip().split(' ')
            headers = {}
            size = 0
            while True:
                line = reader.readline(65537)
                size += len(line)
                if size > 65536 or not line:
                    raise RuntimeError('Docker headers exceed limit')
                if line == b'\r\n':
                    break
                key, value = line.decode('latin1').split(':', 1)
                headers[key.lower()] = value.strip()
            if headers.get('expect', '').lower() == '100-continue':
                client.sendall(b'HTTP/1.1 100 Continue\r\n\r\n')
                headers.pop('expect')
            create = method == 'POST' and re.fullmatch(r'/(?:v[0-9.]+/)?containers/create', urlsplit(target).path)
            body = b''
            if create:
                if headers.get('transfer-encoding', '').lower() == 'chunked':
                    while True:
                        count = int(reader.readline(128).split(b';', 1)[0], 16)
                        if count == 0:
                            if reader.readline(128) != b'\r\n':
                                raise RuntimeError('Docker trailers unsupported')
                            break
                        if len(body) + count > 1048576:
                            raise RuntimeError('Docker create body exceeds limit')
                        chunk = reader.read(count)
                        if len(chunk) != count or reader.read(2) != b'\r\n':
                            raise RuntimeError('Invalid Docker create chunk')
                        body += chunk
                else:
                    count = int(headers.get('content-length', 0))
                    if not 0 < count <= 1048576:
                        raise RuntimeError('Invalid Docker create body length')
                    body = reader.read(count)
                    if len(body) != count:
                        raise RuntimeError('Truncated Docker create body')
                body = json.dumps(bounded_create(json.loads(body), self.server.nonce, self.server.cap)).encode()
                headers.pop('transfer-encoding', None)
                headers['content-length'] = str(len(body))
            upgrade = headers.get('connection', '').lower() == 'upgrade'
            if not upgrade:
                headers['connection'] = 'close'
            upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.server.sockets.add(upstream)
            upstream.connect(self.server.docker.path)
            upstream.sendall(request + b''.join((key + ': ' + value + '\r\n').encode('latin1') for key, value in headers.items()) + b'\r\n' + body)
            # Any buffered non-create body must be sent before transparent streaming/upgrade.
            if not create and headers.get('content-length'):
                remaining = int(headers['content-length'])
                while remaining:
                    chunk = reader.read(min(remaining, 65536))
                    if not chunk:
                        raise RuntimeError('Truncated Docker request')
                    upstream.sendall(chunk)
                    remaining -= len(chunk)
            elif not create and headers.get('transfer-encoding', '').lower() == 'chunked':
                while True:
                    line = reader.readline(128)
                    count = int(line.split(b';', 1)[0], 16)
                    upstream.sendall(line)
                    remaining = count
                    while remaining:
                        chunk = reader.read(min(remaining, 65536))
                        if not chunk:
                            raise RuntimeError('Truncated Docker upload')
                        upstream.sendall(chunk)
                        remaining -= len(chunk)
                    if count:
                        if reader.read(2) != b'\r\n':
                            raise RuntimeError('Invalid Docker upload delimiter')
                        upstream.sendall(b'\r\n')
                    else:
                        trailer_size = 0
                        while True:
                            trailer = reader.readline(8193)
                            trailer_size += len(trailer)
                            if not trailer or trailer_size > 8192:
                                raise RuntimeError('Docker trailers exceed bound')
                            upstream.sendall(trailer)
                            if trailer == b'\r\n':
                                break
                        break
            client.settimeout(None)
            while True:
                readable, _, _ = select.select([client, upstream], [], [], 1)
                for source in readable:
                    chunk = source.recv(65536)
                    if not chunk:
                        return
                    (upstream if source is client else client).sendall(chunk)
        except OSError:
            return
        except (ValueError, RuntimeError, KeyError):
            self.server.failure = 'docker-budget-proxy-failed'
            try:
                client.sendall(b'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass
        finally:
            if reader:
                reader.close()
            for sock in (client, upstream):
                if sock:
                    self.server.sockets.discard(sock)
                    sock.close()


def record(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def init(root, docker_enabled):
    hosted(os.environ)
    directory = root / 'reports/ci'
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / 'job.json'
    if path.exists():
        raise RuntimeError('Job ownership state already exists')
    git = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, capture_output=True, text=True, timeout=5)
    if git.returncode or not re.fullmatch('[a-f0-9]{40}', git.stdout.strip()):
        raise RuntimeError('Source identity unavailable')
    record(path, {'nonce': os.urandom(16).hex(), 'sourceSha': git.stdout.strip(), 'docker': docker_enabled,
                  'baselineContainers': [c['Id'] for c in Docker().containers()] if docker_enabled else []})


def cleanup(root):
    hosted(os.environ)
    path = root / 'reports/ci/job.json'
    if not path.exists():
        return
    state = json.loads(path.read_text())
    if state['docker']:
        docker = Docker()
        for container in docker.containers():
            if owned_container(container, state):
                docker.request('DELETE', '/containers/' + container['Id'] + '?force=1&v=1')


def run(root, stage, profile, command):
    hosted(os.environ)
    if not re.fullmatch('[a-z0-9-]+', stage):
        raise RuntimeError('Invalid stage')
    state = json.loads((root / 'reports/ci/job.json').read_text())
    heap, rss_limit, docker_limit, timeout = PROFILES[profile]
    directory = root / 'reports/ci'
    target = directory / (stage + '.json')
    if target.exists():
        raise RuntimeError('Stage evidence already exists; automatic retry refused')
    result = {'sourceSha': state['sourceSha'], 'stage': stage, 'profile': profile, 'heapMiB': heap,
              'rssBudgetMiB': rss_limit, 'dockerRssBudgetMiB': docker_limit, 'reserveMiB': RESERVE,
              'requiredMiB': rss_limit + docker_limit + RESERVE, 'nativeExitCode': None}
    available = available_mib()
    result['initialAvailableMiB'] = available
    if available < result['requiredMiB']:
        result.update(status='refused-before-spawn', exitCode=75)
        record(target, result)
        return 75
    lock = os.open(directory / '.lock', os.O_WRONLY | os.O_CREAT, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    proxy = None
    proc = None
    started = time.monotonic()
    maximum = docker_maximum = 0
    minimum = available
    stopped = False
    guard_phase = 'setup'
    container_id = None
    def stop_owned(*_):
        nonlocal stopped
        stopped = True
        if proc:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                return
    previous = {sig: signal.signal(sig, stop_owned) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        environment = {key: os.environ[key] for key in ('HOME', 'PATH', 'PNPM_HOME', 'COREPACK_HOME') if key in os.environ}
        environment.update(CI='true', TZ='UTC', LANG='C.UTF-8', NEXT_TELEMETRY_DISABLED='1',
                           NODE_OPTIONS='--max-old-space-size=' + str(heap), RAYON_NUM_THREADS='1', TOKIO_WORKER_THREADS='1')
        proxy_path = directory / 'docker.sock'
        if proxy_path.exists():
            proxy_path.unlink()
        if state['docker']:
            proxy = BudgetProxy(proxy_path, Docker(), state['nonce'], (4096 if profile == 'e2e' else 512) * MIB if docker_limit else 0)
            threading.Thread(target=proxy.serve_forever, daemon=True).start()
        environment['DOCKER_HOST'] = 'unix://' + str(proxy_path)
        environment['COMPOSE_PROJECT_NAME'] = 'core-ci-' + state['nonce'][:16]
        with (directory / (stage + '.log')).open('x') as log:
            os.chmod(log.name, 0o600)
            proc = subprocess.Popen(command, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            result['ownedProcessGroup'] = proc.pid
            while proc.poll() is None:
                guard_phase, container_id = 'host-and-process-memory', None
                available = available_mib()
                rss = group_rss(proc.pid) / MIB
                docker_rss = 0
                if state['docker']:
                    docker = Docker()
                    guard_phase = 'container-list'
                    for container in docker.containers():
                        if container['Id'] in state['baselineContainers']:
                            continue
                        guard_phase, container_id = 'container-ownership', container['Id']
                        if not owned_container(container, state):
                            raise GuardInvariantError(InvariantCode.OWNERSHIP)
                        guard_phase = 'container-inspect'
                        info = docker.request('GET', '/containers/' + container['Id'] + '/json')
                        if info is None:
                            continue
                        guard_phase = 'container-limits'
                        host = info['HostConfig']
                        cap = (4096 if profile == 'e2e' else 512) * MIB
                        if not (0 < host['Memory'] <= cap and host['MemorySwap'] == host['Memory']):
                            raise GuardInvariantError(InvariantCode.LIVE_LIMITS)
                        if info['State']['Running']:
                            guard_phase = 'container-stats-request'
                            stats = docker.request('GET', '/containers/' + container['Id'] + '/stats?stream=false&one-shot=true')
                            if stats is not None:
                                guard_phase = 'container-stats-memory'
                                docker_rss += container_memory(stats) / MIB
                        if info['State']['OOMKilled']:
                            result['terminationReason'] = 'owned-container-oom'
                maximum, docker_maximum, minimum = max(maximum, rss), max(docker_maximum, docker_rss), min(minimum, available)
                reason = ('host-or-cgroup-reserve' if available < RESERVE + 128 else
                          'child-group-rss' if rss > rss_limit else
                          'container-rss' if docker_rss > docker_limit else
                          'stage-timeout' if time.monotonic() - started > timeout else
                          'interrupted' if stopped else proxy.failure if proxy and proxy.failure else result.get('terminationReason'))
                if reason:
                    result['terminationReason'] = reason
                    stop_owned()
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                    break
                time.sleep(0.25)
            result['nativeExitCode'] = proc.wait()
            result['exitCode'] = 75 if result.get('terminationReason') else (result['nativeExitCode'] if result['nativeExitCode'] >= 0 else 1)
            result['status'] = 'guard-terminated' if result.get('terminationReason') else 'completed'
    except BaseException as error:
        result.update(status='guard-failed', exitCode=1, exceptionType=type(error).__name__, guardPhase=guard_phase)
        if container_id is not None:
            result['guardContainerId'] = container_id
        if isinstance(error, GuardInvariantError):
            result['invariantCode'] = error.code.value
            if error.http_status is not None:
                result['dockerHttpStatus'] = error.http_status
        if proc and proc.poll() is None:
            stop_owned()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        if proc:
            result['nativeExitCode'] = proc.returncode
    finally:
        if proc:
            stop_owned()
            if group_rss(proc.pid):
                time.sleep(0.3)
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if proxy:
            proxy.close_owned()
        if state['docker'] and profile in ('runtime', 'e2e'):
            try:
                cleanup(root)
            except (RuntimeError, OSError, ValueError):
                result.update(status='cleanup-failed', exitCode=1)
        if (directory / 'docker.sock').exists():
            (directory / 'docker.sock').unlink()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        os.close(lock)
        result.update(seconds=round(time.monotonic() - started, 2), maxOwnedRssMiB=round(maximum, 2),
                      maxOwnedContainerRssMiB=round(docker_maximum, 2), minAvailableMiB=minimum)
        record(target, result)
    print(json.dumps(result))
    return result['exitCode']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['init', 'run', 'cleanup'])
    parser.add_argument('--docker', action='store_true')
    parser.add_argument('--stage')
    parser.add_argument('--profile', choices=PROFILES)
    arguments = sys.argv[1:]
    split = arguments.index('--') if '--' in arguments else len(arguments)
    args = parser.parse_args(arguments[:split])
    command = arguments[split+1:]
    root = Path(__file__).resolve().parents[2]
    if args.action == 'init':
        init(root, args.docker)
        return 0
    if args.action == 'cleanup':
        cleanup(root)
        return 0
    if not args.stage or not args.profile or not command:
        parser.error('run requires --stage, --profile and explicit -- command')
    return run(root, args.stage, args.profile, command)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print(json.dumps({'status': 'REFUSED', 'exceptionType': type(error).__name__}), flush=True)
        raise SystemExit(1)
