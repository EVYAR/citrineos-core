#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
# SPDX-License-Identifier: Apache-2.0
"""A focused fixture run must never be presented as full backend acceptance."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
reports = root / 'reports/ci'
stage = json.loads((reports / 'runtime-ocpp-fixtures.json').read_text())
assert stage['nativeExitCode'] == stage['exitCode'] == 0
runtime = json.loads((root / 'reports/runtime-ocpp-fixtures.json').read_text())
cases = [case for suite in runtime['testResults'] for case in suite['assertionResults']]
assert runtime['success'] and cases and len(cases) == runtime['numTotalTests']
assert all(case['status'] == 'passed' and not case.get('meta', {}).get('typecheck') for case in cases)
checks = {}
for project in ['base', 'dal', 'ocpp', 'ocpi']:
    checked = json.loads((reports / ('typecheck-' + project + '.json')).read_text())
    assert checked['nativeExitCode'] == checked['exitCode'] == 0
    checks[project] = checked['nativeExitCode']
summary = {'sourceSha': stage['sourceSha'], 'scope': 'OCPP_NINE_FIXTURE_FILES_NOT_FULL_BACKEND_ACCEPTANCE',
           'runtimePassed': len(cases), 'runtimeFiles': len(runtime['testResults']),
           'typedDiscoveryAssertions': 0, 'nativeTypeScript': checks,
           'postgresqlAcceptance': False, 'imageRuntimeChanged': False}
(reports / 'ocpp-fixture-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
