# 验证未配置、缺适配器、加载失败和可用状态；环境检查不连接 ERP。
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from main import environment_report
from session import WorkerError

class EnvironmentTests(unittest.TestCase):
    @patch("main.load_adapter")
    @patch("main.local_erp_config", return_value={})
    def test_missing_configuration(self, config, loader):
        report = environment_report()
        self.assertEqual(report["erp_package"]["status"], "missing")
        self.assertFalse(report["erp_connected"])
        loader.assert_not_called()

    @patch("main.load_adapter", side_effect=WorkerError("PACKAGE_UNAVAILABLE", "本机适配器缺失"))
    @patch("main.local_erp_config", return_value={"domain": "https://erp.example.test/"})
    def test_missing_adapter(self, config, loader):
        self.assertEqual(environment_report()["erp_package"]["status"], "missing")

    @patch("main.load_adapter", side_effect=ImportError("dependency unavailable"))
    @patch("main.local_erp_config", return_value={"domain": "https://erp.example.test/"})
    def test_broken_dependency(self, config, loader):
        report = environment_report()
        self.assertEqual(report["erp_package"]["status"], "error")
        self.assertFalse(report["erp_connected"])

    @patch("main.load_adapter", return_value=SimpleNamespace(VERSION="test-adapter"))
    @patch("main.local_erp_config", return_value={"domain": "https://erp.example.test/"})
    def test_import_is_not_connection(self, config, loader):
        report = environment_report()
        self.assertEqual(report["erp_package"]["status"], "ready")
        self.assertFalse(report["erp_connected"])

if __name__ == "__main__":
    unittest.main()
