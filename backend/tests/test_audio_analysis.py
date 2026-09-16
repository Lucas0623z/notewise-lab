"""Signal safety regressions, independent of model note counts/accuracy."""

from array import array
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

from stemwork.audio_analysis import AudioLevels, analyse_track, measure_pcm
from stemwork import pipeline


class SignalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def wav(self, name, samples, channels=1):
        path = self.root / name
        with wave.open(str(path), "wb") as stream:
            stream.setnchannels(channels)
            stream.setsampwidth(2)
            stream.setframerate(8000)
            stream.writeframes(array("h", samples).tobytes())
        return path

    def test_silence_has_finite_json_and_skips_inference(self):
        path = self.wav("silent.wav", [0] * 8000)
        levels = measure_pcm(path, lambda: None)
        analysis = analyse_track(levels, levels)
        self.assertTrue(analysis["lowSignal"])
        json.dumps(analysis, allow_nan=False)
        with patch.object(pipeline, "_check_dependencies"), \
                patch.object(pipeline, "_model_environment", return_value={}), \
                patch.object(pipeline, "_transcribe_audio") as infer:
            result = pipeline.run_pipeline(path, self.root / "out", {"mode": "transcribe_only"},
                                           lambda *args: None, lambda _: None, lambda: False)
        infer.assert_not_called()
        self.assertEqual(result["tracks"][0]["notes"], [])
        self.assertTrue(result["tracks"][0]["analysis"]["autoTranscriptionSkipped"])

    def test_extremely_quiet_original_is_not_removed_by_absolute_level(self):
        levels = AudioLevels(rms=3e-5, peak=9e-5, loudest_window_rms=5e-5)
        self.assertFalse(analyse_track(levels, levels)["lowSignal"])

    def test_antiphase_stereo_measures_energy_without_cancelling(self):
        path = self.wav("stereo.wav", [4000, -4000] * 8000, channels=2)
        levels = measure_pcm(path, lambda: None)
        self.assertAlmostEqual(levels.rms, 4000 / 32768)
        self.assertFalse(analyse_track(levels, levels)["lowSignal"])

    def test_short_transients_are_protected_even_if_global_rms_is_low(self):
        original = AudioLevels(.1, .5, .2)
        # Very brief high peak OR quieter, sustained 100 ms event protects a stem.
        for levels in (AudioLevels(1e-5, .18, .003), AudioLevels(1e-5, .004, .002)):
            self.assertFalse(analyse_track(levels, original)["lowSignal"])

    def test_measuring_honours_cancellation(self):
        path = self.wav("input.wav", [40] * 8000)
        with self.assertRaises(pipeline.PipelineCancelled):
            measure_pcm(path, lambda: pipeline._check_cancelled(lambda: True))

    def test_residuals_skip_pitch_but_preserve_audio_and_sparse_drums(self):
        original = self.wav("original.wav", [1000, -1000] * 8000)
        residual = self.wav("residual.wav", [1, -1] * 8000)
        drums = self.wav("drums.wav", [6000, -6000] * 40 + [0] * 15920)
        sources = [("vocals", residual), ("drums", drums), ("bass", residual), ("piano", original)]
        published = []
        with patch.object(pipeline, "_check_dependencies"), \
                patch.object(pipeline, "_model_environment", return_value={}), \
                patch.object(pipeline, "_separate_audio", return_value=sources), \
                patch.object(pipeline, "_transcribe_audio", return_value=([], [])) as infer:
            result = pipeline.run_pipeline(original, self.root / "out", {"separationModel": "htdemucs_6s"},
                                           lambda *args: None, published.append, lambda: False)
        self.assertEqual(infer.call_count, 1)
        self.assertEqual(infer.call_args.args[0], original)
        self.assertEqual(len(published), 4)
        vocal, drum, bass, piano = result["tracks"]
        for track in (vocal, bass):
            self.assertEqual(track["notes"], [])
            self.assertTrue(track["analysis"]["autoTranscriptionSkipped"])
            self.assertTrue(Path(track["audioPath"]).is_file())
        self.assertFalse(drum["analysis"]["lowSignal"])
        self.assertEqual(drum["transcriptionStatus"], "unsupported")
        self.assertFalse(piano["analysis"]["autoTranscriptionSkipped"])

    def test_skipped_residual_does_not_mask_failure_of_only_meaningful_track(self):
        original = self.wav("original.wav", [1000] * 8000)
        residual = self.wav("residual.wav", [1] * 8000)
        published = []
        with patch.object(pipeline, "_check_dependencies"), \
                patch.object(pipeline, "_model_environment", return_value={}), \
                patch.object(pipeline, "_separate_audio", return_value=[("vocals", residual), ("other", original)]), \
                patch.object(pipeline, "_transcribe_audio", side_effect=pipeline.PipelineError("broken model")):
            with self.assertRaisesRegex(pipeline.PipelineError, "broken model"):
                pipeline.run_pipeline(original, self.root / "out", {}, lambda *args: None,
                                      published.append, lambda: False)
        self.assertEqual(len(published), 2)
        self.assertEqual(published[1]["transcriptionStatus"], "failed")


if __name__ == "__main__":
    unittest.main()
