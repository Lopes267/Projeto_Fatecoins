"""
Quem pode usar o serviço online.

O painel do site manda o ID token do Firebase do lojista logado (o mesmo que
o site usa nas chamadas à API). Aqui ele é conferido com as chaves PÚBLICAS do
Google — sem segredo compartilhado com o site — seguindo a documentação do
Firebase ("Verify ID tokens using a third-party JWT library"):
  alg RS256, kid entre as chaves do securetoken, aud = id do projeto,
  iss = https://securetoken.google.com/<projeto>, sub não vazio, dentro da validade.

Conferido o token, o navegador recebe um cookie próprio deste serviço
(uid + validade, assinado com HMAC), para não precisar mandar o token de novo.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import threading
import time
import urllib.request

import jwt
from cryptography.x509 import load_pem_x509_certificate

URL_CHAVES = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"


class TokenInvalido(Exception):
    pass


def buscar_chaves_google():
    with urllib.request.urlopen(URL_CHAVES, timeout=10) as r:
        certs = json.loads(r.read())
        idade = re.search(r"max-age=(\d+)", r.headers.get("Cache-Control", ""))
    return certs, int(idade.group(1)) if idade else 3600


class VerificadorFirebase:
    def __init__(self, projeto: str, buscar=buscar_chaves_google):
        self.projeto = projeto
        self._buscar = buscar
        self._chaves: dict = {}
        self._validade = 0.0
        self._trava = threading.Lock()

    def _carregar(self, forcar=False):
        with self._trava:
            if forcar or time.time() >= self._validade:
                certs, idade = self._buscar()
                self._chaves = {kid: load_pem_x509_certificate(pem.encode()).public_key()
                                for kid, pem in certs.items()}
                self._validade = time.time() + max(60, idade)
        return self._chaves

    def verificar(self, token: str) -> str:
        """Devolve o uid do usuário ou levanta TokenInvalido."""
        if not token or len(token) > 4096:
            raise TokenInvalido("token ausente")
        try:
            cab = jwt.get_unverified_header(token)
        except jwt.PyJWTError:
            raise TokenInvalido("token ilegível") from None
        if cab.get("alg") != "RS256":
            raise TokenInvalido("algoritmo inesperado")
        kid = cab.get("kid")
        chave = self._carregar().get(kid)
        if chave is None:                       # o Google trocou as chaves há pouco
            chave = self._carregar(forcar=True).get(kid)
        if chave is None:
            raise TokenInvalido("chave desconhecida")
        try:
            dados = jwt.decode(token, chave, algorithms=["RS256"], audience=self.projeto,
                               issuer=f"https://securetoken.google.com/{self.projeto}",
                               leeway=60, options={"require": ["exp", "iat", "sub", "aud", "iss"]})
        except jwt.ExpiredSignatureError:
            raise TokenInvalido("sessão do site expirada") from None
        except jwt.PyJWTError as e:
            raise TokenInvalido(f"token recusado: {e}") from None
        uid = dados.get("sub")
        if not isinstance(uid, str) or not uid or len(uid) > 128:
            raise TokenInvalido("token sem usuário")
        if float(dados.get("auth_time", 0)) > time.time() + 60:
            raise TokenInvalido("token do futuro")
        return uid


class Cookies:
    """Cookie de sessão deste serviço: '<uid>.<validade>.<hmac>'."""

    def __init__(self, segredo: str, duracao: int = 7 * 24 * 3600):
        self.segredo = segredo.encode()
        self.duracao = duracao

    def _assinar(self, texto: str) -> str:
        return hmac.new(self.segredo, texto.encode(), hashlib.sha256).hexdigest()

    def emitir(self, uid: str) -> str:
        texto = f"{uid}.{int(time.time()) + self.duracao}"
        return f"{texto}.{self._assinar(texto)}"

    def conferir(self, valor: str | None) -> str | None:
        if not valor or valor.count(".") < 2:
            return None
        texto, assinatura = valor.rsplit(".", 1)
        if not hmac.compare_digest(assinatura, self._assinar(texto)):
            return None
        uid, validade = texto.rsplit(".", 1)
        try:
            return uid if int(validade) > time.time() else None
        except ValueError:
            return None
