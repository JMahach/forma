import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('forma_local_mailbox', ROOT / 'deploy/local_mailbox.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class LocalMailboxTests(unittest.TestCase):
    def test_inherited_mailpit_settings_cannot_enable_external_delivery_or_persistence(self):
        environment = MODULE.environment({'PATH':'/bin','MP_SMTP_RELAY_ALL':'true','MP_SMTP_FORWARD_CONFIG':'private','MP_DATABASE':'/persistent'})
        self.assertEqual(environment, {'PATH':'/bin'})

    def test_receiver_is_loopback_only_with_tls_and_no_external_delivery_or_persistent_database(self):
        arguments = MODULE.arguments(pathlib.Path('/tmp/forma-mailbox'))
        self.assertEqual(arguments[arguments.index('--listen')+1], '127.0.0.1:8025')
        self.assertEqual(arguments[arguments.index('--smtp')+1], '127.0.0.1:1025')
        self.assertIn('--smtp-require-starttls', arguments)
        self.assertIn('--disable-version-check', arguments)
        self.assertEqual(arguments[arguments.index('--webroot')+1], '/__mail/')
        for flag in ['--database','--smtp-relay-all','--smtp-forward-config','--send-api-auth-accept-any']:
            self.assertNotIn(flag, arguments)

    def test_substituted_binary_is_rejected_before_extraction(self):
        with self.assertRaisesRegex(ValueError,'checksum'):
            MODULE.extract_binary(b'not the release', '0'*64)

    def test_service_keeps_email_bodies_out_of_system_logs(self):
        service = MODULE.launch_agent(pathlib.Path('/Users/test/.local/share/forma-mailbox'))
        self.assertEqual(service['StandardOutPath'],'/dev/null')
        self.assertEqual(service['StandardErrorPath'],'/dev/null')
        self.assertTrue(service['KeepAlive'])
        self.assertEqual(service['ProgramArguments'][-1], 'run')
