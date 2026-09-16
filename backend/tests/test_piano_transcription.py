"""Adapter regressions; actual model evaluation is recorded separately."""

import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from stemwork import piano_transcription as piano


class PianoAdapterTests(unittest.TestCase):
    def test_missing_checkpoint_fails_before_model_import(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "权重未安装"):
                piano.verify_checkpoint(Path(directory) / "missing.pth")

    def test_wrong_weight_bytes_are_rejected_even_at_matching_size(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "weights.pth"
            path.write_bytes(b"bad!")
            with patch.object(piano, "CHECKPOINT_BYTES", 4), \
                    patch.object(piano, "CHECKPOINT_SHA256", hashlib.sha256(b"good").hexdigest()):
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    piano.verify_checkpoint(path)

    def test_checkpoint_loading_explicitly_requires_weights_only(self):
        torch = Mock()
        torch.load.return_value = {"model": {"note_model": {}, "pedal_model": {}}}
        path = Path("verified.pth")
        piano._read_weights(torch, path)
        torch.load.assert_called_once_with(str(path), map_location="cpu", weights_only=True)
        torch.load.side_effect = RuntimeError("unsupported safe checkpoint")
        with self.assertRaisesRegex(RuntimeError, "unsupported safe"):
            piano._read_weights(torch, path)
        self.assertEqual(torch.load.call_count, 2)  # No unsafe retry.

    def test_padding_is_clipped_but_legitimate_short_notes_are_retained(self):
        events = [
            {"onset_time": 0.2, "offset_time": 0.24, "midi_note": 60, "velocity": 64},
            {"onset_time": 0.8, "offset_time": 1.5, "midi_note": 64, "velocity": 127},
            {"onset_time": 1.1, "offset_time": 1.4, "midi_note": 67, "velocity": 70},
        ]
        result = piano._note_events(events, 1.0)
        self.assertEqual(len(result), 2)
        self.assertAlmostEqual(result[0][1] - result[0][0], 0.04)
        self.assertEqual(result[1], [0.8, 1.0, 64, 1.0])
        json.dumps(result, allow_nan=False)

    def test_invalid_model_values_do_not_enter_json(self):
        with self.assertRaisesRegex(RuntimeError, "非有限"):
            piano._note_events([{"onset_time": 0, "offset_time": float("nan"), "midi_note": 60, "velocity": 80}], 1)

    def test_checkpoint_resolution_uses_server_cache_without_home_download(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict("os.environ", {"STEMWORK_MODEL_CACHE": directory, "STEMWORK_PIANO_CHECKPOINT": ""}):
                self.assertEqual(piano.resolve_checkpoint(), (Path(directory) / "piano" / piano.CHECKPOINT_FILENAME).resolve())

    def test_cli_errors_are_utf8_even_with_windows_ascii_stream(self):
        destination = io.BytesIO()
        stream = io.TextIOWrapper(destination, encoding="ascii")
        with patch.object(piano.sys, "stderr", stream), \
                patch.object(piano, "transcribe", side_effect=RuntimeError("权重缺失")):
            self.assertEqual(piano.main(["audio.wav", "notes.json", "weights.pth", "cpu"]), 1)
        stream.flush()
        self.assertIn("权重缺失", destination.getvalue().decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
