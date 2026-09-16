"""Adapter risk tests. Models are mocked; these do not claim model accuracy."""

from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import wave

from stemwork import pipeline


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.audio = self.root / "input.wav"
        self._write_wave(self.audio, frames=8000)
        self.progress = []
        self.tracks = []

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _write_wave(path, frames):
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\x00\x10" * frames)

    def _run(self, mode="transcribe_only", is_cancelled=lambda: False):
        with patch.object(pipeline, "_model_environment", return_value={}):
            return pipeline.run_pipeline(
                self.audio, self.root / "output", {"mode": mode, "bpm": 90},
                lambda *args: self.progress.append(args), self.tracks.append, is_cancelled,
            )

    def test_real_wave_duration_is_positive_and_original_is_retained(self):
        with patch.object(pipeline, "_check_dependencies"), \
                patch.object(pipeline, "_transcribe_audio", return_value=([], [])):
            result = self._run()
        self.assertEqual(result["durationSeconds"], 1.0)
        self.assertEqual(result["bpm"], 90)
        self.assertEqual(result["tracks"][0]["transcriptionStatus"], "completed")
        self.assertEqual(result["tracks"][0]["kind"], "other")
        self.assertTrue(Path(result["tracks"][0]["audioPath"]).is_file())
        self.assertIn("未进行自动节拍检测", result["warnings"][0])

    def test_zero_duration_wave_is_rejected_before_model_inference(self):
        self._write_wave(self.audio, frames=0)
        with patch.object(pipeline, "_check_dependencies"), \
                patch.object(pipeline, "_transcribe_audio") as transcription:
            with self.assertRaisesRegex(pipeline.PipelineError, "大于 0"):
                self._run()
        transcription.assert_not_called()

    def test_duration_limit_is_enforced_before_transcription(self):
        with patch.object(pipeline, "MAX_AUDIO_SECONDS", 0.5), \
                patch.object(pipeline, "_check_dependencies"), \
                patch.object(pipeline, "_transcribe_audio") as transcription:
            with self.assertRaisesRegex(pipeline.PipelineError, "30 分钟"):
                self._run()
        transcription.assert_not_called()

    def test_early_cancellation_does_not_start_models(self):
        with patch.object(pipeline, "_check_dependencies") as dependencies:
            with self.assertRaises(pipeline.PipelineCancelled):
                self._run(is_cancelled=lambda: True)
        dependencies.assert_not_called()

    def test_subprocess_is_reaped_when_cancelled(self):
        import os
        import re

        real_popen = subprocess.Popen
        processes = []
        handles = []
        log_path = self.root / "cancel.log"
        kernel32 = None
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel32.WaitForSingleObject.restype = wintypes.DWORD
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL

        def capture_process(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append((args[0], process, kwargs))
            return process

        leaf = "import os,time; print('LEAF_READY='+str(os.getpid()),flush=True); time.sleep(20)"
        script = (
            "import os,subprocess,sys,time; "
            "print('ROOT_READY='+str(os.getpid()),flush=True); "
            + (f"child=subprocess.Popen([sys.executable,'-c',{leaf!r}],stdout=sys.stdout,stderr=sys.stderr,creationflags=subprocess.CREATE_NO_WINDOW); "
               if os.name == "nt" else "")
            + "time.sleep(20)"
        )
        started = time.monotonic()

        def cancel_after_real_children_start():
            if not log_path.exists():
                return False
            output = log_path.read_text(encoding="utf-8", errors="replace")
            pids = re.findall(r"(?:ROOT|LEAF)_READY=(\d+)", output)
            expected = 2 if os.name == "nt" else 1
            if len(pids) < expected:
                # Bound test startup even on a broken interpreter.
                return time.monotonic() - started > 5
            if kernel32 and not handles:
                for pid in pids:
                    handle = kernel32.OpenProcess(0x00100000, False, int(pid))  # SYNCHRONIZE
                    self.assertTrue(handle, f"Test process {pid} should still be alive before cancellation")
                    handles.append(handle)
            return True

        try:
            with patch.object(pipeline.subprocess, "Popen", side_effect=capture_process):
                with self.assertRaises(pipeline.PipelineCancelled):
                    pipeline._run_process(
                        [sys.executable, "-c", script], log_path, cancel_after_real_children_start,
                    )
            self.assertIsNotNone(processes[0][1].poll())
            if kernel32:
                self.assertEqual(len(handles), 2, log_path.read_text(encoding="utf-8", errors="replace"))
                for handle in handles:
                    self.assertEqual(kernel32.WaitForSingleObject(handle, 1000), 0,
                                     "The real interpreter and its child must both exit")
                # Native cleanup creates no helper console/process at all.
                self.assertEqual(len(processes), 1)
                self.assertEqual(processes[0][2]["creationflags"], subprocess.CREATE_NO_WINDOW)
            # Windows refuses this if an orphan still holds the inherited log.
            log_path.unlink()
            self.assertFalse(log_path.exists())
            self.assertLess(time.monotonic() - started, 8)
        finally:
            if kernel32:
                for handle in handles:
                    kernel32.CloseHandle(handle)

    def test_nonzero_model_exit_keeps_diagnostic(self):
        with self.assertRaisesRegex(pipeline.PipelineError, "broken checkpoint"):
            pipeline._run_process(
                [sys.executable, "-c", "import sys; print('broken checkpoint'); sys.exit(7)"],
                self.root / "failure.log", lambda: False,
            )

    def test_missing_dependency_is_actionable(self):
        with patch.object(pipeline, "_run_process", side_effect=pipeline.PipelineError("Missing basic_pitch")):
            with self.assertRaisesRegex(pipeline.PipelineError, "STEMWORK_MODEL_PYTHON"):
                pipeline._check_dependencies("transcribe_only", self.root, {}, lambda: False)

    def test_total_transcription_failure_does_not_report_success(self):
        with patch.object(pipeline, "_check_dependencies"), \
                patch.object(pipeline, "_transcribe_audio", side_effect=pipeline.PipelineError("model unavailable")):
            with self.assertRaisesRegex(pipeline.PipelineError, "model unavailable"):
                self._run()
        self.assertEqual(self.tracks[0]["transcriptionStatus"], "failed")
        self.assertNotIn("done", [event[0] for event in self.progress])

    def test_drums_have_audio_without_fabricated_notes_and_other_is_labelled(self):
        sources = [(stem, self.audio) for stem in ("drums", "other")]
        with patch.object(pipeline, "_check_dependencies"), \
                patch.object(pipeline, "_separate_audio", return_value=sources), \
                patch.object(pipeline, "_transcribe_audio", return_value=([], [])) as transcription:
            result = self._run("demucs_basic_pitch")
        drums, other = result["tracks"]
        self.assertTrue(drums["isDrum"])
        self.assertEqual(drums["notes"], [])
        self.assertEqual(drums["transcriptionStatus"], "unsupported")
        self.assertTrue(drums["audioPath"])
        self.assertIn("混合轨", other["warnings"][0])
        self.assertEqual(transcription.call_count, 1)

    def test_cancellation_is_not_swallowed_as_failed_track(self):
        with patch.object(pipeline, "_check_dependencies"), \
                patch.object(pipeline, "_transcribe_audio", side_effect=pipeline.PipelineCancelled("stop")):
            with self.assertRaises(pipeline.PipelineCancelled):
                self._run()
        self.assertEqual(self.tracks, [])

    def test_invalid_note_events_and_padded_tail_cannot_escape_audio(self):
        events = [[-0.1, 2.0, 60, 0.5], [0.1, float("nan"), 60, 0.5],
                  [2.0, 3.0, 60, 0.7], [0.0, 0.2, 200, 0.5], None]
        notes, invalid = pipeline._notes_from_events(events, 1.0)
        self.assertEqual(invalid, 4)
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["startSeconds"], 0)
        self.assertEqual(notes[0]["durationSeconds"], 1)
        self.assertGreater(notes[0]["velocity"], 0)


if __name__ == "__main__":
    unittest.main()
