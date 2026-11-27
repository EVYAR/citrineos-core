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

    def test_docker_http_failure_is_classified_without_response_body(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'backend.sock'
            class Backend(socketserver.StreamRequestHandler):
                def handle(self):
                    self.rfile.readline()
                    while self.rfile.readline() != b'\r\n':
                        pass
                    body = b'private-daemon-message'
                    self.wfile.write(b'HTTP/1.1 500 Internal Server Error\r\nContent-Length: ' +
                                     str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)
            backend = socketserver.ThreadingUnixStreamServer(str(path), Backend)
            threading.Thread(target=backend.serve_forever, daemon=True).start()
            try:
                with self.assertRaises(GUARD.GuardInvariantError) as caught:
                    GUARD.Docker(path).request('GET', '/containers/json?all=1')
                self.assertEqual(caught.exception.code, GUARD.InvariantCode.DOCKER_RESPONSE)
                self.assertEqual(caught.exception.http_status, 500)
                self.assertNotIn('private-daemon-message', str(caught.exception))
            finally:
                backend.shutdown()
                backend.server_close()

    def _stats_transition(self, transition, native_exit=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reports = root / 'reports/ci'
            reports.mkdir(parents=True)
            state = {'nonce': 'fixture', 'sourceSha': 'a' * 40, 'docker': True, 'baselineContainers': []}
            (reports / 'job.json').write_text(json.dumps(state))
            identity = 'b' * 64
            seen = []
            inspections = 0
            finished = '2026-01-01T00:00:00.123456789Z'
            class Backend(socketserver.StreamRequestHandler):
                def handle(self):
                    nonlocal inspections
                    method, target, _ = self.rfile.readline().decode().split()
                    while True:
                        line = self.rfile.readline()
                        if not line or line == b'\r\n':
                            break
                    seen.append((method, target))
                    status = '200 OK'
                    if method == 'DELETE':
                        value = None
                    elif target == '/containers/json?all=1':
                        owner = 'other' if inspections > 1 and transition == 'ownership' else 'fixture'
                        value = [] if inspections > 1 and transition == 'deleted' else [{'Id': identity, 'Labels': {GUARD.LABEL: owner}}]
                    elif target.endswith('/json'):
                        inspections += 1
                        stopped = inspections > 1 and transition not in ('running', 'stats404-running')
                        value = {'Id': identity, 'Config': {'Labels': {GUARD.LABEL: 'fixture'}, 'Env': ['PRIVATE_VALUE=daemon-private-value']},
                                 'HostConfig': {'Memory': 512 * GUARD.MIB, 'MemorySwap': 512 * GUARD.MIB},
                                 'State': {'Running': not stopped, 'Status': 'exited' if stopped else 'running',
                                           'FinishedAt': finished if stopped else '0001-01-01T00:00:00Z',
                                           'Restarting': False, 'Paused': False, 'Dead': False,
                                           'OOMKilled': False, 'ExitCode': 0, 'Error': 'daemon-private-error'}}
                        if inspections > 1:
                            if transition == 'deleted':
                                status, value = '404 Not Found', None
                            elif transition == 'ownership':
                                value['Config']['Labels'][GUARD.LABEL] = 'other'
                            elif transition == 'identity':
                                value['Id'] = 'c' * 64
                            elif transition == 'limits':
                                value['HostConfig']['MemorySwap'] = -1
                            elif transition == 'lower-limits':
                                value['HostConfig']['Memory'] = 256 * GUARD.MIB
                                value['HostConfig']['MemorySwap'] = 256 * GUARD.MIB
                            elif transition == 'unfinished':
                                value['State']['FinishedAt'] = '0001-01-01T00:00:00Z'
                            elif transition == 'restarting':
                                value['State']['Restarting'] = True
                            elif transition == 'oom':
                                value['State']['OOMKilled'] = True
                    else:
                        value = {'memory_stats': {}}
                        if transition.startswith('stats404'):
                            status, value = '404 Not Found', None
                    body = json.dumps(value).encode()
                    self.wfile.write(('HTTP/1.1 ' + status + '\r\nContent-Length: ').encode() + str(len(body)).encode() +
                                     b'\r\nConnection: close\r\n\r\n' + body)
            backend = socketserver.ThreadingUnixStreamServer(str(root / 'real.sock'), Backend)
            backend.daemon_threads = True
            threading.Thread(target=backend.serve_forever, daemon=True).start()
            docker = GUARD.Docker(root / 'real.sock')
            try:
                command = [sys.executable, '-c', f'import time,sys;time.sleep(0.6);sys.exit({native_exit})']
                with patch.object(GUARD, 'hosted'), patch.object(GUARD, 'available_mib', return_value=10000), patch.object(GUARD, 'Docker', return_value=docker):
                    code = GUARD.run(root, 'stats-transition', 'runtime', command)
                result = json.loads((reports / 'stats-transition.json').read_text())
                private = reports / 'stats-transition-container-stats.private.jsonl'
                self.assertEqual(private.stat().st_mode & 0o777, 0o600)
                private_text = private.read_text()
                self.assertNotIn('daemon-private-value', private_text)
                self.assertNotIn('daemon-private-error', private_text)
                snapshots = [json.loads(line) for line in private_text.splitlines()]
                self.assertEqual(len(snapshots), 1)
                self.assertEqual(snapshots[0]['requestedId'], identity)
                self.assertNotIn('FinishedAt', json.dumps(result))
                self.assertNotIn('ownershipLabel', json.dumps(result))
                decisions = result['containerStatsDecisions']
                self.assertTrue(set(decisions) <= {item.value for item in GUARD.StatsDecision})
                self.assertEqual(sum(decisions.values()), 1)
                self.assertNotIn(identity, json.dumps(decisions))
                self.assertNotIn(finished, json.dumps(decisions))
                self.assertNotIn('fixture', json.dumps(decisions))
                self.assertEqual(result['reserveMiB'], 1536)
                self.assertIn(('GET', '/containers/' + identity + '/stats?stream=false&one-shot=true'), seen)
                self.assertGreaterEqual(inspections, 2)
                return code, result, snapshots[0], seen
            finally:
                backend.shutdown()
                backend.server_close()

    def test_stop_between_inspect_and_stats_requires_fresh_stopped_proof(self):
        code, result, snapshot, _ = self._stats_transition('stopped')
        self.assertEqual(code, 0)
        self.assertEqual(result['nativeExitCode'], 0)
        self.assertEqual(result['containerStatsRechecks'], 1)
        self.assertEqual(result['verifiedStoppedRechecks'], 1)
        self.assertEqual(result['containerStatsDecisions'], {'verified-exited': 1})
        self.assertEqual(snapshot['ownershipLabel'], 'fixture')
        self.assertEqual(snapshot['state']['Status'], 'exited')
        self.assertFalse(snapshot['state']['Running'])
        self.assertNotEqual(snapshot['state']['FinishedAt'], '0001-01-01T00:00:00Z')

    def test_still_running_empty_stats_fails_closed_with_private_fresh_snapshot(self):
        code, result, snapshot, seen = self._stats_transition('running')
        self.assertEqual(code, 1)
        self.assertEqual(result['status'], 'guard-failed')
        self.assertEqual(result['nativeExitCode'], -15)
        self.assertEqual(result['invariantCode'], GUARD.InvariantCode.MEMORY_STATS.value)
        self.assertEqual(result['guardPhase'], 'container-stats-fresh-verification')
        self.assertEqual(result['verifiedStoppedRechecks'], 0)
        self.assertEqual(result['containerStatsDecisions'], {'still-running': 1})
        self.assertTrue(snapshot['state']['Running'])
        self.assertIn(('DELETE', '/containers/' + snapshot['requestedId'] + '?force=1&v=1'), seen)

    def test_stats_404_still_requires_fresh_stopped_proof(self):
        for transition, expected in [('stats404-stopped', 0), ('stats404-running', 1)]:
            with self.subTest(transition=transition):
                code, result, _, _ = self._stats_transition(transition)
                self.assertEqual(code, expected)
                self.assertEqual(result['verifiedStoppedRechecks'], int(expected == 0))

    def test_deleted_fresh_inspect_is_not_stopped_proof(self):
        code, result, snapshot, _ = self._stats_transition('deleted')
        self.assertEqual(code, 1)
        self.assertFalse(snapshot['inspectPresent'])
        self.assertEqual(result['containerStatsDecisions'], {'missing-inspect': 1})
        self.assertEqual(result['invariantCode'], GUARD.InvariantCode.MEMORY_STATS.value)
        self.assertEqual(result['verifiedStoppedRechecks'], 0)

    def test_changed_fresh_identity_or_label_is_not_adopted(self):
        for transition in ['identity', 'ownership']:
            with self.subTest(transition=transition):
                code, result, _, seen = self._stats_transition(transition)
                self.assertEqual(code, 1)
                self.assertEqual(result['invariantCode'], GUARD.InvariantCode.OWNERSHIP.value)
                self.assertEqual(result['verifiedStoppedRechecks'], 0)
                self.assertNotIn(('DELETE', '/containers/' + 'c' * 64 + '?force=1&v=1'), seen)
                if transition == 'ownership':
                    self.assertFalse(any(method == 'DELETE' for method, _ in seen))

    def test_fresh_limit_change_fails_even_for_stopped_container(self):
        for transition in ['limits', 'lower-limits']:
            with self.subTest(transition=transition):
                code, result, _, _ = self._stats_transition(transition)
                self.assertEqual(code, 1)
                self.assertEqual(result['invariantCode'], GUARD.InvariantCode.LIVE_LIMITS.value)
                self.assertEqual(result['verifiedStoppedRechecks'], 0)
                self.assertEqual(result['containerStatsDecisions'], {'limits-changed': 1})

    def test_unfinished_or_restarting_container_is_not_stopped_proof(self):
        for transition in ['unfinished', 'restarting']:
            with self.subTest(transition=transition):
                code, result, _, _ = self._stats_transition(transition)
                self.assertEqual(code, 1)
                self.assertEqual(result['invariantCode'], GUARD.InvariantCode.MEMORY_STATS.value)
                self.assertEqual(result['verifiedStoppedRechecks'], 0)
                self.assertEqual(result['containerStatsDecisions'], {'incomplete-stop': 1})

    def test_verified_stopped_does_not_mask_native_process_failure(self):
        code, result, _, _ = self._stats_transition('stopped', native_exit=7)
        self.assertEqual(code, 7)
        self.assertEqual(result['nativeExitCode'], 7)
        self.assertEqual(result['verifiedStoppedRechecks'], 1)

    def test_verified_stopped_does_not_mask_oom_failure(self):
        code, result, _, _ = self._stats_transition('oom')
        self.assertEqual(code, 75)
        self.assertEqual(result['terminationReason'], 'owned-container-oom')
        self.assertEqual(result['nativeExitCode'], -15)

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
