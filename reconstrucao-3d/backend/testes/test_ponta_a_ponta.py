"""
Ponta a ponta: servidor de verdade (uvicorn) + WebSocket + captura sintética
no formato do celular -> .glb baixado pela rota HTTP -> medido contra a
caneca verdadeira.

Os limites abaixo são uma trava contra piora (medidos em 24/11/2026 e com
folga), não uma especificação de qualidade: a especificação não define
números. Valores medidos estão no README.
"""
import json
import socket
import threading
import time
import urllib.request

import numpy as np
import pytest
import uvicorn
from websockets.sync.client import connect

from backend.reconstrucao import exportar
from backend.servidor import criar_app
from backend.sintetico import avaliar, gerar


def _porta_livre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def servidor(tmp_path_factory):
    pasta = tmp_path_factory.mktemp("sessoes")
    porta = _porta_livre()
    srv = uvicorn.Server(uvicorn.Config(criar_app(pasta), host="127.0.0.1", port=porta,
                                        log_level="warning", ws_max_size=16 * 1024 * 1024))
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"127.0.0.1:{porta}", pasta
    srv.should_exit = True
    t.join(5)


def _capturar(endereco, mensagens, modo="todos", intervalo=0.0):
    with connect(f"ws://{endereco}/ws/captura", max_size=None) as ws:
        ws.send(json.dumps({"tipo": "iniciar", "modo": modo, "raio": 0.25}))
        resp = json.loads(ws.recv(10))
        assert resp["tipo"] == "sessao"
        for m in mensagens:
            ws.send(m)
            if intervalo:
                time.sleep(intervalo)
        ws.send(json.dumps({"tipo": "finalizar"}))
        ultimo_estado = None
        while True:
            dados = json.loads(ws.recv(120))
            if dados["tipo"] == "estado":
                ultimo_estado = dados
            if dados["tipo"] == "pronto":
                return dados, ultimo_estado


def _baixar_e_medir(endereco, pronto):
    assert pronto["ok"], pronto
    with urllib.request.urlopen(f"http://{endereco}{pronto['arquivos']['glb']}") as r:
        assert r.headers["content-type"] == "model/gltf-binary"
        gltf, arr = exportar.ler_glb(r.read())
    extras = gltf["nodes"][0]["extras"]
    assert extras["escalaReal"] is True and extras["escaneado"] is True
    V = avaliar.para_mundo(arr["POSITION"].astype(float), extras["mundoDoModelo"])
    return avaliar.avaliar(V, arr["indices"].reshape(-1, 3)), extras, arr


def test_caneca_sem_ruido(servidor):
    endereco, _ = servidor
    pronto, estado = _capturar(endereco, gerar.quadros(n=90, ruido=False))
    a, extras, arr = _baixar_e_medir(endereco, pronto)
    print("\nsem ruído:", a)
    assert estado["integrados"] == 90 and estado["descartados"] == 0
    assert estado["sondas"]["batem"] is True and estado["sondas"]["inverter_y"] is False
    assert a["precisao_media_mm"] < 1.5 and a["precisao_p95_mm"] < 5
    assert a["cobertura_6mm"] > 0.98
    assert max(abs(e) for e in a["erro_medidas_mm"]) <= 5
    assert a["intrusos"] == 0
    # modelo no referencial do site: base em y = 0, centrado em x/z
    P = arr["POSITION"]
    assert abs(P[:, 1].min()) < 0.004 and abs(P[:, 0].min() + P[:, 0].max()) < 1e-4
    assert abs(extras["alturaCm"] - 9.5) <= 0.5


def test_caneca_com_ruido_e_deriva(servidor):
    endereco, _ = servidor
    pronto, estado = _capturar(endereco, gerar.quadros(n=90, ruido=True, seed=3))
    a, extras, _ = _baixar_e_medir(endereco, pronto)
    print("\ncom ruído:", a)
    assert estado["integrados"] == 90
    assert a["precisao_media_mm"] < 2.5 and a["precisao_p95_mm"] < 7
    assert a["cobertura_6mm"] > 0.80
    assert max(abs(e) for e in a["erro_medidas_mm"]) <= 6
    assert a["intrusos"] <= 10, "sobrou mesa ou a caixa vizinha"
    assert pronto["plano_de_apoio"] is True


def test_detecta_mapa_lido_com_y_invertido(servidor):
    """Se o navegador usar a outra convenção de y, as sondas avisam e a leitura se ajusta."""
    endereco, _ = servidor
    pronto, estado = _capturar(endereco, gerar.quadros(n=45, ruido=False, inverter_y=True))
    assert estado["sondas"]["inverter_y"] is True and estado["sondas"]["batem"] is True
    a, _, _ = _baixar_e_medir(endereco, pronto)
    print("\ny invertido:", a)
    assert a["precisao_media_mm"] < 1.5 and a["cobertura_6mm"] > 0.95


def test_tempo_real_descarta_atrasados_sem_acumular(servidor):
    """Quadros mais rápidos do que a fusão: descarta os velhos e a latência não cresce."""
    endereco, _ = servidor
    msgs = list(gerar.quadros(n=120, ruido=True, seed=5))
    pronto, estado = _capturar(endereco, msgs, modo="tempo-real", intervalo=0.002)
    print("\ntempo real:", {k: estado[k] for k in ("recebidos", "integrados", "descartados",
                                                     "latencia_ms", "integracao_ms")})
    assert estado["recebidos"] == 120
    assert estado["descartados"] > 0
    assert estado["integrados"] + estado["descartados"] == 120
    assert estado["latencia_ms"] < 150
    assert pronto["ok"]


def test_quadros_ruins_nao_derrubam_a_sessao(servidor):
    endereco, _ = servidor
    bons = list(gerar.quadros(n=30, ruido=False))
    ruins = [b"lixo", bons[0][:100], b"\xff" * 64]
    pronto, estado = _capturar(endereco, ruins + bons)
    assert estado["invalidos"] == 3 and estado["integrados"] == 30
    assert pronto["ok"]


def test_sem_alvo_responde_com_motivo(servidor):
    endereco, _ = servidor
    pronto, _ = _capturar(endereco, [])
    assert pronto["ok"] is False and "nenhum quadro" in pronto["motivo"]


def test_rotas_recusam_caminhos_estranhos(servidor):
    endereco, _ = servidor
    for caminho in ("/sessoes/../servidor.py", "/sessoes/20260101-000000/quadros",
                    "/sessoes/abc/modelo.glb"):
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(f"http://{endereco}{caminho}")
        assert e.value.code == 404
