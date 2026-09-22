#!/usr/bin/env python3
"""Pruebas offline del puente NVIDIA ASR.

No tocan la red: usan los protobuf reales de `nvidia-riva-client` para validar la
construcción de mensajes y dobles locales para el canal gRPC.

Correr de verdad (el descubrimiento automático no puede importar este nombre de
archivo; ver la nota del final):

    runtime/nvidia-py/bin/python test/asr-bridge.test.py
"""

from __future__ import annotations

import importlib.util
import inspect
import io
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

# Las pruebas cargan el puente por ruta: no dejan `__pycache__` en el repo.
sys.dont_write_bytecode = True

REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = REPO_ROOT / "scripts" / "nvidia-asr-bridge.py"

_SECRET = "nvapi-ENV-DE-PRUEBA-no-real-9f3a"


def _load_bridge() -> Any:
    spec = importlib.util.spec_from_file_location("nvidia_asr_bridge", BRIDGE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


bridge = _load_bridge()
MODULES = bridge.load_riva_modules()


# ── Dobles ────────────────────────────────────────────────────────────────────
def result(transcript: str, is_final: bool) -> Any:
    return SimpleNamespace(
        alternatives=[SimpleNamespace(transcript=transcript)], is_final=is_final
    )


def response(*results: Any) -> Any:
    return SimpleNamespace(results=list(results))


class RecordingStream(io.StringIO):
    """stdout falso que cuenta los flush (el contrato pide flush inmediato)."""

    def __init__(self) -> None:
        super().__init__()
        self.flushes = 0

    def flush(self) -> None:  # type: ignore[override]
        self.flushes += 1
        super().flush()

    def events(self) -> List[Dict[str, Any]]:
        return [json.loads(line) for line in self.getvalue().split("\n") if line]


class FakeStatus:
    def __init__(self, name: str) -> None:
        self.name = name


class FakeRpcError(Exception):
    """Imita un `grpc.RpcError`: `code()` devuelve un StatusCode."""

    def __init__(self, name: str, message: str = "detalle del servidor") -> None:
        super().__init__(message)
        self._name = name

    def code(self) -> FakeStatus:
        return FakeStatus(self._name)


class FakeCall:
    """Llamada streaming falsa: consume los chunks y produce respuestas dadas."""

    def __init__(self, responses: List[Any]) -> None:
        self._responses = list(responses)
        self._chunks: Any = None
        self.cancelled = False
        self.received: List[bytes] = []

    def __iter__(self) -> Any:
        if self._chunks is not None:
            self.received = list(self._chunks)
        for item in self._responses:
            yield item

    def bind_chunks(self, chunks: Any) -> None:
        self._chunks = chunks

    def cancel(self) -> None:
        self.cancelled = True


class BlockingCall:
    """Itera hasta que se cancele y entonces falla, como un canal real."""

    def __init__(self, first: Any) -> None:
        self._first = first
        self._cancelled = threading.Event()
        self.cancelled = False

    def __iter__(self) -> Any:
        yield self._first
        self._cancelled.wait(5.0)
        raise FakeRpcError("CANCELLED")

    def cancel(self) -> None:
        self.cancelled = True
        self._cancelled.set()


class StuckCall:
    """Itera ignorando la cancelación: prueba la cota dura de cierre."""

    def __init__(self, first: Any) -> None:
        self._first = first
        self.cancelled = False

    def __iter__(self) -> Any:
        yield self._first
        time.sleep(5.0)

    def cancel(self) -> None:
        self.cancelled = True


class StdinRoto:
    """stdin que falla, como cuando Node destruye la tubería."""

    def __init__(self, delay: float = 0.0) -> None:
        self._delay = delay

    def read1(self, size: int) -> bytes:  # noqa: ARG002 - firma de BufferedReader
        if self._delay:
            time.sleep(self._delay)
        raise OSError("tubería rota")


class StreamRoto:
    """stdout que falla, como cuando el servidor Node ya murió."""

    def write(self, text: str) -> int:  # noqa: ARG002 - firma de TextIO
        raise BrokenPipeError("consumidor muerto")

    def flush(self) -> None:
        raise BrokenPipeError("consumidor muerto")


class FakeAuth:
    """Sustituye a `riva.client.Auth` sin abrir ningún canal."""

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.channel = object()


class FakeStub:
    """Registra la llamada tal como la haría el stub real."""

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    def StreamingRecognize(
        self, requests: Any, metadata: Any = None, timeout: Optional[float] = None
    ) -> Any:
        self.calls.append(
            {"requests": list(requests), "metadata": metadata, "timeout": timeout}
        )
        return FakeCall([])


class FakeASRService:
    """Sustituye a `riva.client.ASRService`: guarda el Auth y expone el stub."""

    last: Optional["FakeASRService"] = None

    def __init__(self, auth: FakeAuth) -> None:
        self.auth = auth
        self.stub = FakeStub()
        FakeASRService.last = self


def _fake_riva() -> Any:
    return SimpleNamespace(Auth=FakeAuth, ASRService=FakeASRService)


def _fake_modules() -> Any:
    """Protobuf reales + cliente Riva falso: cubre `open_streaming_call` sin red."""
    return bridge.RivaModules(
        riva=_fake_riva(), proto=MODULES.proto, audio=MODULES.audio, grpc=MODULES.grpc
    )


def _opener_returning(call: Any, seen: Dict[str, Any]) -> Any:
    """Devuelve un `open_call` que registra argumentos y liga los chunks."""

    def opener(settings: Any, chunks: Any, *, timeout_seconds: Optional[float] = None) -> Any:
        seen["settings"] = settings
        seen["timeout_seconds"] = timeout_seconds
        seen["chunks"] = chunks
        if hasattr(call, "bind_chunks"):
            call.bind_chunks(chunks)
        seen["call"] = call
        return call

    return opener


# ── Configuración y credenciales ──────────────────────────────────────────────
class SettingsTests(unittest.TestCase):
    def test_requires_api_key(self) -> None:
        for environ in ({}, {"NVIDIA_API_KEY": ""}, {"NVIDIA_API_KEY": "   "}):
            with self.subTest(environ=environ):
                with self.assertRaises(bridge.BridgeError) as ctx:
                    bridge.settings_from_environ(environ)
                self.assertEqual(ctx.exception.code, "UNAUTHENTICATED")

    def test_error_never_carries_the_credential(self) -> None:
        with self.assertRaises(bridge.BridgeError) as ctx:
            bridge.settings_from_environ({"NVIDIA_API_KEY": ""})
        self.assertNotIn(_SECRET, str(ctx.exception))

    def test_defaults_match_the_contract(self) -> None:
        settings = bridge.settings_from_environ({"NVIDIA_API_KEY": _SECRET})
        self.assertEqual(settings.api_key, _SECRET)
        self.assertEqual(settings.function_id, "71203149-d3b7-4460-8231-1be2543a1fca")
        self.assertEqual(settings.uri, "grpc.nvcf.nvidia.com:443")
        self.assertEqual(settings.language_code, "es-US")
        self.assertEqual(settings.sample_rate_hertz, 16000)
        self.assertEqual(settings.timeout_seconds, 300.0)

    def test_function_id_can_be_overridden_and_blank_falls_back(self) -> None:
        settings = bridge.settings_from_environ(
            {"NVIDIA_API_KEY": _SECRET, "NVIDIA_ASR_FUNCTION_ID": "otro-id"}
        )
        self.assertEqual(settings.function_id, "otro-id")
        blank = bridge.settings_from_environ(
            {"NVIDIA_API_KEY": _SECRET, "NVIDIA_ASR_FUNCTION_ID": "  "}
        )
        self.assertEqual(blank.function_id, bridge.DEFAULT_FUNCTION_ID)


class MetadataTests(unittest.TestCase):
    def test_metadata_is_bearer_plus_function_id(self) -> None:
        metadata = bridge.build_auth_metadata(_SECRET, "fn-1")
        self.assertEqual(
            metadata,
            [("authorization", f"Bearer {_SECRET}"), ("function-id", "fn-1")],
        )


class RecognitionConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = bridge.settings_from_environ({"NVIDIA_API_KEY": _SECRET})

    def test_recognition_config_uses_real_proto(self) -> None:
        config = bridge.build_recognition_config(self.settings, MODULES)
        self.assertIsInstance(config, MODULES.proto.RecognitionConfig)
        self.assertEqual(config.encoding, MODULES.audio.AudioEncoding.LINEAR_PCM)
        self.assertEqual(config.sample_rate_hertz, 16000)
        self.assertEqual(config.language_code, "es-US")
        self.assertEqual(config.audio_channel_count, 1)
        self.assertTrue(config.enable_automatic_punctuation)
        self.assertEqual(config.max_alternatives, 1)

    def test_streaming_config_enables_interim_results(self) -> None:
        config = bridge.build_recognition_config(self.settings, MODULES)
        streaming = bridge.build_streaming_config(config, MODULES)
        self.assertEqual(streaming.config, config)
        self.assertTrue(streaming.interim_results)

    def test_request_iterator_sends_config_first_and_then_audio(self) -> None:
        config = bridge.build_recognition_config(self.settings, MODULES)
        streaming = bridge.build_streaming_config(config, MODULES)
        chunks = [b"\x01\x02\x03\x04", b"\x05\x06"]
        requests = list(bridge.iter_requests(streaming, iter(chunks), MODULES))
        self.assertEqual(len(requests), 3)
        self.assertTrue(requests[0].HasField("streaming_config"))
        self.assertEqual(requests[0].audio_content, b"")
        self.assertEqual([r.audio_content for r in requests[1:]], chunks)
        for request in requests[1:]:
            self.assertFalse(request.HasField("streaming_config"))

    def test_request_iterator_skips_empty_chunks(self) -> None:
        streaming = bridge.build_streaming_config(
            bridge.build_recognition_config(self.settings, MODULES), MODULES
        )
        requests = list(bridge.iter_requests(streaming, iter([b"", b"\x09", b""]), MODULES))
        self.assertEqual([r.audio_content for r in requests[1:]], [b"\x09"])


# ── Lectura de audio ──────────────────────────────────────────────────────────
class AudioReaderTests(unittest.TestCase):
    def test_chunks_are_100ms_and_lossless(self) -> None:
        pcm = bytes(range(256)) * 50  # 12 800 bytes = 400 ms
        chunks = list(bridge.read_audio_chunks(io.BytesIO(pcm)))
        self.assertEqual([len(c) for c in chunks], [3200, 3200, 3200, 3200])
        self.assertEqual(b"".join(chunks), pcm)

    def test_short_tail_and_empty_input(self) -> None:
        pcm = b"\xaa" * 3300
        chunks = list(bridge.read_audio_chunks(io.BytesIO(pcm), 3200))
        self.assertEqual([len(c) for c in chunks], [3200, 100])
        self.assertEqual(list(bridge.read_audio_chunks(io.BytesIO(b""))), [])

    def test_queue_iterator_stops_at_sentinel_and_on_stop_event(self) -> None:
        chunks: "queue.Queue" = queue.Queue()
        chunks.put(b"a")
        chunks.put(bridge.STREAM_END)
        self.assertEqual(list(bridge.iter_queued_chunks(chunks, poll_seconds=0.01)), [b"a"])

        chunks.put(b"b")
        stopping = threading.Event()
        stopping.set()
        self.assertEqual(
            list(bridge.iter_queued_chunks(chunks, stopping, poll_seconds=0.01)), []
        )


# ── Extracción de eventos ─────────────────────────────────────────────────────
class TranscriptExtractorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.extractor = bridge.TranscriptExtractor()

    def test_partial_is_emitted_as_not_final(self) -> None:
        events = self.extractor.events_for_response(response(result("hola", False)))
        self.assertEqual(events, [{"type": "transcript", "text": "hola", "final": False}])

    def test_final_is_emitted_once(self) -> None:
        events = self.extractor.events_for_response(response(result("hola.", True)))
        self.assertEqual(events, [{"type": "transcript", "text": "hola.", "final": True}])

    def test_no_partial_is_lost_when_a_response_carries_several_results(self) -> None:
        events = self.extractor.events_for_response(
            response(result("hola", False), result("hola.", True))
        )
        self.assertEqual(
            events,
            [
                {"type": "transcript", "text": "hola", "final": False},
                {"type": "transcript", "text": "hola.", "final": True},
            ],
        )

    def test_empty_alternatives_or_blank_text_are_ignored(self) -> None:
        self.assertEqual(
            self.extractor.events_for_response(response(result("   ", False))), []
        )
        self.assertEqual(
            self.extractor.events_for_response(SimpleNamespace(results=[])), []
        )
        self.assertEqual(self.extractor.events_for_response(SimpleNamespace()), [])
        self.assertEqual(
            self.extractor.events_for_response(
                SimpleNamespace(results=[SimpleNamespace(alternatives=[])])
            ),
            [],
        )

    def test_text_is_stripped(self) -> None:
        events = self.extractor.events_for_response(response(result("  hola  ", False)))
        self.assertEqual(events, [{"type": "transcript", "text": "hola", "final": False}])

    def test_repeated_final_burst_is_not_duplicated(self) -> None:
        first = self.extractor.events_for_response(response(result("hola", True)))
        repeated = self.extractor.events_for_response(response(result("hola", True)))
        self.assertEqual(len(first), 1)
        self.assertEqual(repeated, [])

    def test_duplicate_final_inside_one_response_is_not_duplicated(self) -> None:
        events = self.extractor.events_for_response(
            response(result("hola", True), result("hola", True))
        )
        self.assertEqual(events, [{"type": "transcript", "text": "hola", "final": True}])

    def test_repeated_phrase_after_a_partial_is_emitted_again(self) -> None:
        self.extractor.events_for_response(response(result("hola", True)))
        self.extractor.events_for_response(response(result("hola", False)))
        events = self.extractor.events_for_response(response(result("hola", True)))
        self.assertEqual(events, [{"type": "transcript", "text": "hola", "final": True}])

    def test_distinct_finals_are_all_emitted(self) -> None:
        events = self.extractor.events_for_response(
            response(result("uno", True), result("dos", True))
        )
        self.assertEqual([e["text"] for e in events], ["uno", "dos"])


# ── Errores cerrados ──────────────────────────────────────────────────────────
class ErrorEncodingTests(unittest.TestCase):
    def test_grpc_status_name_is_used(self) -> None:
        self.assertEqual(bridge.status_code_name(FakeRpcError("UNAVAILABLE")), "UNAVAILABLE")
        self.assertEqual(bridge.status_code_name(FakeRpcError("PERMISSION_DENIED")), "PERMISSION_DENIED")

    def test_unknown_fallback_is_a_real_grpc_status(self) -> None:
        names = {code.name for code in MODULES.grpc.StatusCode}
        self.assertEqual(bridge.status_code_name(RuntimeError("vaya")), "UNKNOWN")
        self.assertIn(bridge.ERROR_CODE_UNKNOWN, names)
        self.assertIn(bridge.ERROR_CODE_MISSING_CREDENTIAL, names)
        self.assertIn(bridge.ERROR_CODE_STDIN, names)

    def test_broken_code_attribute_falls_back(self) -> None:
        class Roto(Exception):
            def code(self) -> Any:
                raise RuntimeError("sin código")

        self.assertEqual(bridge.status_code_name(Roto()), "UNKNOWN")

    def test_error_event_is_closed_and_never_leaks_the_message(self) -> None:
        exc = FakeRpcError("UNAUTHENTICATED", f"metadata={{authorization: Bearer {_SECRET}}}")
        event = bridge.error_event(exc)
        self.assertEqual(set(event), {"type", "code"})
        self.assertEqual(event["code"], "UNAUTHENTICATED")
        line = bridge.encode_event(event)
        self.assertNotIn(_SECRET, line)
        self.assertNotIn("Bearer", line)
        self.assertNotIn("Traceback", line)

    def test_transcript_events_survive_the_node_code_sanitizer(self) -> None:
        for code in ("UNAUTHENTICATED", "DEADLINE_EXCEEDED", "INTERNAL", "UNKNOWN"):
            with self.subTest(code=code):
                self.assertRegex(code, re.compile(r"^[A-Z_]+$"))

    def test_encode_event_is_one_json_line_with_unicode(self) -> None:
        line = bridge.encode_event({"type": "transcript", "text": "¡órale ñ!", "final": True})
        self.assertTrue(line.endswith("\n"))
        self.assertEqual(line.count("\n"), 1)
        self.assertIn("ñ", line)
        self.assertEqual(json.loads(line)["text"], "¡órale ñ!")

    def test_emit_event_flushes_every_line(self) -> None:
        stream = RecordingStream()
        bridge.emit_event({"type": "transcript", "text": "a", "final": False}, stream)
        bridge.emit_event({"type": "transcript", "text": "b", "final": True}, stream)
        self.assertEqual(stream.flushes, 2)
        self.assertEqual([e["text"] for e in stream.events()], ["a", "b"])


class ShutdownControllerTests(unittest.TestCase):
    def test_request_stop_sets_the_event_and_cancels_once(self) -> None:
        controller = bridge.ShutdownController()
        call = FakeCall([])
        controller.attach(call)
        controller.request_stop()
        controller.request_stop()
        self.assertTrue(controller.event.is_set())
        self.assertTrue(controller.requested)
        self.assertTrue(call.cancelled)

    def test_stop_before_attach_cancels_when_the_call_arrives(self) -> None:
        controller = bridge.ShutdownController()
        controller.request_stop()
        call = FakeCall([])
        controller.attach(call)
        self.assertTrue(call.cancelled)

    def test_grace_deadline_is_within_two_seconds(self) -> None:
        controller = bridge.ShutdownController()
        self.assertLessEqual(controller.grace_seconds, 2.0)


# ── Apertura del canal (protobuf reales + cliente falso, sin sockets) ─────────
class OpenStreamingCallTests(unittest.TestCase):
    def setUp(self) -> None:
        self.settings = bridge.settings_from_environ({"NVIDIA_API_KEY": _SECRET})
        self.modules = _fake_modules()

    def test_auth_is_tls_and_call_carries_metadata_and_timeout(self) -> None:
        call = bridge.open_streaming_call(
            self.settings, iter([b"\x01\x02"]), modules=self.modules
        )
        service = FakeASRService.last
        assert service is not None
        self.assertEqual(service.auth.kwargs, {"uri": "grpc.nvcf.nvidia.com:443", "use_ssl": True})
        self.assertIsInstance(call, FakeCall)
        recorded = service.stub.calls[0]
        self.assertEqual(
            recorded["metadata"],
            [("authorization", f"Bearer {_SECRET}"), ("function-id", bridge.DEFAULT_FUNCTION_ID)],
        )
        self.assertEqual(recorded["timeout"], 300.0)

    def test_real_proto_requests_are_config_then_audio(self) -> None:
        bridge.open_streaming_call(self.settings, iter([b"\x01\x02", b"\x03"]), modules=self.modules)
        service = FakeASRService.last
        assert service is not None
        requests = service.stub.calls[0]["requests"]
        self.assertEqual(len(requests), 3)
        config = requests[0].streaming_config
        self.assertEqual(config.config.encoding, MODULES.audio.AudioEncoding.LINEAR_PCM)
        self.assertEqual(config.config.sample_rate_hertz, 16000)
        self.assertEqual(config.config.language_code, "es-US")
        self.assertTrue(config.config.enable_automatic_punctuation)
        self.assertTrue(config.interim_results)
        self.assertEqual([r.audio_content for r in requests[1:]], [b"\x01\x02", b"\x03"])

    def test_timeout_can_be_overridden_explicitly(self) -> None:
        bridge.open_streaming_call(
            self.settings, iter([]), timeout_seconds=5.0, modules=self.modules
        )
        service = FakeASRService.last
        assert service is not None
        self.assertEqual(service.stub.calls[0]["timeout"], 5.0)

    def test_returned_call_is_cancellable_by_the_controller(self) -> None:
        call = bridge.open_streaming_call(self.settings, iter([]), modules=self.modules)
        controller = bridge.ShutdownController()
        controller.attach(call)
        controller.request_stop()
        self.assertTrue(call.cancelled)

    def test_proto_service_exposes_bidirectional_streaming_recognize(self) -> None:
        service = MODULES.proto.DESCRIPTOR.services_by_name["RivaSpeechRecognition"]
        method = service.methods_by_name["StreamingRecognize"]
        self.assertTrue(method.client_streaming)
        self.assertTrue(method.server_streaming)

    def test_real_stub_callable_accepts_timeout_and_metadata(self) -> None:
        # Cableado contra el stub real de grpc sin abrir canal: si los nombres de
        # los kwargs cambian, la corrida real fallaría y esto lo delata antes.
        shape = inspect.signature(MODULES.grpc._channel._StreamStreamMultiCallable.__call__)
        for name in ("request_iterator", "timeout", "metadata"):
            self.assertIn(name, shape.parameters)
        # El objeto devuelto por una llamada streaming real es cancelable.
        self.assertTrue(hasattr(MODULES.grpc._channel._MultiThreadedRendezvous, "cancel"))


# ── Puente completo, con dobles ───────────────────────────────────────────────
class RunBridgeTests(unittest.TestCase):
    def test_missing_credential_reports_one_error_event_and_never_opens_a_call(self) -> None:
        def opener(*args: Any, **kwargs: Any) -> Any:
            raise AssertionError("no debe abrirse ningún canal sin credencial")

        stdout = RecordingStream()
        code = bridge.run_bridge(
            environ={},
            stdin=io.BytesIO(b""),
            stdout=stdout,
            open_call=opener,
            install_signal_handlers=False,
        )
        self.assertEqual(code, bridge.EXIT_CONFIG)
        self.assertEqual(stdout.events(), [{"type": "error", "code": "UNAUTHENTICATED"}])

    def test_full_flow_emits_jsonl_and_passes_contract_values(self) -> None:
        pcm = b"\x11\x22" * 3200  # 6400 bytes = 200 ms
        seen: Dict[str, Any] = {}
        call = FakeCall(
            [
                response(result("órale", False)),
                response(result("órale,", False), result("órale, qué tal.", True)),
                response(result("órale, qué tal.", True)),  # final repetido: se descarta
            ]
        )
        stdout = RecordingStream()
        code = bridge.run_bridge(
            environ={"NVIDIA_API_KEY": _SECRET},
            stdin=io.BytesIO(pcm),
            stdout=stdout,
            open_call=_opener_returning(call, seen),
            install_signal_handlers=False,
        )
        self.assertEqual(code, bridge.EXIT_OK)
        self.assertEqual(
            stdout.events(),
            [
                {"type": "transcript", "text": "órale", "final": False},
                {"type": "transcript", "text": "órale,", "final": False},
                {"type": "transcript", "text": "órale, qué tal.", "final": True},
            ],
        )
        # Al menos un flush por evento (el cierre añade uno más).
        self.assertGreaterEqual(stdout.flushes, len(stdout.events()))
        self.assertEqual(seen["timeout_seconds"], 300.0)
        self.assertEqual(seen["settings"].sample_rate_hertz, 16000)
        self.assertEqual([len(c) for c in call.received], [3200, 3200])
        self.assertEqual(b"".join(call.received), pcm)

    def test_grpc_error_becomes_a_closed_event_and_exit_one(self) -> None:
        def opener(settings: Any, chunks: Any, *, timeout_seconds: Optional[float] = None) -> Any:
            raise FakeRpcError("PERMISSION_DENIED", f"Bearer {_SECRET}")

        stdout = RecordingStream()
        code = bridge.run_bridge(
            environ={"NVIDIA_API_KEY": _SECRET},
            stdin=io.BytesIO(b""),
            stdout=stdout,
            open_call=opener,
            install_signal_handlers=False,
        )
        self.assertEqual(code, bridge.EXIT_ERROR)
        self.assertEqual(stdout.events(), [{"type": "error", "code": "PERMISSION_DENIED"}])
        self.assertNotIn(_SECRET, stdout.getvalue())

    def test_broken_stdout_does_not_propagate_nor_leak(self) -> None:
        call = FakeCall([response(result("hola", True))])
        code = bridge.run_bridge(
            environ={"NVIDIA_API_KEY": _SECRET},
            stdin=io.BytesIO(b""),
            stdout=StreamRoto(),
            open_call=_opener_returning(call, {}),
            install_signal_handlers=False,
        )
        self.assertEqual(code, bridge.EXIT_OK)

    def test_broken_stdout_on_config_error_does_not_propagate(self) -> None:
        code = bridge.run_bridge(
            environ={},
            stdin=io.BytesIO(b""),
            stdout=StreamRoto(),
            open_call=_opener_returning(FakeCall([]), {}),
            install_signal_handlers=False,
        )
        self.assertEqual(code, bridge.EXIT_CONFIG)

    def test_midstream_error_is_reported_once(self) -> None:
        class Explota:
            def __iter__(self) -> Any:
                yield response(result("uno", False))
                raise FakeRpcError("DEADLINE_EXCEEDED", f"Bearer {_SECRET}")

            def cancel(self) -> None:
                pass

        stdout = RecordingStream()
        code = bridge.run_bridge(
            environ={"NVIDIA_API_KEY": _SECRET},
            stdin=io.BytesIO(b""),
            stdout=stdout,
            open_call=_opener_returning(Explota(), {}),
            install_signal_handlers=False,
        )
        self.assertEqual(code, bridge.EXIT_ERROR)
        self.assertEqual(
            stdout.events(),
            [
                {"type": "transcript", "text": "uno", "final": False},
                {"type": "error", "code": "DEADLINE_EXCEEDED"},
            ],
        )

    def test_stdin_failure_is_an_internal_error(self) -> None:
        stdout = RecordingStream()
        code = bridge.run_bridge(
            environ={"NVIDIA_API_KEY": _SECRET},
            stdin=StdinRoto(),
            stdout=stdout,
            open_call=_opener_returning(FakeCall([]), {}),
            install_signal_handlers=False,
        )
        self.assertEqual(code, bridge.EXIT_ERROR)
        self.assertEqual(stdout.events(), [{"type": "error", "code": "INTERNAL"}])

    def test_stdin_failure_during_shutdown_is_not_an_error(self) -> None:
        # Node destruye stdin y manda SIGTERM a la vez: el fallo de lectura es
        # colateral del cierre, no una falla que deba llegar al navegador.
        stopping = threading.Event()
        call = BlockingCall(response(result("hola", False)))
        stdout = RecordingStream()
        result_box: List[int] = []

        runner = threading.Thread(
            target=lambda: result_box.append(
                bridge.run_bridge(
                    environ={"NVIDIA_API_KEY": _SECRET},
                    stdin=StdinRoto(delay=0.1),
                    stdout=stdout,
                    open_call=_opener_returning(call, {}),
                    stop_event=stopping,
                    install_signal_handlers=False,
                )
            ),
            daemon=True,
        )
        runner.start()
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not call.cancelled:
            stopping.set()
            time.sleep(0.01)
        runner.join(3.0)

        self.assertFalse(runner.is_alive())
        self.assertEqual(result_box, [bridge.EXIT_OK])
        self.assertEqual(
            stdout.events(), [{"type": "transcript", "text": "hola", "final": False}]
        )

    def test_signal_style_stop_cancels_silently_within_the_grace(self) -> None:
        stopping = threading.Event()
        call = BlockingCall(response(result("hola", False)))
        stdout = RecordingStream()
        result_box: List[int] = []

        runner = threading.Thread(
            target=lambda: result_box.append(
                bridge.run_bridge(
                    environ={"NVIDIA_API_KEY": _SECRET},
                    stdin=io.BytesIO(b""),
                    stdout=stdout,
                    open_call=_opener_returning(call, {}),
                    stop_event=stopping,
                    install_signal_handlers=False,
                )
            ),
            daemon=True,
        )
        start = time.monotonic()
        runner.start()
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and len(stdout.events()) < 1:
            time.sleep(0.01)
        self.assertEqual(len(stdout.events()), 1, "debió emitirse la parcial antes de parar")
        stopping.set()
        runner.join(3.0)
        elapsed = time.monotonic() - start

        self.assertFalse(runner.is_alive(), "el puente no terminó tras la parada")
        self.assertEqual(result_box, [bridge.EXIT_OK])
        self.assertLess(elapsed, 2.0)
        self.assertTrue(call.cancelled, "debió cancelarse el canal")
        self.assertEqual(
            stdout.events(), [{"type": "transcript", "text": "hola", "final": False}]
        )

    def test_uncooperative_stream_is_cut_within_the_grace(self) -> None:
        stopping = threading.Event()
        call = StuckCall(response(result("hola", False)))
        stdout = RecordingStream()
        hard_exits: List[int] = []
        result_box: List[int] = []

        runner = threading.Thread(
            target=lambda: result_box.append(
                bridge.run_bridge(
                    environ={"NVIDIA_API_KEY": _SECRET},
                    stdin=io.BytesIO(b""),
                    stdout=stdout,
                    open_call=_opener_returning(call, {}),
                    stop_event=stopping,
                    install_signal_handlers=False,
                    hard_exit=hard_exits.append,
                )
            ),
            daemon=True,
        )
        start = time.monotonic()
        runner.start()
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and len(stdout.events()) < 1:
            time.sleep(0.01)
        stopping.set()
        runner.join(3.0)
        elapsed = time.monotonic() - start

        self.assertFalse(runner.is_alive(), "la cota de cierre no se respetó")
        self.assertLess(elapsed, 2.0)
        self.assertEqual(hard_exits, [bridge.EXIT_OK])
        self.assertTrue(call.cancelled)
        self.assertEqual(
            stdout.events(), [{"type": "transcript", "text": "hola", "final": False}]
        )


class EntryPointTests(unittest.TestCase):
    """Prueba el proceso real: mismo intérprete, sin red, sin credencial."""

    def _run(self, extra_env: Optional[Dict[str, str]] = None) -> "subprocess.CompletedProcess[str]":
        env = {"PATH": os.environ.get("PATH", "")}
        env.update(extra_env or {})
        return subprocess.run(
            [sys.executable, "-u", str(BRIDGE_PATH)],
            input=b"",
            capture_output=True,
            env=env,
            cwd=str(REPO_ROOT),
            timeout=30,
        )

    def test_entry_point_reports_missing_credential_without_traceback(self) -> None:
        completed = self._run()
        lines = [line for line in completed.stdout.decode().split("\n") if line]
        self.assertEqual(len(lines), 1, completed.stdout)
        event = json.loads(lines[0])
        self.assertEqual(event, {"type": "error", "code": "UNAUTHENTICATED"})
        self.assertNotEqual(completed.returncode, 0)
        self.assertNotIn("Traceback", completed.stderr.decode())
        self.assertNotIn(_SECRET, completed.stdout.decode())

    def test_entry_point_does_not_import_the_grpc_stack_eagerly(self) -> None:
        script = (
            "import importlib.util,sys;"
            f"spec=importlib.util.spec_from_file_location('b',{str(BRIDGE_PATH)!r});"
            "m=importlib.util.module_from_spec(spec);sys.modules['b']=m;spec.loader.exec_module(m);"
            "print('riva.client' in sys.modules)"
        )
        completed = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            env={"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"},
            cwd=str(REPO_ROOT),
            timeout=30,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr.decode())
        self.assertEqual(completed.stdout.decode().strip(), "False")


if __name__ == "__main__":
    # El descubrimiento de unittest no puede importar un archivo llamado
    # `asr-bridge.test.py` (nombre no es un identificador válido), así que esta
    # ejecución directa es la que corre las pruebas de verdad.
    unittest.main(verbosity=2)
