# SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
# SPDX-License-Identifier: Apache-2.0
import copy
import importlib.util
import json
import os
import sys
from unittest.mock import patch
from pathlib import Path
import socket
import socketserver
import tempfile
import threading
import unittest

SPEC = importlib.util.spec_from_file_location('guard', Path(__file__).resolve().parents[1] / 'bounded.py')
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)


class GuardFixtures(unittest.TestCase):
    def test_hosted_only(self):
        GUARD.hosted({'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux'})
        for value in ['self-hosted', '', None]:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                GUARD.hosted({'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': value, 'RUNNER_OS': 'Linux'})

    def test_host_and_cgroup_minimum(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'meminfo').write_text('MemAvailable: 8388608 kB\n')
            (root / 'memory.max').write_text(str(4096 * GUARD.MIB))
            (root / 'memory.current').write_text(str(1024 * GUARD.MIB))
            self.assertEqual(GUARD.available_mib(root / 'meminfo', root), 3072)
            (root / 'memory.max').write_text('max')
            self.assertEqual(GUARD.available_mib(root / 'meminfo', root), 8192)

    def test_process_group_rss_excludes_unrelated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for pid, group, pages in [(11, 11, 5), (12, 11, 7), (13, 13, 99)]:
                path = root / str(pid)
                path.mkdir()
                fields = ['S', '1', str(group), str(group)] + ['0'] * 17 + [str(pages)]
                (path / 'stat').write_text(f'{pid} (name with ) spaces) ' + ' '.join(fields))
            self.assertEqual(GUARD.group_rss(11, root), 12 * GUARD.os.sysconf('SC_PAGE_SIZE'))

    def test_cgroup_rss_and_conservative_fallback(self):
        self.assertEqual(GUARD.container_memory({'memory_stats': {'stats': {'anon': 123}, 'usage': 999}}), 123)
        self.assertEqual(GUARD.container_memory({'memory_stats': {'stats': {'rss': 234}}}), 234)
        self.assertEqual(GUARD.container_memory({'memory_stats': {'usage': 345}}), 345)
        with self.assertRaises(RuntimeError):
            GUARD.container_memory({})

    def test_create_caps_are_atomic_and_preserve_lower_requested_limit(self):
        original = {'Image': 'postgres:16-alpine', 'Labels': {'org.testcontainers': 'true'},
                    'HostConfig': {'Memory': 256 * GUARD.MIB, 'MemorySwap': -1}}
        prior = copy.deepcopy(original)
        changed = GUARD.bounded_create(original, 'nonce', 512 * GUARD.MIB)
        self.assertEqual(original, prior)
        self.assertEqual(changed['HostConfig']['Memory'], 256 * GUARD.MIB)
        self.assertEqual(changed['HostConfig']['MemorySwap'], 256 * GUARD.MIB)
        self.assertEqual(changed['Labels'][GUARD.LABEL], 'nonce')
        self.assertEqual(changed['Labels']['org.testcontainers'], 'true')
        with self.assertRaises(RuntimeError):
            GUARD.bounded_create(original, 'nonce', 0)

    def test_cleanup_ownership_requires_both_new_identity_and_job_label(self):
        state = {'nonce': 'ours', 'baselineContainers': ['old']}
        self.assertFalse(GUARD.owned_container({'Id': 'old', 'Labels': {GUARD.LABEL: 'ours'}}, state))
        self.assertFalse(GUARD.owned_container({'Id': 'new', 'Labels': {GUARD.LABEL: 'other'}}, state))
        self.assertTrue(GUARD.owned_container({'Id': 'new', 'Labels': {GUARD.LABEL: 'ours'}}, state))

    def test_native_exit_and_sanitized_child_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reports = root / 'reports/ci'
            reports.mkdir(parents=True)
            (reports / 'job.json').write_text(json.dumps({'nonce': 'fixture', 'sourceSha': 'a' * 40, 'docker': False, 'baselineContainers': []}))
            with patch.object(GUARD, 'hosted'), patch.object(GUARD, 'available_mib', return_value=10000), patch.dict(os.environ, {'DATABASE_URL': 'must-not-inherit'}):
                code = GUARD.run(root, 'native', 'stdlib', [sys.executable, '-c', "import os,sys;assert 'DATABASE_URL' not in os.environ;sys.exit(7)"])
            result = json.loads((reports / 'native.json').read_text())
            self.assertEqual(code, 7)
            self.assertEqual(result['nativeExitCode'], 7)
            self.assertEqual(result['status'], 'completed')

    def test_resource_refusal_does_not_spawn_or_claim_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reports = root / 'reports/ci'
            reports.mkdir(parents=True)
            (reports / 'job.json').write_text(json.dumps({'nonce': 'fixture', 'sourceSha': 'a' * 40, 'docker': False, 'baselineContainers': []}))
            with patch.object(GUARD, 'hosted'), patch.object(GUARD, 'available_mib', return_value=1535), patch.object(GUARD.subprocess, 'Popen') as spawn:
                self.assertEqual(GUARD.run(root, 'refused', 'stdlib', ['never-run']), 75)
                spawn.assert_not_called()
            self.assertIsNone(json.loads((reports / 'refused.json').read_text())['nativeExitCode'])

    def test_docker_create_transport_gets_enforced_limits(self):
        for chunked in [False, True]:
            with self.subTest(chunked=chunked), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                received = []
                class Backend(socketserver.StreamRequestHandler):
                    def handle(self):
                        self.rfile.readline()
                        headers = {}
                        while True:
                            line = self.rfile.readline()
                            if line == b'\r\n':
                                break
                            key, value = line.decode().split(':', 1)
                            headers[key.lower()] = value.strip()
                        received.append(json.loads(self.rfile.read(int(headers['content-length']))))
                        self.wfile.write(b'HTTP/1.1 201 Created\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"Id":"ok"}')
                backend = socketserver.ThreadingUnixStreamServer(str(root / 'real.sock'), Backend)
                backend.daemon_threads = True
                threading.Thread(target=backend.serve_forever, daemon=True).start()
                proxy = GUARD.BudgetProxy(root / 'proxy.sock', GUARD.Docker(str(root / 'real.sock')), 'owned', 512 * GUARD.MIB)
                threading.Thread(target=proxy.serve_forever, daemon=True).start()
                try:
                    body = b'{"Image":"postgres:16-alpine"}'
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                        client.settimeout(3)
                        client.connect(str(root / 'proxy.sock'))
                        framing = b'Transfer-Encoding: chunked\r\n' if chunked else f'Content-Length: {len(body)}\r\n'.encode()
                        payload = f'{len(body):x}\r\n'.encode() + body + b'\r\n0\r\n\r\n' if chunked else body
                        client.sendall(b'POST /v1.41/containers/create HTTP/1.1\r\nHost: localhost\r\n' + framing + b'\r\n' + payload)
                        response = b''
                        while True:
                            piece = client.recv(4096)
                            if not piece:
                                break
                            response += piece
                    self.assertIn(b'201 Created', response)
                    self.assertEqual(received[0]['HostConfig']['Memory'], 512 * GUARD.MIB)
                    self.assertEqual(received[0]['Labels'][GUARD.LABEL], 'owned')
                    self.assertIsNone(proxy.failure)
                finally:
                    proxy.close_owned()
                    backend.shutdown()
                    backend.server_close()


if __name__ == '__main__':
    unittest.main()
