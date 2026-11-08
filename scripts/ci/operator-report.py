#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
# SPDX-License-Identifier: Apache-2.0
"""Actual Operator runtime assertions, native TypeScript and standalone acceptance have separate evidence."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
reports = root / 'reports/ci'
runtime = json.loads((reports / 'operator-unit-runtime.json').read_text())
discovered = [case for suite in runtime['testResults'] for case in suite['assertionResults']]
typed = [case for case in discovered if case.get('meta', {}).get('typecheck')]
executed = [case for case in discovered if not case.get('meta', {}).get('typecheck')]
assert not typed, 'Typed discovery must remain separate from runtime assertions'
assert runtime['success'] and executed
assert all(case['status'] == 'passed' for case in executed)
for name in ['operator-unit', 'operator-typecheck', 'operator']:
    stage = json.loads((reports / (name + '.json')).read_text())
    assert stage['nativeExitCode'] == stage['exitCode'] == 0
standalone = json.loads((root / 'operator-build-validation.json').read_text())
summary = {'sourceSha': standalone['sourceSha'], 'runtimeAssertionsPassed': len(executed),
           'typedDiscoveryAssertions': len(typed), 'nativeTypeScriptExitCode': 0,
           'standaloneTransport': standalone['standaloneTransport']}
(reports / 'operator-acceptance-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
