#!/usr/bin/env python3
"""Prepare a release PR from origin/dev. Never merges, tags, builds or deploys."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def main():
    cfg = json.loads(Path('.release/component.json').read_text())
    if not cfg.get('productionBranch'):
        raise ValueError('No production branch exists; review first-production bootstrap before preparing a release')
    if cfg.get('upstream'):
        raise ValueError('Upstream release needs manual review; preserve upstream versions')
    run('git', 'fetch', 'origin', cfg['developmentBranch'], cfg['productionBranch'])
    snapshot = run('git', 'rev-parse', 'origin/' + cfg['developmentBranch'])
    # The accepted dev checkout must contain policy before any preparation.
    run('git', 'cat-file', '-e', snapshot + ':.release/release.py')
    temporary = tempfile.mkdtemp(prefix='evyar-release-')
    checkout = Path(temporary) / 'source'
    run('git', 'worktree', 'add', '--detach', str(checkout), snapshot)
    try:
        result = json.loads(run(sys.executable, '.release/release.py', 'prepare', cwd=checkout))
        branch = 'release/' + cfg['name'] + '-v' + result['version']
        run('git', 'switch', '-c', branch, cwd=checkout)
        run('git', 'add', '--all', cwd=checkout)
        run('git', 'commit', '-m', 'chore(release): ' + cfg['name'] + ' ' + result['version'], cwd=checkout)
        run(sys.executable, '.release/release.py', 'check', '--base', 'origin/' + cfg['productionBranch'], '--release', cwd=checkout)
        run('git', 'push', '-u', 'origin', branch, cwd=checkout)
        body = Path(temporary) / 'body.md'
        body.write_text('Prepare ' + cfg['name'] + ' ' + result['version'] + ' from frozen dev commit `' + snapshot + '`.\n\nReview CHANGELOG.md and consumed declarations in `.release/history`. The source-bound policy check passed locally.\n\nBefore merging: validate immutable production artifacts, compatibility, migrations/configuration, rollback and the platform manifest. This PR does not build, tag, deploy or publish. After promotion, back-merge the release history into dev.\n')
        print(run('gh', 'pr', 'create', '--base', cfg['productionBranch'], '--head', branch, '--draft', '--title', 'chore(release): ' + cfg['name'] + ' v' + result['version'], '--body-file', str(body), cwd=checkout))
    finally:
        # Keep failed work reviewable; never reset/discard preparation output.
        print('Release checkout: ' + str(checkout), file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print('Release PR preparation stopped: ' + str(exc), file=sys.stderr)
        sys.exit(1)
