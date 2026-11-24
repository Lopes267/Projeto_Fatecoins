"""
Compara uma reconstrução com a caneca verdadeira.

  precisão     : distância de cada vértice reconstruído até a superfície real
                 (média e percentil 95) — mede deformação e sujeira;
  cobertura    : fração da superfície externa visível que tem malha a menos
                 de 6 mm — mede o que faltou (ex.: alça sumida);
  medidas      : caixa envolvente contra a da caneca (11,0 x 9,5 x 8,0 cm);
  intrusos     : vértices longe da caneca (mesa, caixa vizinha) que sobraram.
"""
from __future__ import annotations

import numpy as np
import open3d as o3d

from . import cena


def _cena_raio(V, T):
    s = o3d.t.geometry.RaycastingScene()
    s.add_triangles(o3d.core.Tensor(np.asarray(V, np.float32)),
                    o3d.core.Tensor(np.asarray(T, np.uint32)))
    return s


def distancia(pontos, V, T):
    s = _cena_raio(V, T)
    return s.compute_distance(o3d.core.Tensor(np.asarray(pontos, np.float32))).numpy()


def avaliar(V_mundo: np.ndarray, T: np.ndarray) -> dict:
    Vc, Tc, _, parte = cena.montar(com_mesa=False, com_caixa=False)
    d = distancia(V_mundo, Vc, Tc)
    externas = cena.amostras_externas()
    cob = distancia(externas, V_mundo, T)
    lo, hi = V_mundo.min(0), V_mundo.max(0)
    esperado = cena.CANECA_MAX - cena.CANECA_MIN
    return {
        "precisao_media_mm": round(float(d.mean()) * 1000, 2),
        "precisao_p95_mm": round(float(np.percentile(d, 95)) * 1000, 2),
        "cobertura_6mm": round(float((cob < 0.006).mean()), 3),
        "medidas_cm": [round(float(x) * 100, 2) for x in (hi - lo)],
        "esperado_cm": [round(float(x) * 100, 2) for x in esperado],
        "erro_medidas_mm": [round(float(x) * 1000, 1) for x in (hi - lo) - esperado],
        "intrusos": int((d > 0.015).sum()),
        "vertices": int(len(V_mundo)),
    }


def para_mundo(V_modelo: np.ndarray, mundo_do_modelo_colunas) -> np.ndarray:
    M = np.asarray(mundo_do_modelo_colunas, float).reshape(4, 4).T
    return V_modelo @ M[:3, :3].T + M[:3, 3]
