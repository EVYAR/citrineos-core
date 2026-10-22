import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'release.py'
spec = importlib.util.spec_from_file_location('policy', SCRIPT)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        policy.write_json('.release/component.json', {'schemaVersion': 1, 'name': 'test', 'kind': 'mobile', 'versionFile': 'package.json'})
        policy.write_json('package.json', {'version': '1.0.0'})
        policy.write_json('package-lock.json', {'version': '1.0.0', 'packages': {'': {'version': '1.0.0'}}})
        policy.write_json('app.json', {'expo': {'version': '1.0.0', 'ios': {'buildNumber': '17'}, 'android': {'versionCode': 28}}})
        self.commit()
        self.base = self.git('rev-parse', 'HEAD')
    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()
    def git(self, *args):
        return subprocess.check_output(['git', *args], text=True, stderr=subprocess.DEVNULL).strip()
    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'test')
    def change(self, kind='minor'):
        policy.write_json('.release/changes/feature.json', {'type': kind, 'summary': 'New behavior'})
        Path('runtime.js').write_text('new behavior')
        self.commit()
    def test_semver_and_largest_change(self):
        self.assertEqual(policy.bump('1.9.9', 'minor'), '1.10.0')
        self.assertEqual(policy.bump('0.9.9', 'major'), '1.0.0')
        for invalid in ('01.1.0', '1.0', '1.0.0-01'):
            with self.assertRaises(ValueError): policy.semver(invalid)
    def test_none_rejects_runtime(self):
        self.change('none')
        with self.assertRaisesRegex(ValueError, 'cannot declare'): policy.check(self.base)
    def test_prepare_freezes_records_and_preserves_native_counters(self):
        self.change()
        policy.check(self.base)
        policy.prepare()
        self.assertEqual(policy.read_json('app.json')['expo'], {'version': '1.1.0', 'ios': {'buildNumber': '17'}, 'android': {'versionCode': 28}})
        self.commit()
        policy.check(self.base, release=True)
        Path('runtime.js').write_text('unreviewed candidate change')
        self.commit()
        with self.assertRaisesRegex(ValueError, 'changed source'): policy.check(self.base, release=True)
    def test_prepare_checks_inputs_before_mutating(self):
        self.change()
        Path('package-lock.json').write_text('{broken')
        self.commit()
        with self.assertRaises(ValueError): policy.prepare()
        self.assertEqual(policy.read_json('package.json')['version'], '1.0.0')
        self.assertTrue(Path('.release/changes/feature.json').exists())
    def test_major_requires_migration(self):
        self.change('major')
        with self.assertRaisesRegex(ValueError, 'migration'): policy.prepare()
    def test_draft_manifest_cannot_promote(self):
        policy.write_json('manifest.json', {'schemaVersion': 1, 'version': '1.1.0', 'status': 'draft', 'components': [{'name': 'test', 'version': '1.0.0', 'sourceCommit': self.base, 'artifactDigest': None}]})
        policy.validate_manifest('manifest.json', False)
        with self.assertRaises(ValueError): policy.validate_manifest('manifest.json', True)
    def test_metadata_records_exact_source_and_dirty_state(self):
        policy.build_info('metadata.json')
        data = policy.read_json('metadata.json')
        self.assertEqual(data['sourceCommit'], self.base)
        self.assertFalse(data['dirty'])
        Path('runtime.js').write_text('local')
        policy.build_info('metadata.json')
        self.assertTrue(policy.read_json('metadata.json')['dirty'])

if __name__ == '__main__': unittest.main()
