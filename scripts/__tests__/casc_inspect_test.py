import importlib.util
import json
import tempfile
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


class CascRecoveryTests(unittest.TestCase):
    def test_complete_extraction_is_reused_only_with_matching_source_and_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sc2 = root / "StarCraft II"
            output = root / "B97579"
            sc2.mkdir()
            (output / "files").mkdir(parents=True)
            (output / "known-files.tsv.gz").write_bytes(b"index")
            (output / "selected-files.tsv").write_text("index", encoding="utf-8")
            manifest = {
                "extractorVersion": MODULE.CASC_EXTRACTOR_VERSION,
                "source": {"starCraftRoot": str(sc2.resolve()), "version": "5.0.15.97579"},
                "extract": {
                    "selectedFiles": 12,
                    "extractedFiles": 12,
                    "failures": [],
                },
            }
            (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertTrue(MODULE.extraction_is_complete(output, sc2, "5.0.15.97579"))
            manifest["extract"]["failures"] = [{"path": "broken"}]
            (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertFalse(MODULE.extraction_is_complete(output, sc2, "5.0.15.97579"))

    def test_publish_and_recovery_keep_the_last_complete_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "B97579"
            staging = root / "B97579.building-1"
            output.mkdir()
            staging.mkdir()
            (output / "marker").write_text("old", encoding="utf-8")
            (staging / "marker").write_text("new", encoding="utf-8")
            MODULE.publish_extraction(staging, output)
            self.assertEqual((output / "marker").read_text(encoding="utf-8"), "new")
            self.assertFalse((root / "B97579.previous").exists())

            output.rename(root / "B97579.previous")
            stale = root / "B97579.building-stale"
            stale.mkdir()
            MODULE.recover_extraction_output(output)
            self.assertEqual((output / "marker").read_text(encoding="utf-8"), "new")
            self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
