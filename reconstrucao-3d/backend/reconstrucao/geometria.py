"""
Geometria: do que o celular manda (convenções do WebXR) para o que o Open3D
espera (câmera "pinhole" no padrão do OpenCV).

O WebXR entrega, a cada quadro:
  - a projeção da câmera (4x4 do OpenGL),
  - a pose da câmera no mundo (4x4, câmera -> mundo, eixos do OpenGL:
    x para a direita, y para cima, a câmera olha para -z),
  - o mapa de profundidade, que NÃO está na mesma grade da imagem: a matriz
    normDepthBufferFromNormView leva uma coordenada normalizada da vista
    (0..1, origem no canto superior esquerdo, y para baixo) para uma
    coordenada normalizada do mapa. No celular em pé o mapa vem deitado, e
    essa matriz faz o giro.

Todas as matrizes do WebXR chegam como 16 números em ordem de COLUNA.

O Open3D quer: imagem de profundidade em metros numa grade de pixels comum,
intrínsecos (fx, fy, cx, cy) e a extrínseca mundo -> câmera nos eixos do
OpenCV (x para a direita, y para BAIXO, a câmera olha para +z).
"""
from __future__ import annotations

import numpy as np

# Troca de eixos OpenGL <-> OpenCV (as duas direções são a mesma matriz)
GL_PARA_CV = np.diag([1.0, -1.0, -1.0, 1.0])


def matriz_de_colunas(valores) -> np.ndarray:
    """16 números em ordem de coluna (Float32Array do WebXR) -> matriz 4x4."""
    m = np.asarray(valores, dtype=np.float64)
    if m.shape != (16,) or not np.all(np.isfinite(m)):
        raise ValueError("matriz 4x4 inválida")
    return m.reshape(4, 4).T


def para_colunas(m: np.ndarray) -> list[float]:
    """Matriz 4x4 -> 16 números em ordem de coluna (o inverso da anterior)."""
    return [float(v) for v in np.asarray(m, dtype=np.float64).T.reshape(16)]


def aspecto_da_projecao(P: np.ndarray) -> float:
    """Largura / altura da vista, tirada da projeção (tan(h/2) / tan(v/2))."""
    return float(P[1, 1] / P[0, 0])


def intrinsecos_da_projecao(P: np.ndarray, largura: int, altura: int):
    """
    fx, fy, cx, cy de uma imagem largura x altura que cobre a vista inteira.

    cx/cy saem no padrão do Open3D: o centro do pixel de índice i está em i
    (e não em i + 0,5). Com 160 pixels de largura, errar esse meio pixel
    desloca o modelo ~1,5 mm a 45 cm.
    """
    fx = P[0, 0] * largura / 2.0
    fy = P[1, 1] * altura / 2.0
    cx = (1.0 - P[0, 2]) * largura / 2.0 - 0.5
    cy = (1.0 + P[1, 2]) * altura / 2.0 - 0.5
    return float(fx), float(fy), float(cx), float(cy)


def grade_da_vista(P: np.ndarray, larg_prof: int, alt_prof: int) -> tuple[int, int]:
    """
    Tamanho da grade (largura, altura) em que a profundidade será reamostrada:
    mesmo número de pixels do mapa original, com o formato da vista. Assim um
    mapa 160x90 de um celular em pé vira uma grade 90x160.
    """
    total = larg_prof * alt_prof
    aspecto = aspecto_da_projecao(P)
    largura = max(8, int(round(np.sqrt(total * aspecto))))
    altura = max(8, int(round(largura / aspecto)))
    return largura, altura


def amostrar_na_vista(mapa: np.ndarray, norm_prof_da_vista: np.ndarray,
                      largura: int, altura: int,
                      inverter_y_vista: bool = False) -> np.ndarray:
    """
    Reamostra (vizinho mais próximo) um mapa do sensor para a grade da vista,
    seguindo o algoritmo de getDepthInMeters() da especificação do WebXR:
    coordenada normalizada da vista -> matriz -> coluna/linha do mapa.

    mapa: (altura_mapa, largura_mapa) ou (altura_mapa, largura_mapa, canais).
    Pixels que caem fora do mapa saem 0.
    """
    alt_m, larg_m = mapa.shape[:2]
    u = (np.arange(largura) + 0.5) / largura
    v = (np.arange(altura) + 0.5) / altura
    uu, vv = np.meshgrid(u, v)                      # (altura, largura)
    if inverter_y_vista:
        vv = 1.0 - vv
    pts = np.stack([uu.ravel(), vv.ravel(), np.zeros(uu.size), np.ones(uu.size)])
    dx, dy = (norm_prof_da_vista @ pts)[:2]
    col = np.floor(dx * larg_m).astype(np.int64)
    lin = np.floor(dy * alt_m).astype(np.int64)
    dentro = (col >= 0) & (col < larg_m) & (lin >= 0) & (lin < alt_m)
    saida = np.zeros((largura * altura,) + mapa.shape[2:], dtype=mapa.dtype)
    saida[dentro] = mapa[lin[dentro], col[dentro]]
    return saida.reshape((altura, largura) + mapa.shape[2:])


def amostrar_ponto(mapa: np.ndarray, norm_prof_da_vista: np.ndarray,
                   x: float, y: float, inverter_y_vista: bool = False) -> float:
    """Um ponto só, para comparar com as sondas de getDepthInMeters()."""
    alt_m, larg_m = mapa.shape[:2]
    if inverter_y_vista:
        y = 1.0 - y
    dx, dy = (norm_prof_da_vista @ np.array([x, y, 0.0, 1.0]))[:2]
    col, lin = int(np.floor(dx * larg_m)), int(np.floor(dy * alt_m))
    if 0 <= col < larg_m and 0 <= lin < alt_m:
        return float(mapa[lin, col])
    return 0.0


def pose_cv(transformacao_gl: np.ndarray) -> np.ndarray:
    """Pose câmera -> mundo nos eixos do OpenCV (o Open3D usa esses)."""
    return transformacao_gl @ GL_PARA_CV


def extrinseca(transformacao_gl: np.ndarray) -> np.ndarray:
    """Extrínseca mundo -> câmera (OpenCV), que o integrate() do Open3D pede."""
    return np.linalg.inv(pose_cv(transformacao_gl))


def pontos_da_profundidade(prof: np.ndarray, fx: float, fy: float,
                           cx: float, cy: float) -> tuple[np.ndarray, np.ndarray]:
    """
    Seção 6 da especificação: para cada pixel (u, v) com profundidade Z,
        X = (u - cx) * Z / fx,   Y = (v - cy) * Z / fy
    Devolve os pontos (N, 3) no referencial da câmera (OpenCV) e o índice
    linear de cada um na imagem.
    """
    alt, larg = prof.shape
    v, u = np.mgrid[0:alt, 0:larg]
    z = prof.ravel()
    validos = np.nonzero(z > 0)[0]
    z = z[validos]
    x = (u.ravel()[validos] - cx) * z / fx
    y = (v.ravel()[validos] - cy) * z / fy
    return np.stack([x, y, z], axis=1), validos


def para_mundo(pontos_cam: np.ndarray, pose_cam_para_mundo: np.ndarray) -> np.ndarray:
    return pontos_cam @ pose_cam_para_mundo[:3, :3].T + pose_cam_para_mundo[:3, 3]
