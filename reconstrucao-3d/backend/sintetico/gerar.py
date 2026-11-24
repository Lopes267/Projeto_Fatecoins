"""
Gera uma captura sintética no MESMO formato que a página do celular manda
(convenções do WebXR), dando uma volta em torno da caneca.

Imita um celular em pé com o mapa de profundidade deitado (160 x 90, como o
ARCore costuma entregar), centro óptico fora do meio, e — com ruido=True —
os defeitos típicos da Depth API: erro proporcional à distância, manchas de
baixa frequência, "pixels voando" nas bordas, buracos, e deriva da pose.

Uso: python -m backend.sintetico.gerar <pasta>   (grava quadros .bin)
"""
from __future__ import annotations

import io
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from ..reconstrucao import geometria as geo
from ..reconstrucao.quadro import montar as montar_quadro
from . import cena
from .motor import Camera, Projection, renderizar

# Celular em pé: vista 9:16, ~63° na vertical
LARG_PROF, ALT_PROF = 160, 90           # mapa do sensor (deitado)
LARG_VISTA, ALT_VISTA = 180, 320        # render da vista, 2x a resolução do mapa
H_FOV = 2 * math.atan(math.tan(math.radians(63) / 2) * LARG_VISTA / ALT_VISTA)
DESLOC = (0.02, -0.015)                 # P[0][2], P[1][2]: centro óptico fora do meio

# normDepthBufferFromNormView do celular em pé: mapa = giro de 90° da vista
#   u_mapa = v_vista ;  v_mapa = 1 - u_vista
GIRO = np.array([[0.0, 1.0, 0.0, 0.0],
                 [-1.0, 0.0, 0.0, 1.0],
                 [0.0, 0.0, 1.0, 0.0],
                 [0.0, 0.0, 0.0, 1.0]])
SONDAS = [(0.5, 0.5), (0.3, 0.3), (0.7, 0.3), (0.3, 0.7), (0.7, 0.7)]


def _mapa_do_sensor(prof_vista, inverter_y):
    """Monta o mapa deitado a partir do render da vista, seguindo GIRO."""
    inv = np.linalg.inv(GIRO)
    mapa = np.zeros((ALT_PROF, LARG_PROF))
    du = (np.arange(LARG_PROF) + 0.5) / LARG_PROF
    dv = (np.arange(ALT_PROF) + 0.5) / ALT_PROF
    uu, vv = np.meshgrid(du, dv)
    pts = np.stack([uu.ravel(), vv.ravel(), np.zeros(uu.size), np.ones(uu.size)])
    vx, vy = (inv @ pts)[:2]
    if inverter_y:              # "navegador" que lê a vista com y para cima
        vy = 1.0 - vy
    col = np.clip((vx * LARG_VISTA).astype(int), 0, LARG_VISTA - 1)
    lin = np.clip((vy * ALT_VISTA).astype(int), 0, ALT_VISTA - 1)
    mapa.ravel()[:] = prof_vista[lin, col]
    return mapa


def _ruido(mapa, rng):
    m = mapa.copy()
    valido = m > 0
    # pixels voando: nas bordas de profundidade o sensor mistura frente e fundo
    pad = np.pad(m, 1, mode="edge")
    viz = np.stack([pad[i:i + ALT_PROF, j:j + LARG_PROF] for i in range(3) for j in range(3)])
    salto = (viz.max(0) - viz.min(0)) > 0.02
    mistura = salto & (rng.random(m.shape) < 0.7)
    m[mistura] = viz.mean(0)[mistura]
    # erro de ~1% da distância + manchas suaves de ~0,4%
    m += rng.normal(0, 1, m.shape) * 0.010 * m
    grosso = rng.normal(0, 1, (4, 6))
    yy = np.linspace(0, 3, ALT_PROF)[:, None]
    xx = np.linspace(0, 5, LARG_PROF)[None, :]
    y0, x0 = np.floor(yy).astype(int).clip(0, 2), np.floor(xx).astype(int).clip(0, 4)
    fy, fx = yy - y0, xx - x0
    suave = (grosso[y0, x0] * (1 - fy) * (1 - fx) + grosso[y0, x0 + 1] * (1 - fy) * fx +
             grosso[y0 + 1, x0] * fy * (1 - fx) + grosso[y0 + 1, x0 + 1] * fy * fx)
    m += suave * 0.004 * m
    # buracos
    m[rng.random(m.shape) < 0.03] = 0
    m[~valido] = 0
    return m


def _cor_da_vista(idbuf, cores_tri, normais_tri, centros_tri, pos_cam, rng, ruido):
    luz = np.array([0.4, 0.9, 0.3]) / np.linalg.norm([0.4, 0.9, 0.3])
    img = np.zeros(idbuf.shape + (3,))
    tem = idbuf >= 0
    ids = idbuf[tem]
    n = normais_tri[ids]
    para_cam = pos_cam - centros_tri[ids]
    n = np.where((np.sum(n * para_cam, 1) < 0)[:, None], -n, n)   # face virada para a câmera
    sombra = 0.35 + 0.65 * np.clip(n @ luz, 0, 1)
    img[tem] = cores_tri[ids] * sombra[:, None]
    img[~tem] = (0.25, 0.27, 0.30)
    if ruido:
        img += rng.normal(0, 0.015, img.shape)
    return (np.clip(img, 0, 1) * 255).astype(np.uint8)


def _rasante(idbuf, normais_tri, centros_tri, pos_cam):
    """Superfície vista quase de lado: o sensor não mede."""
    cos = np.ones(idbuf.shape)
    tem = idbuf >= 0
    ids = idbuf[tem]
    d = centros_tri[ids] - pos_cam
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    cos[tem] = np.abs(np.sum(normais_tri[ids] * d, 1))
    return cos < 0.17


def _deriva(rng, passos, sigma_t=0.00025, sigma_r=math.radians(0.03)):
    """Erro acumulado da pose (o rastreamento do ARCore anda um pouco numa volta)."""
    D = np.eye(4)
    seq = []
    for _ in range(passos):
        eixo = rng.normal(0, 1, 3)
        eixo /= np.linalg.norm(eixo)
        ang = rng.normal(0, sigma_r)
        K = np.array([[0, -eixo[2], eixo[1]], [eixo[2], 0, -eixo[0]], [-eixo[1], eixo[0], 0]])
        R = np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * K @ K
        passo = np.eye(4)
        passo[:3, :3] = R
        passo[:3, 3] = rng.normal(0, sigma_t, 3)
        D = passo @ D
        seq.append(D.copy())
    return seq


def quadros(n=90, ruido=True, seed=0, com_cor=True, inverter_y=False, voltas=1.0):
    """Gera as mensagens binárias, uma por quadro, prontas para o WebSocket."""
    rng = np.random.default_rng(seed)
    V, T, cores, _ = cena.montar()
    tri_v = V[T]
    centros = tri_v.mean(1)
    normais = np.cross(tri_v[:, 1] - tri_v[:, 0], tri_v[:, 2] - tri_v[:, 0])
    normais /= np.maximum(np.linalg.norm(normais, axis=1, keepdims=True), 1e-12)
    derivas = _deriva(rng, n) if ruido else [np.eye(4)] * n

    for k in range(n):
        th = 2 * math.pi * voltas * k / n + 0.6
        raio = 0.40 + 0.03 * math.sin(3 * th)
        alt = 0.24 + 0.03 * math.sin(2 * th)
        pos = (raio * math.cos(th), alt, raio * math.sin(th))
        alvo = np.array([0.0, 0.045, 0.0])
        if ruido:
            alvo = alvo + rng.normal(0, 0.006, 3) * (k > 0)
        cam = Camera(LARG_VISTA, ALT_VISTA, pos, h_fov=H_FOV, near_plane=0.05, far_plane=20.0)
        cam.olhar_para(alvo)
        proj = Projection(cam, *DESLOC)
        zbuf, idbuf = renderizar(V, T, cam, proj)
        zbuf[_rasante(idbuf, normais, centros, cam.position[:3])] = 0

        mapa = _mapa_do_sensor(zbuf, inverter_y)
        if ruido:
            mapa = _ruido(mapa, rng)
        bruto = np.clip(np.round(mapa * 1000), 0, 65535).astype("<u2")   # mm, como luminance-alpha

        # O que o "navegador" responderia em getDepthInMeters()
        M = GIRO
        sondas = []
        for x, y in SONDAS:
            yy = 1.0 - y if inverter_y else y
            sondas.append([x, y, geo.amostrar_ponto(bruto.astype(np.float64) * 0.001, M, x, yy)])

        T_gl = derivas[k] @ cam.transformacao_gl()
        cab = {"tipo": "quadro", "n": k, "t": round(k * 200.0, 1),
               "vista": {"projecao": geo.para_colunas(proj.projecao_gl()),
                         "transformacao": geo.para_colunas(T_gl)},
               "profundidade": {"largura": LARG_PROF, "altura": ALT_PROF, "formato": "uint16",
                                "paraMetros": 0.001,
                                "normDepthBufferFromNormView": geo.para_colunas(M),
                                "sondas": sondas}}
        jpeg = None
        if com_cor:
            img = _cor_da_vista(idbuf, cores, normais, centros, cam.position[:3], rng, ruido)
            buf = io.BytesIO()
            Image.fromarray(img).save(buf, "JPEG", quality=80)
            jpeg = buf.getvalue()
            cab["cor"] = {"largura": LARG_VISTA, "altura": ALT_VISTA}
        yield montar_quadro(cab, bruto.tobytes(), jpeg)


if __name__ == "__main__":
    destino = Path(sys.argv[1] if len(sys.argv) > 1 else "sessoes/sintetica")
    destino.mkdir(parents=True, exist_ok=True)
    for i, msg in enumerate(quadros()):
        (destino / f"{i + 1:05d}.bin").write_bytes(msg)
    print(f"{i + 1} quadros em {destino}")
