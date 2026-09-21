import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "casc-inspect.py"
SPEC = importlib.util.spec_from_file_location("coopagent_casc_inspect", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class CascSelectionTests(unittest.TestCase):
    def test_selects_main_starcoop_catalog(self):
        self.assertEqual(
            MODULE.should_extract(
                r"mods\starcoop\starcoop.sc2mod\base.sc2data\gamedata\unitdata.xml"
            ),
            "starcoop",
        )

    def test_selects_nested_commander_packages(self):
        self.assertEqual(
            MODULE.should_extract(
                r"mods\starcoop\commanders\arcturusmengsk.sc2mod\base.sc2data\gamedata\unitdata.xml"
            ),
            "starcoop/commanders/arcturusmengsk.sc2mod",
        )
        self.assertEqual(
            MODULE.should_extract(
                r"mods\starcoop\commanders\egonstetmann.sc2mod\zhcn.sc2data\localizeddata\gamestrings.txt"
            ),
            "starcoop/commanders/egonstetmann.sc2mod",
        )

    def test_selects_campaign_catalog_dependencies(self):
        self.assertEqual(
            MODULE.should_extract(
                r"campaigns\libertystory.sc2campaign\base.sc2data\gamedata\abildata.xml"
            ),
            "libertystory.sc2campaign",
        )
        self.assertEqual(
            MODULE.should_extract(
                r"campaigns\swarm.sc2campaign\zhcn.sc2data\localizeddata\gamestrings.txt"
            ),
            "swarm.sc2campaign",
        )

    def test_ignores_non_database_assets(self):
        self.assertIsNone(
            MODULE.should_extract(
                r"mods\starcoop\commanders\arcturusmengsk.sc2mod\base.sc2assets\assets\unit.m3"
            )
        )
        self.assertIsNone(
            MODULE.should_extract(
                r"campaigns\void.sc2campaign\base.sc2assets\assets\unit.m3"
            )
        )


if __name__ == "__main__":
    unittest.main()
