import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'release.py'
SPEC = importlib.util.spec_from_file_location('upstream_policy', SCRIPT)
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)


class UpstreamAdoptionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'policy-test@example.invalid')
        self.git('config', 'user.name', 'Policy Test')
        self.cfg = {
            'schemaVersion': 1, 'name': 'vendor-core', 'kind': 'upstream',
            'versionFile': 'package.json', 'upstream': True,
            'upstreamRepository': 'https://github.com/vendor/core.git',
        }
        policy.write_json('.release/component.json', self.cfg)
        self.packages('1.0.0', '0.9.0')
        self.commit()
        self.base = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-qb', 'vendor')
        self.packages('2.1.0', '1.4.0')
        self.commit()
        self.vendor = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-qb', 'fork', self.base)
        Path('runtime.js').write_text('retained fork behavior\n')
        Path('review.md').write_text('Pinned source and migration review\n')
        policy.write_json('.release/changes/upgrade.json', {
            'type': 'major', 'summary': 'Adopt vendor source',
            'migration': 'Coordinate consumers and offline database upgrade',
        })
        self.commit()
        self.previous = self.git('rev-parse', 'HEAD')
        self.git('merge', '--no-edit', 'vendor')
        self.record_path = '.release/upstream-adoptions/vendor-v2.1.0.json'
        self.record = {
            'schemaVersion': 1, 'component': 'vendor-core',
            'repository': self.cfg['upstreamRepository'], 'tag': 'v2.1.0',
            'commit': self.vendor, 'previousForkCommit': self.previous,
            'reason': 'Owner-selected stable upgrade', 'reviewDocument': 'review.md',
        }
        self.save_record()

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], text=True,
                                       stderr=subprocess.DEVNULL).strip()

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')

    def packages(self, core, ui):
        policy.write_json('package.json', {'version': core})
        policy.write_json('package-lock.json', {'version': core, 'packages': {'': {'version': core}}})
        policy.write_json('packages/types/package.json', {'version': core})
        policy.write_json('apps/operator-ui/package.json', {'version': ui})

    def save_record(self):
        policy.write_json(self.record_path, self.record)
        self.commit()

    def test_accepts_pinned_merged_upstream_and_preserves_independent_versions(self):
        policy.check(self.base)
        self.assertEqual(policy.read_json('apps/operator-ui/package.json')['version'], '1.4.0')

    def test_missing_record_does_not_allow_vendor_version_change(self):
        self.git('rm', self.record_path)
        self.commit()
        with self.assertRaisesRegex(ValueError, 'exactly one new upstream record'):
            policy.check(self.base)

    def test_record_cannot_authorize_an_invented_vendor_version(self):
        self.packages('2.1.1', '1.4.0')
        self.commit()
        with self.assertRaisesRegex(ValueError, 'matching the vendor version'):
            policy.check(self.base)

    def test_unmerged_commit_is_rejected_even_with_matching_package_bytes(self):
        tree = self.git('rev-parse', self.vendor + '^{tree}')
        self.record['commit'] = self.git('commit-tree', tree, '-m', 'unmerged vendor')
        self.save_record()
        with self.assertRaisesRegex(ValueError, 'retained in the current ancestry'):
            policy.check(self.base)

    def test_unknown_source_is_rejected(self):
        self.record['commit'] = '0' * 40
        self.save_record()
        with self.assertRaisesRegex(ValueError, 'retained in the current ancestry'):
            policy.check(self.base)

    def test_previous_fork_cannot_already_include_the_adopted_source(self):
        self.record['previousForkCommit'] = self.vendor
        self.save_record()
        with self.assertRaisesRegex(ValueError, 'already included before this adoption'):
            policy.check(self.base)

    def test_repository_must_match_declared_upstream(self):
        self.record['repository'] = 'https://github.com/someone/other.git'
        self.save_record()
        with self.assertRaisesRegex(ValueError, 'repository must match'):
            policy.check(self.base)

    def test_review_document_must_be_committed_and_repository_relative(self):
        for value in ('../outside.md', '/tmp/review.md', 'missing.md'):
            self.record['reviewDocument'] = value
            self.save_record()
            with self.assertRaisesRegex(ValueError, 'reviewDocument must identify'):
                policy.check(self.base)

    def test_tag_and_reason_are_required_audit_metadata(self):
        for key in ('tag', 'reason'):
            self.record[key] = ''
            self.save_record()
            with self.assertRaisesRegex(ValueError, key + ' is required'):
                policy.check(self.base)
            self.record[key] = 'reviewed value'

    def test_independent_workspace_version_cannot_be_rewritten(self):
        policy.write_json('apps/operator-ui/package.json', {'version': '9.0.0'})
        self.commit()
        with self.assertRaisesRegex(ValueError, 'preserve the selected upstream package version'):
            policy.check(self.base)

    def test_ordinary_component_cannot_use_upstream_exception(self):
        self.cfg['upstream'] = False
        policy.write_json('.release/component.json', self.cfg)
        self.commit()
        with self.assertRaisesRegex(ValueError, 'reviewed release PR'):
            policy.check(self.base)

    def test_adoption_records_are_append_only_after_acceptance(self):
        accepted = self.git('rev-parse', 'HEAD')
        self.record['reason'] = 'rewritten historic approval'
        policy.write_json('.release/changes/docs.json', {'type': 'none', 'summary': 'Update notes'})
        self.save_record()
        with self.assertRaisesRegex(ValueError, 'adoption records are append-only'):
            policy.check(accepted)

    def test_later_fork_fix_does_not_need_another_vendor_adoption(self):
        accepted = self.git('rev-parse', 'HEAD')
        Path('runtime.js').write_text('later fork fix\n')
        policy.write_json('.release/changes/fix.json', {'type': 'patch', 'summary': 'Fork fix'})
        self.commit()
        policy.check(accepted)

    def test_new_adoption_record_requires_an_actual_version_change(self):
        accepted = self.git('rev-parse', 'HEAD')
        policy.write_json('.release/upstream-adoptions/duplicate.json', self.record)
        policy.write_json('.release/changes/docs.json', {'type': 'none', 'summary': 'Metadata only'})
        self.commit()
        with self.assertRaisesRegex(ValueError, 'require an actual vendor version change'):
            policy.check(accepted)

    def test_adoption_does_not_bypass_runtime_declaration_or_lock_checks(self):
        policy.write_json('.release/changes/upgrade.json', {'type': 'none', 'summary': 'Wrong classification'})
        self.commit()
        with self.assertRaisesRegex(ValueError, 'cannot declare type none'):
            policy.check(self.base)

    def test_lock_still_must_match_the_adopted_version(self):
        policy.write_json('package-lock.json', {'version': '1.0.0'})
        self.commit()
        with self.assertRaisesRegex(ValueError, 'root version differs'):
            policy.check(self.base)

    def test_upstream_prepare_and_ordinary_release_validation_remain_disabled(self):
        with self.assertRaisesRegex(ValueError, 'manual upstream review'):
            policy.prepare()
        with self.assertRaisesRegex(ValueError, 'reviewed upstream release'):
            policy.check(self.base, release=True)


if __name__ == '__main__':
    unittest.main()
