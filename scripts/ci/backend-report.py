#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
# SPDX-License-Identifier: Apache-2.0
"""Summarize executed runtime assertions separately from native TypeScript input discovery."""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
reports = ROOT / 'reports/ci'
job = json.loads((reports / 'job.json').read_text())
projects = ['base', 'dal', 'ocpp', 'ocpi']
results = []
suites = []
project_runtime = {}
for project in projects:
    runtime = json.loads((ROOT / 'reports' / ('runtime-' + project + '.json')).read_text())
    stage = json.loads((reports / ('runtime-' + project + '.json')).read_text())
    assert stage['nativeExitCode'] == stage['exitCode'] == 0
    assert runtime['success'] is True
    executed = [test for suite in runtime['testResults'] for test in suite['assertionResults']]
    assert executed and len(executed) == runtime['numTotalTests']
    results.extend(executed)
    suites.extend(runtime['testResults'])
    project_runtime[project] = {'totalAssertions': len(executed), 'nativeExitCode': stage['nativeExitCode']}
boot = [suite for suite in suites if suite['name'].replace('\\', '/').endswith('/packages/dal/test/migrations/boot-config-archive-integration.test.ts')]
assert len(boot) == 1 and len(boot[0]['assertionResults']) == 12
assert all(test['status'] == 'passed' for test in boot[0]['assertionResults'])
typed = {}
for project in projects:
    checked = json.loads((reports / ('typecheck-' + project + '.json')).read_text())
    assert checked['nativeExitCode'] == checked['exitCode'] == 0
    lines = (reports / ('typecheck-' + project + '.log')).read_text().splitlines()
    prefix = str(ROOT / 'packages' / project) + '/'
    files = sorted({line.strip() for line in lines if line.strip().startswith(prefix) and re.search(r'\.(test|spec)\.tsx?$', line.strip())})
    assert files
    typed[project] = {'testInputFiles': len(files), 'scope': 'TSC_INPUT_DISCOVERY_NOT_EXECUTED_TEST_CASES'}
summary = {'sourceSha': job['sourceSha'], 'runtime': {'totalAssertions': len(results),
    'passed': sum(test['status'] == 'passed' for test in results),
    'failed': sum(test['status'] == 'failed' for test in results),
    'other': sum(test['status'] not in ('passed', 'failed') for test in results),
    'projects': project_runtime, 'projectProcessesSequential': True, 'typecheckEnabledInRuntime': False, 'bootArchiveIntegrationPassed': 12},
    'typescript': typed, 'scope': 'HOSTED_BACKEND_TESTS_NOT_DEPLOYMENT_OR_STATION_ACCEPTANCE'}
(reports / 'backend-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
