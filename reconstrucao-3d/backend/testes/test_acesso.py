"""
Quem entra no serviço online: login do site (ID token do Firebase) e,
opcionalmente, a chave CHAVE_ACESSO. Os tokens daqui são assinados com uma
chave RSA de teste, no mesmo formato dos do Firebase (RS256, kid, aud, iss).
"""
import datetime as dt
import json
import socket
import threading
import time
import urllib.error
import urllib.request

import jwt
import pytest
import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect

from backend.acesso import Cookies, TokenInvalido, VerificadorFirebase
from backend.servidor import COOKIE_CHAVE, COOKIE_SESSAO, criar_app

CHAVE = "chave-de-teste-123"
PROJETO = "projeto-teste"
KID = "kid-teste"


def _par_rsa():
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nome = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "teste")])
    agora = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(nome).issuer_name(nome)
            .public_key(priv.public_key()).serial_number(1)
            .not_valid_before(agora - dt.timedelta(days=1)).not_valid_after(agora + dt.timedelta(days=1))
            .sign(priv, hashes.SHA256()))
    return priv, cert.public_bytes(serialization.Encoding.PEM).decode()


PRIV, PEM = _par_rsa()
OUTRA_PRIV, _ = _par_rsa()


def _token(sub="uid-lojista", aud=PROJETO, iss=None, exp_em=3600, kid=KID, chave=None, alg="RS256"):
    agora = int(time.time())
    dados = {"sub": sub, "aud": aud, "iss": iss or f"https://securetoken.google.com/{PROJETO}",
             "iat": agora - 10, "exp": agora + exp_em, "auth_time": agora - 10}
    return jwt.encode(dados, chave or PRIV, algorithm=alg, headers={"kid": kid})


def _verificador():
    return VerificadorFirebase(PROJETO, buscar=lambda: ({KID: PEM}, 3600))


# ---------- verificação do token ----------

def test_token_valido_devolve_o_uid():
    assert _verificador().verificar(_token()) == "uid-lojista"


@pytest.mark.parametrize("token, motivo", [
    (lambda: _token(aud="outro-projeto"), "token recusado"),
    (lambda: _token(iss="https://securetoken.google.com/outro"), "token recusado"),
    (lambda: _token(exp_em=-3600), "expirada"),
    (lambda: _token(kid="kid-que-nao-existe"), "chave desconhecida"),
    (lambda: _token(chave=OUTRA_PRIV), "token recusado"),             # assinatura falsa
    (lambda: _token(sub=""), "token"),
    (lambda: jwt.encode({"sub": "x"}, "segredo", algorithm="HS256", headers={"kid": KID}), "algoritmo"),
    (lambda: "isto.nao.e-um-token", "ilegível"),
    (lambda: "", "ausente"),
])
def test_tokens_ruins_sao_recusados(token, motivo):
    with pytest.raises(TokenInvalido, match=motivo):
        _verificador().verificar(token())


def test_cookie_assinado():
    c = Cookies("segredo")
    v = c.emitir("uid-1")
    assert c.conferir(v) == "uid-1"
    assert c.conferir(v.replace("uid-1", "uid-2")) is None            # trocou o usuário
    assert Cookies("outro-segredo").conferir(v) is None
    assert Cookies("segredo", duracao=-10).conferir(Cookies("segredo", duracao=-10).emitir("u")) is None
    assert c.conferir("lixo") is None and c.conferir(None) is None


# ---------- servidor ----------

class _SemRedirecionar(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


abrir = urllib.request.build_opener(_SemRedirecionar).open


def _subir(app):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        porta = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=porta, log_level="warning"))
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    while not srv.started:
        time.sleep(0.05)
    return srv, t, f"127.0.0.1:{porta}"


@pytest.fixture(scope="module")
def servidor(tmp_path_factory):
    app = criar_app(tmp_path_factory.mktemp("s"), chave=CHAVE, exigir_login=True,
                    verificador=_verificador())
    srv, t, endereco = _subir(app)
    yield endereco
    srv.should_exit = True
    t.join(5)


def _pedir(url, cookie=None, corpo=None):
    cab = {"Cookie": cookie} if cookie else {}
    dados = None
    if corpo is not None:
        dados = json.dumps(corpo).encode()
        cab["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=dados, headers=cab)
    try:
        with abrir(req) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def _entrar(servidor, token):
    codigo, cab, corpo = _pedir(f"http://{servidor}/api/entrar", corpo={"token": token})
    biscoito = (cab.get("set-cookie") or "").split(";")[0]
    return codigo, json.loads(corpo), biscoito


def test_sem_login_manda_para_o_painel(servidor):
    for caminho in ("/", "/captura", "/teste/ar-viewer"):
        codigo, _, corpo = _pedir(f"http://{servidor}{caminho}")
        assert codigo == 401 and "Escanear com a câmera".encode() in corpo
    codigo, _, corpo = _pedir(f"http://{servidor}/api/sessoes")
    assert codigo == 401 and json.loads(corpo) == {"erro": "entre pelo painel do site"}


def test_publicos_abrem_sem_login(servidor):
    for caminho in ("/saude", "/entrar", "/web/captura.js", "/web/visualizador.js", "/site/ar-viewer.js"):
        assert _pedir(f"http://{servidor}{caminho}")[0] == 200, caminho


def test_login_do_site_vira_cookie(servidor):
    codigo, resp, biscoito = _entrar(servidor, _token())
    assert codigo == 200 and resp == {"ok": True} and biscoito.startswith(COOKIE_SESSAO + "=")
    assert _pedir(f"http://{servidor}/", cookie=biscoito)[0] == 200
    assert _pedir(f"http://{servidor}/captura", cookie=biscoito)[0] == 200
    assert _pedir(f"http://{servidor}/api/sessoes", cookie=biscoito)[0] == 200
    with connect(f"ws://{servidor}/ws/captura", additional_headers={"Cookie": biscoito}) as ws:
        ws.send(json.dumps({"tipo": "iniciar"}))
        assert json.loads(ws.recv(10))["tipo"] == "sessao"


def test_login_ruim_nao_entra(servidor):
    codigo, resp, biscoito = _entrar(servidor, _token(exp_em=-3600))
    assert codigo == 401 and resp["motivo"] == "sessão do site expirada" and not biscoito
    codigo, resp, _ = _entrar(servidor, _token(aud="outro"))
    assert codigo == 401
    assert _pedir(f"http://{servidor}/api/entrar", corpo=["lista"])[0] == 401
    falso = f"{COOKIE_SESSAO}=uid.9999999999.{'0' * 64}"
    assert _pedir(f"http://{servidor}/", cookie=falso)[0] == 401


def test_chave_continua_como_segunda_porta(servidor):
    codigo, cab, _ = _pedir(f"http://{servidor}/teste/ar-viewer?glb=%2Fsessoes%2Fx%2Fmodelo.glb&chave={CHAVE}")
    assert codigo == 303 and cab["location"] == "/teste/ar-viewer?glb=%2Fsessoes%2Fx%2Fmodelo.glb"
    assert f"{COOKIE_CHAVE}={CHAVE}" in cab["set-cookie"] and "httponly" in cab["set-cookie"].lower()
    assert _pedir(f"http://{servidor}/", cookie=f"{COOKIE_CHAVE}={CHAVE}")[0] == 200
    codigo, _, corpo = _pedir(f"http://{servidor}/?chave=errada")
    assert codigo == 401 and "Chave errada".encode() in corpo
    codigo, cab, _ = _pedir(f"http://{servidor}//exemplo.com?chave={CHAVE}")
    assert codigo == 303 and cab["location"].startswith("/exemplo.com")


def test_websocket_sem_login_e_recusado(servidor):
    for rota in ("/ws/captura", "/ws/visualizador"):
        with pytest.raises(InvalidStatus):
            connect(f"ws://{servidor}{rota}", open_timeout=5)
    with connect(f"ws://{servidor}/ws/visualizador?chave={CHAVE}") as ws:
        assert json.loads(ws.recv(5))["tipo"] == "ola"


def test_sem_render_fica_aberto_como_antes(tmp_path):
    srv, t, endereco = _subir(criar_app(tmp_path, chave="", exigir_login=False))
    try:
        assert _pedir(f"http://{endereco}/")[0] == 200
        assert _pedir(f"http://{endereco}/api/sessoes")[0] == 200
    finally:
        srv.should_exit = True
        t.join(5)
