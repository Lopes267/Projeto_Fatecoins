"""
Cena de teste com medidas conhecidas (metros, y para cima, mesa em y = 0):

  - caneca (o objeto de validação da seção 14 da especificação):
    8 cm de diâmetro, 9,5 cm de altura, parede de 4 mm, fundo de 6 mm,
    alça do lado +x (a caneca inteira vai de x = -4 cm a x = +7 cm);
  - mesa xadrez de 1 m x 1 m;
  - uma caixa de 6 x 10 x 6 cm ao lado, dentro da região de interesse:
    ela tem de ficar FORA do modelo final.
"""
from __future__ import annotations

import math

import numpy as np

R_EXT, R_INT, ALTURA, FUNDO = 0.040, 0.036, 0.095, 0.006
ALCA_CENTRO, ALCA_RAIO, ALCA_TUBO = (0.036, 0.0475), 0.028, 0.0055
CAIXA_CENTRO, CAIXA_TAM = (0.17, 0.05, -0.08), (0.06, 0.10, 0.06)
# Caixa envolvente da caneca (com alça): x, y, z
CANECA_MIN = np.array([-R_EXT, 0.0, -R_EXT])
CANECA_MAX = np.array([ALCA_CENTRO[0] + ALCA_RAIO + ALCA_TUBO, ALTURA, R_EXT])


class Malha:
    def __init__(self):
        self.v: list = []
        self.t: list = []
        self.cor: list = []      # cor por triângulo
        self.parte: list = []    # 'externa', 'interna', 'mesa', 'caixa'

    def tri(self, a, b, c, cor, parte):
        self.t.append((a, b, c))
        self.cor.append(cor)
        self.parte.append(parte)

    def quad(self, a, b, c, d, cor, parte):
        self.tri(a, b, c, cor, parte)
        self.tri(a, c, d, cor, parte)

    def ponto(self, p):
        self.v.append(tuple(float(x) for x in p))
        return len(self.v) - 1

    def arrays(self):
        return (np.array(self.v, np.float64), np.array(self.t, np.int64),
                np.array(self.cor, np.float64), np.array(self.parte))


def _cor_caneca(ang, y):
    # faixa vermelha no meio: dá textura de cor para conferir a fusão das cores
    if 0.035 < y < 0.055:
        return (0.80, 0.18, 0.15)
    return (0.93, 0.91, 0.86)


def _cilindro(m: Malha, r, y0, y1, seg, parte, aneis=8):
    ids = []
    for k in range(aneis + 1):
        y = y0 + (y1 - y0) * k / aneis
        ids.append([m.ponto((r * math.cos(2 * math.pi * i / seg), y,
                             r * math.sin(2 * math.pi * i / seg))) for i in range(seg)])
    for k in range(aneis):
        ym = y0 + (y1 - y0) * (k + 0.5) / aneis
        for i in range(seg):
            j = (i + 1) % seg
            m.quad(ids[k][i], ids[k][j], ids[k + 1][j], ids[k + 1][i],
                   _cor_caneca(2 * math.pi * i / seg, ym), parte)


def _anel(m: Malha, r0, r1, y, seg, parte, cor):
    a = [m.ponto((r0 * math.cos(2 * math.pi * i / seg), y, r0 * math.sin(2 * math.pi * i / seg))) for i in range(seg)]
    b = [m.ponto((r1 * math.cos(2 * math.pi * i / seg), y, r1 * math.sin(2 * math.pi * i / seg))) for i in range(seg)]
    for i in range(seg):
        j = (i + 1) % seg
        m.quad(a[i], a[j], b[j], b[i], cor, parte)


def _disco(m: Malha, r, y, seg, parte, cor):
    c = m.ponto((0, y, 0))
    a = [m.ponto((r * math.cos(2 * math.pi * i / seg), y, r * math.sin(2 * math.pi * i / seg))) for i in range(seg)]
    for i in range(seg):
        m.tri(c, a[i], a[(i + 1) % seg], cor, parte)


def _alca(m: Malha, seg_arco=24, seg_tubo=12):
    cx, cy = ALCA_CENTRO
    aneis = []
    for k in range(seg_arco + 1):
        th = -math.pi / 2 + math.pi * k / seg_arco      # meia-volta do lado +x
        c = np.array([cx + ALCA_RAIO * math.cos(th), cy + ALCA_RAIO * math.sin(th), 0.0])
        radial = np.array([math.cos(th), math.sin(th), 0.0])
        lateral = np.array([0.0, 0.0, 1.0])
        aneis.append([m.ponto(c + ALCA_TUBO * (math.cos(2 * math.pi * i / seg_tubo) * radial +
                                                 math.sin(2 * math.pi * i / seg_tubo) * lateral))
                      for i in range(seg_tubo)])
    for k in range(seg_arco):
        for i in range(seg_tubo):
            j = (i + 1) % seg_tubo
            m.quad(aneis[k][i], aneis[k][j], aneis[k + 1][j], aneis[k + 1][i],
                   (0.93, 0.91, 0.86), "externa")


def _caixa(m: Malha, centro, tam, cor, parte):
    cx, cy, cz = centro
    sx, sy, sz = (t / 2 for t in tam)
    p = [m.ponto((cx + dx * sx, cy + dy * sy, cz + dz * sz))
         for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    for a, b, c, d in faces:
        m.quad(p[a], p[b], p[c], p[d], cor, parte)


def _mesa(m: Malha, lado=1.0, n=20):
    ids = [[m.ponto((-lado / 2 + lado * i / n, 0.0, -lado / 2 + lado * k / n))
            for i in range(n + 1)] for k in range(n + 1)]
    for k in range(n):
        for i in range(n):
            cor = (0.55, 0.40, 0.26) if (i + k) % 2 else (0.70, 0.55, 0.38)
            m.quad(ids[k][i], ids[k][i + 1], ids[k + 1][i + 1], ids[k + 1][i], cor, "mesa")


def montar(com_mesa=True, com_caixa=True, seg=64):
    m = Malha()
    _cilindro(m, R_EXT, 0.0, ALTURA, seg, "externa")
    _cilindro(m, R_INT, FUNDO, ALTURA, seg, "interna")
    _anel(m, R_INT, R_EXT, ALTURA, seg, "externa", (0.93, 0.91, 0.86))
    _disco(m, R_INT, FUNDO, seg, "interna", (0.90, 0.88, 0.83))
    _alca(m)
    if com_mesa:
        _mesa(m)
    if com_caixa:
        _caixa(m, CAIXA_CENTRO, CAIXA_TAM, (0.20, 0.35, 0.65), "caixa")
    return m.arrays()


def amostras_externas(n=6000, seed=1):
    """
    Pontos da superfície de fora da caneca que uma volta a ~30° de elevação
    enxerga: parede externa, borda e alça (sem o trecho da alça enterrado na
    parede). Servem para medir quanto do objeto a reconstrução cobriu.
    """
    rng = np.random.default_rng(seed)
    pts = []
    # parede externa (área ~ 2*pi*r*h) e borda; proporção pela área
    n_par = int(n * 0.70)
    a = rng.uniform(0, 2 * math.pi, n_par)
    y = rng.uniform(0.004, ALTURA, n_par)        # rente à mesa fica escondido
    pts.append(np.stack([R_EXT * np.cos(a), y, R_EXT * np.sin(a)], 1))
    n_b = int(n * 0.08)
    a = rng.uniform(0, 2 * math.pi, n_b)
    r = np.sqrt(rng.uniform(R_INT ** 2, R_EXT ** 2, n_b))
    pts.append(np.stack([r * np.cos(a), np.full(n_b, ALTURA), r * np.sin(a)], 1))
    n_a = n - n_par - n_b
    th = rng.uniform(-math.pi / 2, math.pi / 2, n_a * 2)
    ph = rng.uniform(0, 2 * math.pi, n_a * 2)
    cx, cy = ALCA_CENTRO
    centro = np.stack([cx + ALCA_RAIO * np.cos(th), cy + ALCA_RAIO * np.sin(th), np.zeros_like(th)], 1)
    radial = np.stack([np.cos(th), np.sin(th), np.zeros_like(th)], 1)
    p = centro + ALCA_TUBO * (np.cos(ph)[:, None] * radial + np.sin(ph)[:, None] * np.array([0, 0, 1.0]))
    fora = np.hypot(p[:, 0], p[:, 2]) > R_EXT + 0.001
    pts.append(p[fora][:n_a])
    return np.concatenate(pts)
