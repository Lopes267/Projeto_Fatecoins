"""
Protocolo de um quadro (celular -> computador), por WebSocket binário.

    [4 bytes: tamanho N do cabeçalho, uint32 little-endian]
    [N bytes: cabeçalho JSON em UTF-8]
    [bytes da profundidade][bytes da cor (JPEG), se houver]

Cabeçalho:
    {
      "tipo": "quadro", "n": 12, "t": 1234.5,
      "vista": {"projecao": [16], "transformacao": [16]},
      "profundidade": {
        "largura": 160, "altura": 90,
        "formato": "uint16" | "float32",
        "paraMetros": 0.001,
        "normDepthBufferFromNormView": [16],
        "sondas": [[x, y, metros], ...]      # getDepthInMeters() do próprio navegador
      },
      "cor": {"largura": 180, "altura": 320, "bytes": 12345} | null
    }

A profundidade vai crua (números), nunca como JPEG: compressão com perda
destruiria a medida (seção 7 da especificação).
"""
from __future__ import annotations

import io
import json
import struct
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from . import geometria as geo

LIMITE_LADO = 1024          # nenhum mapa de profundidade de celular passa disso
LIMITE_COR = 4 * 1024 * 1024
FORMATOS = {"uint16": np.dtype("<u2"), "float32": np.dtype("<f4")}


class QuadroInvalido(ValueError):
    pass


@dataclass
class Quadro:
    n: int
    t: float
    projecao: np.ndarray            # 4x4 OpenGL
    transformacao: np.ndarray       # 4x4 câmera -> mundo (OpenGL)
    profundidade: np.ndarray        # metros, grade do SENSOR (altura, largura)
    norm_prof_da_vista: np.ndarray  # 4x4
    sondas: list = field(default_factory=list)
    cor: np.ndarray | None = None   # RGB uint8 alinhado à vista (altura, largura, 3)


def montar(cabecalho: dict, profundidade: bytes, cor: bytes | None = None) -> bytes:
    """Lado do remetente (usado pelos testes e pelo gerador sintético)."""
    cab = dict(cabecalho)
    if cor is not None:
        cab["cor"] = dict(cab.get("cor") or {}, bytes=len(cor))
    else:
        cab["cor"] = None
    texto = json.dumps(cab, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(texto)) + texto + profundidade + (cor or b"")


def ler(mensagem: bytes) -> Quadro:
    if len(mensagem) < 4:
        raise QuadroInvalido("mensagem curta demais")
    (tam,) = struct.unpack_from("<I", mensagem, 0)
    if tam <= 0 or 4 + tam > len(mensagem):
        raise QuadroInvalido("cabeçalho com tamanho inválido")
    try:
        cab = json.loads(mensagem[4:4 + tam].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise QuadroInvalido(f"cabeçalho ilegível: {e}") from None
    if not isinstance(cab, dict) or cab.get("tipo") != "quadro":
        raise QuadroInvalido("não é um quadro")

    try:
        vista, prof = cab["vista"], cab["profundidade"]
        P = geo.matriz_de_colunas(vista["projecao"])
        T = geo.matriz_de_colunas(vista["transformacao"])
        M = geo.matriz_de_colunas(prof["normDepthBufferFromNormView"])
        larg, alt = int(prof["largura"]), int(prof["altura"])
        formato = FORMATOS[prof["formato"]]
        escala = float(prof["paraMetros"])
    except (KeyError, TypeError, ValueError) as e:
        raise QuadroInvalido(f"campo faltando ou inválido: {e}") from None

    if not (0 < larg <= LIMITE_LADO and 0 < alt <= LIMITE_LADO):
        raise QuadroInvalido("tamanho de profundidade fora do limite")
    if not (0 < escala < 10) or P[0, 0] <= 0 or P[1, 1] <= 0:
        raise QuadroInvalido("escala ou projeção absurda")

    inicio = 4 + tam
    n_bytes = larg * alt * formato.itemsize
    if inicio + n_bytes > len(mensagem):
        raise QuadroInvalido("faltam bytes de profundidade")
    bruto = np.frombuffer(mensagem, dtype=formato, count=larg * alt, offset=inicio)
    metros = bruto.reshape(alt, larg).astype(np.float32) * np.float32(escala)
    metros[~np.isfinite(metros)] = 0
    metros[metros < 0] = 0
    inicio += n_bytes

    cor = None
    info_cor = cab.get("cor")
    if info_cor:
        n_cor = int(info_cor.get("bytes", 0))
        if not (0 < n_cor <= LIMITE_COR) or inicio + n_cor > len(mensagem):
            raise QuadroInvalido("bytes de cor inválidos")
        try:
            img = Image.open(io.BytesIO(mensagem[inicio:inicio + n_cor]))
            img.draft("RGB", img.size)
            cor = np.asarray(img.convert("RGB"), dtype=np.uint8)
        except Exception as e:  # imagem corrompida não derruba a sessão
            raise QuadroInvalido(f"imagem de cor ilegível: {e}") from None

    sondas = []
    for s in prof.get("sondas") or []:
        try:
            x, y, m = (float(s[0]), float(s[1]), float(s[2]))
            if 0 <= x <= 1 and 0 <= y <= 1 and np.isfinite(m):
                sondas.append((x, y, m))
        except (TypeError, ValueError, IndexError):
            pass

    return Quadro(n=int(cab.get("n", 0)), t=float(cab.get("t", 0)),
                  projecao=P, transformacao=T, profundidade=metros,
                  norm_prof_da_vista=M, sondas=sondas[:16], cor=cor)
