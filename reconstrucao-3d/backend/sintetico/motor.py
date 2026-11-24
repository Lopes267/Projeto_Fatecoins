"""
Renderizador de teste, baseado no Software_3D_engine
(https://github.com/StanislavPetrovV/Software_3D_engine, MIT, (c) 2020 StanislavPetrovV).

Do motor original vêm:
  - as matrizes de matrix_functions.py (convenção de vetor-linha: v @ M);
  - a câmera de camera.py: camera_matrix() = translate_matrix() @ rotate_matrix(),
    com os eixos right/up/forward nas colunas;
  - a projeção e a matriz para a tela de projection.py;
  - o caminho de screen_projection() em object_3d.py: vértices @ câmera
    @ projeção, divisão por w, @ tela; e o Numba (@njit) para o laço pesado.

O que foi acrescentado (o motor desenha só contornos, seção 2.1 da
especificação): Z-buffer por pixel e triângulos preenchidos — é daí que sai o
mapa de profundidade "verdadeiro" que o teste manda para a reconstrução.

O que foi corrigido:
  1. Espelhamento. O original usa right = +x, up = +y, forward = +z. Uma
     câmera de verdade olhando para +z com y para cima tem a direita em -x
     (direita = frente x cima). Com o original, um modelo comum aparece
     espelhado — e uma reconstrução alimentada assim sairia espelhada.
     Aqui a câmera é montada com olhar_para(), que calcula a direita certa.
  2. Campo de visão vertical. O original faz v_fov = h_fov * altura/largura,
     que só vale para ângulo pequeno: com 60° e 16:9 dá 33,75° em vez de 36,0°
     e os pixels deixam de ser quadrados (fx != fy). Aqui:
     tan(v/2) = tan(h/2) * altura/largura.
"""
from __future__ import annotations

import math

import numpy as np
from numba import njit


# ---------- matrix_functions.py (igual ao original) ----------

def translate(pos):
    tx, ty, tz = pos
    return np.array([
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [tx, ty, tz, 1]
    ], dtype=np.float64)


def rotate_x(a):
    return np.array([
        [1, 0, 0, 0],
        [0, math.cos(a), math.sin(a), 0],
        [0, -math.sin(a), math.cos(a), 0],
        [0, 0, 0, 1]
    ], dtype=np.float64)


def rotate_y(a):
    return np.array([
        [math.cos(a), 0, -math.sin(a), 0],
        [0, 1, 0, 0],
        [math.sin(a), 0, math.cos(a), 0],
        [0, 0, 0, 1]
    ], dtype=np.float64)


def rotate_z(a):
    return np.array([
        [math.cos(a), math.sin(a), 0, 0],
        [-math.sin(a), math.cos(a), 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
    ], dtype=np.float64)


def scale(n):
    return np.array([
        [n, 0, 0, 0],
        [0, n, 0, 0],
        [0, 0, n, 0],
        [0, 0, 0, 1]
    ], dtype=np.float64)


# ---------- camera.py (sem pygame; eixos montados por olhar_para) ----------

def _unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


class Camera:
    def __init__(self, largura, altura, posicao, h_fov=math.pi / 3,
                 near_plane=0.05, far_plane=20.0):
        self.WIDTH, self.HEIGHT = largura, altura
        self.position = np.array([*posicao, 1.0])
        self.forward = np.array([0, 0, 1, 1.0])
        self.up = np.array([0, 1, 0, 1.0])
        self.right = np.array([1, 0, 0, 1.0])
        self.h_fov = h_fov
        # correção 2: relação exata entre os campos de visão
        self.v_fov = 2 * math.atan(math.tan(h_fov / 2) * altura / largura)
        self.near_plane = near_plane
        self.far_plane = far_plane

    def olhar_para(self, alvo, cima=(0.0, 1.0, 0.0)):
        """Correção 1: direita = frente x cima (câmera de verdade, sem espelho)."""
        f = _unit(np.asarray(alvo, float) - self.position[:3])
        r = _unit(np.cross(f, cima))
        u = np.cross(r, f)
        self.forward = np.array([*f, 1.0])
        self.right = np.array([*r, 1.0])
        self.up = np.array([*u, 1.0])

    def translate_matrix(self):
        x, y, z, w = self.position
        return np.array([
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, 0],
            [-x, -y, -z, 1]
        ], dtype=np.float64)

    def rotate_matrix(self):
        rx, ry, rz, w = self.right
        fx, fy, fz, w = self.forward
        ux, uy, uz, w = self.up
        return np.array([
            [rx, ux, fx, 0],
            [ry, uy, fy, 0],
            [rz, uz, fz, 0],
            [0, 0, 0, 1]
        ], dtype=np.float64)

    def camera_matrix(self):
        return self.translate_matrix() @ self.rotate_matrix()

    def transformacao_gl(self):
        """Pose câmera -> mundo nos eixos do OpenGL/WebXR: colunas [direita, cima, -frente, posição]."""
        T = np.eye(4)
        T[:3, 0] = self.right[:3]
        T[:3, 1] = self.up[:3]
        T[:3, 2] = -self.forward[:3]
        T[:3, 3] = self.position[:3]
        return T


# ---------- projection.py (+ centro óptico fora do meio, como nos celulares) ----------

class Projection:
    def __init__(self, camera: Camera, desloc_x=0.0, desloc_y=0.0):
        NEAR, FAR = camera.near_plane, camera.far_plane
        RIGHT = math.tan(camera.h_fov / 2)
        LEFT = -RIGHT
        TOP = math.tan(camera.v_fov / 2)
        BOTTOM = -TOP

        m00 = 2 / (RIGHT - LEFT)
        m11 = 2 / (TOP - BOTTOM)
        m22 = (FAR + NEAR) / (FAR - NEAR)
        m32 = -2 * NEAR * FAR / (FAR - NEAR)
        self.projection_matrix = np.array([
            [m00, 0, 0, 0],
            [0, m11, 0, 0],
            [0, 0, m22, 1],
            [0, 0, m32, 0]
        ], dtype=np.float64)

        HW, HH = camera.WIDTH / 2, camera.HEIGHT / 2
        # desloc_x/desloc_y são o P[0][2]/P[1][2] da projeção do WebXR
        self.to_screen_matrix = np.array([
            [HW, 0, 0, 0],
            [0, -HH, 0, 0],
            [0, 0, 1, 0],
            [HW * (1 - desloc_x), HH * (1 + desloc_y), 0, 1]
        ], dtype=np.float64)
        self.desloc = (desloc_x, desloc_y)
        self.m00, self.m11 = m00, m11
        self.near, self.far = NEAR, FAR

    def projecao_gl(self):
        """A mesma projeção no formato que o WebXR entrega (OpenGL, câmera olhando para -z)."""
        n, f = self.near, self.far
        dx, dy = self.desloc
        return np.array([
            [self.m00, 0, dx, 0],
            [0, self.m11, dy, 0],
            [0, 0, -(f + n) / (f - n), -2 * f * n / (f - n)],
            [0, 0, -1, 0]
        ], dtype=np.float64)


# ---------- object_3d.screen_projection() + Z-buffer ----------

def projetar(vertices_h, camera: Camera, projection: Projection):
    """Mesmo caminho do original; devolve pixels (contínuos) e a profundidade z da câmera."""
    cam = vertices_h @ camera.camera_matrix()
    clip = cam @ projection.projection_matrix
    w = clip[:, 3:4].copy()
    w[np.abs(w) < 1e-9] = 1e-9
    ndc = clip / w
    tela = ndc @ projection.to_screen_matrix
    return np.ascontiguousarray(tela[:, :2]), np.ascontiguousarray(cam[:, 2])


@njit(cache=True, fastmath=False)
def rasterizar(tela, z, triangulos, largura, altura, near, zbuf, idbuf):
    """Triângulos preenchidos com Z-buffer; amostra no centro de cada pixel."""
    for t in range(triangulos.shape[0]):
        a, b, c = triangulos[t, 0], triangulos[t, 1], triangulos[t, 2]
        za, zb, zc = z[a], z[b], z[c]
        if za < near or zb < near or zc < near:
            continue
        xa, ya = tela[a, 0], tela[a, 1]
        xb, yb = tela[b, 0], tela[b, 1]
        xc, yc = tela[c, 0], tela[c, 1]
        area = (xb - xa) * (yc - ya) - (xc - xa) * (yb - ya)
        if abs(area) < 1e-12:
            continue
        x0 = max(int(math.floor(min(xa, xb, xc) - 0.5)), 0)
        x1 = min(int(math.ceil(max(xa, xb, xc) - 0.5)), largura - 1)
        y0 = max(int(math.floor(min(ya, yb, yc) - 0.5)), 0)
        y1 = min(int(math.ceil(max(ya, yb, yc) - 0.5)), altura - 1)
        if x0 > x1 or y0 > y1:
            continue
        iza, izb, izc = 1.0 / za, 1.0 / zb, 1.0 / zc
        for py in range(y0, y1 + 1):
            sy = py + 0.5
            for px in range(x0, x1 + 1):
                sx = px + 0.5
                wa = ((xb - sx) * (yc - sy) - (xc - sx) * (yb - sy)) / area
                wb = ((xc - sx) * (ya - sy) - (xa - sx) * (yc - sy)) / area
                wc = 1.0 - wa - wb
                if wa < -1e-9 or wb < -1e-9 or wc < -1e-9:
                    continue
                # 1/z varia linearmente na tela (correção de perspectiva)
                zz = 1.0 / (wa * iza + wb * izb + wc * izc)
                if zz < zbuf[py, px]:
                    zbuf[py, px] = zz
                    idbuf[py, px] = t


def renderizar(vertices, triangulos, camera: Camera, projection: Projection):
    """Devolve (profundidade z em metros, 0 = nada; índice do triângulo, -1 = nada)."""
    vh = np.hstack([vertices, np.ones((len(vertices), 1))])
    tela, z = projetar(vh, camera, projection)
    zbuf = np.full((camera.HEIGHT, camera.WIDTH), np.inf)
    idbuf = np.full((camera.HEIGHT, camera.WIDTH), -1, np.int64)
    rasterizar(tela, z, np.ascontiguousarray(triangulos, np.int64),
               camera.WIDTH, camera.HEIGHT, camera.near_plane, zbuf, idbuf)
    zbuf[~np.isfinite(zbuf)] = 0
    return zbuf, idbuf
