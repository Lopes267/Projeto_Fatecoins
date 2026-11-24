"""Chave de acesso do serviço online (variável CHAVE_ACESSO)."""
import json
import socket
import threading
import time
import urllib.error
import urllib.request

import pytest
import uvicorn
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect

from backend.servidor import COOKIE, criar_app

CHAVE = "chave-de-teste-123"


class _SemRedirecionar(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


abrir = urllib.request.build_opener(_SemRedirecionar).open


@pytest.fixture(scope="module")
def servidor(tmp_path_factory):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        porta = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(criar_app(tmp_path_factory.mktemp("s"), chave=CHAVE),
                                        host="127.0.0.1", port=porta, log_level="warning"))
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    while not srv.started:
        time.sleep(0.05)
    yield f"127.0.0.1:{porta}"
    srv.should_exit = True
    t.join(5)


def _status(url, cookie=None):
    req = urllib.request.Request(url, headers={"Cookie": f"{COOKIE}={cookie}"} if cookie else {})
    try:
        with abrir(req) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def test_sem_chave_pede_a_chave(servidor):
    for caminho in ("/", "/captura", "/teste/ar-viewer"):
        codigo, _, corpo = _status(f"http://{servidor}{caminho}")
        assert codigo == 401 and b"chave de acesso" in corpo.lower()
    codigo, _, corpo = _status(f"http://{servidor}/api/sessoes")
    assert codigo == 401 and json.loads(corpo) == {"erro": "chave de acesso"}


def test_publicos_abrem_sem_chave(servidor):
    for caminho in ("/saude", "/web/captura.js", "/web/visualizador.js", "/site/ar-viewer.js"):
        assert _status(f"http://{servidor}{caminho}")[0] == 200, caminho


def test_chave_certa_vira_cookie_e_sai_do_endereco(servidor):
    codigo, cab, _ = _status(f"http://{servidor}/teste/ar-viewer?glb=%2Fsessoes%2Fx%2Fmodelo.glb&chave={CHAVE}")
    assert codigo == 303
    assert cab["location"] == "/teste/ar-viewer?glb=%2Fsessoes%2Fx%2Fmodelo.glb"
    assert f"{COOKIE}={CHAVE}" in cab["set-cookie"] and "httponly" in cab["set-cookie"].lower()
    assert _status(f"http://{servidor}/", cookie=CHAVE)[0] == 200
    assert _status(f"http://{servidor}/api/sessoes", cookie=CHAVE)[0] == 200


def test_chave_errada_e_redirecionamento_para_fora(servidor):
    codigo, _, corpo = _status(f"http://{servidor}/?chave=errada")
    assert codigo == 401 and "Chave errada".encode() in corpo
    assert _status(f"http://{servidor}/", cookie="errada")[0] == 401
    codigo, cab, _ = _status(f"http://{servidor}//exemplo.com?chave={CHAVE}")
    assert codigo == 303 and cab["location"].startswith("/exemplo.com")


def test_websocket_exige_a_chave(servidor):
    for rota in ("/ws/captura", "/ws/visualizador"):
        with pytest.raises(InvalidStatus):
            connect(f"ws://{servidor}{rota}", open_timeout=5)
    with connect(f"ws://{servidor}/ws/visualizador?chave={CHAVE}") as ws:
        assert json.loads(ws.recv(5))["tipo"] == "ola"
    with connect(f"ws://{servidor}/ws/captura",
                 additional_headers={"Cookie": f"{COOKIE}={CHAVE}"}) as ws:
        ws.send(json.dumps({"tipo": "iniciar"}))
        assert json.loads(ws.recv(10))["tipo"] == "sessao"
