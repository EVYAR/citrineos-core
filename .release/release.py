#!/usr/bin/env python3
"""EVYAR release policy v1. Standard library only; never deploys or publishes."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SEMVER = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$')
RANK = {'none': 0, 'patch': 1, 'minor': 2, 'major': 3}


def fail(message):
    raise ValueError(message)


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def semver(value):
    match = SEMVER.fullmatch(value or '')
    if not match:
        fail('Invalid SemVer: ' + str(value))
    if match[4] and any(x.isdigit() and len(x) > 1 and x.startswith('0') for x in match[4].split('.')):
        fail('Numeric prerelease identifiers cannot have leading zeroes')
    return tuple(int(match[i]) for i in (1, 2, 3))


def bump(version, kind):
    major, minor, patch = semver(version)
    if '-' in version or '+' in version:
        fail('Establish a reviewed stable baseline before automated version preparation')
    if kind == 'major':
        return f'{major + 1}.0.0'
    if kind == 'minor':
        return f'{major}.{minor + 1}.0'
    if kind == 'patch':
        return f'{major}.{minor}.{patch + 1}'
    fail('No releasable changes; unchanged components keep their version')


def config():
    data = read_json('.release/component.json')
    if data.get('schemaVersion') != 1 or not re.fullmatch(r'[a-z][a-z0-9-]*', data.get('name', '')):
        fail('Invalid component configuration')
    path = Path(data.get('versionFile', ''))
    if path.is_absolute() or '..' in path.parts or not path.parts:
        fail('versionFile must be a repository-relative path')
    return data


def version(cfg):
    path = cfg['versionFile']
    value = read_json(path).get('version') if path.endswith('.json') else Path(path).read_text().strip()
    if not cfg.get('upstream'):
        semver(value)
    elif not isinstance(value, str) or not value.strip():
        fail('Upstream source version is required')
    return value


def declaration(path):
    data = read_json(path)
    if data.get('type') not in RANK or not isinstance(data.get('summary'), str) or not data['summary'].strip():
        fail(f'{path}: type and a nonempty summary are required')
    if data['type'] == 'major' and not str(data.get('migration', '')).strip():
        fail(f'{path}: breaking changes need migration/consumer compatibility notes')
    return data


def source_at(ref, path):
    try:
        return subprocess.check_output(['git', 'show', f'{ref}:{path}'], text=True, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        return None


def is_nonruntime(path):
    return (path.startswith(('.release/', '.github/', 'docs/')) or
            path.endswith(('.md', '.mdx')) or
            bool(re.search(r'(^|/)(__tests__|tests|test)/|\.(test|spec)\.[^/]+$', path)))


def check(base, release=False):
    cfg = config()
    current = version(cfg)
    changed = git('diff', '--name-only', base, 'HEAD').splitlines()
    added = git('diff', '--name-only', '--diff-filter=A', base, 'HEAD', '--', '.release/changes').splitlines()
    new = [declaration(p) for p in added if p.endswith('.json')]
    old = source_at(base, cfg['versionFile'])
    old_version = None
    if old:
        old_version = json.loads(old).get('version') if cfg['versionFile'].endswith('.json') else old.strip()
    if release:
        if cfg.get('upstream'):
            fail('Upstream components require a reviewed upstream release; do not rewrite vendor versions')
        history = read_json(f'.release/history/{current}.json')
        snapshot = history.get('sourceCommit', '')
        if not re.fullmatch(r'[0-9a-f]{40}', snapshot):
            fail('Release history needs its frozen dev source commit')
        if subprocess.run(['git', 'merge-base', '--is-ancestor', snapshot, 'HEAD'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            fail('Frozen source must be an ancestor of the release commit')
        source_paths = git('ls-tree', '-r', '--name-only', snapshot, '--', '.release/changes').splitlines()
        expected_records = []
        for source_path in sorted(p for p in source_paths if p.endswith('.json')):
            raw = source_at(snapshot, source_path)
            expected_records.append({'id': Path(source_path).name, **json.loads(raw), 'sha256': hashlib.sha256(raw.encode()).hexdigest()})
        if history.get('changes') != expected_records:
            fail('Consumed changes must exactly match the frozen dev declarations')
        post_snapshot = git('diff', '--name-only', snapshot, 'HEAD').splitlines()
        allowed = {cfg['versionFile'], 'CHANGELOG.md', 'package-lock.json', 'npm-shrinkwrap.json', 'app.json'}
        if any(p not in allowed and not p.startswith(('.release/history/', '.release/changes/')) for p in post_snapshot):
            fail('Release PR changed source after its frozen candidate; prepare it again')
        records = history.get('changes', [])
        if old_version is None:
            old_version = cfg.get('baselineVersion')
        if history.get('from') != old_version or not records:
            fail('Release history must match the production base version and include consumed changes')
        checked = []
        for record in records:
            if record.get('type') not in RANK or not record.get('summary'):
                fail('Invalid consumed change record')
            if record['type'] == 'major' and not record.get('migration'):
                fail('Breaking release history needs migration notes')
            checked.append(record)
        expected = bump(old_version, max(checked, key=lambda x: RANK[x['type']])['type'])
        if current != expected:
            fail(f'Release version must be {expected}, got {current}')
        if not any(p.startswith('.release/history/') for p in changed):
            fail('Release must introduce consumed change history')
    else:
        if not new:
            fail('Add .release/changes/<unique-name>.json declaring patch, minor, major or none')
        if old_version and current != old_version:
            fail('Version changes belong in a reviewed release PR, not a feature PR')
        if all(x['type'] == 'none' for x in new) and any(not is_nonruntime(p) for p in changed):
            fail('Runtime/package changes cannot declare type none')
        modified = git('diff', '--name-only', '--diff-filter=MD', base, 'HEAD', '--', '.release/changes').splitlines()
        if modified:
            fail('Pending change declarations are append-only until consumed by a release PR')
    for lock in ('package-lock.json', 'npm-shrinkwrap.json'):
        if Path(lock).exists() and cfg['versionFile'] == 'package.json':
            data = read_json(lock)
            if data.get('version') != current or data.get('packages', {}).get('', {}).get('version', current) != current:
                fail(lock + ': root version differs from package.json')
    if Path('app.json').exists() and cfg.get('kind') == 'mobile':
        if read_json('app.json')['expo']['version'] != current:
            fail('Expo display version must match package.json; native build numbers stay managed by EAS')
    print(json.dumps({'component': cfg['name'], 'version': current, 'check': 'passed'}))


def prepare():
    cfg = config()
    if cfg.get('upstream'):
        fail('Preserve upstream versions: this component requires manual upstream review')
    if git('status', '--porcelain'):
        fail('Use a clean isolated checkout before preparing a release')
    records = []
    paths = sorted(Path('.release/changes').glob('*.json'))
    for path in paths:
        item = declaration(path)
        records.append({'id': path.name, **item, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    if not records:
        fail('No pending change declarations')
    old = version(cfg)
    snapshot = git('rev-parse', 'HEAD')
    kind = max(records, key=lambda x: RANK[x['type']])['type']
    new = bump(old, kind)
    if Path(f'.release/history/{new}.json').exists():
        fail('Release history already exists; never overwrite a released version')
    # Validate every input before writing any release files.
    for lock in ('package-lock.json', 'npm-shrinkwrap.json'):
        if cfg['versionFile'] == 'package.json' and Path(lock).exists():
            read_json(lock)
    if cfg.get('kind') == 'mobile':
        read_json('app.json')['expo']['version']
    path = cfg['versionFile']
    if path.endswith('.json'):
        data = read_json(path)
        data['version'] = new
        write_json(path, data)
    else:
        Path(path).write_text(new + '\n')
    if path == 'package.json':
        for lock in ('package-lock.json', 'npm-shrinkwrap.json'):
            if Path(lock).exists():
                data = read_json(lock)
                data['version'] = new
                if '' in data.get('packages', {}):
                    data['packages']['']['version'] = new
                write_json(lock, data)
    if cfg.get('kind') == 'mobile':
        data = read_json('app.json')
        data['expo']['version'] = new
        write_json('app.json', data)
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    notes = f'## [{new}] — {today}\n\n' + '\n'.join(f"- {r['summary']}" for r in records if r['type'] != 'none') + '\n\n'
    changelog = Path('CHANGELOG.md')
    old_notes = changelog.read_text() if changelog.exists() else '# Changelog\n'
    changelog.write_text('# Changelog\n\n' + notes + old_notes.removeprefix('# Changelog').lstrip())
    write_json(f'.release/history/{new}.json', {'schemaVersion': 1, 'component': cfg['name'], 'from': old, 'version': new, 'sourceCommit': snapshot, 'changes': records})
    for path in paths:
        path.unlink()
    print(json.dumps({'component': cfg['name'], 'from': old, 'version': new, 'status': 'prepared-only'}))


def build_info(output):
    cfg = config()
    sha = git('rev-parse', 'HEAD')
    dirty = bool(git('status', '--porcelain', '--untracked-files=normal'))
    source_date = dt.datetime.fromtimestamp(int(os.environ.get('SOURCE_DATE_EPOCH', git('show', '-s', '--format=%ct', 'HEAD'))), dt.timezone.utc).isoformat()
    canonical = version(cfg)
    branch = os.environ.get('GITHUB_HEAD_REF') or os.environ.get('GITHUB_REF_NAME') or git('branch', '--show-current')
    artifact_version = canonical
    if not cfg.get('upstream') and branch != cfg.get('productionBranch', 'prod'):
        artifact_version = canonical.split('+')[0] + ('-' if '-' not in canonical else '.') + 'dev.' + os.environ.get('GITHUB_RUN_NUMBER', '0') + '.' + sha[:12]
    data = {'schemaVersion': 1, 'component': cfg['name'], 'version': canonical, 'artifactVersion': artifact_version, 'sourceCommit': sha,
            'sourceDate': source_date, 'dirty': dirty, 'buildId': os.environ.get('GITHUB_RUN_ID'),
            'buildAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'upstream': cfg.get('upstream', False)}
    if output:
        write_json(output, data)
    else:
        print(json.dumps(data))


def validate_manifest(path, promotable):
    data = read_json(path)
    semver(data.get('version'))
    if data.get('schemaVersion') != 1 or not isinstance(data.get('components'), list) or not data['components']:
        fail('Manifest needs schemaVersion 1 and nonempty components')
    names = set()
    for c in data['components']:
        name = c.get('name')
        if not name or name in names:
            fail('Manifest component names must be unique')
        names.add(name)
        if c.get('version') is not None and not c.get('upstream'):
            semver(c['version'])
        if promotable:
            if not c.get('version') or not re.fullmatch(r'[0-9a-f]{40}', c.get('sourceCommit', '')):
                fail(name + ': exact component version and source commit are required')
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', c.get('artifactDigest', '')):
                fail(name + ': immutable artifact digest is required')
            if not c.get('validation') or not c.get('rollback') or not isinstance(c.get('migrations'), list) or not isinstance(c.get('configuration'), list):
                fail(name + ': validation, rollback, migration and configuration evidence required')
    if promotable and (data.get('status') != 'approved' or data.get('blockers')):
        fail('Only an approved manifest without blockers is promotable')
    print(json.dumps({'manifest': str(path), 'version': data['version'], 'components': len(names), 'promotable': promotable}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    cmd = sub.add_parser('check'); cmd.add_argument('--base', required=True); cmd.add_argument('--release', action='store_true')
    sub.add_parser('prepare')
    cmd = sub.add_parser('build-info'); cmd.add_argument('--output')
    cmd = sub.add_parser('manifest'); cmd.add_argument('path'); cmd.add_argument('--promotable', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'check': check(args.base, args.release)
        elif args.command == 'prepare': prepare()
        elif args.command == 'build-info': build_info(args.output)
        else: validate_manifest(args.path, args.promotable)
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print('Release policy: ' + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
