#!/usr/bin/env python3
"""Puente de reconocimiento de voz NVIDIA Parakeet (NVCF) para Organima.

Contrato con el consumidor `src/voice-agents.ts`:

- Entrada: audio PCM 16 bits little-endian, 16 kHz, mono, por stdin binario.
- Salida: eventos JSON, uno por línea, por stdout, con flush inmediato:
  ``{"type": "transcript", "text": "...", "final": true|false}`` y
  ``{"type": "error", "code": "NOMBRE_DE_GRPC_STATUS"}``.
- Cierre: el fin de stdin cierra el stream; SIGTERM/SIGINT cancelan el canal y el
  proceso termina en menos de dos segundos (el servidor Node envía SIGKILL a los
  1500 ms, así que el cierre real ocurre bastante antes).

Salida cerrada: sólo se emiten esos dos tipos de evento. No se anuncia ninguna
conexión confirmada antes de que el servidor responda, y ningún error incluye
mensajes del servidor, metadata, credenciales ni tracebacks: sólo el nombre del
código gRPC.

No hay respaldo a navegador ni a ningún otro transcriptor.

Pruebas offline: `test/asr-bridge.test.py` (sin red, con dobles de las
dependencias).

Uso:
    runtime/nvidia-py/bin/python -u scripts/nvidia-asr-bridge.py < audio.pcm
"""

from __future__ import annotations

import json
import os
import queue
import signal
import sys
import threading
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Mapping, Optional, Tuple

__all__ = [
    "AUDIO_CHANNEL_COUNT",
    "BridgeError",
    "BridgeSettings",
    "CHUNK_BYTES",
    "DEFAULT_ASR_URI",
    "DEFAULT_FUNCTION_ID",
    "DEFAULT_LANGUAGE_CODE",
    "EXIT_CONFIG",
    "EXIT_ERROR",
    "EXIT_OK",
    "GRPC_TIMEOUT_SECONDS",
    "QUEUE_MAXSIZE",
    "RivaModules",
    "SAMPLE_RATE_HERTZ",
    "SHUTDOWN_GRACE_SECONDS",
    "SHUTDOWN_POLL_SECONDS",
    "STREAM_END",
    "ShutdownController",
    "TranscriptExtractor",
    "build_auth_metadata",
    "build_recognition_config",
    "build_streaming_config",
    "emit_event",
    "encode_event",
    "error_event",
    "iter_queued_chunks",
    "iter_requests",
    "load_riva_modules",
    "main",
    "open_streaming_call",
    "read_audio_chunks",
    "run_bridge",
    "settings_from_environ",
    "status_code_name",
]

# ── Contrato fijo ─────────────────────────────────────────────────────────────
DEFAULT_ASR_URI = "grpc.nvcf.nvidia.com:443"
DEFAULT_FUNCTION_ID = "71203149-d3b7-4460-8231-1be2543a1fca"
DEFAULT_LANGUAGE_CODE = "es-US"
SAMPLE_RATE_HERTZ = 16000
AUDIO_CHANNEL_COUNT = 1
#: 100 ms de PCM16LE a 16 kHz mono: 16000 muestras/s * 2 bytes / 10.
CHUNK_BYTES = 3200
GRPC_TIMEOUT_SECONDS = 300.0
#: Cota de cierre tras una señal. El consumidor Node envía SIGKILL a los 1500 ms.
SHUTDOWN_GRACE_SECONDS = 1.0
SHUTDOWN_POLL_SECONDS = 0.02
QUEUE_MAXSIZE = 64
READER_JOIN_SECONDS = 0.25

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CONFIG = 2

#: Códigos de error permitidos: siempre nombres de `grpc.StatusCode`.
ERROR_CODE_UNKNOWN = "UNKNOWN"
ERROR_CODE_MISSING_CREDENTIAL = "UNAUTHENTICATED"
ERROR_CODE_STDIN = "INTERNAL"

#: Centinela que marca el fin de stdin dentro de la cola.
STREAM_END = object()

#: Serializa los writes a stdout entre el hilo lector y el hilo gRPC.
STDOUT_LOCK = threading.Lock()


class BridgeError(Exception):
    """Fallo local del puente. `code` es siempre un nombre de `grpc.StatusCode`."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class BridgeSettings:
    """Configuración efectiva del puente, ya saneada."""

    api_key: str
    function_id: str = DEFAULT_FUNCTION_ID
    uri: str = DEFAULT_ASR_URI
    language_code: str = DEFAULT_LANGUAGE_CODE
    sample_rate_hertz: int = SAMPLE_RATE_HERTZ
    timeout_seconds: float = GRPC_TIMEOUT_SECONDS


@dataclass(frozen=True)
class RivaModules:
    """Dependencias de `nvidia-riva-client` cargadas en un solo punto.

    Se inyectan en las pruebas para ejercitar la construcción de mensajes con
    los protobuf reales sin abrir ningún canal.
    """

    riva: Any
    proto: Any
    audio: Any
    grpc: Any


def load_riva_modules() -> RivaModules:
    """Carga gRPC y `riva.client` de forma diferida.

    El puente debe poder arrancar y reportar un error de configuración sin el
    stack de gRPC disponible, así que nada de esto se importa al cargar el módulo.
    """
    import grpc  # importación diferida deliberada
    import riva.client as riva_client
    from riva.client.proto import riva_asr_pb2, riva_audio_pb2

    return RivaModules(
        riva=riva_client,
        proto=riva_asr_pb2,
        audio=riva_audio_pb2,
        grpc=grpc,
    )


def settings_from_environ(environ: Mapping[str, str]) -> BridgeSettings:
    """Lee la credencial del entorno (nunca de `.env`) y valida lo indispensable."""
    api_key = (environ.get("NVIDIA_API_KEY") or "").strip()
    if not api_key:
        raise BridgeError(ERROR_CODE_MISSING_CREDENTIAL, "falta NVIDIA_API_KEY")
    function_id = (environ.get("NVIDIA_ASR_FUNCTION_ID") or "").strip() or DEFAULT_FUNCTION_ID
    return BridgeSettings(api_key=api_key, function_id=function_id)


def build_auth_metadata(api_key: str, function_id: str) -> List[Tuple[str, str]]:
    """Metadata gRPC de NVCF. No se registra ni se imprime nunca."""
    return [("authorization", f"Bearer {api_key}"), ("function-id", function_id)]


def build_recognition_config(
    settings: BridgeSettings, modules: Optional[RivaModules] = None
) -> Any:
    """Configuración de reconocimiento: PCM lineal 16 kHz mono en español."""
    modules = modules or load_riva_modules()
    return modules.proto.RecognitionConfig(
        encoding=modules.audio.AudioEncoding.LINEAR_PCM,
        sample_rate_hertz=settings.sample_rate_hertz,
        language_code=settings.language_code,
        audio_channel_count=AUDIO_CHANNEL_COUNT,
        enable_automatic_punctuation=True,
        max_alternatives=1,
    )


def build_streaming_config(
    recognition_config: Any, modules: Optional[RivaModules] = None
) -> Any:
    """Configuración de streaming con resultados parciales habilitados."""
    modules = modules or load_riva_modules()
    return modules.proto.StreamingRecognitionConfig(
        config=recognition_config,
        interim_results=True,
    )


def iter_requests(
    streaming_config: Any, audio_chunks: Iterator[bytes], modules: Optional[RivaModules] = None
) -> Iterator[Any]:
    """Primer mensaje: la configuración. Después: sólo audio."""
    modules = modules or load_riva_modules()
    yield modules.proto.StreamingRecognizeRequest(streaming_config=streaming_config)
    for chunk in audio_chunks:
        if chunk:
            yield modules.proto.StreamingRecognizeRequest(audio_content=chunk)


def read_audio_chunks(buffer: Any, chunk_bytes: int = CHUNK_BYTES) -> Iterator[bytes]:
    """Lee como máximo 100 ms por vuelta con `read1` hasta el fin de stdin."""
    while True:
        chunk = buffer.read1(chunk_bytes)
        if not chunk:
            return
        yield chunk


def iter_queued_chunks(
    chunks: "queue.Queue",
    stop_event: Optional[threading.Event] = None,
    poll_seconds: float = 0.2,
) -> Iterator[bytes]:
    """Traduce la cola del hilo lector en un iterable para gRPC.

    El centinela `STREAM_END` cierra el stream (half-close). Una señal de parada
    también lo cierra: se sondea la cola para no quedar bloqueado para siempre.
    """
    while True:
        if stop_event is not None and stop_event.is_set():
            return
        try:
            item = chunks.get(timeout=poll_seconds)
        except queue.Empty:
            continue
        if item is STREAM_END:
            return
        yield item


class TranscriptExtractor:
    """Traduce respuestas de Riva en eventos `transcript`.

    - No pierde parciales: recorre todos los resultados de cada respuesta y emite
      el primer alternative de cada uno.
    - No duplica finales: descarta un final idéntico al último emitido mientras no
      haya mediado una parcial, porque el servidor repite el final hasta que llega
      audio nuevo.
    - Un final idéntico separado por una parcial sí se emite: es una frase repetida
      de verdad.
    """

    def __init__(self) -> None:
        self._last_final_text: Optional[str] = None
        self._interim_since_final = False

    def events_for_response(self, response: Any) -> List[Dict[str, Any]]:
        events: List[Dict[str, Any]] = []
        for result in getattr(response, "results", None) or ():
            alternatives = getattr(result, "alternatives", None) or ()
            if not alternatives:
                continue
            text = (getattr(alternatives[0], "transcript", "") or "").strip()
            if not text:
                continue
            if bool(getattr(result, "is_final", False)):
                if text == self._last_final_text and not self._interim_since_final:
                    continue
                self._last_final_text = text
                self._interim_since_final = False
                events.append({"type": "transcript", "text": text, "final": True})
            else:
                self._interim_since_final = True
                events.append({"type": "transcript", "text": text, "final": False})
        return events


def status_code_name(exc: BaseException, default: str = ERROR_CODE_UNKNOWN) -> str:
    """Nombre de `grpc.StatusCode` del error, sin exponer su mensaje."""
    code = getattr(exc, "code", None)
    if callable(code):
        try:
            code = code()
        except Exception:
            return default
    name = getattr(code, "name", None)
    if isinstance(name, str) and name and name.isupper():
        return name
    return default


def error_event(exc: BaseException) -> Dict[str, str]:
    """Evento de error cerrado: sólo `type` y el nombre del código gRPC."""
    return {"type": "error", "code": status_code_name(exc)}


def encode_event(event: Mapping[str, Any]) -> str:
    """Una línea JSON, sin escapes innecesarios para el español."""
    return json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"


def emit_event(
    event: Mapping[str, Any], stream: Any, lock: Optional[threading.Lock] = None
) -> None:
    """Escribe un evento y lo vacía de inmediato."""
    line = encode_event(event)
    if lock is None:
        stream.write(line)
        stream.flush()
        return
    with lock:
        stream.write(line)
        stream.flush()


def _emit_safely(event: Mapping[str, Any], stream: Any) -> bool:
    """Escribe un evento sin propagar fallos de escritura (stdout roto).

    Devuelve si el evento llegó a escribirse. Si el consumidor ya murió no hay a
    quién reportar, y menos aún un traceback que ensucie stderr.
    """
    try:
        emit_event(event, stream, STDOUT_LOCK)
        return True
    except Exception:
        return False


class ShutdownController:
    """Cancelación cooperativa del canal gRPC, acotada en el tiempo."""

    def __init__(
        self,
        stop_event: Optional[threading.Event] = None,
        grace_seconds: float = SHUTDOWN_GRACE_SECONDS,
    ) -> None:
        self.event = stop_event if stop_event is not None else threading.Event()
        self.grace_seconds = float(grace_seconds)
        self.requested = False
        self._lock = threading.Lock()
        self._call: Any = None
        self._cancelled = False

    def attach(self, call: Any) -> None:
        """Registra la llamada en curso; si ya se pidió parar, la cancela."""
        with self._lock:
            self._call = call
            must_cancel = self.requested
        if must_cancel:
            self.cancel()

    def request_stop(self) -> None:
        """Marca la parada, despierta a los hilos y cancela el canal."""
        with self._lock:
            self.requested = True
        self.event.set()
        self.cancel()

    def cancel(self) -> None:
        """Cancela el canal una sola vez; nunca propaga errores de cancelación."""
        with self._lock:
            target = self._call
            if target is None or self._cancelled:
                return
            self._cancelled = True
        try:
            target.cancel()
        except Exception:
            pass


def open_streaming_call(
    settings: BridgeSettings,
    audio_chunks: Iterator[bytes],
    *,
    timeout_seconds: Optional[float] = None,
    modules: Optional[RivaModules] = None,
) -> Any:
    """Abre el canal TLS de NVCF y devuelve el iterable cancelable de respuestas.

    La metadata viaja por llamada (una sola vez): la credencial no se duplica en el
    canal ni se registra en ningún lado.
    """
    modules = modules or load_riva_modules()
    timeout = settings.timeout_seconds if timeout_seconds is None else timeout_seconds
    streaming_config = build_streaming_config(
        build_recognition_config(settings, modules), modules
    )
    requests = iter_requests(streaming_config, audio_chunks, modules)
    auth = modules.riva.Auth(uri=settings.uri, use_ssl=True)
    service = modules.riva.ASRService(auth)
    return service.stub.StreamingRecognize(
        requests,
        metadata=build_auth_metadata(settings.api_key, settings.function_id),
        timeout=timeout,
    )


def _default_stdin() -> Any:
    buffer = getattr(sys.stdin, "buffer", None)
    return sys.stdin if buffer is None else buffer


def _hard_exit(code: int) -> None:
    """Corta el proceso sin esperar hilos que ignoren la cancelación."""
    try:
        sys.stdout.flush()
    except Exception:
        pass
    os._exit(code)


def _flush(stream: Any) -> None:
    try:
        stream.flush()
    except Exception:
        pass


def _warn(detail: str) -> None:
    """Diagnóstico local por stderr: nunca credenciales ni tracebacks."""
    try:
        sys.stderr.write(f"nvidia-asr-bridge: {detail}\n")
        sys.stderr.flush()
    except Exception:
        pass


def _install_signal_handlers(controller: ShutdownController) -> None:
    def handler(signum: int, frame: Any) -> None:  # noqa: ARG001 - firma de signal
        controller.request_stop()

    for name in ("SIGTERM", "SIGINT"):
        signum = getattr(signal, name, None)
        if signum is None:
            continue
        try:
            signal.signal(signum, handler)
        except (ValueError, OSError, RuntimeError):
            continue


def _drain(chunks: "queue.Queue") -> None:
    """Vacía la cola al cerrar para que el hilo lector no quede bloqueado."""
    while True:
        try:
            chunks.get_nowait()
        except queue.Empty:
            return


def run_bridge(
    *,
    environ: Optional[Mapping[str, str]] = None,
    stdin: Any = None,
    stdout: Any = None,
    open_call: Optional[Any] = None,
    stop_event: Optional[threading.Event] = None,
    install_signal_handlers: bool = True,
    chunk_bytes: int = CHUNK_BYTES,
    hard_exit: Optional[Any] = None,
) -> int:
    """Ejecuta el puente completo. Devuelve el código de salida del proceso."""
    environ = os.environ if environ is None else environ
    stdin = _default_stdin() if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    opener = open_streaming_call if open_call is None else open_call
    exit_hard = _hard_exit if hard_exit is None else hard_exit

    try:
        settings = settings_from_environ(environ)
    except BridgeError as exc:
        _emit_safely({"type": "error", "code": exc.code}, stdout)
        _warn(exc.detail)
        return EXIT_CONFIG

    controller = ShutdownController(stop_event)
    stop = controller.event
    done = threading.Event()
    chunks: "queue.Queue" = queue.Queue(maxsize=QUEUE_MAXSIZE)
    reader_failures: List[BaseException] = []
    reported: List[str] = []
    reported_lock = threading.Lock()

    def report_error(code: str) -> None:
        with reported_lock:
            if reported:
                return
            reported.append(code)
        _emit_safely({"type": "error", "code": code}, stdout)

    def reader() -> None:
        try:
            for chunk in read_audio_chunks(stdin, chunk_bytes):
                if done.is_set():
                    return
                chunks.put(chunk)
        except Exception as exc:  # noqa: BLE001 - se reporta como error cerrado
            # Si ya se pidió parar, o el stream ya cerró, el fallo de lectura es
            # colateral del cierre (Node destruye stdin y manda SIGTERM a la vez),
            # no una falla del puente que deba llegar al navegador.
            if not (controller.requested or done.is_set()):
                reader_failures.append(exc)
        finally:
            chunks.put(STREAM_END)

    def worker() -> None:
        extractor = TranscriptExtractor()
        try:
            call = opener(
                settings,
                iter_queued_chunks(chunks, stop),
                timeout_seconds=settings.timeout_seconds,
            )
        except BridgeError as exc:
            report_error(exc.code)
            done.set()
            return
        except Exception as exc:  # noqa: BLE001 - se reporta como error cerrado
            report_error(status_code_name(exc))
            done.set()
            return
        controller.attach(call)
        try:
            for response in call:
                for event in extractor.events_for_response(response):
                    if not _emit_safely(event, stdout):
                        # stdout cerrado: el consumidor murió, no hay a quién reportar.
                        return
        except Exception as exc:  # noqa: BLE001 - se reporta como error cerrado
            if not controller.requested:
                report_error(status_code_name(exc))
        finally:
            done.set()

    reader_thread = threading.Thread(target=reader, name="asr-stdin", daemon=True)
    worker_thread = threading.Thread(target=worker, name="asr-grpc", daemon=True)

    if install_signal_handlers and threading.current_thread() is threading.main_thread():
        _install_signal_handlers(controller)

    reader_thread.start()
    worker_thread.start()

    try:
        while worker_thread.is_alive() and not controller.requested:
            if stop.is_set():
                controller.request_stop()
                break
            worker_thread.join(SHUTDOWN_POLL_SECONDS)
    finally:
        _drain(chunks)

    if controller.requested:
        worker_thread.join(controller.grace_seconds)
        if worker_thread.is_alive():
            _flush(stdout)
            exit_hard(EXIT_OK)
    else:
        worker_thread.join()

    reader_thread.join(READER_JOIN_SECONDS)
    _flush(stdout)

    if reported:
        return EXIT_ERROR
    if reader_failures and not controller.requested:
        report_error(ERROR_CODE_STDIN)
        _flush(stdout)
        return EXIT_ERROR
    return EXIT_OK


def main() -> int:
    """Punto de entrada del proceso."""
    return run_bridge()


if __name__ == "__main__":
    sys.exit(main())
